import { initSqlTab } from './sqlTab.js';

interface Ssh { enabled: boolean; host: string; port: number; user: string; password: string; privateKeyPath: string; passphrase: string }
interface Conn {ssh?: Ssh;  id: string; name: string; type: 'postgres' | 'mysql' | 'mssql'; host: string; port: number; user: string; password: string; database: string; ssl: boolean }
interface TableInfo { schema: string; name: string; rowEstimate: number; sizeBytes: number }
interface Col { name: string; dataType: string; nullable: boolean; hasDefault: boolean; isPrimaryKey: boolean }
interface TableData { columns: Col[]; rows: Record<string, unknown>[]; total: number }
declare const api: {
  listConnections(): Promise<Conn[]>; saveConnection(c: Conn): Promise<string>; removeConnection(id: string): Promise<void>;
  open(id: string): Promise<{ size: number; tables: TableInfo[] }>; close(): Promise<void>;
  tables(): Promise<{ size: number; tables: TableInfo[] }>;
  data(s: string, t: string, limit: number, offset: number, search?: string): Promise<TableData>;
  insert(s: string, t: string, v: Record<string, string | null>): Promise<void>;
  del(s: string, t: string, key: Record<string, unknown>): Promise<number>;
  script(sql: string, commit: boolean): Promise<{ results: { command: string; rowCount: number | null; columns: string[]; rows: (string | null)[][]; truncated: boolean }[]; committed: boolean }>;
  drop(s: string, t: string): Promise<void>; backup(): Promise<string | null>;
  toolStatus(): Promise<{ tool: string; path: string | null }[]>; pickTool(t: string): Promise<string | null>;
};

const PAGE = 50;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let activeConn: string | null = null;
let current: { schema: string; name: string } | null = null;
let offset = 0;
let data: TableData | null = null;

function el(tag: string, attrs: Record<string, string> = {}, text = '') {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text) e.textContent = text;
  return e;
}
function bytes(n: number) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(i ? 1 : 0) + ' ' + u[i];
}
function toast(msg: string, err = false) {
  const t = $('toast'); t.textContent = msg; t.className = err ? 'err' : ''; t.hidden = false;
  setTimeout(() => (t.hidden = true), err ? 7000 : 3500);
}
async function guard<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try { return await fn(); } catch (e) { toast(String((e as Error).message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true); }
}

function dialog(build: (box: HTMLElement, close: () => void) => void) {
  const box = $('dialog'); box.replaceChildren();
  const close = () => ($('modal').hidden = true);
  build(box, close); $('modal').hidden = false;
}

function confirmDialog(title: string, body: string, okLabel: string, typeToConfirm?: string): Promise<boolean> {
  return new Promise((resolve) => dialog((box, close) => {
    box.append(el('h3', {}, title), el('div', {}, body));
    let input: HTMLInputElement | null = null;
    if (typeToConfirm) {
      const l = el('label', {}, `Type "${typeToConfirm}" to confirm`); input = el('input') as HTMLInputElement; l.append(input); box.append(l);
    }
    const ok = el('button', { class: 'danger' }, okLabel) as HTMLButtonElement;
    const no = el('button', {}, 'Cancel');
    if (input) { ok.disabled = true; input.oninput = () => (ok.disabled = input!.value !== typeToConfirm); }
    ok.onclick = () => { close(); resolve(true); };
    no.onclick = () => { close(); resolve(false); };
    const a = el('div', { class: 'actions' }); a.append(no, ok); box.append(a);
  }));
}

async function renderConns() {
  const list = await api.listConnections();
  const box = $('connList'); box.replaceChildren();
  for (const c of list) {
    const row = el('div', { class: 'item' + (c.id === activeConn ? ' active' : '') });
    row.append(el('span', {}, c.name), el('small', {}, `${{ postgres: 'PG', mysql: 'MySQL', mssql: 'MSSQL' }[c.type]} · ${c.database}`));
    row.onclick = () => openConn(c.id);
    row.oncontextmenu = (ev) => { ev.preventDefault(); connDialog(c); };
    box.append(row);
  }
}

