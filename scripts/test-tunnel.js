// Starts a throwaway PostgreSQL and a tiny SSH server that only allows forwarding, then connects through the tunnel.
const EmbeddedPostgres = require('embedded-postgres').default;
const { Server } = require('ssh2');
const net = require('net');
const crypto = require('crypto');
const assert = require('assert');
const fs = require('fs');
const { openTunnel } = require('../dist/main/tunnel');
const { PostgresDriver } = require('../dist/main/db/postgres');

(async () => {
  fs.rmSync('/tmp/dbdesk-pg3', { recursive: true, force: true });
  const pg = new EmbeddedPostgres({ databaseDir: '/tmp/dbdesk-pg3', user: 'postgres', password: 'pw', port: 54331, persistent: false });
  await pg.initialise(); await pg.start(); await pg.createDatabase('sales');
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  let forwards = 0;
  const srv = new Server({ hostKeys: [privateKey] }, (client) => {
    client.on('authentication', (ctx) => (ctx.method === 'password' && ctx.username === 'amr' && ctx.password === 'sshpw' ? ctx.accept() : ctx.reject(['password'])));
    client.on('ready', () => client.on('tcpip', (accept, _rej, info) => {
      forwards++;
      const ch = accept(); const s = net.connect(info.destPort, info.destIP);
      ch.pipe(s).pipe(ch); s.on('error', () => ch.close());
    }));
    client.on('error', () => {});
  });
  await new Promise((r) => srv.listen(2222, '127.0.0.1', r));
  try {
    await assert.rejects(openTunnel({ host: '127.0.0.1', port: 2222, user: 'amr', password: 'wrong', privateKeyPath: '', passphrase: '' }, '127.0.0.1', 54331), /SSH tunnel failed/);
    const t = await openTunnel({ host: '127.0.0.1', port: 2222, user: 'amr', password: 'sshpw', privateKeyPath: '', passphrase: '' }, '127.0.0.1', 54331);
    const d = await PostgresDriver.connect({ host: '127.0.0.1', port: t.localPort, user: 'postgres', password: 'pw', database: 'sales', ssl: false });
    assert((await d.databaseSize()) > 0);
    await d.close(); t.close();
    assert(forwards > 0, 'traffic must go through the SSH forward');
    console.log('tunnel test passed, forwarded connections:', forwards);
  } finally { srv.close(); await pg.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
