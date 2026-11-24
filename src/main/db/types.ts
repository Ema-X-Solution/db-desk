export type DbType = 'postgres' | 'mysql' | 'mssql';

export const DEFAULT_PORTS: Record<DbType, number> = { postgres: 5432, mysql: 3306, mssql: 1433 };

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
  tableData(schema: string, table: string, limit: number, offset: number): Promise<TableData>;
  insertRow(schema: string, table: string, values: Record<string, string | null>): Promise<void>;
  deleteRow(schema: string, table: string, key: Record<string, unknown>): Promise<number>;
  dropTable(schema: string, table: string): Promise<void>;
  /** Optional JS backup, used when the engine has no dump tool we can run locally (SQL Server). */
  exportSql?(outFile: string): Promise<void>;
}