function connDialog(existing?: Conn) {
  dialog((box, close) => {
    box.append(el('h3', {}, existing ? 'Edit connection' : 'New connection'));
    const f: Record<string, HTMLInputElement | HTMLSelectElement> = {};
    const field = (key: string, label: string, type = 'text', value = '') => {
      const l = el('label', {}, label); const i = el('input', { type }) as HTMLInputElement; i.value = value; f[key] = i; l.append(i); return l;
    };
    const typeL = el('label', {}, 'Database type'); const sel = el('select') as HTMLSelectElement;
    const PORTS: Record<string, number> = { postgres: 5432, mysql: 3306, mssql: 1433 };
    for (const [v, n] of [['postgres', 'PostgreSQL'], ['mysql', 'MySQL / MariaDB'], ['mssql', 'SQL Server']]) sel.append(el('option', { value: v }, n));
    sel.value = existing?.type ?? 'postgres'; f.type = sel; typeL.append(sel);
    sel.onchange = () => { f.port.value = String(PORTS[sel.value]); };
    box.append(typeL, field('name', 'Name', 'text', existing?.name ?? ''));
    const r = el('div', { class: 'row' }); r.append(field('host', 'Host', 'text', existing?.host ?? ''), field('port', 'Port', 'number', String(existing?.port ?? PORTS[sel.value]))); box.append(r);
    box.append(field('database', 'Database', 'text', existing?.database ?? ''), field('user', 'User', 'text', existing?.user ?? ''),
      field('password', existing ? 'Password (leave empty to keep)' : 'Password', 'password'));
    const sslL = el('label', {}, 'Use SSL'); const ssl = el('input', { type: 'checkbox' }) as HTMLInputElement; ssl.checked = existing?.ssl ?? false; sslL.append(ssl); box.append(sslL);
    const sshL = el('label', {}, 'Connect through an SSH tunnel'); const sshOn = el('input', { type: 'checkbox' }) as HTMLInputElement;
    sshOn.checked = existing?.ssh?.enabled ?? false; sshL.append(sshOn); box.append(sshL);
    const sshBox = el('div', { class: 'sshbox' }); sshBox.hidden = !sshOn.checked;
    sshBox.append(el('div', { class: 'muted' }, 'Host above is then the address as seen from the SSH server (usually 127.0.0.1).'));
    const sr = el('div', { class: 'row' }); sr.append(field('sshHost', 'SSH host', 'text', existing?.ssh?.host ?? ''), field('sshPort', 'SSH port', 'number', String(existing?.ssh?.port ?? 22)));
    sshBox.append(sr, field('sshUser', 'SSH user', 'text', existing?.ssh?.user ?? ''),
      field('sshPassword', existing?.ssh ? 'SSH password (leave empty to keep)' : 'SSH password', 'password'),
      field('sshKey', 'Or private key file path (optional)', 'text', existing?.ssh?.privateKeyPath ?? ''),
      field('sshPass', 'Key passphrase (optional)', 'password'));
    box.append(sshBox); sshOn.onchange = () => (sshBox.hidden = !sshOn.checked);
    const a = el('div', { class: 'actions' });
    if (existing) { const rm = el('button', { class: 'danger' }, 'Delete'); rm.onclick = async () => { if (await confirmDialog('Delete saved connection?', existing.name + ' will be removed from this computer. The database itself is not touched.', 'Delete')) { await api.removeConnection(existing.id); close(); renderConns(); } }; a.append(rm); }
    const cancel = el('button', {}, 'Cancel'); cancel.onclick = close;
    const save = el('button', { class: 'primary' }, 'Save & connect');
    save.onclick = async () => {
      const c: Conn = { id: existing?.id ?? '', name: f.name.value || f.host.value, type: sel.value as Conn['type'], host: f.host.value, port: Number(f.port.value) || PORTS[sel.value], user: f.user.value, password: f.password.value, database: f.database.value, ssl: ssl.checked,
        ssh: { enabled: sshOn.checked, host: f.sshHost.value, port: Number(f.sshPort.value) || 22, user: f.sshUser.value, password: f.sshPassword.value, privateKeyPath: f.sshKey.value, passphrase: f.sshPass.value } };
      const id = await guard(() => api.saveConnection(c)); if (!id) return;
      close(); await renderConns(); openConn(id);
    };
    a.append(cancel, save); box.append(a);
  });
}

