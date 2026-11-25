import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { ToolName } from './backup';

/** Non-secret app settings (paths to dump tools). Stored in the user profile. */
const file = () => path.join(app.getPath('userData'), 'settings.json');
type Settings = {
  toolPaths?: Partial<Record<ToolName, string>>;
  lastBackups?: Record<string, { at: string; file: string }>;
  server?: { nginxLog?: string; repoPath?: string };
};

function read(): Settings { try { return JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { return {}; } }

export const getToolPath = (t: ToolName) => read().toolPaths?.[t];

export function setToolPath(t: ToolName, p: string) {
  const s = read(); s.toolPaths = { ...s.toolPaths, [t]: p };
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(s, null, 2));
}

function write(s: Settings) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(s, null, 2));
}

/** db-desk only knows about backups it made itself. */
export const getLastBackup = (connId: string) => read().lastBackups?.[connId] ?? null;
export function setLastBackup(connId: string, filePath: string) {
  const s = read(); s.lastBackups = { ...s.lastBackups, [connId]: { at: new Date().toISOString(), file: filePath } }; write(s);
}

export const getServerSettings = () => ({ nginxLog: '/var/log/nginx/access.log', repoPath: '', ...read().server });
export function setServerSettings(v: { nginxLog?: string; repoPath?: string }) {
  const s = read(); s.server = { ...s.server, ...v }; write(s);
}
