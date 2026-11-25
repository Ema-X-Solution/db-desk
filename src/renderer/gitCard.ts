// Git card of the Server view: repo status (read-only), Fetch (check for updates) and Pull (behind a confirm dialog).
import { card, el, ago } from './ui.js';

export interface GitInfo {
  path: string; branch: string; upstream: string | null;
  commit: { short: string; full: string; author: string; time: number; subject: string };
  changed: number; untracked: number; ahead: number | null; behind: number | null;
}
export interface GitDeps {
  api: {
    serverSettings(v?: { nginxLog?: string; repoPath?: string }): Promise<{ nginxLog: string; repoPath: string }>;
    gitInfo(): Promise<GitInfo>; gitFetch(): Promise<GitInfo>; gitPull(): Promise<{ output: string; before: GitInfo; after: GitInfo }>;
  };
  guard: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
  toast: (m: string, err?: boolean) => void;
  confirm: (title: string, body: string, okLabel: string) => Promise<boolean>;
}

export function gitCard(d: GitDeps) {
  const box = card('Git on the server'); box.classList.add('wide2');
  const content = el('div');
  box.append(content);
  let info: GitInfo | null = null;
  let lastPull = '';

  async function repoPath() { return (await d.api.serverSettings()).repoPath; }

  function pathRow(current: string) {
    const row = el('div', { class: 'hrow' });
    const input = el('input', { placeholder: 'Repository folder on the server, e.g. /var/www/app' }) as HTMLInputElement; input.value = current;
    const save = el('button', {}, 'Save and check');
    save.onclick = async () => { const ok = await d.guard(async () => { await d.api.serverSettings({ repoPath: input.value.trim() }); return true; }); if (ok) refresh(); };
    row.append(input, save); return row;
  }

  function badge(text: string, cls: string) { return el('span', { class: 'badge ' + cls }, text); }

  function draw(path: string, err?: string) {
    content.replaceChildren(pathRow(path));
    if (err) content.append(el('div', { class: 'sqlstatus err' }, err));
    if (!info) return;
    const i = info;
    const head = el('div', { class: 'gitline' });
    head.append(el('b', {}, i.branch), el('span', { class: 'muted' }, i.upstream ? ` → ${i.upstream}` : ' (no upstream branch)'));
    content.append(head);
    const c = el('div', { class: 'gitline' });
    c.append(el('code', {}, i.commit.short), el('span', {}, ' ' + i.commit.subject), el('span', { class: 'muted' }, `  · ${i.commit.author} · ${ago(i.commit.time)}`));
    content.append(c);
    const badges = el('div', { class: 'gitline' });
    badges.append(i.changed ? badge(`${i.changed} changed file${i.changed === 1 ? '' : 's'}`, 'warn') : badge('clean', 'ok'));
    if (i.untracked) badges.append(badge(`${i.untracked} untracked`, 'muted'));
    if (i.behind === null) badges.append(badge('behind/ahead unknown', 'muted'));
    else {
      badges.append(i.behind ? badge(`${i.behind} behind`, 'warn') : badge('up to date', 'ok'));
      if (i.ahead) badges.append(badge(`${i.ahead} ahead`, 'muted'));
    }
    content.append(badges);
    content.append(el('div', { class: 'muted small' }, '"Behind" is as of the last fetch on the server. Fetch only reads the remote; it does not change the running code.'));
    const actions = el('div', { class: 'hrow' });
    const fetchBtn = el('button', {}, 'Fetch (check for updates)');
    fetchBtn.onclick = async () => { const r = await d.guard(() => d.api.gitFetch()); if (r) { info = r; lastPull = ''; draw(path); d.toast('Fetched. Nothing on the server was changed.'); } };
    const pull = el('button', { class: 'danger' }, 'Git pull…') as HTMLButtonElement;
    pull.disabled = i.changed > 0 || !i.upstream || !i.behind;
    pull.title = i.changed > 0 ? 'The repository has local changes' : !i.upstream ? 'No upstream branch' : !i.behind ? 'Already up to date (fetch first to check)' : '';
    pull.onclick = async () => {
      const ok = await d.confirm('Pull on the server?',
        `This changes the code on the server at ${i.path}: it fast-forwards branch ${i.branch} by ${i.behind} commit${i.behind === 1 ? '' : 's'} (now at ${i.commit.short}). If the app runs from this folder, it will run the new code after its next restart or reload. A pull cannot be undone from here.`, 'Pull');
      if (!ok) return;
      const r = await d.guard(() => d.api.gitPull()); if (!r) return;
      info = r.after; lastPull = `Pulled ${r.before.commit.short} → ${r.after.commit.short}.\n${r.output}`; draw(path); d.toast('Pulled ' + r.after.commit.short);
    };
    actions.append(fetchBtn, pull); content.append(actions);
    if (lastPull) content.append(el('pre', { class: 'gitout' }, lastPull));
  }

  async function refresh() {
    const path = await repoPath();
    if (!path) { info = null; draw(''); content.append(el('div', { class: 'muted' }, 'Enter the folder of the repository on the server to see its git status.')); return; }
    try { info = await d.api.gitInfo(); draw(path); }
    catch (e) { info = null; draw(path, String((e as Error).message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
  }
  return { element: box, refresh };
}
