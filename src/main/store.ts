import { app, safeStorage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { ConnectionConfig } from './db/types';

/** Saved connections live in the user's profile. Passwords are encrypted with the OS keychain (safeStorage). */
const file = () => path.join(app.getPath('userData'), 'connections.json');

interface Stored extends Omit<ConnectionConfig, 'password'> { passwordEnc: string }

export function loadConnections(): ConnectionConfig[] {
  if (!fs.existsSync(file())) return [];
  const list: Stored[] = JSON.parse(fs.readFileSync(file(), 'utf8'));
  return list.map(({ passwordEnc, ...rest }) => ({ ...rest, password: decrypt(passwordEnc) }));
}

export function saveConnection(c: ConnectionConfig) {
  const all = loadConnections().filter((x) => x.id !== c.id);
  all.push(c);
  write(all);
}

export function removeConnection(id: string) {
  write(loadConnections().filter((x) => x.id !== id));
}

function write(all: ConnectionConfig[]) {
  const out: Stored[] = all.map(({ password, ...rest }) => ({ ...rest, passwordEnc: encrypt(password) }));
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(out, null, 2), { mode: 0o600 });
}

function encrypt(s: string) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption is not available, refusing to store the password in plain text.');
  return safeStorage.encryptString(s).toString('base64');
}
function decrypt(s: string) {
  return safeStorage.decryptString(Buffer.from(s, 'base64'));
}
