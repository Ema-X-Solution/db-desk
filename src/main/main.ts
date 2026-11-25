import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { findTool, mysqlDump, pgDump, ToolName, ToolNotFoundError } from './backup';
import { getLastBackup, getServerSettings, getToolPath, setLastBackup, setServerSettings, setToolPath } from './settings';
import { ServerSession } from './serverStatus';
import { gitFetch, gitInfo, gitPull, validRepoPath } from './gitRepo';
import { DbDriver, ConnectionConfig } from './db/types';
import { PostgresDriver } from './db/postgres';
import { MysqlDriver } from './db/mysql';
import { MssqlDriver } from './db/mssql';
import { openTunnel, Tunnel } from './tunnel';
import { loadConnections, removeConnection, saveConnection } from './store';

let driver: DbDriver | null = null;
let active: ConnectionConfig | null = null;
let tunnel: Tunnel | null = null;
let activeSsh: ConnectionConfig['ssh'] | null = null;
let serverSession: ServerSession | null = null;

function closeServer() { serverSession?.close(); serverSession = null; }

/** Runs a read on the server over the connection's SSH settings. One SSH session is reused until the view closes. */
async function withServer<T>(fn: (s: ServerSession) => Promise<T>): Promise<T> {
  if (!activeSsh?.enabled) throw new Error('Server tools need the SSH tunnel turned on for this connection (edit the connection and tick the SSH option).');
  if (!serverSession) serverSession = await ServerSession.open(activeSsh);
  try { return await fn(serverSession); } catch (e) { closeServer(); throw e; }
}

async function closeAll() {
  if (driver) await driver.close().catch(() => {});
  if (tunnel) tunnel.close();
  closeServer();
  driver = null; active = null; tunnel = null; activeSsh = null;
}

function need(): DbDriver {
  if (!driver) throw new Error('Not connected');
  return driver;
}

function connect(c: ConnectionConfig): Promise<DbDriver> {
  switch (c.type) {
    case 'postgres': return PostgresDriver.connect(c);
    case 'mysql': return MysqlDriver.connect(c);
    case 'mssql': return MssqlDriver.connect(c);
    default: throw new Error('Unsupported database type: ' + c.type);
  }
}

const hidePw = (c: ConnectionConfig) => ({ ...c, password: '', ssh: c.ssh && { ...c.ssh, password: '', passphrase: '' } });

