// Fulcra J4 commit provenance (CONTRACTS.md §2.2). Reads the project's local repositories with read-only git
// and proposes links; the controller stores them and applies precedence. No network is involved.
//
// A project's repositories are the git worktrees in its member sessions' working folders (the folder itself,
// or one level below it). For each recent commit on HEAD:
//   reported, high   `Fulcra-Session: <id>` / `Fulcra-Task: <id>` trailers naming a KNOWN session or task.
//                    A trailer naming anything else counts as absent.
//   inferred, high   no session trailer, the worktree is inside exactly one session's folder, and the author
//                    time is inside that session's active window. An unknown window never gives high.
//   inferred, medium no task trailer, and the commit is only on branch `cc/<job>` (the task of the session
//                    whose folder holds it) or `job/<task-id>`.
//   inferred, medium the commit subject or branch names a ticket key of a mapped tracker for this repository, or of
//                    a mapped Jira project (any repository): the issue is worked by whoever produced the commit.
import path from 'node:path';
import { gitCommands, parseLog } from './git.mjs';
import { commitRef, repoKey } from '../../shared/cc/connector-rules.mjs';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const WINDOW_SLACK_MS = 10 * 60000;
const slug = name => (name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'repo').replace(/^[^a-z0-9]/, 'r');
const inside = (child, parent) => child === parent || child.startsWith(parent.endsWith('/') ? parent : parent + '/');
// Worktree candidates for one session folder: the folder and its immediate subfolders holding `.git`.
async function candidates(fs, cwd, limit = 24) {
  const out = [cwd];
  try {
    for (const entry of (await fs.readdir(cwd, { withFileTypes: true })).slice(0, 256)) {
      if (out.length > limit) break;
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        try { await fs.access(path.join(cwd, entry.name, '.git')); out.push(path.join(cwd, entry.name)); } catch { /* not a worktree */ }
      }
    }
  } catch { /* unreadable folder: only the folder itself */ }
  return out;
}
export async function scanProject({ projectId, sessions, knownSessions, knownTasks, windows = new Map(), mappings = [], registry, git, fs }) {
  const repos = new Map();
  for (const s of sessions) {
    if (typeof s.cwd !== 'string' || !path.isAbsolute(s.cwd)) continue;
    for (const dir of await candidates(fs, path.resolve(s.cwd))) {
      const top = (await git(dir, gitCommands.toplevel()))?.trim();
      if (!top || repos.has(top)) continue;
      repos.set(top, null);
    }
  }
  const links = new Map(), producersByCommit = new Map();
  const propose = l => { const k = `${l.from}|${l.relation}|${l.to}`, prev = links.get(k); if (!prev || rank(l) > rank(prev)) links.set(k, l); };
  for (const top of repos.keys()) {
    const owners = sessions.filter(s => typeof s.cwd === 'string' && inside(top, path.resolve(s.cwd)));
    const [origin, branchOut, logOut] = await Promise.all([git(top, gitCommands.origin()), git(top, gitCommands.branch()), git(top, gitCommands.log())]);
    const branch = branchOut?.trim() ?? '';
    const unique = branch && branch !== 'HEAD' && /^[A-Za-z0-9._\/-]{1,120}$/.test(branch) ? new Set((await git(top, gitCommands.unique(branch)))?.split('\n').map(s => s.trim()).filter(Boolean) ?? []) : new Set();
    // The repository's ref: the mapped tracker whose remote this clone's origin is, else a local key.
    const matching = mappings.filter(m => registry.get(m.connector)?.matchesOrigin?.(m, origin));
    const key = matching.length ? registry.get(matching[0].connector).repoKeyFor(matching[0]) : repoKey('local', null, `${projectId}/${slug(path.basename(top))}`);
    const branchTask = branchTaskFor(branch, owners, knownTasks);
    // Ticket trackers (Jira) have no repository: their keys count in every repository of the project.
    const keyed = [...matching, ...mappings.filter(m => { const c = registry.get(m.connector); return c && typeof c.matchesOrigin !== 'function' && typeof c.issueRefsIn === 'function'; })];
    for (const c of parseLog(logOut)) {
      const commit = commitRef(key, c.sha), at = Date.parse(c.at), producers = [];
      const trailerSession = c.sessions.find(id => UUID.test(id) && knownSessions.has(id));
      const trailerTask = c.tasks.find(id => UUID.test(id) && knownTasks.has(id));
      if (trailerSession) producers.push({ ref: `session:${trailerSession}`, provenance: 'reported', confidence: 'high', evidence: 'The commit names this session.' });
      else {
        const within = owners.filter(s => { const w = windows.get(s.id); return w && at >= w.from - WINDOW_SLACK_MS && at <= w.to + WINDOW_SLACK_MS; });
        if (within.length === 1) producers.push({ ref: `session:${within[0].id}`, provenance: 'inferred', confidence: 'high', evidence: "The commit was made in this session's folder while it was working." });
      }
      if (trailerTask) producers.push({ ref: `task:${trailerTask}`, provenance: 'reported', confidence: 'high', evidence: 'The commit names this task.' });
      else if (branchTask && unique.has(c.sha)) producers.push({ ref: `task:${branchTask}`, provenance: 'inferred', confidence: 'medium', evidence: "The commit is only on this task's branch." });
      for (const p of producers) propose({ from: p.ref, relation: 'produced', to: commit, provenance: p.provenance, confidence: p.confidence, evidence: p.evidence });
      if (producers.length) producersByCommit.set(commit, producers);
      // Ticket keys in the subject or the branch name: the issue is worked by whoever made the commit.
      // R-E-8: the whole message (subject and body) is scanned. R-E-7: the branch name speaks only for the branch's
      // OWN commits (on no other branch); ancestors shared with main are not attributed to its ticket.
      for (const m of keyed) {
        const connector = registry.get(m.connector);
        const fromBranch = unique.has(c.sha) ? connector.issueRefsIn(m, branch) : [];
        for (const issue of new Set([...connector.issueRefsIn(m, `${c.subject}\n${c.body ?? ''}`), ...fromBranch])) {
          for (const p of producers) propose({ from: issue, relation: 'worked-by', to: p.ref, provenance: 'inferred', confidence: 'medium', evidence: `A commit by this ${p.ref.startsWith('task:') ? 'task' : 'session'} mentions the issue.` });
        }
      }
    }
  }
  return { links: [...links.values()], producersByCommit, repositories: repos.size };
}
function branchTaskFor(branch, owners, knownTasks) {
  const job = /^job\/([0-9a-f-]{36})$/.exec(branch);
  if (job && knownTasks.has(job[1])) return job[1];
  if (!/^cc\/[a-z0-9][a-z0-9-]{0,63}$/.test(branch)) return null;
  const tasks = new Set(owners.map(s => s.task).filter(t => knownTasks.has(t)));
  return tasks.size === 1 ? [...tasks][0] : null;
}
const P = { inferred: 1, reported: 2, manual: 3 }, C = { low: 1, medium: 2, high: 3 };
const rank = l => P[l.provenance] * 10 + C[l.confidence];
// Joins provider-reported links with commit producers: a pull request (or an issue a commit closed) is
// worked by the sessions and tasks that produced its commits. Two facts joined, so it is inferred.
export function chainLinks(itemKey, providerCommits, producersByCommit) {
  const out = new Map();
  for (const commit of providerCommits) {
    for (const p of producersByCommit.get(commit) ?? []) {
      const l = { from: itemKey, relation: 'worked-by', to: p.ref, provenance: 'inferred', confidence: p.confidence, evidence: `Commits ${itemKey.startsWith('pr:') ? 'in this pull request' : 'that closed this issue'} were made by this ${p.ref.startsWith('task:') ? 'task' : 'session'}.` };
      const prev = out.get(p.ref);
      if (!prev || rank(l) > rank(prev)) out.set(p.ref, l);
    }
  }
  return [...out.values()];
}
