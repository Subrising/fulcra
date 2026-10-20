// One SDK-owned observation per connection lifetime; ordinary watchdog reads do
// not create additional subscriptions. The SDK restores this handle on reconnect.
// FU-423: the observation is also the controller's directory of live (non-archived)
// sessions. One fetch_agents list builds it (the host leaves archived sessions out)
// and its upserts and removes keep it current, so startup and timer passes skip
// archived sessions without a per-agent fetch. While the directory is incomplete
// (no list yet, the observation failed, or more live sessions than one page) every
// id counts as live, which is the behaviour before FU-423.
export const DIRECTORY_PAGE_LIMIT = 200;
// A watchdog pass re-reads a session only when it is running, when the directory shows a change since the
// pass last read it, or when SAFETY_REREAD_MS has passed (a lost update is still caught, only later).
export const SAFETY_REREAD_MS = 10 * 60_000;
const ACTIVE = new Set(["running", "initializing"]);
export function tickDue(native, id, memo, now = Date.now()) {
  const state = native?.liveState?.(id) ?? null,
    last = memo.get(id),
    version = state ? `${state.status}|${state.updatedAt}` : null;
  if (
    state &&
    !ACTIVE.has(state.status) &&
    last?.version === version &&
    now - last.at < SAFETY_REREAD_MS
  )
    return false;
  memo.set(id, { version, at: now });
  return true;
}
export function agentWatch(client) {
  let active = null,
    starting = null,
    closed = false,
    complete = false,
    unsubscribe = () => {},
    stopUpdates = () => {};
  const live = new Map();
  const keep = (agent) => live.set(agent.id, agent);
  const load = (payload) => {
    live.clear();
    for (const entry of payload?.entries ?? [])
      if (entry?.agent?.id && !entry.agent.archivedAt) keep(entry.agent);
    complete = Array.isArray(payload?.entries) && payload.pageInfo?.hasMore !== true;
  };
  return {
    watch() {
      if (closed) return Promise.reject(Error("Agent observer closed"));
      // FU-423: the live observation already carries every change; another list is a wasted request.
      if (active) return Promise.resolve(null);
      return (starting ??= client.agents
        .list({ page: { limit: DIRECTORY_PAGE_LIMIT }, subscribe: {} })
        .then((result) => {
          load(result);
          active = result.subscription;
          stopUpdates();
          stopUpdates =
            client.agents.subscribe?.((update) => {
              if (update?.kind === "upsert" && update.agent?.id) {
                if (update.agent.archivedAt) live.delete(update.agent.id);
                else keep(update.agent);
              } else if (update?.kind === "remove") live.delete(update.agentId ?? update.id);
            }) ?? (() => {});
          unsubscribe = active.subscribe({
            snapshot(payload) {
              if (Array.isArray(payload?.entries)) load(payload);
            },
            update() {},
            error() {
              active = null;
              complete = false;
              unsubscribe();
              stopUpdates();
            },
          });
          return result;
        })
        .finally(() => {
          starting = null;
        }));
    },
    // False only when the complete directory shows the session is archived or gone.
    isLive(id) {
      return !active || !complete || live.has(id);
    },
    // The directory's full snapshot of a live session (the same record fetch_agent returns); null when unknown.
    liveSnapshot(id) {
      return active && complete ? (live.get(id) ?? null) : null;
    },
    // The directory's status, update time and pending permission count for a live session; null when unknown.
    liveState(id) {
      const agent = this.liveSnapshot(id);
      return agent
        ? {
            status: agent.status ?? null,
            updatedAt: agent.updatedAt ?? null,
            pendingPermissions: agent.pendingPermissions?.length ?? 0,
          }
        : null;
    },
    async close() {
      closed = true;
      await starting?.catch(() => {});
      unsubscribe();
      stopUpdates();
      await active?.release();
      active = null;
      complete = false;
    },
  };
}
