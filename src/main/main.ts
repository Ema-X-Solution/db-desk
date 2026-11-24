import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { mysqlDump, pgDump } from './backup';
import { DbDriver, ConnectionConfig } from './db/types';
import { PostgresDriver } from './db/postgres';
import { MysqlDriver } from './db/mysql';
import { MssqlDriver } from './db/mssql';
import { loadConnections, removeConnection, saveConnection } from './store';

let driver: DbDriver | null = null;
let active: ConnectionConfig | null = null;

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

const hidePw = (c: ConnectionConfig) => ({ ...c, password: '' });

function registerIpc() {
  ipcMain.handle('conn:list', () => loadConnections().map(hidePw));
  ipcMain.handle('conn:save', (_e, c: ConnectionConfig) => {
    const old = c.id ? loadConnections().find((x) => x.id === c.id) : undefined;
    const full = { ...c, id: c.id || randomUUID(), password: c.password || old?.password || '' };
    saveConnection(full);
    return full.id;
  });
  ipcMain.handle('conn:remove', (_e, id: string) => removeConnection(id));
  ipcMain.handle('conn:open', async (_e, id: string) => {
    const c = loadConnections().find((x) => x.id === id);
    if (!c) throw new Error('Connection not found');
    if (driver) await driver.close();
    driver = await connect(c);
    active = c;
    return { size: await driver.databaseSize(), tables: await driver.listTables() };
  });
  ipcMain.handle('conn:close', async () => { if (driver) await driver.close(); driver = null; active = null; });
  ipcMain.handle('db:tables', async () => ({ size: await need().databaseSize(), tables: await need().listTables() }));
  ipcMain.handle('db:data', (_e, s: string, t: string, limit: number, offset: number) => need().tableData(s, t, limit, offset));
  ipcMain.handle('db:insert', (_e, s: string, t: string, v: Record<string, string | null>) => need().insertRow(s, t, v));
  ipcMain.handle('db:delete', (_e, s: string, t: string, key: Record<string, unknown>) => need().deleteRow(s, t, key));
  ipcMain.handle('db:drop', (_e, s: string, t: string) => need().dropTable(s, t));
  ipcMain.handle('db:backup', async () => {
    if (!active) throw new Error('Not connected');
    const stamp = new Date().toISOString().slice(0, 10);
    const r = await dialog.showSaveDialog({ defaultPath: `${active.database}-${stamp}.sql`, filters: [{ name: 'SQL', extensions: ['sql'] }] });
    if (r.canceled || !r.filePath) return null;
    if (active.type === 'postgres') await pgDump(active, r.filePath);
    else if (active.type === 'mysql') await mysqlDump(active, r.filePath);
    else if (need().exportSql) await need().exportSql!(r.filePath);
    else throw new Error('Backup is not supported for this database type');
    return r.filePath;
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