function renderTables(info: { size: number; tables: TableInfo[] }) {
  $('tablesBox').hidden = false;
  $('dbInfo').textContent = `Database size: ${bytes(info.size)} · ${info.tables.length} tables`;
  const box = $('tableList'); box.replaceChildren();
  for (const t of info.tables) {
    const row = el('div', { class: 'item' + (current && current.schema === t.schema && current.name === t.name ? ' active' : '') });
    row.append(el('span', {}, t.schema === 'public' ? t.name : `${t.schema}.${t.name}`), el('small', {}, bytes(t.sizeBytes)));
    row.onclick = () => { current = { schema: t.schema, name: t.name }; offset = 0; ($('search') as HTMLInputElement).value = ''; sqlTab.hide(); loadTable(); renderTables(info); };
    box.append(row);
  }
  const bk = el('button', { class: 'wide' }, 'Backup database…'); bk.style.marginTop = '10px';
  bk.onclick = () => runBackup();
  const bt = el('button', { class: 'wide link' }, 'Backup tool path…'); bt.style.marginTop = '6px';
  bt.onclick = () => toolDialog();
  box.append(bk, bt);
}

async function runBackup() {
  try {
    const p = await api.backup();
    if (p) toast('Backup saved: ' + p);
  } catch (e) {
    const msg = String((e as Error).message || e);
    const m = msg.match(/TOOL_NOT_FOUND:(pg_dump|mysqldump)/);
    if (m) toolDialog(m[1], true); else toast(msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true);
  }
}

/** Shows where the dump tools were found and lets the user pick one with a file dialog. */
async function toolDialog(missing?: string, retry = false) {
  const status = await api.toolStatus();
  dialog((box, close) => {
    box.append(el('h3', {}, missing ? `${missing} was not found` : 'Backup tools'));
    if (missing) box.append(el('div', {}, `db-desk looked in PATH and the usual install folders (PostgreSQL, pgAdmin 4). Choose the file yourself, for example pgAdmin 4\\runtime\\${missing}.exe.`));
    for (const s of status) {
      const row = el('div', { class: 'toolrow' });
      row.append(el('div', {}, s.tool), el('div', { class: 'muted' }, s.path ?? 'not found'));
      const pick = el('button', {}, 'Choose file…');
      pick.onclick = async () => {
        const p = await guard(() => api.pickTool(s.tool)); if (!p) return;
        close(); toast(`${s.tool}: ${p}`); if (retry && s.tool === missing) runBackup(); else toolDialog();
      };
      row.append(pick); box.append(row);
    }
    const a = el('div', { class: 'actions' }); const c = el('button', {}, 'Close'); c.onclick = close; a.append(c); box.append(a);
  });
}

async function openConn(id: string) {
  const info = await guard(() => api.open(id)); if (!info) return;
  sqlTab.reset(); sqlTab.hide(); activeConn = id; current = null; $('view').hidden = true; $('welcome').hidden = false; $('welcome').textContent = 'Connected. Pick a table.';
  renderTables(info); renderConns();
}

function cellText(v: unknown) {
  if (v === null || v === undefined) return null;
  if (v instanceof Object) return JSON.stringify(v);
  return String(v);
}

async function loadTable() {
  if (!current) return;
  const term = ($('search') as HTMLInputElement).value.trim();
  const d = await guard(() => api.data(current!.schema, current!.name, PAGE, offset, term || undefined)); if (!d) return;
  data = d;
  $('welcome').hidden = true; $('view').hidden = false;
  $('title').textContent = `${current.schema}.${current.name}  (${d.total} rows${term ? ' matching "' + term + '"' : ''})`;
  const grid = $('grid'); grid.replaceChildren();
  const head = el('tr');
  for (const c of d.columns) { const th = el('th', {}, (c.isPrimaryKey ? '[PK] ' : '') + c.name); th.append(el('small', {}, c.dataType)); head.append(th); }
  head.append(el('th'));
  grid.append(head);
  for (const r of d.rows) {
    const tr = el('tr');
    for (const c of d.columns) {
      const t = cellText(r[c.name]);
      const td = el('td', t === null ? { class: 'null' } : {}, t === null ? 'NULL' : t); if (t) td.title = t; tr.append(td);
    }
    const td = el('td'); const del = el('button', { class: 'danger' }, 'Delete'); del.onclick = () => deleteRow(r); td.append(del); tr.append(td); grid.append(tr);
  }
  $('pageInfo').textContent = `${d.total ? offset + 1 : 0}–${Math.min(offset + PAGE, d.total)} of ${d.total}`;
  ($('prev') as HTMLButtonElement).disabled = offset === 0;
  ($('next') as HTMLButtonElement).disabled = offset + PAGE >= d.total;
}