function registerIpc() {
  ipcMain.handle('conn:list', () => loadConnections().map(hidePw));
  ipcMain.handle('conn:save', (_e, c: ConnectionConfig) => {
    const old = c.id ? loadConnections().find((x) => x.id === c.id) : undefined;
    const full: ConnectionConfig = { ...c, id: c.id || randomUUID(), password: c.password || old?.password || '' };
    if (full.ssh) full.ssh = { ...full.ssh, password: full.ssh.password || old?.ssh?.password || '', passphrase: full.ssh.passphrase || old?.ssh?.passphrase || '' };
    saveConnection(full);
    return full.id;
  });
  ipcMain.handle('conn:remove', (_e, id: string) => removeConnection(id));
  ipcMain.handle('conn:open', async (_e, id: string) => {
    const c = loadConnections().find((x) => x.id === id);
    if (!c) throw new Error('Connection not found');
    await closeAll();
    let eff = c;
    try {
      if (c.ssh?.enabled) {
        tunnel = await openTunnel(c.ssh, c.host, c.port);
        eff = { ...c, host: '127.0.0.1', port: tunnel.localPort };
      }
      driver = await connect(eff);
    } catch (e) { await closeAll(); throw e; }
    active = eff; activeSsh = c.ssh ?? null;
    return { size: await driver.databaseSize(), tables: await driver.listTables() };
  });
  ipcMain.handle('conn:close', () => closeAll());
  ipcMain.handle('db:tables', async () => ({ size: await need().databaseSize(), tables: await need().listTables() }));
  ipcMain.handle('db:data', (_e, s: string, t: string, limit: number, offset: number, search?: string) => need().tableData(s, t, limit, offset, typeof search === 'string' ? search.slice(0, 200) : undefined));
  ipcMain.handle('db:insert', (_e, s: string, t: string, v: Record<string, string | null>) => need().insertRow(s, t, v));
  ipcMain.handle('db:delete', (_e, s: string, t: string, key: Record<string, unknown>) => need().deleteRow(s, t, key));
  ipcMain.handle('db:script', (_e, sql: string, commit: boolean) => {
    if (typeof sql !== 'string') throw new Error('Invalid script');
    return need().runScript(sql, commit === true);
  });
  ipcMain.handle('stats:db', async () => {
    const d = need();
    if (!d.stats) throw new Error('Database stats are only available for PostgreSQL for now.');
    return { ...(await d.stats()), lastBackup: active ? getLastBackup(active.id) : null };
  });
  ipcMain.handle('server:settings', (_e, v?: { nginxLog?: string; repoPath?: string }) => {
    if (v) {
      if (v.nginxLog !== undefined && v.nginxLog !== '' && !validRepoPath(v.nginxLog)) throw new Error('Enter the full path of the nginx log, for example /var/log/nginx/access.log');
      if (v.repoPath !== undefined && v.repoPath !== '' && !validRepoPath(v.repoPath)) throw new Error('Enter the full folder path on the server, for example /var/www/app');
      setServerSettings({ nginxLog: v.nginxLog, repoPath: v.repoPath });
    }
    return getServerSettings();
  });
  ipcMain.handle('server:status', (_e, withNginx: boolean) => withServer((s) => s.status(withNginx ? getServerSettings().nginxLog || null : null)));
  ipcMain.handle('server:close', () => closeServer());
  const repo = () => { const p = getServerSettings().repoPath; if (!p) throw new Error('Enter the repository folder on the server first.'); return p; };
  ipcMain.handle('server:git:info', () => withServer((s) => gitInfo(s, repo())));
  ipcMain.handle('server:git:fetch', () => withServer(async (s) => { await gitFetch(s, repo()); return gitInfo(s, repo()); }));
  ipcMain.handle('server:git:pull', () => withServer((s) => gitPull(s, repo())));
  ipcMain.handle('db:drop', (_e, s: string, t: string) => need().dropTable(s, t));
  const toolFor = (c: ConnectionConfig): ToolName | null => (c.type === 'postgres' ? 'pg_dump' : c.type === 'mysql' ? 'mysqldump' : null);
  ipcMain.handle('db:backup', async () => {
    if (!active) throw new Error('Not connected');
    const conn = active;
    const tool = toolFor(conn);
    // Check the tool before asking where to save, so a missing tool fails fast.
    if (tool && !findTool(tool, getToolPath(tool))) throw new ToolNotFoundError(tool);
    const stamp = new Date().toISOString().slice(0, 10);
    const r = await dialog.showSaveDialog({ defaultPath: `${conn.database}-${stamp}.sql`, filters: [{ name: 'SQL', extensions: ['sql'] }] });
    if (r.canceled || !r.filePath) return null;
    if (conn.type === 'postgres') await pgDump(conn, r.filePath, getToolPath('pg_dump'));
    else if (conn.type === 'mysql') await mysqlDump(conn, r.filePath, getToolPath('mysqldump'));
    else if (need().exportSql) await need().exportSql!(r.filePath);
    else throw new Error('Backup is not supported for this database type');
    setLastBackup(conn.id, r.filePath);
    return r.filePath;
  });
  ipcMain.handle('tool:status', () => (['pg_dump', 'mysqldump'] as ToolName[]).map((t) => ({ tool: t, path: findTool(t, getToolPath(t)) })));
  ipcMain.handle('tool:pick', async (_e, tool: ToolName) => {
    const r = await dialog.showOpenDialog({ title: `Select ${tool}`, properties: ['openFile'], filters: process.platform === 'win32' ? [{ name: 'Program', extensions: ['exe'] }] : [] });
    if (r.canceled || !r.filePaths[0]) return null;
    setToolPath(tool, r.filePaths[0]);
    return r.filePaths[0];
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280, height: 800, title: 'db-desk',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(() => { registerIpc(); createWindow(); });
app.on('window-all-closed', () => app.quit());
