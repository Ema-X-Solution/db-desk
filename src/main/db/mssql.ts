import * as sql from 'mssql';
import * as fs from 'fs';
import { checkScript, makeResult, ScriptResult } from './script';
import { ColumnInfo, ConnectionConfig, DbDriver, TableData, TableInfo, likeEscape } from './types';

const q = (id: string) => '[' + id.replace(/]/g, ']]') + ']';
const qt = (schema: string, table: string) => `${q(schema)}.${q(table)}`;

export class MssqlDriver implements DbDriver {
  private constructor(private pool: sql.ConnectionPool) {}

  static async connect(c: ConnectionConfig): Promise<MssqlDriver> {
    const pool = new sql.ConnectionPool({
      server: c.host, port: c.port, user: c.user, password: c.password, database: c.database,
      connectionTimeout: 8000, options: { encrypt: c.ssl, trustServerCertificate: true },
    });
    await pool.connect();
    return new MssqlDriver(pool);
  }

  async close() { await this.pool.close(); }

  private req() { return this.pool.request(); }

  async databaseSize() {
    const r = await this.req().query('SELECT SUM(CAST(size AS bigint)) * 8192 AS s FROM sys.database_files');
    return Number(r.recordset[0].s);
  }

  async listTables(): Promise<TableInfo[]> {
    const r = await this.req().query(`
      SELECT s.name AS [schema], t.name AS name,
             SUM(CASE WHEN p.index_id IN (0,1) THEN p.row_count ELSE 0 END) AS cnt,
             SUM(p.used_page_count) * 8192 AS sz
      FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id
      LEFT JOIN sys.dm_db_partition_stats p ON p.object_id = t.object_id
      GROUP BY s.name, t.name ORDER BY s.name, t.name`);
    return r.recordset.map((x: any) => ({ schema: x.schema, name: x.name, rowEstimate: Number(x.cnt || 0), sizeBytes: Number(x.sz || 0) }));
  }

  private async columns(schema: string, table: string): Promise<ColumnInfo[]> {
    const r = await this.req().input('s', schema).input('t', table).query(`
      SELECT c.name AS name,
             ty.name + CASE WHEN ty.name IN ('varchar','nvarchar','char','nchar','varbinary')
                            THEN '(' + CASE WHEN c.max_length = -1 THEN 'max' WHEN ty.name LIKE 'n%' THEN CAST(c.max_length/2 AS varchar(10)) ELSE CAST(c.max_length AS varchar(10)) END + ')'
                            WHEN ty.name IN ('decimal','numeric') THEN '(' + CAST(c.precision AS varchar(10)) + ',' + CAST(c.scale AS varchar(10)) + ')' ELSE '' END AS type,
             c.is_nullable AS nullable,
             CASE WHEN c.default_object_id <> 0 OR c.is_identity = 1 OR c.is_computed = 1 OR ty.name IN ('timestamp','rowversion') THEN 1 ELSE 0 END AS has_default,
             CASE WHEN EXISTS (SELECT 1 FROM sys.index_columns ic JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
                               WHERE i.is_primary_key = 1 AND ic.object_id = c.object_id AND ic.column_id = c.column_id) THEN 1 ELSE 0 END AS pk
      FROM sys.columns c JOIN sys.tables t ON t.object_id = c.object_id JOIN sys.schemas s ON s.schema_id = t.schema_id
      JOIN sys.types ty ON ty.user_type_id = c.user_type_id
      WHERE s.name = @s AND t.name = @t ORDER BY c.column_id`);
    return r.recordset.map((x: any) => ({ name: x.name, dataType: x.type, nullable: !!x.nullable, hasDefault: !!x.has_default, isPrimaryKey: !!x.pk }));
  }

