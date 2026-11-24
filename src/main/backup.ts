import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ConnectionConfig } from './db/types';

export type ToolName = 'pg_dump' | 'mysqldump';

/** Thrown when the dump tool cannot be found. The UI offers a file picker when it sees code TOOL_NOT_FOUND. */
export class ToolNotFoundError extends Error {
  code = 'TOOL_NOT_FOUND';
  constructor(public tool: ToolName) {
    super(`TOOL_NOT_FOUND:${tool}: ${tool} was not found on this computer. Choose where ${tool} is installed.`);
  }
}

const exe = (tool: ToolName, platform: string) => (platform === 'win32' ? tool + '.exe' : tool);

function subdirs(dir: string, match: RegExp): string[] {
  try { return fs.readdirSync(dir).filter((d) => match.test(d)).sort(byVersionDesc).map((d) => path.join(dir, d)); } catch { return []; }
}
function byVersionDesc(a: string, b: string) {
  const n = (s: string) => (s.match(/\d+(\.\d+)*/)?.[0] ?? '0').split('.').map(Number);
  const x = n(a), y = n(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
  return 0;
}

/** Folders worth looking in when the tool is not on PATH. Newest versions first. Exported for tests. */
export function candidateDirs(tool: ToolName, platform: string, env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  if (platform === 'win32') {
    const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432, 'C:\\Program Files', 'C:\\Program Files (x86)'].filter(Boolean) as string[];
    const local = [env.LOCALAPPDATA, env.USERPROFILE && path.join(env.USERPROFILE, 'AppData', 'Local')].filter(Boolean) as string[];
    if (tool === 'pg_dump') {
      for (const r of [...new Set(roots)]) {
        for (const d of subdirs(path.join(r, 'PostgreSQL'), /^\d/)) out.push(path.join(d, 'bin'));
        for (const d of subdirs(r, /^pgAdmin 4/i)) out.push(path.join(d, 'runtime'));
        for (const d of subdirs(path.join(r, 'pgAdmin 4'), /^v\d/i)) out.push(path.join(d, 'runtime'));
        out.push(path.join(r, 'pgAdmin 4', 'runtime'));
      }
      for (const l of [...new Set(local)]) {
        const base = path.join(l, 'Programs');
        for (const d of subdirs(base, /^pgAdmin 4/i)) out.push(path.join(d, 'runtime'));
        for (const d of subdirs(path.join(base, 'pgAdmin 4'), /^v\d/i)) out.push(path.join(d, 'runtime'));
        out.push(path.join(base, 'pgAdmin 4', 'runtime'));
      }
    } else {
      for (const r of [...new Set(roots)]) {
        for (const d of subdirs(path.join(r, 'MySQL'), /^MySQL Server/i)) out.push(path.join(d, 'bin'));
        for (const d of subdirs(r, /^MariaDB/i)) out.push(path.join(d, 'bin'));
      }
    }
  } else {
    out.push('/usr/local/bin', '/opt/homebrew/bin', '/usr/bin');
    if (tool === 'pg_dump') {
      for (const d of subdirs('/usr/lib/postgresql', /^\d/)) out.push(path.join(d, 'bin'));
      for (const d of subdirs('/opt/homebrew/opt', /^postgresql/)) out.push(path.join(d, 'bin'));
      for (const d of subdirs('/Applications/Postgres.app/Contents/Versions', /^\d/)) out.push(path.join(d, 'bin'));
      for (const d of subdirs('/Library/PostgreSQL', /^\d/)) out.push(path.join(d, 'bin'));
    }
  }
  return out;
}

const isFile = (p: string) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

/** Finds the dump tool: the configured path, then PATH, then common install folders. Returns a full path or null. */
export function findTool(tool: ToolName, custom?: string, platform = process.platform, env: NodeJS.ProcessEnv = process.env): string | null {
  if (custom && isFile(custom)) return custom;
  const name = exe(tool, platform);
  const pathDirs = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  for (const d of [...pathDirs, ...candidateDirs(tool, platform, env)]) {
    const p = path.join(d, name);
    if (isFile(p)) return p;
  }
  return null;
}

function run(bin: string, args: string[], env: NodeJS.ProcessEnv, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { env, windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => reject(new Error(`${label} could not start: ${e.message}`)));
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `${label} exited with ${code}`))));
  });
}

/** pg_dump. Password goes via env, never the command line. */
export async function pgDump(c: ConnectionConfig, outFile: string, custom?: string): Promise<void> {
  const bin = findTool('pg_dump', custom);
  if (!bin) throw new ToolNotFoundError('pg_dump');
  const args = ['-h', c.host, '-p', String(c.port), '-U', c.user, '-d', c.database, '-F', 'p', '-f', outFile, '--no-password'];
  await run(bin, args, { ...process.env, PGPASSWORD: c.password, PGSSLMODE: c.ssl ? 'require' : 'prefer' }, 'pg_dump');
}

/** mysqldump. Password goes via env, never the command line. */
export async function mysqlDump(c: ConnectionConfig, outFile: string, custom?: string): Promise<void> {
  const bin = findTool('mysqldump', custom);
  if (!bin) throw new ToolNotFoundError('mysqldump');
  const args = ['-h', c.host, '-P', String(c.port), '-u', c.user, '--single-transaction', '--routines', '--result-file=' + outFile, c.database];
  if (c.ssl) args.unshift('--ssl-mode=REQUIRED');
  await run(bin, args, { ...process.env, MYSQL_PWD: c.password }, 'mysqldump');
}
