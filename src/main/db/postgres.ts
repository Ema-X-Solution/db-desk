import { Client } from 'pg';
import { checkScript, makeResult, ScriptResult } from './script';
import { DbStats, ColumnInfo, ConnectionConfig, DbDriver, TableData, TableInfo, likeEscape } from './types';

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

  /** Read-only SELECTs against the system views. Needs no special rights, except slow-query history. */
  async stats(): Promise<DbStats> {
    const one = async (sql: string) => (await this.client.query(sql)).rows;
    const [{ v, up, mx }] = await one(`SELECT version() AS v, extract(epoch FROM now() - pg_postmaster_start_time())::bigint AS up, current_setting('max_connections')::int AS mx`);
    const tables = (await this.listTables()).sort((a, b) => b.sizeBytes - a.sizeBytes).slice(0, 10);
    const conn = await one(`SELECT count(*)::int AS total, count(*) FILTER (WHERE state = 'active')::int AS active,
        count(*) FILTER (WHERE state LIKE 'idle%')::int AS idle FROM pg_stat_activity WHERE backend_type = 'client backend'`);
    const [h] = await one(`SELECT blks_hit, blks_read, xact_commit, xact_rollback, deadlocks FROM pg_stat_database WHERE datname = current_database()`);
    const hit = Number(h.blks_hit), read = Number(h.blks_read);
    let slow: DbStats['slow'] | null = null;
    const ext = await one(`SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'`);
    if (ext.length) {
      try {
        const rows = await one(`SELECT query, calls, mean_exec_time AS mean, total_exec_time AS total FROM pg_stat_statements
          WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database()) ORDER BY mean_exec_time DESC LIMIT 10`);
        slow = { source: 'history', note: 'Slowest by average time, since the statistics were last reset.',
          rows: rows.map((r) => ({ query: String(r.query).slice(0, 400), calls: Number(r.calls), meanMs: Number(r.mean), totalMs: Number(r.total) })) };
      } catch { /* no permission: fall back to running queries */ }
    }
    if (!slow) {
      const rows = await one(`SELECT query, extract(epoch FROM now() - query_start) * 1000 AS ms FROM pg_stat_activity
        WHERE state = 'active' AND pid <> pg_backend_pid() AND backend_type = 'client backend' AND datname = current_database()
        ORDER BY query_start LIMIT 10`);
      slow = { source: 'running', rows: rows.map((r) => ({ query: String(r.query).slice(0, 400), calls: null, meanMs: Number(r.ms), totalMs: null })),
        note: ext.length ? 'No permission to read the query history (pg_stat_statements). Showing queries running right now.'
          : 'Query history is off: the pg_stat_statements extension is not installed on this database. Showing queries running right now.' };
    }
    return {
      version: String(v).replace(/ on .*/, ''), uptimeSec: Number(up), sizeBytes: await this.databaseSize(),
      biggestTables: tables.map((t) => ({ schema: t.schema, name: t.name, sizeBytes: t.sizeBytes, rows: t.rowEstimate })),
      connections: { current: conn[0].total, active: conn[0].active, idle: conn[0].idle, max: mx },
      health: { cacheHitPercent: hit + read > 0 ? (hit / (hit + read)) * 100 : null, commits: Number(h.xact_commit), rollbacks: Number(h.xact_rollback), deadlocks: Number(h.deadlocks) },
      slow,
    };
  }

  async runScript(sql: string, commit: boolean): Promise<ScriptResult> {
    checkScript('postgres', sql, commit);
    await this.client.query('BEGIN');
    try {
      await this.client.query("SET LOCAL statement_timeout = '300s'");
      // Simple protocol: all statements in one call, one result each. rowMode keeps duplicate column names.
      const res: any = await this.client.query({ text: sql, rowMode: 'array' });
      const list: any[] = Array.isArray(res) ? res : [res];
      const results = list.map((r) => makeResult(r.command ?? '', r.rowCount ?? null, (r.fields ?? []).map((f: any) => f.name), r.rows ?? []));
      await this.client.query(commit ? 'COMMIT' : 'ROLLBACK');
      return { results, committed: commit };
    } catch (e) {
      await this.client.query('ROLLBACK').catch(() => {});
      throw e;
    }
  }

  async dropTable(schema: string, table: string) {
    await this.client.query(`DROP TABLE ${qt(schema, table)}`);
  }
}
