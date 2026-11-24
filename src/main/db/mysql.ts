import * as mysql from 'mysql2/promise';
import { ColumnInfo, ConnectionConfig, DbDriver, TableData, TableInfo } from './types';

const q = (id: string) => '`' + id.replace(/`/g, '``') + '`';
const qt = (schema: string, table: string) => `${q(schema)}.${q(table)}`;

export class MysqlDriver implements DbDriver {
  private constructor(private conn: mysql.Connection, private db: string) {}

  static async connect(c: ConnectionConfig): Promise<MysqlDriver> {
    const conn = await mysql.createConnection({
      host: c.host, port: c.port, user: c.user, password: c.password, database: c.database,
      ssl: c.ssl ? { rejectUnauthorized: false } : undefined, connectTimeout: 8000, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true,
    });
    return new MysqlDriver(conn, c.database);
  }

  async close() { await this.conn.end(); }

  async databaseSize() {
    const [r] = await this.conn.query<any[]>(
      'SELECT COALESCE(SUM(data_length + index_length), 0) AS s FROM information_schema.tables WHERE table_schema = DATABASE()');
    return Number(r[0].s);
  }

  async listTables(): Promise<TableInfo[]> {
    const [r] = await this.conn.query<any[]>(
      `SELECT table_name AS name, COALESCE(table_rows, 0) AS cnt, COALESCE(data_length + index_length, 0) AS sz
       FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY table_name`);
    return r.map((x) => ({ schema: this.db, name: x.name, rowEstimate: Number(x.cnt), sizeBytes: Number(x.sz) }));
  }

  private async columns(table: string): Promise<ColumnInfo[]> {
    const [r] = await this.conn.query<any[]>(
      `SELECT column_name AS name, column_type AS type, is_nullable AS nullable, column_default AS def, extra, column_key AS ck
       FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position`, [table]);
    return r.map((x) => ({
      name: x.name, dataType: x.type, nullable: x.nullable === 'YES',
      hasDefault: x.def !== null || /auto_increment|DEFAULT_GENERATED/i.test(x.extra || ''), isPrimaryKey: x.ck === 'PRI',
    }));
  }

  async tableData(schema: string, table: string, limit: number, offset: number): Promise<TableData> {
    const columns = await this.columns(table);
    if (!columns.length) throw new Error(`Table ${table} not found`);
    const pk = columns.filter((c) => c.isPrimaryKey).map((c) => q(c.name));
    const order = pk.length ? ' ORDER BY ' + pk.join(', ') : '';
    const [cnt] = await this.conn.query<any[]>(`SELECT COUNT(*) AS n FROM ${qt(schema, table)}`);
    const [rows] = await this.conn.query<any[]>(`SELECT * FROM ${qt(schema, table)}${order} LIMIT ? OFFSET ?`, [limit, offset]);
    return { columns, rows: rows as Record<string, unknown>[], total: Number(cnt[0].n) };
  }

  async insertRow(schema: string, table: string, values: Record<string, string | null>) {
    const cols = Object.keys(values);
    if (!cols.length) { await this.conn.query(`INSERT INTO ${qt(schema, table)} () VALUES ()`); return; }
    await this.conn.query(
      `INSERT INTO ${qt(schema, table)} (${cols.map(q).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      cols.map((c) => values[c]));
  }

  async deleteRow(schema: string, table: string, key: Record<string, unknown>) {
    const cols = Object.keys(key);
    if (!cols.length) throw new Error('This table has no primary key, so rows cannot be deleted safely.');
    const where = cols.map((c) => `${q(c)} = ?`).join(' AND ');
    await this.conn.beginTransaction();
    try {
      const [res] = await this.conn.query<any>(`DELETE FROM ${qt(schema, table)} WHERE ${where}`, cols.map((c) => key[c]));
      if (res.affectedRows > 1) throw new Error('Delete would affect more than one row, rolled back.');
      await this.conn.commit();
      return res.affectedRows as number;
    } catch (e) { await this.conn.rollback(); throw e; }
  }

  async dropTable(schema: string, table: string) {
    await this.conn.query(`DROP TABLE ${qt(schema, table)}`);
  }
}
