// Pure model for the live overlay (fleet-live.ts holds the hook). Live state for sessions on other hosts, read by this app over its own host connections (MULTIHOST-DESIGN §5.2).
//
// The Sessions page's rows come from the controller, which reaches other hosts only through its receiver. When
// that path is down (no tailnet), the app may still hold a connection to the host (the relay). This module reads
// the host's own agent list over that connection and lays the result BESIDE the controller's row.
//
// It is display-only. Nothing here becomes an input to an action: the row objects handed to buttons, links and
// the step-through are the controller's rows, unchanged. `liveOverlayIsDisplayOnly` in fleet-live.test.ts holds
// that line.
import type { Fleet } from "../shared/fleet";

type Node = Fleet["nodes"][number];

/** A saved app host, as the plugin client reports it. */
export interface AppHost {
  readonly serverId: string;
  readonly label: string;
  readonly status: string;
}

/** What this app can see of one session on another host. */
export interface LiveState {
  readonly status: string;
  readonly pending?: number;
  readonly accountName?: string | null;
  readonly title: string | null;
  readonly backgroundWorkCount: number;
  readonly updatedAt: string | null;
  /** The host's name as this app knows it; never an id. */
  readonly via: string;
}

export interface LiveOverlay {
  readonly byNode: ReadonlyMap<string, LiveState>;
  /** Hosts this app tried and could not read, by name. */
  readonly unavailable: readonly string[];
}

export const EMPTY_OVERLAY: LiveOverlay = { byNode: new Map(), unavailable: [] };
export const LIVE_READ_BUDGET_MS = 10_000;
const MAX_AGENTS_PER_HOST = 100;

/** A host's name for people: its label, or "Unnamed host" when the label is empty or repeats the id. */
export function appHostName(host: AppHost): string {
  const label = host.label.trim();
  return !label || label === host.serverId ? "Unnamed host" : label;
}

/**
 * Which hosts to read, and for which agents. Only rows on another host with a known server binding and agent id
 * qualify, and only hosts this app has online now. Rows on the controller's own host already carry live state.
 */
export function planLiveReads(
  nodes: readonly Node[],
  hosts: readonly AppHost[],
  localHostName: string | null,
): Map<string, string[]> {
  const online = new Set(hosts.filter((h) => h.status === "online").map((h) => h.serverId));
  const plan = new Map<string, string[]>();
  for (const node of nodes) {
    if (
      node.host === localHostName ||
      !node.serverId ||
      !node.agentId ||
      !online.has(node.serverId)
    )
      continue;
    const agents = plan.get(node.serverId) ?? [];
    if (!agents.includes(node.agentId)) agents.push(node.agentId);
    plan.set(node.serverId, agents);
  }
  return plan;
}

const text = (value: unknown, max = 512): string | null =>
  typeof value === "string" && value.length ? value.slice(0, max) : null;

/** A host's reported background-job count; anything malformed reads as none. */
export function readBackgroundWorkCount(agent: unknown): number {
  const work = (agent as { backgroundWork?: { count?: unknown } } | null)?.backgroundWork;
  const count = work?.count;
  return typeof count === "number" && Number.isInteger(count) && count > 0 && count <= 999
    ? count
    : 0;
}

/**
 * A host's name for the Sessions page: this app's own label for it when it has one, otherwise the
 * Command Centre's configured name with normal capitalisation ("Mini", not "mini"). Never an id.
 */
export function displayHostName(
  name: string,
  serverId: string | null | undefined,
  hosts: readonly AppHost[],
): string {
  const host = serverId ? hosts.find((h) => h.serverId === serverId) : undefined;
  const label = host ? appHostName(host) : "Unnamed host";
  if (label !== "Unnamed host") return label;
  const trimmed = name.trim();
  return trimmed ? trimmed.charAt(0).toLocaleUpperCase("en-GB") + trimmed.slice(1) : "Unnamed host";
}

// The controller's wording when it cannot read a session on another host through its receiver.
const UNREACHABLE = [
  /^Remote observation (unavailable|still in progress|not started)/,
  /^Native observation unavailable/,
];

/** Plain words for "the Command Centre can't reach that host", for rows on another host. Other errors pass through. */
export function plainNodeError(
  error: string | null,
  input: { remote: boolean; hostName: string; hasLiveLine: boolean },
): string | null {
  if (!error) return null;
  if (!input.remote || !UNREACHABLE.some((pattern) => pattern.test(error))) return error;
  return `The Command Centre can't reach ${input.hostName} directly.${input.hasLiveLine ? " The live line above comes from this app." : " Refresh to try again."}`;
}

