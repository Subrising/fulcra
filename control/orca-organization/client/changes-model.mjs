import { parseRef } from '../shared/cc/refs.mjs';
const WINDOW = 14 * 86400000;
export function recentPullRequests(entries, now = Date.now()) {
  return entries.filter(entry => {
    if (entry.item.kind !== 'pr' || parseRef(entry.item.key)?.kind !== 'pr') return false;
    if (entry.item.state === 'open') return true;
    if (entry.item.state !== 'merged') return false;
    const merged = entry.trail.find(step => step.kind === 'state' && step.label.toLowerCase() === 'merged')?.at;
    const at = Date.parse(merged ?? '');
    return Number.isFinite(at) && at >= now - WINDOW && at <= now;
  });
}
function repository(url) {
  if (typeof url !== 'string') return null;
  const ssh = /^(?:[^@\s]+@)([^:\s]+):(.+)$/.exec(url);
  try {
    const parsed = new URL(ssh ? `ssh://${ssh[1]}/${ssh[2]}` : url);
    if (!['https:', 'http:', 'ssh:'].includes(parsed.protocol)) return null;
    return `${parsed.hostname.toLowerCase()}${parsed.pathname.replace(/\/$/, '').replace(/\.git$/, '')}`;
  } catch { return null; }
}
// U5-D12: each pull request's state is decided up front, not on a click. `ready` names the workspace to open; a PR
// whose repository no served workspace has as its `origin` is `no-checkout` (the view offers to add, or pick, that
// checkout's folder: a GitHub remote not named `origin` is resolved by the host, D07); a PR row that does not name
// its own repository consistently is `unreadable`. `chosen` maps a repository to the workspace the person picked.
export function changeTarget(item, workspaces, chosen = new Map()) {
  const ref = parseRef(item.key);
  if (ref?.kind !== 'pr') return { state: 'unreadable' };
  let url;
  try { url = new URL(item.url); } catch { return { state: 'unreadable' }; }
  const match = /^([^:@]+)(?:@([^:]+))?:(.+)$/.exec(ref.repoKey);
  const site = match?.[2] ?? ({ github: 'github.com', bitbucket: 'bitbucket.org' })[match?.[1]];
  if (!match || !site) return { state: 'unreadable' };
  const suffix = /\/(?:pull|pull-requests)\/(\d+)\/?$/.exec(url.pathname);
  if (!suffix || Number(suffix[1]) !== ref.number) return { state: 'unreadable' };
  const repo = `${site.toLowerCase()}/${match[3]}`;
  if (repository(url.origin + url.pathname.slice(0, suffix.index)) !== repo) return { state: 'unreadable' };
  const matches = workspaces.filter(workspace => repository(workspace.gitRuntime?.remoteUrl) === repo);
  // Multiple checkouts of the same repository are equivalent for committed reads. Prefer its root checkout.
  const workspace = matches.find(w => w.workspaceKind !== 'worktree') ?? matches[0]
    ?? workspaces.find(w => w.id === chosen.get(repo));
  return workspace ? { state: 'ready', repo, workspaceId: workspace.id, pullRequest: ref.number } : { state: 'no-checkout', repo, pullRequest: ref.number };
}
export function changeDestination(item, workspaces) {
  const target = changeTarget(item, workspaces);
  return target.state === 'ready' ? { workspaceId: target.workspaceId, pullRequest: target.pullRequest } : null;
}
// The folder a person types to add (or pick) a checkout: a host path, never a URL.
export function checkoutFolder(text) {
  const folder = typeof text === 'string' ? text.trim() : '';
  if (!folder || folder.length > 1024 || /[\u0000-\u001f]/.test(folder)) return null;
  return /^(?:\/|~\/|~$|[A-Za-z]:[\\/])/.test(folder) ? folder : null;
}
// Why adding a folder failed, in words a person can act on. A read-only device may not add workspaces.
export function addFolderProblem(error) {
  const text = String(error?.message ?? error ?? '');
  if (/permission|not authori[sz]ed|forbidden|read-only|workspace\.manage/i.test(text)) return 'This device cannot add workspaces on this host. On the host, add the folder in Fulcra with Add project, then come back.';
  if (/not a directory|no such file|does not exist|ENOENT|not found/i.test(text)) return 'That folder does not exist on this host. Check the path, then try again.';
  return 'That folder could not be added. Check the path, then try again.';
}

export async function readChangeWorkspaces(list) {
  const entries = [], cursors = new Set();
  let cursor;
  do {
    const page = await list({ page: { limit: 200, ...(cursor ? { cursor } : {}) } });
    entries.push(...page.entries);
    if (!page.pageInfo?.hasMore) return { entries };
    cursor = page.pageInfo.nextCursor;
    if (!cursor || cursors.has(cursor)) throw new Error('Workspace list is incomplete.');
    cursors.add(cursor);
  } while (cursors.size < 50);
  throw new Error('Workspace list is too large.');
}
