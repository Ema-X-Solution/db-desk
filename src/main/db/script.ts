// Shared pieces of the SQL tab: result types, script checks and cell formatting.
// Each driver implements `runScript` on top of these.
import { DbType } from './types';

export const MAX_RESULT_ROWS = 200;
export const MAX_SCRIPT_CHARS = 1_000_000;

export interface StatementResult {
  /** e.g. SELECT, UPDATE, DELETE */
  command: string;
  /** Rows returned (SELECT) or rows changed (others). null when the engine does not say. */
  rowCount: number | null;
  columns: string[];
  /** At most MAX_RESULT_ROWS rows, every cell already turned into text. */
  rows: (string | null)[][];
  truncated: boolean;
}

export interface ScriptResult {
  results: StatementResult[];
  /** true only when the transaction was committed. */
  committed: boolean;
}

/** Blanks out comments and quoted text so keyword checks cannot be fooled by them. */
export function stripSql(sql: string): string {
  return sql.replace(
    /--[^\n]*|\/\*[\s\S]*?\*\/|\$([A-Za-z_]*)\$[\s\S]*?\$\1\$|'(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]/g,
    ' ',
  );
}

const TX_WORDS: Record<DbType, RegExp> = {
  postgres: /^(begin|start|commit|end|rollback|abort|prepare\s+transaction)\b/i,
  mysql: /^(begin|start\s+transaction|commit|rollback)\b/i,
  mssql: /^(begin\s+tran(saction)?|commit|rollback|save\s+tran(saction)?)\b/i,
};
const MYSQL_IMPLICIT_COMMIT = /^(create|alter|drop|truncate|rename)\b/i;

const statementsOf = (sql: string) => stripSql(sql).split(';').map((s) => s.trim()).filter(Boolean);

/** Throws a plain-language error when the script cannot be run safely inside db-desk's transaction. */
export function checkScript(type: DbType, sql: string, commit: boolean): void {
  if (!sql.trim()) throw new Error('The script is empty.');
  if (sql.length > MAX_SCRIPT_CHARS) throw new Error('The script is too large (limit 1,000,000 characters).');
  const stmts = statementsOf(sql);
  if (!stmts.length) throw new Error('The script has no statements (only comments).');
  const bad = stmts.find((s) => TX_WORDS[type].test(s));
  if (bad) {
    throw new Error(
      `Remove the transaction line "${bad.split(/\s+/).slice(0, 2).join(' ').toUpperCase()}" from the script. db-desk already wraps the whole script in one transaction: a dry run always rolls back, and "Run and commit" commits only if every statement succeeds.`,
    );
  }
  if (type === 'mysql' && !commit && stmts.some((s) => MYSQL_IMPLICIT_COMMIT.test(s))) {
    throw new Error('MySQL saves CREATE / ALTER / DROP / TRUNCATE / RENAME immediately, so a dry run cannot undo them. Dry run is blocked for this script.');
  }
}

export function cellToText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? 'Invalid date' : v.toISOString();
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'object') {
    if (v instanceof Uint8Array) return '\\x' + Buffer.from(v).toString('hex');
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v);
}

/** Builds a StatementResult from column names and row arrays, applying the row cap. */
export function makeResult(command: string, rowCount: number | null, columns: string[], rows: unknown[][]): StatementResult {
  return {
    command, rowCount, columns,
    rows: rows.slice(0, MAX_RESULT_ROWS).map((r) => r.map(cellToText)),
    truncated: rows.length > MAX_RESULT_ROWS,
  };
}
