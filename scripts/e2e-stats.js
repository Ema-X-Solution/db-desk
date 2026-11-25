// Runs the real app under Electron against a throwaway PostgreSQL and saves screenshots.
const { app, safeStorage } = require('electron');
safeStorage.isEncryptionAvailable = () => true; // no OS keyring in CI/headless
safeStorage.encryptString = (s) => Buffer.from(s);
safeStorage.decryptString = (b) => b.toString();
const { startFakeVps } = require('./lib/fake-ssh');
const { execSync } = require('child_process');
const EmbeddedPostgres = require('embedded-postgres').default;
const { BrowserWindow } = require('electron');
const fs = require('fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.setPath('userData', '/tmp/dbdesk-ud'); fs.rmSync('/tmp/dbdesk-ud', { recursive: true, force: true });
app.commandLine.appendSwitch('no-sandbox');
(async () => {
  const pg = new EmbeddedPostgres({ databaseDir: '/tmp/dbdesk-pg-stats', user: 'postgres', password: 'pw', port: 54350, persistent: false, postgresFlags: ['-c', 'shared_preload_libraries=pg_stat_statements'] });
  fs.rmSync('/tmp/dbdesk-pg-stats', { recursive: true, force: true });
  await pg.initialise(); await pg.start(); await pg.createDatabase('demo_erp');
  const { Client } = require('pg');
  const c = new Client({ host: '127.0.0.1', port: 54350, user: 'postgres', password: 'pw', database: 'demo_erp' }); await c.connect();
  await c.query('CREATE EXTENSION pg_stat_statements');
  await c.query(`CREATE TABLE customers(id serial primary key, name text not null, city text)`);
  await c.query(`CREATE TABLE orders(id serial primary key, customer_id int, total numeric(10,2), status text, note text, ordered_at timestamp default now())`);
  await c.query(`CREATE TABLE products(id serial primary key, name text, price numeric(10,2))`);
  await c.query(`INSERT INTO customers(name, city) SELECT 'Customer '||g, (ARRAY['Alexandria','Cairo','Giza'])[g%3+1] FROM generate_series(1,5000) g`);
  await c.query(`INSERT INTO orders(customer_id,total,status,note) SELECT g%5000+1, g*1.5, (ARRAY['paid','pending','shipped'])[g%3+1], repeat('x', 200) FROM generate_series(1,120000) g`);
  await c.query(`INSERT INTO products(name, price) SELECT 'Dress '||g, g FROM generate_series(1,300) g`);
  await c.query('ANALYZE');
  for (let n = 0; n < 4; n++) await c.query(`SELECT c.city, count(*), sum(o.total) FROM orders o JOIN customers c ON c.id = o.customer_id GROUP BY c.city ORDER BY 3 DESC`);
  await c.query(`SELECT count(*) FROM orders WHERE note LIKE '%y%'`);
  await c.query(`SELECT pg_sleep(0.4), count(*) FROM products`);
  for (let n = 0; n < 30; n++) await c.query('SELECT * FROM customers WHERE id = $1', [n + 1]);
  // fake VPS: ssh, nginx log, git clone one commit behind
  const real = Math.floor(Date.now() / 1000), MO = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'], p2 = (x) => String(x).padStart(2, '0');
  const lines = [];
  for (let m = 0; m < 59; m++) { const cnt = 8 + Math.round(10 * Math.abs(Math.sin(m / 6))) + (m < 5 ? 6 : 0); for (let n = 0; n < cnt; n++) {
    const d = new Date((real - m * 60 - n * 2) * 1000); const code = [200,200,200,200,200,304,301,404,500,200][(m + n * 3) % 10];
    lines.push(`41.2.3.${n} - - [${p2(d.getUTCDate())}/${MO[d.getUTCMonth()]}/${d.getUTCFullYear()}:${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} +0000] "GET /api/orders HTTP/1.1" ${code} 512 "-" "Mozilla"`); } }
  fs.writeFileSync('/tmp/demo-nginx.log', lines.reverse().join('\n') + '\n');
  execSync(`rm -rf /tmp/gt && mkdir -p /tmp/gt && cd /tmp/gt && git init -q --bare -b main remote.git && git clone -q remote.git work 2>/dev/null && cd work && git config user.email dev@example.com && git config user.name "Dev Team" && git checkout -q -b main && echo 1 > app.js && git add . && git commit -qm "Fix invoice rounding" && git push -q origin main && cd .. && git clone -q remote.git app && cd work && echo 2 > app.js && git commit -qam "Add customer search to orders page" && git push -q origin main`);
  fs.mkdirSync('/tmp/dbdesk-ud', { recursive: true });
  fs.writeFileSync('/tmp/dbdesk-ud/settings.json', JSON.stringify({ server: { nginxLog: '/tmp/demo-nginx.log', repoPath: '/tmp/gt/app' } }));
  const vps = await startFakeVps(2240);
require('../dist/main/main.js');
  await app.whenReady(); await sleep(1500);
  const win = BrowserWindow.getAllWindows()[0];
  win.webContents.on('console-message', (_e, _l, m) => console.log('[renderer]', m));
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
  const js = (s) => win.webContents.executeJavaScript(s).catch((e) => { console.log('JSFAIL', s.slice(0, 80), e.message); throw e; });
  const shot = async (n) => { await sleep(500); fs.writeFileSync(`/tmp/shots-stats/${n}.png`, (await win.webContents.capturePage()).toPNG()); };
  fs.mkdirSync('/tmp/shots-stats', { recursive: true });
  win.setBounds({ x: 0, y: 0, width: 1280, height: 1150 });
  const click = (id) => js(`document.getElementById('${id}').click()`);
  const btn = (t) => js(`[...document.querySelectorAll('button')].find(b=>b.textContent.startsWith(${JSON.stringify(t)})).click()`);
  await click('newConn'); await sleep(300);
  await js(`(()=>{const cb=[...document.querySelectorAll('#dialog label')].find(l=>l.firstChild.textContent.startsWith('Connect through'));const i=cb.querySelector('input');i.checked=true;i.dispatchEvent(new Event('change'));
    const v={Name:'Demo ERP (fake data)','Host':'127.0.0.1',Port:'54350',Database:'demo_erp',User:'postgres',Password:'pw','SSH host':'127.0.0.1','SSH port':'2240','SSH user':'amr','SSH password':'sshpw'};
    document.querySelectorAll('#dialog label').forEach(l=>{const t=l.firstChild.textContent;const k=Object.keys(v).sort((a,b)=>b.length-a.length).find(k=>t===k||t.startsWith(k+' '));const inp=l.querySelector('input');if(k&&inp&&inp.type!=='checkbox')inp.value=v[k];});})()`);
  await js(`[...document.querySelectorAll('#dialog button')].find(b=>b.textContent.startsWith('Save')).click()`); await sleep(1500);
  await js(`document.querySelector('#connList .item').click()`); await sleep(2500);
  // database backup so "last backup" has a value
  const fsx = require('fs'); const { dialog } = require('electron');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: '/tmp/demo_erp-2026-11-25.sql' });
  try { await js(`window.api.backup()`); } catch (e) { console.log('backup (sandbox pg_dump older than server):', String(e.message).slice(0, 80)); }
  await js(`document.getElementById('openStats').click()`); await sleep(2500); await shot('1-db-stats');
  console.log('STATS', (await js(`document.getElementById('statsBody').innerText`)).replace(/\n+/g, ' | ').slice(0, 600));
  // check the "last backup" line using the real settings code (no screenshot of this, nothing is faked in the shots)
  { const { loadConnections } = require('../dist/main/store'); const { setLastBackup } = require('../dist/main/settings');
    setLastBackup(loadConnections()[0].id, '/tmp/check.sql'); await js(`document.getElementById('statsRefresh').click()`); await sleep(1500);
    console.log('LASTBACKUP', /Last backup[^\n]*\n[^\n]*just now/.test(await js(`document.getElementById('statsBody').innerText`))); fs.rmSync('/tmp/dbdesk-ud/settings.json.bak', { force: true });
    const sp = '/tmp/dbdesk-ud/settings.json'; const st = JSON.parse(fs.readFileSync(sp, 'utf8')); delete st.lastBackups; fs.writeFileSync(sp, JSON.stringify(st)); }
  await js(`document.getElementById('statsRefresh').click()`); await sleep(1200);
  await js(`document.getElementById('openServer').click()`); await sleep(6000); await shot('2-server-status');
  console.log('SERVER', (await js(`document.getElementById('serverBody').innerText`)).replace(/\n+/g, ' | ').slice(0, 900));
  for (let n = 0; n < 6; n++) { await js(`document.getElementById('serverRefresh').click()`); await sleep(1700); }
  await shot('2b-server-status-history');
  await js(`document.getElementById('serverAuto').click()`);
  await btn('Fetch'); await sleep(2500); await shot('3-git-behind');
  await btn('Git pull'); await sleep(500); await shot('4-pull-confirm');
  await js(`[...document.querySelectorAll('#dialog button')].find(b=>b.textContent==='Pull').click()`); await sleep(2500); await shot('5-after-pull');
  console.log('GIT', (await js(`document.querySelector('#serverBody .card:last-child').innerText`)).replace(/\n+/g, ' | '));
  console.log('app.js on server now:', fsx.readFileSync('/tmp/gt/app/app.js', 'utf8').trim());
  console.log('ssh commands run:', vps.log.length, '| any write-like:', vps.log.some((x) => /\brm\b|\bmv\b|>\s*\//.test(x.replace(/2>\/dev\/null|>\/dev\/null|2>&1/g, ''))));
  vps.close(); process.exit(0);
})();
