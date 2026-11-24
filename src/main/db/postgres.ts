import { Client } from 'pg';
import { ColumnInfo, ConnectionConfig, DbDriver, TableData, TableInfo, likeEscape } from './types';

const q = (id: string) => '"' + id.replace(/"/g, '""') + '"';
const qt = (schema: string, table: string) => `${q(schema)}.${q(table)}`;

export function clientOptions(c: ConnectionConfig) {
  return {
    host: c.host, port: c.port, user: c.user, password: c.password, database: c.database,
    ssl: c.ssl ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 8000,
  };
}

export class PostgresDriver implements DbDriver {
  private constructor(private client: Client) {}

  static async connect(c: ConnectionConfig): Promise<PostgresDriver> {
    const client = new Client(clientOptions(c));
    await client.connect();
    return new PostgresDriver(client);
  }

  async close() { await this.client.end(); }

  async databaseSize() {
    const r = await this.client.query('SELECT pg_database_size(current_database())::bigint AS s');
    return Number(r.rows[0].s);
  }

  async listTables(): Promise<TableInfo[]> {
    const r = await this.client.query(`
      SELECT n.nspname AS schema, c.relname AS name,
             GREATEST(c.reltuples, 0)::bigint AS rows,
             pg_total_relation_size(c.oid)::bigint AS size
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema')
        AND n.nspname NOT LIKE 'pg_toast%'
      ORDER BY n.nspname, c.relname`);
    return r.rows.map((x) => ({ schema: x.schema, name: x.name, rowEstimate: Number(x.rows), sizeBytes: Number(x.size) }));
  }

  private async columns(schema: string, table: string): Promise<ColumnInfo[]> {
    const r = await this.client.query(`
      SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
             NOT a.attnotnull AS nullable, a.atthasdef AS has_default,
             COALESCE(a.attnum = ANY (i.indkey), false) AS pk
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_index i ON i.indrelid = c.oid AND i.indisprimary
      WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`, [schema, table]);
    return r.rows.map((x) => ({ name: x.name, dataType: x.type, nullable: x.nullable, hasDefault: x.has_default, isPrimaryKey: x.pk }));
  }

  async tableData(schema: string, table: string, limit: number, offset: number, search?: string): Promise<TableData> {
    const columns = await this.columns(schema, table);
    if (!columns.length) throw new Error(`Table ${schema}.${table} not found`);
    const pk = columns.filter((c) => c.isPrimaryKey).map((c) => q(c.name));
    const order = pk.length ? ' ORDER BY ' + pk.join(', ') : '';
    const term = search?.trim();
    const where = term ? ' WHERE ' + columns.map((c) => `${q(c.name)}::text ILIKE $1 ESCAPE '\\'`).join(' OR ') : '';
    const sp = term ? ['%' + likeEscape(term) + '%'] : [];
    const count = await this.client.query(`SELECT count(*)::bigint AS n FROM ${qt(schema, table)}${where}`, sp);
    const rows = await this.client.query(`SELECT * FROM ${qt(schema, table)}${where}${order} LIMIT $${sp.length + 1} OFFSET $${sp.length + 2}`, [...sp, limit, offset]);
    return { columns, rows: rows.rows, total: Number(count.rows[0].n) };
  }

  async insertRow(schema: string, table: string, values: Record<string, string | null>) {
    const cols = Object.keys(values);
    if (!cols.length) {
      await this.client.query(`INSERT INTO ${qt(schema, table)} DEFAULT VALUES`);
      return;
    }
    const params = cols.map((_, i) => `$${i + 1}`);
    await this.client.query(
      `INSERT INTO ${qt(schema, table)} (${cols.map(q).join(', ')}) VALUES (${params.join(', ')})`,
      cols.map((c) => values[c]),
    );
  }

  /** Deletes by primary key only, inside a transaction, and refuses to touch more than one row. */
  async deleteRow(schema: string, table: string, key: Record<string, unknown>) {
    const cols = Object.keys(key);
    if (!cols.length) throw new Error('This table has no primary key, so rows cannot be deleted safely.');
    const where = cols.map((c, i) => `${q(c)} = $${i + 1}`).join(' AND ');
    await this.client.query('BEGIN');
    try {
      const r = await this.client.query(`DELETE FROM ${qt(schema, table)} WHERE ${where}`, cols.map((c) => key[c]));
      if ((r.rowCount ?? 0) > 1) throw new Error('Delete would affect more than one row, rolled back.');
      await this.client.query('COMMIT');
      return r.rowCount ?? 0;
    } catch (e) {
      await this.client.query('ROLLBACK');
      throw e;
    }
  }

  async dropTable(schema: string, table: string) {
    await this.client.query(`DROP TABLE ${qt(schema, table)}`);
  }
}