/** Joins what each host reported to the rows that asked for it. Unknown agents simply get no live state. */
export function matchLiveEntries(
  nodes: readonly Node[],
  reports: ReadonlyMap<string, readonly unknown[]>,
  hostNames: ReadonlyMap<string, string>,
): Map<string, LiveState> {
  const byNode = new Map<string, LiveState>();
  for (const node of nodes) {
    if (!node.serverId || !node.agentId) continue;
    const entries = reports.get(node.serverId);
    if (!entries) continue;
    const found = entries
      .map((e) => (e as { agent?: unknown })?.agent ?? e)
      .find((a) => (a as { id?: unknown })?.id === node.agentId) as
      | Record<string, unknown>
      | undefined;
    if (!found) continue;
    byNode.set(node.id, {
      status: text(found.status, 64) ?? "unknown",
      pending: Array.isArray(found.pendingPermissions)
        ? found.pendingPermissions.length
        : (node.pending ?? 0),
      title: text(found.title),
      ...(text((found.labels as Record<string, unknown> | undefined)?.["fulcra.account-name"], 60)
        ? {
            accountName: text(
              (found.labels as Record<string, unknown> | undefined)?.["fulcra.account-name"],
              60,
            ),
          }
        : {}),
      backgroundWorkCount: readBackgroundWorkCount(found),
      updatedAt: text(found.updatedAt, 64),
      via: hostNames.get(node.serverId) ?? "Unnamed host",
    });
  }
  return byNode;
}

/** The one line a row shows for its live state. */
export function describeLiveState(state: LiveState): string {
  const jobs =
    state.backgroundWorkCount > 0
      ? ` · ${state.backgroundWorkCount} background job${state.backgroundWorkCount === 1 ? "" : "s"}`
      : "";
  const status = state.pending
    ? "Needs you"
    : state.status === "running"
      ? "Working"
      : state.status === "idle"
        ? "Idle"
        : state.status;
  return `Live from this app's link to ${state.via}: ${status}${jobs}${state.accountName ? ` · account ${state.accountName}` : ""}`;
}

/** Display only: a session counts as working when its host says so, live or recorded, or it has background jobs. */
export function isWorkingForDisplay(node: Node, live: LiveState | undefined): boolean {
  if ((live?.pending ?? node.pending ?? 0) > 0) return false;
  if (live) return live.status === "running" || live.backgroundWorkCount > 0;
  return node.status === "running" || readBackgroundWorkCount(node) > 0;
}

export interface AgentsApi {
  agents: { list(options: unknown): Promise<unknown> };
}

function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Live read timed out")), ms);
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/** Reads each planned host once per refresh: one bounded list call per host, failures isolated per host. */
export async function readLiveOverlay(
  nodes: readonly Node[],
  hosts: readonly AppHost[],
  localHostName: string | null,
  client: ((serverId: string) => AgentsApi) | undefined,
  budgetMs = LIVE_READ_BUDGET_MS,
): Promise<LiveOverlay> {
  const plan = planLiveReads(nodes, hosts, localHostName);
  if (!client || plan.size === 0) return EMPTY_OVERLAY;
  const names = new Map(hosts.map((h) => [h.serverId, appHostName(h)] as const));
  const reports = new Map<string, readonly unknown[]>(),
    unavailable: string[] = [];
  await Promise.all(
    [...plan.keys()].map(async (serverId) => {
      try {
        const result = await bounded(
          client(serverId).agents.list({
            filter: { includeArchived: true },
            page: { limit: MAX_AGENTS_PER_HOST },
          }),
          budgetMs,
        );
        const entries = (result as { entries?: unknown })?.entries;
        reports.set(serverId, Array.isArray(entries) ? entries : []);
      } catch {
        unavailable.push(names.get(serverId) ?? "Unnamed host");
      }
    }),
  );
  return { byNode: matchLiveEntries(nodes, reports, names), unavailable: unavailable.sort() };
}

// ---- MH4 (J15): the page must cover every Mac, and never wait forever --------------------------------------

/** The machine switch's "everything" chip: "Both Macs" for two, else "All hosts". */
export function allHostsLabel(hostCount: number): string {
  return hostCount === 2 ? "Both Macs" : "All hosts";
}

export const FLEET_AUTO_RETRY_LIMIT = 3;

export interface FleetReadState {
  kind: "ok" | "loading" | "retrying" | "failed";
  /** Whether the page keeps refetching on its own. False once retries are exhausted: "Try again" restarts them. */
  autoRetry: boolean;
  message: string | null;
}

/**
 * What the page says about its own read. J15 found "Fulcra is not answering yet; retrying" shown forever for a
 * Mac the Command Centre could not read. Retries are bounded: after FLEET_AUTO_RETRY_LIMIT failures in a row the
 * page stops, says so in plain words with the reason, and waits for "Try again".
 */