  async tableData(schema: string, table: string, limit: number, offset: number, search?: string): Promise<TableData> {
    const columns = await this.columns(schema, table);
    if (!columns.length) throw new Error(`Table ${schema}.${table} not found`);
    const pk = columns.filter((c) => c.isPrimaryKey).map((c) => q(c.name));
    const order = pk.length ? pk.join(', ') : '(SELECT NULL)';
    const term = search?.trim();
    const skip = /binary|image|geometry|geography|hierarchyid|timestamp|rowversion/i;
    const sc = columns.filter((c) => !skip.test(c.dataType));
    const where = term && sc.length ? ' WHERE ' + sc.map((c) => `CAST(${q(c.name)} AS NVARCHAR(MAX)) LIKE @s ESCAPE '\\'`).join(' OR ') : '';
    const like = '%' + likeEscape(term || '') + '%';
    const cnt = await this.req().input('s', sql.NVarChar, like).query(`SELECT COUNT_BIG(*) AS n FROM ${qt(schema, table)}${where}`);
    const rows = await this.req().input('s', sql.NVarChar, like).input('o', sql.Int, offset).input('l', sql.Int, limit)
      .query(`SELECT * FROM ${qt(schema, table)}${where} ORDER BY ${order} OFFSET @o ROWS FETCH NEXT @l ROWS ONLY`);
    return { columns, rows: rows.recordset as Record<string, unknown>[], total: Number(cnt.recordset[0].n) };
  }

  async insertRow(schema: string, table: string, values: Record<string, string | null>) {
    const cols = Object.keys(values);
    if (!cols.length) { await this.req().query(`INSERT INTO ${qt(schema, table)} DEFAULT VALUES`); return; }
    const r = this.req();
    cols.forEach((c, i) => r.input('p' + i, values[c]));
    await r.query(`INSERT INTO ${qt(schema, table)} (${cols.map(q).join(', ')}) VALUES (${cols.map((_, i) => '@p' + i).join(', ')})`);
  }

  async deleteRow(schema: string, table: string, key: Record<string, unknown>) {
    const cols = Object.keys(key);
    if (!cols.length) throw new Error('This table has no primary key, so rows cannot be deleted safely.');
    const tx = new sql.Transaction(this.pool);
    await tx.begin();
    try {
      const r = new sql.Request(tx);
      cols.forEach((c, i) => r.input('p' + i, key[c] as any));
      const res = await r.query(`DELETE FROM ${qt(schema, table)} WHERE ${cols.map((c, i) => `${q(c)} = @p${i}`).join(' AND ')}`);
      const n = res.rowsAffected[0] ?? 0;
      if (n > 1) throw new Error('Delete would affect more than one row, rolled back.');
      await tx.commit();
      return n;
    } catch (e) { await tx.rollback(); throw e; }
  }

  async dropTable(schema: string, table: string) {
    await this.req().query(`DROP TABLE ${qt(schema, table)}`);
  }

  /** Data-only backup as INSERT statements. SQL Server's native BACKUP writes on the server, so we export data instead. */
  async runScript(script: string, commit: boolean): Promise<ScriptResult> {
    checkScript('mssql', script, commit);
    const tx = new sql.Transaction(this.pool);
    await tx.begin();
    try {
      const req = new sql.Request(tx);
      (req as any).arrayRowMode = true;
      const res: any = await req.query('SET XACT_ABORT ON;\n' + script);
      const sets: any[] = res.recordsets ?? [];
      const results = sets.map((rs, i) => {
        const cols = Object.values(rs.columns ?? {}).sort((a: any, b: any) => a.index - b.index).map((c: any) => c.name);
        return makeResult('SELECT', rs.length, cols, rs);
      });
      const changed = (res.rowsAffected as number[] | undefined)?.reduce((a, b) => a + b, 0) ?? 0;
      if (!sets.length || changed) results.push(makeResult('OK', changed, [], []));
      if (commit) await tx.commit(); else await tx.rollback();
      return { results, committed: commit };
    } catch (e) {
      await tx.rollback().catch(() => {});
      throw e;
    }
  }

  async exportSql(outFile: string) {
    const out = fs.createWriteStream(outFile);
    const w = (s: string) => new Promise<void>((res) => (out.write(s) ? res() : out.once('drain', () => res())));
    await w('-- db-desk data export (data only, no schema)\n');
    for (const t of await this.listTables()) {
      const cols = await this.columns(t.schema, t.name);
      const names = cols.map((c) => q(c.name)).join(', ');
      for (let off = 0; ; off += 500) {
        const d = await this.tableData(t.schema, t.name, 500, off);
        if (!d.rows.length) break;
        for (const row of d.rows) {
          const vals = cols.map((c) => lit(row[c.name])).join(', ');
          await w(`INSERT INTO ${qt(t.schema, t.name)} (${names}) VALUES (${vals});\n`);
        }
      }
    }
    await new Promise<void>((res) => out.end(res));
  }
}

function lit(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (Buffer.isBuffer(v)) return '0x' + v.toString('hex');
  return `N'${String(v).replace(/'/g, "''")}'`;
}
