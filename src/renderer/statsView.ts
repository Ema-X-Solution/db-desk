// Database stats view: size, biggest tables, connections, health, slow queries, last backup. Read-only.
import { bar, bytes, card, duration, el, ago, kv } from './ui.js';

interface Stats {
  version: string; uptimeSec: number | null; sizeBytes: number;
  biggestTables: { schema: string; name: string; sizeBytes: number; rows: number }[];
  connections: { current: number; active: number; idle: number; max: number | null };
  health: { cacheHitPercent: number | null; commits: number; rollbacks: number; deadlocks: number };
  slow: { source: 'history' | 'running'; note: string | null; rows: { query: string; calls: number | null; meanMs: number; totalMs: number | null }[] };
  lastBackup: { at: string; file: string } | null;
}
export interface StatsDeps {
  api: { dbStats(): Promise<Stats> };
  $: <T extends HTMLElement>(id: string) => T;
  guard: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
  showPanel: (id: string) => void;
}

const ms = (n: number) => (n >= 1000 ? (n / 1000).toFixed(1) + ' s' : Math.round(n) + ' ms');
const num = (n: number) => n.toLocaleString('en-US');

export function initStatsView(d: StatsDeps) {
  const { $ } = d;
  const body = $('statsBody');

  function render(s: Stats) {
    body.replaceChildren();
    const grid = el('div', { class: 'cards' });

    const db = card('Database');
    db.append(el('div', { class: 'big' }, bytes(s.sizeBytes)), kv('Version', s.version), kv('Uptime', s.uptimeSec === null ? 'unknown' : duration(s.uptimeSec)));
    db.append(kv('Last backup (made with db-desk)', s.lastBackup ? ago(s.lastBackup.at) : 'none yet'));
    if (s.lastBackup) { const f = el('div', { class: 'muted small' }, s.lastBackup.file); f.title = s.lastBackup.file; db.append(f); }
    grid.append(db);

    const c = card('Connections');
    const pct = s.connections.max ? (s.connections.current / s.connections.max) * 100 : 0;
    c.append(el('div', { class: 'big' }, `${s.connections.current}${s.connections.max ? ' / ' + s.connections.max : ''}`), bar(pct),
      kv('Active now', String(s.connections.active)), kv('Idle', String(s.connections.idle)));
    grid.append(c);

    const h = card('Health');
    h.append(kv('Cache hit rate', s.health.cacheHitPercent === null ? 'n/a' : s.health.cacheHitPercent.toFixed(1) + ' %'),
      kv('Commits', num(s.health.commits)), kv('Rollbacks', num(s.health.rollbacks)), kv('Deadlocks', num(s.health.deadlocks)));
    grid.append(h);

    const t = card('Biggest tables'); t.classList.add('wide2');
    const max = Math.max(1, ...s.biggestTables.map((x) => x.sizeBytes));
    for (const x of s.biggestTables) {
      const row = el('div', { class: 'trow' });
      row.append(el('span', {}, x.schema === 'public' ? x.name : `${x.schema}.${x.name}`), bar((x.sizeBytes / max) * 100, false), el('span', { class: 'muted' }, `${bytes(x.sizeBytes)} · ~${num(x.rows)} rows`));
      t.append(row);
    }
    grid.append(t);

    const q = card(s.slow.source === 'history' ? 'Slow queries (history)' : 'Queries running now'); q.classList.add('wide2');
    if (s.slow.note) q.append(el('div', { class: 'muted small' }, s.slow.note));
    if (!s.slow.rows.length) q.append(el('div', { class: 'muted' }, s.slow.source === 'history' ? 'No queries recorded.' : 'Nothing is running right now.'));
    else {
      const tb = el('table', { class: 'qtable' }); const hr = el('tr');
      ['Query', s.slow.source === 'history' ? 'Calls' : '', s.slow.source === 'history' ? 'Average' : 'Running for', s.slow.source === 'history' ? 'Total' : ''].forEach((x) => hr.append(el('th', {}, x)));
      tb.append(hr);
      for (const r of s.slow.rows) {
        const tr = el('tr'); const qq = el('td', { class: 'qtext' }, r.query.replace(/\s+/g, ' ')); qq.title = r.query;
        tr.append(qq, el('td', {}, r.calls === null ? '' : num(r.calls)), el('td', {}, ms(r.meanMs)), el('td', {}, r.totalMs === null ? '' : ms(r.totalMs))); tb.append(tr);
      }
      q.append(tb);
    }
    grid.append(q);
    body.append(grid);
  }

  async function load() {
    const s = await d.guard(() => d.api.dbStats()); if (s) render(s);
  }
  $('statsRefresh').onclick = load;
  return { show() { d.showPanel('statsView'); body.replaceChildren(el('div', { class: 'muted pad' }, 'Loading…')); load(); }, reset() { body.replaceChildren(); } };
}
