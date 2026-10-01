import { readAccounts, accountOf as poolAccountOf } from "./accounts.mjs";
import { loadConfig } from "./config.mjs";
import { portable } from "./portable";
import { plainReason } from "../shared/plain-reason.mjs";
import type { PaseoApi } from "@getpaseo/client";
import {
  fleetSchema,
  quotaStatusSchema,
  activityRpc,
  bookActivitySchema,
  fleetHostsSchema,
  type Fleet,
  type FleetHosts,
} from "../shared/fleet";
import { readProjects } from "./projects";
import { localCall } from "./management";
import { readBoard } from "./organization";
import { readTaskCatalog } from "./tasks";
import { readNativeHostBindings } from "./host-binding";
import { readSupervisors } from "./supervisors";
import { readOnlyNativeScope } from "./native-scope";
import { observeRemotes, remoteIdentity } from "./remote-observation";
type Call = (method: string, input?: unknown) => Promise<any>;
const text = (v: unknown, fallback = "unknown") =>
  typeof v === "string" ? v.slice(0, 512) : fallback;
const uuid = (v: unknown): v is string =>
  typeof v === "string" && /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(v);
export function bounded<T>(work: Promise<T>, ms = 12000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Observation timed out")), ms);
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
export async function enrollment(call: Call, ms = 12000) {
  const rows = await bounded(call("list"), ms);
  if (
    !Array.isArray(rows) ||
    rows.length > 2048 ||
    rows.some((r) => !uuid(r?.id) || !uuid(r?.task)) ||
    new Set(rows.map((r) => r.id)).size !== rows.length
  )
    throw Error("Enrollment unavailable");
  return rows;
}
// Display only: the native host's background-job count for a local session (MULTIHOST-DESIGN §5.4). Hosts that
// predate the field, or report something malformed, contribute nothing, and the node keeps its old shape.
export function backgroundWork(agent: unknown): { backgroundWork?: { count: number } } {
  const count = (agent as { backgroundWork?: { count?: unknown } } | null | undefined)
    ?.backgroundWork?.count;
  return typeof count === "number" && Number.isInteger(count) && count > 0 && count <= 999
    ? { backgroundWork: { count } }
    : {};
}
/** MH4: the configured hosts and their bindings, from the portable config alone (never the controller). */
export function readFleetHosts(): FleetHosts {
  const bindings = readNativeHostBindings();
  return fleetHostsSchema.parse({
    local: portable.localHost.name,
    hosts: [portable.localHost, ...portable.hosts].map((h) => ({
      name: h.name,
      serverId: bindings[h.name] ?? null,
    })),
  });
}
export function projectActivity(entries: any[]) {
  return entries.slice(-50).map((e, i) => {
    const item = e.item ?? {},
      tool = item.type === "tool_call",
      detail = item.detail ?? {};
    const files =
      tool && ["read", "edit", "write"].includes(detail.type) && typeof detail.filePath === "string"
        ? [text(detail.filePath)]
        : [];
    return {
      id: text(e.id ?? String(e.seqStart ?? i)),
      kind: text(item.type),
      label: tool
        ? text(item.name)
        : item.type === "user_message"
          ? "User instruction"
          : item.type === "assistant_message"
            ? "Assistant response"
            : text(item.type),
      state: tool ? text(item.status) : null,
      files,
    };
  });
}
// J6: the host kills a plugin RPC at 30 s (REQUEST_TIMEOUT_MS in the host's plugins/runtime.ts). Each stage
// below used to take its own 12 s, and they run one after another -- enrollment, the parallel reads, the Book
// observations, the catalogue look-ups -- so a stalled controller could spend 48 s and lose to the host every
// time, leaving the UI with only "unavailable". One budget now covers the whole read: every stage gets what is
// left of it (never more than 12 s), and the optional catalogue look-ups are skipped when under a second is left.
export const FLEET_BUDGET_MS = 16000;
// J6 (J5 walkthrough: "0 working now" while a session was working). Enrollment comes back oldest first, and the
// fleet keeps at most 64 nodes, so `all.slice(0, 64)` silently dropped the NEWEST sessions -- the ones most likely
// to be working -- while the header still counted every enrolled session. The cap stays (it bounds Book reads and
// the payload); which rows fill it is now chosen by what a viewer needs to see: sessions the daemon reports as
// working first, then the most recently active, then the newest enrolled. The chosen rows keep enrollment order.
export const FLEET_NODE_LIMIT = 64;
// J6: the daemon listing was one page of 100 including archived agents; past 100, enrolled sessions silently
// read as "unavailable". Follow the cursor, bounded (5 pages, one stage budget); anything left marks the fleet partial.
// Update-7: ownership on every create path. The parent a session's labels name: a controller create records
// fulcra.parent-session; a create from inside a session (`paseo run`, an MCP create) records paseo.parent-agent-id.
const UUID = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export function labelParent(labels: Record<string, string> | undefined | null): string | null {
  const p = labels?.["fulcra.parent-session"] ?? labels?.["paseo.parent-agent-id"];
  return typeof p === "string" && UUID.test(p) ? p : null;
}
// Pure: given the page's nodes and this host's agents, attach ownership (parent/project/role/account) to local nodes and
// add the sessions a node here started that the controller did not create ("spawned"), with an edge from their parent,
// up to the node limit. Spawned children of spawned children are followed (a lead's worker's worker).
export function attachOwnership(
  nodes: any[],
  edges: any[],
  entries: any[],
  localHost: string,
  accountOf: (id: string) => { name: string; provider: string } | null,
  limit = 64,
) {
  const accountLabel = (id: string) => {
    const account = accountOf(id);
    return account ? { name: account.name, provider: account.provider } : null;
  };
  const byId = new Map(nodes.map((n) => [n.id, n])),
    agents = new Map<string, any>(
      entries
        .filter((e) => typeof e?.agent?.id === "string")
        .map((e) => [e.agent.id as string, e.agent] as [string, any]),
    );
  for (const n of nodes) {
    const a = n.host === localHost ? agents.get(n.id) : null;
    n.origin ??= "enrolled";
    if (a) {
      n.parent ??= labelParent(a.labels);
      n.project ??= UUID.test(a.labels?.["fulcra.project"] ?? "")
        ? a.labels["fulcra.project"]
        : null;
      n.role ??=
        typeof a.labels?.["fulcra.role"] === "string" ? a.labels["fulcra.role"].slice(0, 40) : null;
      n.account = accountLabel(n.id);
    }
    if (
      n.parent &&
      byId.has(n.parent) &&
      !edges.some((e) => e.from === n.parent && e.to === n.id) &&
      edges.length < 128
    )
      edges.push({
        from: n.parent,
        to: n.id,
        active: ["running", "initializing"].includes(n.status),
        state: "owned",
        event: null,
      });
  }
  for (let pass = 0; pass < 3; pass++) {
    for (const a of agents.values()) {
      if (nodes.length >= limit) return;
      const parent = labelParent(a.labels);
      if (!parent || byId.has(a.id) || !byId.has(parent) || a.archivedAt) continue;
      const p = byId.get(parent);
      const n = {
        id: a.id,
        task: p.task,
        host: localHost,
        serverId: p.host === localHost ? (p.serverId ?? null) : null,
        agentId: a.id,
        title: String(a.title ?? "Worker").slice(0, 200),
        provider: String(a.provider ?? "unknown").slice(0, 40),
        model: typeof a.model === "string" ? a.model.slice(0, 200) : null,
        effort:
          typeof (a.effectiveThinkingOptionId ?? a.thinkingOptionId) === "string"
            ? String(a.effectiveThinkingOptionId ?? a.thinkingOptionId).slice(0, 40)
            : null,
        mode: "spawned",
        status: String(a.status ?? "unknown").slice(0, 40),
        pending: Array.isArray(a.pendingPermissions) ? a.pendingPermissions.length : null,
        observedAt: new Date().toISOString(),
        updatedAt: a.updatedAt ?? null,
        error: null,
        parent,
        project: UUID.test(a.labels?.["fulcra.project"] ?? "")
          ? a.labels["fulcra.project"]
          : (p.project ?? null),
        role:
          typeof a.labels?.["fulcra.role"] === "string"
            ? a.labels["fulcra.role"].slice(0, 40)
            : null,
        origin: "spawned",
        account: accountLabel(a.id),
      };
      nodes.push(n);
      byId.set(n.id, n);
      if (edges.length < 128)
        edges.push({
          from: parent,
          to: n.id,
          active: ["running", "initializing"].includes(n.status),
          state: "spawned",
          event: null,
        });
    }
  }
}
export async function listAgents(paseo: PaseoApi, ms: number, pages = 5) {
  const deadline = Date.now() + ms,
    entries: any[] = [];
  let cursor: string | undefined,
    complete = false;
  for (let page = 0; page < pages; page++) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    const r: any = await bounded(
      paseo.agents.list({
        filter: { includeArchived: true },
        page: cursor ? { limit: 100, cursor } : { limit: 100 },
      }),
      left,
    );
    entries.push(...(Array.isArray(r?.entries) ? r.entries : []));
    const next =
      r?.pageInfo?.hasMore === true && typeof r.pageInfo.nextCursor === "string"
        ? r.pageInfo.nextCursor
        : undefined;
    if (!next) {
      complete = true;
      break;
    }
    cursor = next;
  }
  return { entries, complete };
}
export function chooseRows<T extends { id: string; host?: string }>(
  all: T[],
  entries: { agent: { id: string; status?: string; updatedAt?: string | null } }[],
  limit = FLEET_NODE_LIMIT,
): T[] {
  if (all.length <= limit) return all;
  const localHost = portable.localHost.name;
  const native = new Map(entries.map((e) => [e.agent.id, e.agent]));
  const rank = all
    .map((row, index) => {
      const a = row.host === localHost ? native.get(row.id) : undefined;
      return {
        index,
        working: a && ["running", "initializing"].includes(a.status ?? "") ? 0 : 1,
        active: Date.parse(a?.updatedAt ?? "") || 0,
      };
    })
    .sort((x, y) => x.working - y.working || y.active - x.active || y.index - x.index);
  return rank
    .slice(0, limit)
    .map((r) => r.index)
    .sort((a, b) => a - b)
    .map((i) => all[i]);
}
export async function readFleet(
  paseo: PaseoApi,
  call: Call = localCall,
  catalog = readTaskCatalog,
  details = (id: string) => readBoard(undefined, id),
  budgetMs = FLEET_BUDGET_MS,
  input: { search?: string; offset?: number; host?: string; projectId?: string } = {},
  directory = readProjects,
): Promise<Fleet> {
  const deadline = Date.now() + budgetMs,
    left = () => Math.max(0, Math.min(12000, deadline - Date.now()));
  const bindings = readNativeHostBindings();
  const all = await enrollment(call, left());
  const stage = left();
  const [native, roles, board, quotaRead] = await Promise.allSettled([
    listAgents(paseo, stage),
    bounded(call("manager-summary"), stage),
    bounded(catalog(), stage),
    bounded(call("quota-status"), stage),
  ]);
  let quota: ReturnType<typeof quotaStatusSchema.parse> | null = null;
  try {
    if (quotaRead.status === "fulfilled") {
      const value = quotaStatusSchema.parse(quotaRead.value),
        age = Date.now() - Date.parse(value.observedAt);
      if (
        age < -5000 ||
        age > 45000 ||
        new Set(value.entries.map((e) => e.sessionId)).size !== value.entries.length
      )
        throw Error("Quota observation invalid");
      quota = value;
    }
  } catch {
    /* Unsupported, stale or malformed observations remain unknown. */
  }
  const quotaNote = quota
    ? `${quota.partial ? "Partial quota queue observation. " : ""}Saved quota waits; capacity and control are checked again before work resumes. Scheduled checks are not promised restart times.`
    : "Quota queue unavailable or unsupported; no capacity or readiness is inferred.";
  const entries = native.status === "fulfilled" ? native.value.entries : [];
  const projects =
    input.projectId || input.search?.trim()
      ? await bounded(directory(), left()).catch(() => null)
      : null;
  const query = input.search?.trim().toLowerCase() ?? "";
  const eligible = all.filter((row) => {
    const agent = entries.find((e) => e.agent.id === row.id)?.agent;
    const projectId = projects?.membership.find((m) => m.taskId === row.task)?.projectId;
    const task =
      board.status === "fulfilled" ? board.value.tasks.find((t) => t.id === row.task) : null;
    return (
      (!input.host || input.host === "all" || row.host === input.host) &&
      (!input.projectId || projectId === input.projectId) &&
      (!query ||
        [
          row.id,
          row.task,
          row.provider,
          row.title,
          agent?.title,
          agent?.provider,
          task?.title,
          task?.identifier,
          projects?.projects.find((p) => p.id === projectId)?.name,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(query))
    );
  });
  // Rank the entire matching set once, then page it. The old chooseRows order stays on the default page.
  const first = chooseRows(eligible, entries),
    firstIds = new Set(first.map((r) => r.id));
  const ordered = [...first, ...eligible.filter((r) => !firstIds.has(r.id))];
  const offset = input.offset ?? 0,
    rows = ordered.slice(offset, offset + FLEET_NODE_LIMIT);
  const nextOffset = offset + rows.length < eligible.length ? offset + rows.length : null;
  const nodes: Fleet["nodes"] = [];
  // Book reads keep receiver verification and four unsettled calls across refreshes.
  const remotes = rows.filter((r) => r.host !== portable.localHost.name);
  const { values: remote, pending } = await observeRemotes(call, remotes, left());
  for (const row of rows) {
    const host = Object.hasOwn(bindings, row.host) ? row.host : "unknown";
    const a =
      host === portable.localHost.name ? entries.find((e) => e.agent.id === row.id)?.agent : null;
    const raw = remote.get(row.id),
      identityMatches =
        raw &&
        Number.isSafeInteger(row.generation) &&
        uuid(row.remote?.agentId) &&
        remoteIdentity(raw) === remoteIdentity(row);
    const response = identityMatches ? raw : null,
      observation = response?.observed;
    const malformed =
      !!observation &&
      (!["initializing", "idle", "running", "error", "closed"].includes(observation.status) ||
        !Number.isSafeInteger(observation.pending) ||
        observation.pending < 0);
    const o = malformed ? null : observation;
    const age = Date.now() - Date.parse(o?.observedAt),
      staleRemote = !!o && (!Number.isFinite(age) || age > 45000 || age < -5000),
      known = a || (o && !staleRemote);
    nodes.push({
      id: row.id,
      task: row.task,
      host,
      serverId: host === "unknown" ? null : bindings[host],
      quotaObservedAt: quota?.observedAt ?? null,
      quotaWait:
        quota?.entries.find((e) => e.sessionId === row.id && e.taskId === row.task) ?? undefined,
      agentId:
        host === portable.localHost.name
          ? row.id
          : uuid(row.remote?.agentId)
            ? row.remote.agentId
            : null,
      title: text(
        a?.title ?? o?.title,
        host !== portable.localHost.name ? "Remote conversation" : "Saved conversation",
      ),
      provider: text(a?.provider ?? o?.provider ?? row.provider),
      model: typeof (a?.model ?? o?.model) === "string" ? text(a?.model ?? o?.model) : null,
      // U5-D10: the session's reasoning effort as the host reports it (its thinking option); null when not reported.
      effort:
        typeof (a?.effectiveThinkingOptionId ?? a?.thinkingOptionId ?? o?.thinkingOptionId) ===
        "string"
          ? text(a?.effectiveThinkingOptionId ?? a?.thinkingOptionId ?? o?.thinkingOptionId)
          : null,
      mode: text(response?.mode ?? row.mode),
      status: known ? text(a?.status ?? o?.status) : "unavailable",
      pending: a
        ? a.pendingPermissions.length
        : Number.isSafeInteger(o?.pending) && o.pending >= 0
          ? o.pending
          : null,
      observedAt: a ? new Date().toISOString() : o ? text(o.observedAt) : null,
      updatedAt: a?.updatedAt ?? o?.lastUserAt ?? null,
      ...backgroundWork(a),
      error:
        raw && !identityMatches
          ? "Remote session route changed during observation; refresh to inspect current state"
          : malformed
            ? "Remote observation invalid; current state unavailable"
            : staleRemote
              ? "Remote observation is stale or has an invalid timestamp; current state unavailable"
              : known
                ? a?.lastError || o?.lastError
                  ? text(plainReason(a?.lastError ?? o?.lastError))
                  : null
                : host !== portable.localHost.name && pending.has(row.id)
                  ? "Remote observation still in progress; current state unavailable"
                  : host !== portable.localHost.name && !remote.has(row.id)
                    ? "Remote observation not started within this refresh budget; refresh or inspect this session"
                    : "Native observation unavailable; session retained",
    });
  }
  const byId = new Map(nodes.map((n) => [n.id, n])),
    edges: Fleet["edges"] = [];
  // U5-D04: entry by entry; one unreadable record is flagged, the rest are shown.
  const roleRead = readSupervisors(roles.status === "fulfilled" ? roles.value : null);
  const supervisionAvailable = roleRead.available,
    parsedRoles = { data: roleRead.supervisors };
  const supervisors = parsedRoles.data
    .filter((s) => byId.get(s.id)?.task === s.task)
    .map((s) => ({
      ...s,
      workers: s.workers.filter((w) => !w.workerId || byId.get(w.workerId)?.task === s.task),
    }));
  const supervisionIssues = roleRead.issues;
  const roleCoveragePartial =
    supervisionAvailable &&
    (supervisionIssues.unreadable > 0 ||
      supervisionIssues.truncated > 0 ||
      supervisors.length !== parsedRoles.data.length ||
      supervisors.some(
        (s) => s.workers.length !== parsedRoles.data.find((r) => r.id === s.id)!.workers.length,
      ));
  if (roles.status === "fulfilled" && Array.isArray(roles.value))
    for (const s of roles.value.slice(0, 32))
      for (const w of (Array.isArray(s.workers) ? s.workers : []).slice(0, 32)) {
        const parent = byId.get(s.id),
          child = byId.get(w.workerId);
        if (
          parent &&
          child &&
          parent.id !== child.id &&
          parent.task === child.task &&
          parent.task === s.task &&
          edges.length < 128
        )
          edges.push({
            from: parent.id,
            to: child.id,
            active:
              s.active === true &&
              w.phase === "attached" &&
              w.ownership === "linked" &&
              parent.mode === "delegated" &&
              child.mode === "delegated",
            state: text(w.ownership ?? w.phase),
            event: w.lastEvent
              ? text(
                  w.lastEvent.kind +
                    " · " +
                    w.lastEvent.state +
                    (w.lastEvent.consumed ? " · consumed" : ""),
                )
              : null,
          });
      }
  // Update-7: ownership, role and account on every local node; sessions started here that the controller did not create.
  let pool: ReturnType<typeof readAccounts> | null = null;
  try {
    pool = readAccounts((loadConfig() as { home: string }).home);
  } catch {
    pool = null;
  }
  attachOwnership(
    nodes,
    edges,
    entries,
    portable.localHost.name,
    (id) => (pool ? poolAccountOf(pool, id) : null),
    FLEET_NODE_LIMIT,
  );
  const taskIds = [
    ...new Set([
      ...nodes.map((n) => n.task),
      ...(board.status === "fulfilled" ? board.value.tasks.map((t) => t.id) : []),
    ]),
  ];
  const tasks = taskIds.slice(0, 64).map((id) => {
    const b = board.status === "fulfilled" ? board.value.tasks.find((t) => t.id === id) : null;
    return {
      id,
      title: b?.title ? text(b.title) : "Task name unavailable",
      identifier: b?.identifier ?? null,
    };
  });
  // Recover a bounded set of missing catalogue entries by retained UUID.
  if (left() >= 1000)
    await Promise.all(
      tasks
        .filter((t) => !t.identifier)
        .slice(0, 4)
        .map(async (t) => {
          try {
            const b = await bounded(details(t.id), left());
            if (b.available && b.title) {
              t.title = text(b.title);
              t.identifier = b.identifier;
            }
          } catch {
            /* Keep the retained identity available in technical details. */
          }
        }),
    );
  const partial =
    Boolean((input.projectId || query) && (!projects?.available || projects.partial)) ||
    eligible.length > rows.length ||
    (native.status === "fulfilled" && !native.value.complete) ||
    taskIds.length > tasks.length ||
    roleCoveragePartial ||
    nodes.some((n) => n.status === "unavailable") ||
    !supervisionAvailable ||
    board.status === "rejected" ||
    (board.status === "fulfilled" && board.value.partial === true);
  return fleetSchema.parse({
    observedAt: new Date().toISOString(),
    hosts: [portable.localHost.name, ...portable.hosts.map((h) => h.name)],
    total: all.length,
    matching: eligible.length,
    nextOffset,
    partial,
    quotaNote,
    nodes,
    edges,
    tasks,
    supervisors,
    supervisionAvailable,
    supervisionIssues,
    note: `${partial ? "Partial observation. " : ""}Enrolled sessions; 64 per page; Book reads use four concurrent slots and a 12-second refresh budget. ${!supervisionAvailable ? "Supervision unavailable. " : ""}Saved relationships do not imply active delegation. Observations do not wake models.`,
  });
}
export async function readActivity(
  input: { sessionId: string; taskId: string },
  paseo: PaseoApi,
  call: Call = localCall,
) {
  const row = (await enrollment(call)).find(
    (r) => r.id === input.sessionId && r.task === input.taskId,
  );
  if (!row) throw Error("Session is not enrolled in this task");
  // U5-D09: a local session's identity from its native snapshot (read-only); receipts from the controller's
  // activity-receipts read for every host. The controller's `observe` is not a read, so this read-only handler could not
  // call it: every local activity read failed.
  if (row.host === portable.localHost.name)
    await bounded(readOnlyNativeScope(paseo, row)).catch(() => {
      throw Error("Session membership changed");
    });
  let receiptNote = "";
  const receipts = await bounded(call("activity-receipts", input)).catch(() => {
    receiptNote = "Receipt metadata unavailable. ";
    return [];
  });
  let activity: ReturnType<typeof projectActivity> = [],
    observedAt = new Date().toISOString(),
    note =
      "Remote activity unavailable; receipt metadata retained without a native timeline claim.";
  if (row.host === portable.localHost.name) {
    try {
      const p = await bounded(
        paseo.agents.ref(row.id).timeline.refetch({ limit: 50, projection: "canonical" }),
      );
      if (p.error || p.gap || p.reset || p.staleCursor) throw Error("Timeline gap");
      activity = projectActivity(p.entries ?? []);
      note = `${p.hasOlder ? "Latest 50 timeline entries; older history exists. " : ""}${activity.some((e) => e.kind === "tool_call") ? "" : "No tool events in this window; full history coverage is unverified. "}Original native timeline. Tool file paths show reported touches, not independently verified changes. Delivery is not task acceptance.`;
    } catch {
      note = "Native timeline unavailable; receipts retained. No activity is inferred.";
    }
  }
  if (row.host !== portable.localHost.name) {
    try {
      const p = bookActivitySchema.parse(await bounded(call("book-activity", input))),
        age = Date.now() - Date.parse(p.observedAt);
      if (p.sessionId !== row.id || p.taskId !== row.task || p.agentId !== row.remote?.agentId)
        throw Error("Remote activity identity changed");
      if (!Number.isFinite(age) || age < -5000 || age > 45000)
        throw Error("Remote activity observation is stale");
      activity = p.activity;
      observedAt = p.observedAt;
      note = `${!activity.length ? "No summarizable activity in this window; coverage unverified. " : ""}${activity.length && !activity.some((a) => a.kind === "tool_call") ? "No tool events in this window; coverage unverified. " : ""}${p.skippedCount ? `${p.skippedCount} entries excluded from this metadata view. ` : ""}${p.withheldPaths ? `${p.withheldPaths} paths outside the task or display bounds omitted. ` : ""}${p.hasOlder ? "Latest 50 entries; older history exists. " : ""}Tool paths are reported touches, not verified changes. Delivery is not task acceptance.`;
    } catch (error) {
      note =
        error instanceof Error && error.message === "Remote activity observation is stale"
          ? "Remote activity unavailable: clock skew or stale observation; receipts retained. No current activity is inferred."
          : "Book tool activity unavailable or unsupported; receipts retained. No current activity is inferred.";
    }
  }
  const fresh = (await enrollment(call)).find((r) => r.id === row.id && r.task === row.task);
  if (!fresh) throw Error("Session membership changed during observation");
  if (
    row.host !== portable.localHost.name &&
    (fresh.host !== row.host ||
      fresh.generation !== row.generation ||
      fresh.remote?.agentId !== row.remote?.agentId)
  )
    throw Error("Remote session route changed during observation");
  return activityRpc.output.parse({
    observedAt,
    sessionId: row.id,
    taskId: row.task,
    note: receiptNote + note,
    receipts,
    activity,
  });
}