async function deleteRow(row: Record<string, unknown>) {
  if (!current || !data) return;
  const pk = data.columns.filter((c) => c.isPrimaryKey);
  if (!pk.length) { toast('This table has no primary key, so rows cannot be deleted safely.', true); return; }
  const key: Record<string, unknown> = {}; pk.forEach((c) => (key[c.name] = row[c.name]));
  const label = pk.map((c) => `${c.name} = ${cellText(row[c.name])}`).join(', ');
  if (!(await confirmDialog('Delete this row?', `${current.schema}.${current.name} where ${label}. This cannot be undone.`, 'Delete row'))) return;
  if ((await guard(() => api.del(current!.schema, current!.name, key))) !== undefined) { toast('Row deleted'); loadTable(); refreshTables(); }
}

function addRowDialog() {
  if (!current || !data) return;
  const cols = data.columns;
  dialog((box, close) => {
    box.append(el('h3', {}, `Add row to ${current!.name}`), el('div', { class: 'muted' }, 'Leave a field empty to use its default. Tick NULL to insert NULL.'));
    const inputs: { c: Col; i: HTMLInputElement; n: HTMLInputElement }[] = [];
    for (const c of cols) {
      const l = el('label', {}, `${c.name}  (${c.dataType}${c.nullable ? '' : ', required'}${c.hasDefault ? ', has default' : ''})`);
      const row = el('div', { class: 'row' }); const i = el('input') as HTMLInputElement;
      const n = el('input', { type: 'checkbox' }) as HTMLInputElement; n.style.flex = '0 0 auto'; n.title = 'NULL'; n.disabled = !c.nullable;
      row.append(i, n); l.append(row); box.append(l); inputs.push({ c, i, n });
    }
    const cancel = el('button', {}, 'Cancel'); cancel.onclick = close;
    const ok = el('button', { class: 'primary' }, 'Insert');
    ok.onclick = async () => {
      const v: Record<string, string | null> = {};
      for (const { c, i, n } of inputs) { if (n.checked) v[c.name] = null; else if (i.value !== '') v[c.name] = i.value; }
      const done = await guard(async () => { await api.insert(current!.schema, current!.name, v); return true; });
      if (!done) return;
      toast('Row added');
      close(); loadTable(); refreshTables();
    };
    const a = el('div', { class: 'actions' }); a.append(cancel, ok); box.append(a);
  });
}

async function refreshTables() { const i = await guard(() => api.tables()); if (i) renderTables(i); }

const sqlTab = initSqlTab({ api, $, el, dialog, toast, guard, runBackup, onCommitted: () => { refreshTables(); } });
$('openSql').onclick = () => sqlTab.show();
$('newConn').onclick = () => connDialog();
$('addRow').onclick = addRowDialog;
$('refresh').onclick = () => { loadTable(); refreshTables(); };
let searchTimer: number | undefined;
$('search').oninput = () => { clearTimeout(searchTimer); searchTimer = window.setTimeout(() => { offset = 0; loadTable(); }, 300); };
$('prev').onclick = () => { offset = Math.max(0, offset - PAGE); loadTable(); };
$('next').onclick = () => { offset += PAGE; loadTable(); };
$('dropTable').onclick = async () => {
  if (!current) return;
  const c = current;
  if (!(await confirmDialog('Drop table?', `This permanently deletes ${c.schema}.${c.name} and all its rows. Take a backup first if you are not sure.`, 'Drop table', c.name))) return;
  const done = await guard(async () => { await api.drop(c.schema, c.name); return true; });
  if (done) { toast('Table dropped'); current = null; $('view').hidden = true; $('welcome').hidden = false; refreshTables(); }
};
renderConns();
