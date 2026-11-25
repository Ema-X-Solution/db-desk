// Server status view: CPU, RAM, disk, network, nginx request counts, and git. Read-only, over the SSH connection.
import { bar, bytes, card, duration, el, kv, spark } from './ui.js';
import { gitCard, GitDeps } from './gitCard.js';

interface Status {
  hostname: string; os: string; uptimeSec: number; cores: number; cpuPercent: number; load: [number, number, number];
  mem: { total: number; used: number; available: number; swapTotal: number; swapUsed: number };
  disks: { mount: string; fs: string; total: number; used: number }[];
  net: { rxBytes: number; txBytes: number; rxRate: number; txRate: number };
  nginx: null | 'nolog' | { path: string; last1m: number; last5m: number; last1h: number; classes: { c2xx: number; c3xx: number; c4xx: number; c5xx: number }; perMinute: number[]; windowShort: boolean };
  takenAt: number;
}
export interface ServerDeps extends GitDeps {
  api: GitDeps['api'] & {
    serverStatus(withNginx: boolean): Promise<Status>; serverClose(): Promise<void>;
    serverSettings(v?: { nginxLog?: string; repoPath?: string }): Promise<{ nginxLog: string; repoPath: string }>;
  };
  $: <T extends HTMLElement>(id: string) => T;
  showPanel: (id: string) => void;
}

const REFRESH_MS = 8000;
const HISTORY = 30;

export function initServerView(d: ServerDeps) {
  const { $ } = d;
  const body = $('serverBody');
  const git = gitCard(d);
  let timer: number | undefined;
  let tick = 0;
  let busy = false;
  let lastNginx: Status['nginx'] = null;
  let cpuHist: number[] = [], rxHist: number[] = [], txHist: number[] = [];
  let last: Status | null = null;

  const rate = (n: number) => bytes(n) + '/s';

  function render(s: Status) {
    body.replaceChildren();
    $('serverTitle').textContent = `Server: ${s.hostname || 'unknown host'}`;
    $('serverSub').textContent = `${s.os} · up ${duration(s.uptimeSec)} · ${s.cores} CPU core${s.cores === 1 ? '' : 's'}`;
    const grid = el('div', { class: 'cards' });

    const cpu = card('CPU');
    cpu.append(el('div', { class: 'big' }, s.cpuPercent.toFixed(0) + ' %'), bar(s.cpuPercent), spark(cpuHist, 100),
      kv('Load average (1 / 5 / 15 min)', s.load.map((x) => x.toFixed(2)).join(' / ')));
    grid.append(cpu);

    const mem = card('Memory');
    const mp = s.mem.total ? (s.mem.used / s.mem.total) * 100 : 0;
    mem.append(el('div', { class: 'big' }, `${bytes(s.mem.used)} / ${bytes(s.mem.total)}`), bar(mp), kv('Available', bytes(s.mem.available)),
      kv('Swap', s.mem.swapTotal ? `${bytes(s.mem.swapUsed)} / ${bytes(s.mem.swapTotal)}` : 'none'));
    grid.append(mem);

    const net = card('Network (all interfaces)');
    net.append(kv('Download now', rate(s.net.rxRate)), spark(rxHist), kv('Upload now', rate(s.net.txRate)), spark(txHist),
      kv('Total received since boot', bytes(s.net.rxBytes)), kv('Total sent since boot', bytes(s.net.txBytes)));
    grid.append(net);

    const disk = card('Disk');
    for (const x of s.disks) {
      const p = x.total ? (x.used / x.total) * 100 : 0;
      disk.append(kv(x.mount, `${bytes(x.used)} / ${bytes(x.total)} (${p.toFixed(0)} %)`), bar(p));
    }
    if (!s.disks.length) disk.append(el('div', { class: 'muted' }, 'No disks reported.'));
    grid.append(disk);

    grid.append(nginxCard(s));
    grid.append(git.element);
    body.append(grid);
  }

  function nginxCard(s: Status) {
    const c = card('nginx requests'); c.classList.add('wide2');
    const n = s.nginx ?? lastNginx;
    if (n === 'nolog' || n === null) {
      c.append(el('div', { class: 'muted' }, n === 'nolog' ? 'No readable nginx access log on this server (looked for the path below), so request counts are not shown.' : 'Loading…'));
      const row = el('div', { class: 'hrow' }); const input = el('input') as HTMLInputElement;
      d.api.serverSettings().then((v) => (input.value = v.nginxLog));
      const save = el('button', {}, 'Save path'); save.onclick = async () => { const ok = await d.guard(async () => { await d.api.serverSettings({ nginxLog: input.value.trim() }); return true; }); if (ok) { lastNginx = null; refresh(true); } };
      row.append(input, save); c.append(row); return c;
    }
    const top = el('div', { class: 'stat3' });
    for (const [label, v] of [['Last minute', n.last1m], ['Last 5 minutes', n.last5m], ['Last hour', n.last1h]] as [string, number][]) {
      const b = el('div'); b.append(el('div', { class: 'big' }, v.toLocaleString('en-US')), el('div', { class: 'muted' }, label)); top.append(b);
    }
    c.append(top, el('div', { class: 'muted small' }, 'Requests per minute, last 30 minutes'), spark(n.perMinute));
    c.append(kv('Last hour by status', `2xx ${n.classes.c2xx} · 3xx ${n.classes.c3xx} · 4xx ${n.classes.c4xx} · 5xx ${n.classes.c5xx}`));
    c.append(el('div', { class: 'muted small' }, `Counted from the end of ${n.path}.` + (n.windowShort ? ' The log tail read does not reach back a full hour, so the hourly count may be low.' : '')));
    return c;
  }

  async function refresh(forceNginx = false) {
    if (busy) return; busy = true;
    try {
      const withNginx = forceNginx || tick % 4 === 0 || lastNginx === null;
      const s = await d.guard(() => d.api.serverStatus(withNginx));
      tick++;
      if (!s) { stop(); body.replaceChildren(el('div', { class: 'sqlstatus err' }, 'Could not read the server. Check the SSH settings of this connection, then press Refresh.')); return; }
      if (s.nginx !== null) lastNginx = s.nginx;
      const push = (a: number[], v: number) => { a.push(v); if (a.length > HISTORY) a.shift(); };
      push(cpuHist, s.cpuPercent); push(rxHist, s.net.rxRate); push(txHist, s.net.txRate);
      last = s; render(s);
    } finally { busy = false; }
  }

  function stop() { if (timer) clearInterval(timer); timer = undefined; d.api.serverClose().catch(() => {}); }
  function start() { if (!timer) timer = window.setInterval(() => refresh(), REFRESH_MS); }
  const auto = $('serverAuto') as HTMLInputElement;
  auto.onchange = () => { if (auto.checked) start(); else { if (timer) clearInterval(timer); timer = undefined; } };
  $('serverRefresh').onclick = () => { refresh(true); git.refresh(); };

  return {
    async show() {
      d.showPanel('serverView');
      cpuHist = []; rxHist = []; txHist = []; lastNginx = null; tick = 0; last = null;
      body.replaceChildren(el('div', { class: 'muted pad' }, 'Connecting over SSH…'));
      await refresh(true); await git.refresh();
      if (auto.checked && last) start();
    },
    /** Called whenever another panel is shown: stops polling and closes the SSH session. */
    stop,
    reset() { body.replaceChildren(); cpuHist = []; rxHist = []; txHist = []; lastNginx = null; },
  };
}
