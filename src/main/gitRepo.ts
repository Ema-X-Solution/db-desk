// Git on the server, over the existing SSH connection.
// Status is read-only. "Fetch" only updates remote-tracking info. "Pull" is fast-forward only and refuses a dirty repo.
import { ServerSession } from './serverStatus';

export interface GitInfo {
  path: string; branch: string; upstream: string | null;
  commit: { short: string; full: string; author: string; time: number; subject: string };
  /** Modified or staged tracked files / untracked files. */
  changed: number; untracked: number;
  ahead: number | null; behind: number | null;
}

export const validRepoPath = (p: string) => /^\/[\w./-]+$/.test(p) && !p.includes('..');
const q = (p: string) => `'${p}'`;

function sections(out: string): Record<string, string[]> {
  const res: Record<string, string[]> = {}; let cur = '';
  for (const line of out.split('\n')) { const m = line.match(/^##(\w+)$/); if (m) { cur = m[1]; res[cur] = []; } else if (cur) res[cur].push(line); }
  return res;
}

export function parseGitInfo(out: string, path: string): GitInfo {
  const s = sections(out);
  if (s.err) throw new Error(s.err[0] || 'Git failed');
  if (!s.branch || !s.commit || s.commit.length < 5) throw new Error('Could not read the repository (is it a git repository with at least one commit?).');
  const counts = (s.counts?.[0] || '').trim().split(/\s+/).map(Number);
  const hasCounts = counts.length === 2 && counts.every((n) => !isNaN(n));
  const up = (s.upstream?.[0] || '').trim();
  return {
    path, branch: s.branch[0].trim(), upstream: up && up !== 'NONE' ? up : null,
    commit: { short: s.commit[0], full: s.commit[1], author: s.commit[2], time: Number(s.commit[3]), subject: s.commit[4] },
    changed: Number((s.dirty?.[0] || '0').trim()), untracked: Number((s.untracked?.[0] || '0').trim()),
    ahead: hasCounts ? counts[0] : null, behind: hasCounts ? counts[1] : null,
  };
}

export async function gitInfo(ses: ServerSession, path: string): Promise<GitInfo> {
  if (!validRepoPath(path)) throw new Error('Enter the full folder path on the server, for example /var/www/app');
  const cmd = [
    `cd ${q(path)} 2>/dev/null || { echo '##err'; echo 'Folder not found on the server'; exit 0; }`,
    `git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo '##err'; echo 'That folder is not a git repository'; exit 0; }`,
    `echo '##branch'; git rev-parse --abbrev-ref HEAD`,
    `echo '##commit'; git log -1 --format='%h%n%H%n%an%n%ct%n%s'`,
    `echo '##dirty'; git status --porcelain --untracked-files=no | wc -l`,
    `echo '##untracked'; git status --porcelain | grep -c '^??'`,
    `echo '##upstream'; git rev-parse --abbrev-ref '@{u}' 2>/dev/null || echo NONE`,
    `echo '##counts'; git rev-list --left-right --count 'HEAD...@{u}' 2>/dev/null || echo NONE`,
  ].join('\n');
  return parseGitInfo(await ses.run(cmd), path);
}

async function runGit(ses: ServerSession, path: string, args: string): Promise<{ ok: boolean; output: string }> {
  if (!validRepoPath(path)) throw new Error('Invalid repository path');
  const out = await ses.run(`cd ${q(path)} && GIT_TERMINAL_PROMPT=0 timeout 120 git ${args} 2>&1; echo "##exit $?"`);
  const m = out.match(/##exit (\d+)\s*$/);
  return { ok: !!m && m[1] === '0', output: out.replace(/##exit \d+\s*$/, '').trim() };
}

/** Updates the remote-tracking branches only. The working folder and the running code do not change. */
export async function gitFetch(ses: ServerSession, path: string) {
  const r = await runGit(ses, path, 'fetch --quiet');
  if (!r.ok) throw new Error('git fetch failed: ' + (r.output || 'no output'));
}

/** Fast-forward only. Refuses when tracked files have local changes. */
export async function gitPull(ses: ServerSession, path: string): Promise<{ output: string; before: GitInfo; after: GitInfo }> {
  const before = await gitInfo(ses, path);
  if (before.changed > 0) throw new Error(`Not pulled: the server has ${before.changed} locally changed file(s) in that repository. Clean them up on the server first.`);
  if (!before.upstream) throw new Error('Not pulled: this branch has no upstream branch set.');
  const r = await runGit(ses, path, 'pull --ff-only');
  if (!r.ok) throw new Error('git pull failed (nothing was changed by db-desk beyond what git reports): ' + (r.output || 'no output'));
  return { output: r.output, before, after: await gitInfo(ses, path) };
}
