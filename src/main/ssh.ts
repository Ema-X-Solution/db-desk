import * as fs from 'fs';
import { ConnectConfig } from 'ssh2';
import { SshConfig } from './db/types';

/** Turns the saved SSH settings into ssh2 connect options (shared by the tunnel and the server status view). */
export function sshConnectOptions(cfg: SshConfig): ConnectConfig {
  let privateKey: Buffer | undefined;
  try { if (cfg.privateKeyPath) privateKey = fs.readFileSync(cfg.privateKeyPath); }
  catch (e) { throw new Error('Cannot read the SSH private key file: ' + (e as Error).message); }
  return {
    host: cfg.host, port: cfg.port || 22, username: cfg.user,
    password: cfg.password || undefined, privateKey, passphrase: cfg.passphrase || undefined,
    readyTimeout: 10000, keepaliveInterval: 15000,
  };
}
