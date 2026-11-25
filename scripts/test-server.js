// Server status + git over a fake SSH server (the local machine acts as the VPS).
const assert = require('assert');
const fs = require('fs');
const { execSync } = require('child_process');
const { startFakeVps } = require('./lib/fake-ssh');
const { ServerSession, parseNginx, buildScript } = require('../dist/main/serverStatus');
const { gitInfo, gitFetch, gitPull } = require('../dist/main/gitRepo');

(async () => {
  assert.throws(() => buildScript("/x'; rm -rf /; echo '"), /Invalid nginx log path/);
  assert(!/\b(rm|mv|kill|git|>|tee)\b/.test(buildScript('/var/log/nginx/access.log').replace(/2>\/dev\/null/g, '').replace(/cut -d' ' -f4,5,9/, '')), 'status script must be read-only');

  // nginx parsing with a fixed clock
  const now = Date.UTC(2026, 10, 25, 12, 0, 0) / 1000;
  const ln = (min, code) => { const d = new Date((now - min * 60) * 1000); const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()]; const p = (n) => String(n).padStart(2, '0');
    return `[${p(d.getUTCDate())}/${mo}/${d.getUTCFullYear()}:${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000] ${code}`; };
  const n = parseNginx([ln(0.5, 200), ln(0.2, 404), ln(3, 200), ln(10, 500), ln(59, 301), ln(120, 200), 'garbage'], now, '/x');
  assert.deepEqual([n.last1m, n.last5m, n.last1h], [2, 3, 5]);
  assert.deepEqual(n.classes, { c2xx: 2, c3xx: 1, c4xx: 1, c5xx: 1 });
  assert.equal(n.perMinute.reduce((a, b) => a + b, 0), 4); // 59 min ago is outside the 30 min chart
  assert.equal(parseNginx(['[25/Nov/2026:14:00:00 +0200] 200'], now + 30, '/x').last1m, 1, 'timezone offsets are applied');

  const vps = await startFakeVps(2230);
  const logFile = '/tmp/dbdesk-nginx.log';
  fs.writeFileSync(logFile, [ln(0.1, 200), ln(0.3, 200), ln(2, 502)].map((t) => '1.2.3.4 - - ' + t.replace(']', ']').replace(/\] (\d+)$/, '] "GET /x HTTP/1.1" $1 12 "-" "ua"')).join('\n') + '\n');
  // fix the log to use the real clock (tests above used a fixed one)
  const real = Math.floor(Date.now() / 1000);
  const rl = (secAgo, code) => { const d = new Date((real - secAgo) * 1000); const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()]; const p = (x) => String(x).padStart(2, '0');
    return `1.2.3.4 - - [${p(d.getUTCDate())}/${mo}/${d.getUTCFullYear()}:${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000] "GET /x HTTP/1.1" ${code} 12 "-" "ua"`; };
  fs.writeFileSync(logFile, [rl(5, 200), rl(20, 200), rl(120, 502), rl(400, 404)].join('\n') + '\n');
  try {
    await assert.rejects(ServerSession.open({ ...vps.ssh, password: 'bad' }), /SSH connection failed/);
    const ses = await ServerSession.open(vps.ssh);
    const st = await ses.status(logFile);
    assert(st.mem.total > 0 && st.mem.used > 0 && st.mem.used <= st.mem.total);
    assert(st.cpuPercent >= 0 && st.cpuPercent <= 100); assert(st.cores >= 1); assert(st.uptimeSec > 0);
    assert(st.disks.length >= 1 && st.disks[0].total > 0);
    assert(st.net.rxBytes >= 0 && st.load.length === 3);
    assert.equal(st.nginx.last1h, 4); assert.equal(st.nginx.last5m, 3); assert.equal(st.nginx.last1m, 2); assert.equal(st.nginx.classes.c5xx, 1);
    assert.equal((await ses.status('/tmp/does-not-exist.log')).nginx, 'nolog');
    assert.equal((await ses.status(null)).nginx, null);

    // git: a "remote" and a server clone that is one commit behind
    execSync(`rm -rf /tmp/gt && mkdir -p /tmp/gt && cd /tmp/gt && git init -q --bare -b main remote.git && git clone -q remote.git work 2>/dev/null && cd work && git config user.email a@b.c && git config user.name Tester && git checkout -q -b main && echo 1 > a.txt && git add . && git commit -qm "first" && git push -q origin main && cd .. && git clone -q remote.git app`);
    await assert.rejects(gitInfo(ses, '/tmp/nope-folder'), /not found/);
    await assert.rejects(gitInfo(ses, '/tmp/gt/../etc'), /full folder path/);
    await assert.rejects(gitInfo(ses, "/tmp/gt/app'; echo hi; '"), /full folder path/);
    let g = await gitInfo(ses, '/tmp/gt/app');
    assert.equal(g.branch, 'main'); assert.equal(g.commit.subject, 'first'); assert.equal(g.changed, 0); assert.equal(g.behind, 0); assert.equal(g.ahead, 0);
    execSync(`cd /tmp/gt/work && echo 2 > a.txt && git commit -qam "second change" && git push -q origin main`);
    assert.equal((await gitInfo(ses, '/tmp/gt/app')).behind, 0, 'status alone does not fetch');
    g = await gitFetch(ses, '/tmp/gt/app').then(() => gitInfo(ses, '/tmp/gt/app')); assert.equal(g.behind, 1);
    assert.equal(fs.readFileSync('/tmp/gt/app/a.txt', 'utf8'), '1\n', 'fetch must not change files');
    // dirty repo: pull refused
    fs.writeFileSync('/tmp/gt/app/a.txt', 'local edit\n');
    await assert.rejects(gitPull(ses, '/tmp/gt/app'), /locally changed/);
    assert.equal(fs.readFileSync('/tmp/gt/app/a.txt', 'utf8'), 'local edit\n');
    execSync('cd /tmp/gt/app && git checkout -q a.txt');
    const r = await gitPull(ses, '/tmp/gt/app');
    assert.equal(r.before.behind, 1); assert.equal(r.after.behind, 0); assert.equal(r.after.commit.subject, 'second change');
    assert.equal(fs.readFileSync('/tmp/gt/app/a.txt', 'utf8'), '2\n');
    ses.close();
    // nothing the session ran should write anything
    assert(vps.log.every((c) => !/\brm\b|\bmv\b|\bchmod\b|\bsudo\b/.test(c)));
    console.log('server status + git tests passed');
  } finally { vps.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
