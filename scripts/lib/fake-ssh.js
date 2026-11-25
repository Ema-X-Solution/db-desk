// A tiny SSH server for tests/demos: password login, runs exec commands with the local shell (this machine plays the "VPS").
const { Server } = require('ssh2');
const crypto = require('crypto');
const { spawn } = require('child_process');

exports.startFakeVps = async (port, { user = 'amr', password = 'sshpw' } = {}) => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const log = [];
  const srv = new Server({ hostKeys: [privateKey] }, (client) => {
    client.on('authentication', (ctx) => (ctx.method === 'password' && ctx.username === user && ctx.password === password ? ctx.accept() : ctx.reject(['password'])));
    client.on('ready', () => {
    client.on('tcpip', (accept, _rej, info) => { const ch = accept(); const s = require('net').connect(info.destPort, info.destIP); ch.pipe(s).pipe(ch); s.on('error', () => ch.close()); });
    client.on('session', (accept) => {
      const session = accept();
      session.on('exec', (acceptExec, _rej, info) => {
        log.push(info.command);
        const stream = acceptExec();
        const p = spawn('sh', ['-c', info.command]);
        p.stdout.pipe(stream); p.stderr.pipe(stream.stderr);
        p.on('close', (code) => { stream.exit(code ?? 0); stream.end(); });
      });
    }); });
    client.on('error', () => {});
  });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  return { close: () => srv.close(), log, ssh: { enabled: true, host: '127.0.0.1', port, user, password, privateKeyPath: '', passphrase: '' } };
};
