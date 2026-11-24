import { Client } from 'ssh2';
import * as fs from 'fs';
import * as net from 'net';
import { SshConfig } from './db/types';

export interface Tunnel { localPort: number; close(): void }

/**
 * Opens an SSH connection and a local listener on 127.0.0.1 (random port).
 * Every local connection is forwarded through SSH to dstHost:dstPort as seen from the SSH server.
 */
export function openTunnel(cfg: SshConfig, dstHost: string, dstPort: number): Promise<Tunnel> {
  return new Promise((resolve, reject) => {
    const ssh = new Client();
    const sockets = new Set<net.Socket>();
    let server: net.Server | null = null;
    const close = () => { sockets.forEach((s) => s.destroy()); server?.close(); ssh.end(); };

    ssh.on('ready', () => {
      server = net.createServer((sock) => {
        sockets.add(sock); sock.on('close', () => sockets.delete(sock));
        ssh.forwardOut('127.0.0.1', sock.remotePort ?? 0, dstHost, dstPort, (err, stream) => {
          if (err) { sock.destroy(); return; }
          sock.pipe(stream).pipe(sock);
          stream.on('close', () => sock.destroy());
          sock.on('error', () => stream.destroy());
        });
      });
      server.on('error', (e) => { close(); reject(e); });
      server.listen(0, '127.0.0.1', () => resolve({ localPort: (server!.address() as net.AddressInfo).port, close }));
    });
    ssh.on('error', (e) => reject(new Error('SSH tunnel failed: ' + e.message)));
    ssh.on('close', () => server?.close());

    let privateKey: Buffer | undefined;
    try { if (cfg.privateKeyPath) privateKey = fs.readFileSync(cfg.privateKeyPath); }
    catch (e) { reject(new Error('Cannot read the SSH private key file: ' + (e as Error).message)); return; }
    ssh.connect({
      host: cfg.host, port: cfg.port || 22, username: cfg.user,
      password: cfg.password || undefined, privateKey, passphrase: cfg.passphrase || undefined,
      readyTimeout: 10000, keepaliveInterval: 15000,
    });
  });
}