export function fleetReadState(input: {
  hasData: boolean;
  isError: boolean;
  failures: number;
  hostName: string | null;
  reason: string | null;
}): FleetReadState {
  if (input.hasData) return { kind: "ok", autoRetry: true, message: null };
  const target = input.hostName ? `sessions on ${input.hostName}` : "your sessions";
  if (!input.isError) return { kind: "loading", autoRetry: true, message: `Reading ${target}…` };
  const reason = input.reason ? ` Reason: ${input.reason.slice(0, 160)}.` : "";
  if (input.failures < FLEET_AUTO_RETRY_LIMIT) {
    return {
      kind: "retrying",
      autoRetry: true,
      message: `The Command Centre can't read ${target} right now (attempt ${Math.max(1, input.failures)} of ${FLEET_AUTO_RETRY_LIMIT}); trying again.${reason}`,
    };
  }
  return {
    kind: "failed",
    autoRetry: false,
    message: `The Command Centre can't read ${target} right now. It stopped retrying after ${FLEET_AUTO_RETRY_LIMIT} attempts.${reason}`,
  };
}

export interface FleetHostBinding {
  name: string;
  serverId: string | null;
}

/** Other Macs to list from this app's own link: every non-local bound host, or just the selected one. */
export function appLinkTargets(
  hosts: readonly FleetHostBinding[],
  local: string | null,
  selected: string,
): FleetHostBinding[] {
  return hosts.filter(
    (h) => h.name !== local && h.serverId && (selected === "all" || selected === h.name),
  );
}

export interface AppLinkSession {
  accountName?: string | null;
  agentId: string;
  title: string;
  status: string;
  provider: string | null;
  backgroundWorkCount: number;
  updatedAt: string | null;
}
export interface AppLinkSection {
  hostName: string;
  state: "ok" | "unavailable" | "not-linked";
  sessions: AppLinkSession[];
  /** Plain words for the section's state. */
  note: string;
}

const ID_LIKE = /(?:^|[\\/])[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}[\\/]*$/i;
const STATUS_WORDS: Record<string, string> = {
  running: "Working",
  idle: "Idle",
  closed: "Closed",
  error: "Failed",
  initializing: "Starting",
};

function toAppLinkSession(raw: unknown): AppLinkSession | null {
  const agent = ((raw as { agent?: unknown })?.agent ?? raw) as Record<string, unknown> | null;
  if (!agent || typeof agent.id !== "string") return null;
  const title =
    typeof agent.title === "string" && agent.title.trim() && !ID_LIKE.test(agent.title)
      ? agent.title.trim().slice(0, 200)
      : "Untitled session";
  const status =
    Array.isArray(agent.pendingPermissions) && agent.pendingPermissions.length
      ? "Needs you"
      : typeof agent.status === "string"
        ? (STATUS_WORDS[agent.status] ?? agent.status.slice(0, 32))
        : "Unknown";
  return {
    ...(text((agent.labels as Record<string, unknown> | undefined)?.["fulcra.account-name"], 60)
      ? {
          accountName: text(
            (agent.labels as Record<string, unknown> | undefined)?.["fulcra.account-name"],
            60,
          ),
        }
      : {}),
    agentId: agent.id,
    title,
    status,
    provider: typeof agent.provider === "string" ? agent.provider.slice(0, 32) : null,
    backgroundWorkCount: readBackgroundWorkCount(agent),
    updatedAt: typeof agent.updatedAt === "string" ? agent.updatedAt : null,
  };
}

/**
 * Lists each target Mac's sessions over this app's own link (display only). Sessions the Command Centre already
 * shows (enrolled rows) are left out here; they carry their live line in the task list instead.
 */
export async function readAppLinkSections(
  targets: readonly FleetHostBinding[],
  appHosts: readonly AppHost[],
  client: ((serverId: string) => AgentsApi) | undefined,
  enrolledAgentIds: ReadonlySet<string>,
  budgetMs = LIVE_READ_BUDGET_MS,
): Promise<AppLinkSection[]> {
  return Promise.all(
    targets.map(async (target): Promise<AppLinkSection> => {
      const appHost = appHosts.find((h) => h.serverId === target.serverId);
      const hostName = displayHostName(target.name, target.serverId, appHosts);
      if (!client || !appHost || appHost.status !== "online") {
        return {
          hostName,
          state: "not-linked",
          sessions: [],
          note: `This app has no live link to ${hostName} right now, so its sessions can't be listed here.`,
        };
      }
      try {
        const result = await bounded(
          client(target.serverId!).agents.list({ page: { limit: MAX_AGENTS_PER_HOST } }),
          budgetMs,
        );
        const entries = (result as { entries?: unknown })?.entries;
        const sessions = (Array.isArray(entries) ? entries : [])
          .map(toAppLinkSession)
          .filter((s): s is AppLinkSession => !!s && !enrolledAgentIds.has(s.agentId))
          .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
        return {
          hostName,
          state: "ok",
          sessions,
          note: `From this app's own link to ${hostName}. For reading only.`,
        };
      } catch {
        return {
          hostName,
          state: "unavailable",
          sessions: [],
          note: `This app couldn't read ${hostName}'s sessions just now.`,
        };
      }
    }),
  );
}
