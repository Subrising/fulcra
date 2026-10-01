import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
// DESIGN-R §3.2. What a human needs before resuming a session: which branch it was on and whether it left work
// uncommitted. Read-only and bounded, because it runs from an operator read on a disk that stalls under load:
//
//   - GIT_OPTIONAL_LOCKS=0 so `git status` never takes index.lock (it otherwise refreshes the index and can
//     block, or be blocked by, the session's own git process);
//   - only `status --porcelain=v2 --branch`, never fetch or any network or writing command;
//   - a short timeout and a small output bound per repository, and at most MAX_REPOS repositories: the
//     session directory itself and worktrees placed one level inside it (the job-directory convention).
//
// Nothing here is a verification of what a turn did. It is the local state of the files right now.
export const GIT_ENV = Object.freeze({ GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' });
export const GIT_ARGS = Object.freeze(['status', '--porcelain=v2', '--branch', '--untracked-files=normal']);
const MAX_REPOS = 4, TIMEOUT = 2000, MAX_BUFFER = 262144;
const defaultRun = (dir, args, env) => new Promise((resolve, reject) => {
  execFile('git', ['-C', dir, ...args], { env: { ...process.env, ...env }, timeout: TIMEOUT, maxBuffer: MAX_BUFFER, encoding: 'utf8' },
    (error, stdout) => error ? reject(error) : resolve(stdout));
});
export function parseStatus(text) {
  const out = { branch: null, head: null, upstream: null, ahead: null, behind: null, modified: 0, unmerged: 0, untracked: 0, clean: true };
  for (const line of text.split('\n')) {
    if (line.startsWith('# branch.oid ')) out.head = line.slice(13, 25) === '(initial)' ? null : line.slice(13, 25);
    else if (line.startsWith('# branch.head ')) out.branch = line.slice(14) === '(detached)' ? null : line.slice(14);
    else if (line.startsWith('# branch.upstream ')) out.upstream = line.slice(18);
    else if (line.startsWith('# branch.ab ')) { const [a, b] = line.slice(12).split(' '); out.ahead = Math.abs(Number(a)); out.behind = Math.abs(Number(b)); }
    else if (line.startsWith('1 ') || line.startsWith('2 ')) out.modified++;
    else if (line.startsWith('u ')) out.unmerged++;
    else if (line.startsWith('? ')) out.untracked++;
  }
  out.clean = out.modified === 0 && out.unmerged === 0 && out.untracked === 0;
  return out;
}
// The repositories worth reporting for one session directory. Bounded by MAX_REPOS; hidden and node_modules
// entries are skipped so a directory listing cannot turn into a walk of a dependency tree.
export function candidates(cwd) {
  const dirs = [];
  const isRepo = dir => { try { return fs.existsSync(path.join(dir, '.git')); } catch { return false; } };
  if (isRepo(cwd)) dirs.push(cwd);
  let entries = [];
  try { entries = fs.readdirSync(cwd, { withFileTypes: true }); } catch { return dirs; }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (dirs.length >= MAX_REPOS) break;
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
    const dir = path.join(cwd, e.name);
    if (isRepo(dir)) dirs.push(dir);
  }
  return dirs;
}
export async function repoState(cwd, run = defaultRun) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return { repos: [], note: 'No absolute session directory' };
  const repos = [];
  for (const dir of candidates(cwd)) {
    try { repos.push({ path: dir, ...parseStatus(await run(dir, GIT_ARGS, GIT_ENV)) }); }
    catch (e) { repos.push({ path: dir, error: String(e.message ?? e).slice(0, 200) }); }
  }
  return { repos, note: repos.length ? 'Local working-tree state now, read without locks or network. Not evidence of what a turn completed.' : 'No repository in the session directory or one level inside it' };
}
