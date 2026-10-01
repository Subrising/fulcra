// C2 fix #5 (2026-09-26): the host names a workspace after its directory, and every controller session runs in
// tasks/<messageId>, so the Fulcra sidebar showed folder UUIDs ("09290bdc-...") instead of "CC V1b: ...". The host
// already lets a client title a workspace (workspace.title.set); this gives each controller workspace its session's
// title. Never overwrite a title someone chose: only a workspace that is untitled AND still named after a bare UUID
// folder is touched. Best-effort throughout -- naming is cosmetic and must never fail or delay session creation.
const UUID_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_WORKSPACE_TITLE = 120;
const cleanTitle = t => typeof t === 'string' && t.trim() ? t.trim().slice(0, MAX_WORKSPACE_TITLE) : null;

// True when the descriptor still carries the folder-derived UUID name and no title of its own.
export function needsTitle(descriptor) {
  if (!descriptor || (typeof descriptor.title === 'string' && descriptor.title.trim())) return false;
  return typeof descriptor.name === 'string' && UUID_NAME.test(descriptor.name.trim());
}

// The agent's current workspace id and title, from the host's own snapshot.
async function agentIdentity(agents, id) {
  const ref = agents.ref(id); await ref.refresh();
  const snapshot = ref.current();
  return { workspaceId: typeof snapshot?.workspaceId === 'string' ? snapshot.workspaceId : null, title: cleanTitle(snapshot?.title) };
}

// Right after creation: the workspace is new (a fresh tasks/<messageId> folder), so title it outright.
export async function nameNewWorkspace({ agents, daemon }, id, title) {
  const wanted = cleanTitle(title);
  if (!wanted || typeof daemon?.setWorkspaceTitle !== 'function') return { titled: false, reason: 'unsupported' };
  const { workspaceId } = await agentIdentity(agents, id);
  if (!workspaceId) return { titled: false, reason: 'no workspace' };
  await daemon.setWorkspaceTitle(workspaceId, wanted);
  return { titled: true, workspaceId };
}

// Every workspace the host knows, across pages (bounded, so a misbehaving host cannot loop us forever).
async function allWorkspaces(daemon, maxPages = 50) {
  const byId = new Map(); let cursor;
  for (let page = 0; page < maxPages; page += 1) {
    const payload = await daemon.fetchWorkspaces({ page: { limit: 200, ...(cursor ? { cursor } : {}) } });
    for (const w of payload?.entries ?? []) byId.set(w.id, w);
    cursor = payload?.pageInfo?.hasMore ? payload.pageInfo.nextCursor : null;
    if (!cursor) break;
  }
  return byId;
}

// One-off backfill for sessions created before this fix. Each session is independent: one failure is counted and the
// rest continue. Only untitled, UUID-named workspaces are titled, each with its session's current title.
export async function nameExistingWorkspaces({ agents, daemon }, ids) {
  const result = { titled: 0, skipped: 0, failed: 0 };
  if (typeof daemon?.setWorkspaceTitle !== 'function' || typeof daemon?.fetchWorkspaces !== 'function') return { ...result, skipped: ids.length };
  const workspaces = await allWorkspaces(daemon), done = new Set();
  for (const id of ids) {
    try {
      const { workspaceId, title } = await agentIdentity(agents, id);
      if (!workspaceId || !title || done.has(workspaceId) || !needsTitle(workspaces.get(workspaceId))) { result.skipped += 1; continue; }
      await daemon.setWorkspaceTitle(workspaceId, title); done.add(workspaceId); result.titled += 1;
    } catch { result.failed += 1; }
  }
  return result;
}
