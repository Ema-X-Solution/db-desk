// The SQL tab: write a script, dry-run it (always rolled back), then run it for real in one transaction.
// Kept out of renderer.ts; it gets the shared UI helpers passed in.

interface StatementResult { command: string; rowCount: number | null; columns: string[]; rows: (string | null)[][]; truncated: boolean }
interface ScriptResult { results: StatementResult[]; committed: boolean }

export interface SqlTabDeps {
  api: { script(sql: string, commit: boolean): Promise<ScriptResult> };
  $: <T extends HTMLElement>(id: string) => T;
  el: (tag: string, attrs?: Record<string, string>, text?: string) => HTMLElement;
  dialog: (build: (box: HTMLElement, close: () => void) => void) => void;
  toast: (msg: string, err?: boolean) => void;
  /** Runs a call, shows errors as a toast and returns undefined on failure. */
  guard: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
  runBackup: () => Promise<void>;
  /** Called after a committed script so the table list and sizes refresh. */
  onCommitted: () => void;
}

export function initSqlTab(d: SqlTabDeps) {
  const { $, el } = d;
  const text = $('sqlText') as HTMLTextAreaElement;
  const dry = $('sqlDry') as HTMLButtonElement;
  const run = $('sqlRun') as HTMLButtonElement;
  const status = $('sqlStatus');
  const out = $('sqlOut');
  /** The exact script text that last passed a dry run. "Run and commit" only works for that text. */
  let dryRunOk: string | null = null;

  const sync = () => {
    run.disabled = dryRunOk === null || dryRunOk !== text.value;
    run.title = run.disabled ? 'Dry run this exact script first' : '';
  };
  text.oninput = () => { sync(); if (dryRunOk !== null && dryRunOk !== text.value) setStatus('Script changed. Dry run it again before committing.', ''); };

  function setStatus(msg: string, cls: '' | 'ok' | 'err') { status.textContent = msg; status.className = 'sqlstatus ' + cls; }

  function render(r: ScriptResult) {
    out.replaceChildren();
    r.results.forEach((s, i) => {
      const isSelect = s.columns.length > 0;
      const head = isSelect
        ? `${s.rowCount ?? s.rows.length} row${s.rowCount === 1 ? '' : 's'} returned${s.truncated ? ` (showing first ${s.rows.length})` : ''}`
        : `${s.command}${s.rowCount === null ? '' : ' · ' + s.rowCount + ' row' + (s.rowCount === 1 ? '' : 's') + ' affected'}`;
      const box = el('div', { class: 'sqlres' });
      box.append(el('div', { class: 'sqlhead' }, `Statement ${i + 1}: ${head}`));
      if (isSelect) {
        const wrap = el('div', { class: 'sqlgrid' }); const t = el('table');
        const tr = el('tr'); s.columns.forEach((c) => tr.append(el('th', {}, c))); t.append(tr);
        for (const row of s.rows) {
          const r2 = el('tr');
          row.forEach((v) => { const td = el('td', v === null ? { class: 'null' } : {}, v === null ? 'NULL' : v); if (v) td.title = v; r2.append(td); });
          t.append(r2);
        }
        wrap.append(t); box.append(wrap);
      }
      out.append(box);
    });
  }

  async function execute(commit: boolean) {
    const sql = text.value;
    dry.disabled = true; run.disabled = true;
    setStatus(commit ? 'Running and committing…' : 'Dry run…', '');
    let failed = false;
    try {
      const r = await d.guard(() => d.api.script(sql, commit));
      if (!r) { failed = true; setStatus('Failed. Nothing was saved: the whole script was rolled back.', 'err'); out.replaceChildren(); return; }
      render(r);
      if (commit) {
        dryRunOk = null;
        setStatus('Committed. All statements were saved.', 'ok');
        d.onCommitted();
      } else {
        dryRunOk = sql;
        setStatus('Dry run OK. Nothing was saved (rolled back). Check the results below, then use "Run and commit…" if they look right.', 'ok');
      }
    } finally { dry.disabled = false; if (failed) dryRunOk = commit ? dryRunOk : null; sync(); }
  }

  function commitDialog() {
    d.dialog((box, close) => {
      box.append(
        el('h3', {}, 'Run and commit this script?'),
        el('div', {}, 'All statements run in one transaction and are saved permanently. If any statement fails, nothing is saved. Take a backup first if you have not.'),
      );
      const l = el('label', {}, 'Type "COMMIT" to confirm'); const input = el('input') as HTMLInputElement; l.append(input); box.append(l);
      const bk = el('button', {}, 'Back up first…'); bk.onclick = () => { close(); d.runBackup(); };
      const no = el('button', {}, 'Cancel'); no.onclick = close;
      const ok = el('button', { class: 'danger' }, 'Run and commit') as HTMLButtonElement; ok.disabled = true;
      input.oninput = () => (ok.disabled = input.value !== 'COMMIT');
      ok.onclick = () => { close(); execute(true); };
      const a = el('div', { class: 'actions' }); a.append(bk, no, ok); box.append(a);
    });
  }

  dry.onclick = () => execute(false);
  run.onclick = () => { if (!run.disabled) commitDialog(); };

  return {
    show() {
      $('welcome').hidden = true; $('view').hidden = true; $('sqlView').hidden = false;
      sync();
    },
    hide() { $('sqlView').hidden = true; },
    /** New connection: clear everything so a script is never run against the wrong database by accident. */
    reset() { text.value = ''; out.replaceChildren(); dryRunOk = null; setStatus('', ''); sync(); },
  };
}
