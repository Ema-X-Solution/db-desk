import { spawn } from 'child_process';
import { ConnectionConfig } from './db/types';

/** Backup uses the standard pg_dump tool (install PostgreSQL client tools). Password goes via env, never the command line. */
export function pgDump(c: ConnectionConfig, outFile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ['-h', c.host, '-p', String(c.port), '-U', c.user, '-d', c.database, '-F', 'p', '-f', outFile, '--no-password'];
    const p = spawn('pg_dump', args, { env: { ...process.env, PGPASSWORD: c.password, PGSSLMODE: c.ssl ? 'require' : 'prefer' } });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => reject(new Error('pg_dump not found. Install the PostgreSQL client tools and make sure pg_dump is on your PATH. ' + e.message)));
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `pg_dump exited with ${code}`))));
  });
}
