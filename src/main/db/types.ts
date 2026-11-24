import type { ScriptResult } from './script';

export type DbType = 'postgres' | 'mysql' | 'mssql';

export const DEFAULT_PORTS: Record<DbType, number> = { postgres: 5432, mysql: 3306, mssql: 1433 };

export interface SshConfig {
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  password: string;
  /** Path to a private key file on this computer (optional). */
  privateKeyPath: string;
  passphrase: string;
}

export interface ConnectionConfig {
  id: string;
  name: string;
  type: DbType;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl: boolean;
  ssh?: SshConfig;
}

export interface TableInfo {
  schema: string;
  name: string;
  rowEstimate: number;
  sizeBytes: number;
}

export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  hasDefault: boolean;
  isPrimaryKey: boolean;
}

/** Escape LIKE wildcards so the user's text is matched literally. */
export const likeEscape = (s: string) => s.replace(/[\\%_\[]/g, (m) => '\\' + m);

export interface TableData {
  columns: ColumnInfo[];
  rows: Record<string, unknown>[];
  total: number;
}

/** Every database engine implements this. Add MySQL / SQL Server by adding a driver. */
export interface DbDriver {
  close(): Promise<void>;
  databaseSize(): Promise<number>;
  listTables(): Promise<TableInfo[]>;
  /** `search` (optional) keeps only rows where any column contains the text. Read-only. */
  tableData(schema: string, table: string, limit: number, offset: number, search?: string): Promise<TableData>;
  insertRow(schema: string, table: string, values: Record<string, string | null>): Promise<void>;
  deleteRow(schema: string, table: string, key: Record<string, unknown>): Promise<number>;
  dropTable(schema: string, table: string): Promise<void>;
  /**
   * Runs a multi-statement script in ONE transaction. commit=false always rolls back (dry run).
   * Any error rolls everything back and is thrown. Call checkScript first.
   */
  runScript(sql: string, commit: boolean): Promise<ScriptResult>;
  /** Optional JS backup, used when the engine has no dump tool we can run locally (SQL Server). */
  exportSql?(outFile: string): Promise<void>;
}
