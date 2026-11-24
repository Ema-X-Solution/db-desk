import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { ToolName } from './backup';

/** Non-secret app settings (paths to dump tools). Stored in the user profile. */
const file = () => path.join(app.getPath('userData'), 'settings.json');
type Settings = { toolPaths?: Partial<Record<ToolName, string>> };

function read(): Settings { try { return JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { return {}; } }

export const getToolPath = (t: ToolName) => read().toolPaths?.[t];

export function setToolPath(t: ToolName, p: string) {
  const s = read(); s.toolPaths = { ...s.toolPaths, [t]: p };
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(s, null, 2));
}
