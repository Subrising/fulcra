// "Who is in charge": the sessions the fleet read returned, as a tree in plain words. You direct the main assistant,
// main assistants lead project leads, and leads run workers. Each card says its role, one of five plain states and
// what it is doing now. Roles come from recorded seats first, then the session's own role label, then its shape
// (a session with workers is a lead). Nothing here is guessed from timing, and nothing calls a model.
import type { Fleet } from "../shared/fleet";

type FleetNode = Fleet["nodes"][number];

export type TeamRole = "main" | "lead" | "worker";
export type TeamState = "waiting" | "working" | "paused" | "idle" | "offline";

export interface TeamCard {
  /** The session id, or `offline:<host>` for a merged offline computer. */
  id: string;
  role: TeamRole;
  roleLabel: string;
  title: string;
  state: TeamState;
  stateLabel: string;
  /** One sentence: what it is doing now. */
  now: string;
  host: string;
  serverId: string | null;
  agentId: string | null;
  /** "Claude · Opus 5.5", when the host recorded it. */
  runs: string | null;
  /** No reporting line is recorded for this chat (Fulcra 0.2.8): the Team map marks it. */
  noLine: boolean;
  /** The title of the one chat this chat may also message directly. */
  directLink: string | null;
  /** How many sessions a merged offline card stands for; 1 otherwise. */
  sessions: number;
  children: TeamCard[];
}

export interface TeamTree {
  roots: TeamCard[];
  counts: Record<TeamState, number>;
  /** "2 working · 1 waiting for you · 1 offline", or "No sessions yet". */
  summary: string;
}

export interface TeamTreeInput {
  nodes: readonly FleetNode[];
  edges?: Fleet["edges"];
  /** Sessions bound to a prime seat. */
  mainSessionIds?: ReadonlySet<string>;
  /** Sessions bound to a project-orchestrator seat. */
  leadSessionIds?: ReadonlySet<string>;
  projectNames?: ReadonlyMap<string, string>;
  /** The main assistant every view shows (Fulcra 0.2.8): leads without a recorded leader sit under it. */
  mainSessionId?: string | null;
  /** Each project's lead: the project's workers without a recorded leader sit under it. */
  leadByProject?: ReadonlyMap<string, string>;
  /** Hosts this app could not reach, by name. */
  offlineHosts?: ReadonlySet<string>;
  /** For "checks again at 14:20"; injected so tests are stable. */
  formatTime?: (iso: string) => string;
}

const STATE_ORDER: Record<TeamState, number> = {
  waiting: 0,
  working: 1,
  paused: 2,
  idle: 3,
  offline: 4,
};
export const STATE_LABEL: Record<TeamState, string> = {
  waiting: "Waiting for you",
  working: "Working",
  paused: "Paused",
  idle: "Idle",
  offline: "Offline",
};
const OFFLINE_STATUSES = new Set(["unavailable", "unreachable", "offline", "disconnected"]);
const PROVIDERS: Record<string, string> = { claude: "Claude", codex: "Codex" };

const defaultTime = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

export function stateOf(node: FleetNode, offlineHosts: ReadonlySet<string> = new Set()): TeamState {
  if ((node.pending ?? 0) > 0) return "waiting";
  if (node.quotaWait) return "paused";
  if (offlineHosts.has(node.host) || OFFLINE_STATUSES.has(node.status)) return "offline";
  if (node.status === "running" || (node.backgroundWork?.count ?? 0) > 0) return "working";
  return "idle";
}

function nowSentence(
  node: FleetNode,
  state: TeamState,
  formatTime: (iso: string) => string,
): string {
  const title = node.title.trim() || "its task";
  switch (state) {
    case "waiting":
      return (node.pending ?? 0) > 1
        ? `Has ${node.pending} questions for you about ${title}`
        : `Has a question for you about ${title}`;
    case "paused": {
      const wait = node.quotaWait!;
      const why = wait.reason === "verification" ? "account check" : "usage limit";
      return wait.nextCheckAt
        ? `Paused: ${why}, checks again at ${formatTime(wait.nextCheckAt)}`
        : `Paused: ${why}`;
    }
    case "offline":
      return `Its computer, ${node.host}, can't be reached right now`;
    case "working": {
      const jobs = node.backgroundWork?.count ?? 0;
      return node.status === "running"
        ? `Working on ${title}`
        : `Running ${jobs} background job${jobs === 1 ? "" : "s"} for ${title}`;
    }
    default:
      return `Finished its last message on ${title}`;
  }
}

// Claude model ids as people say them: "claude-haiku-4-5" or "claude-opus-4-1-20250805" become "Haiku 4.5" and
// "Opus 4.1". Anything else (already friendly, or another provider's id) is shown as it is.
const CLAUDE_ID = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/;
export function modelLabel(model: string): string {
  const m = CLAUDE_ID.exec(model);
  if (!m) return model;
  const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1);
  return `${family} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
}

function runsLabel(node: FleetNode): string | null {
  const provider = PROVIDERS[node.provider] ?? (node.provider || null);
  if (!provider) return null;
  return node.model ? `${provider} · ${modelLabel(node.model)}` : provider;
}

export function buildTeamTree(input: TeamTreeInput): TeamTree {
  const offlineHosts = input.offlineHosts ?? new Set<string>();
  const formatTime = input.formatTime ?? defaultTime;
  const byId = new Map(input.nodes.map((node) => [node.id, node]));
  const parentOf = new Map<string, string>();
  const main = input.mainSessionId && byId.has(input.mainSessionId) ? input.mainSessionId : null;
  // The recorded reporting line wins: the main assistant role is whoever holds it now.
  for (const node of input.nodes) {
    const line = node.reportsTo === "role:main-assistant" ? main : node.reportsTo?.split("@", 1)[0];
    if (line && byId.has(line) && line !== node.id) parentOf.set(node.id, line);
  }
  const recorded = (node: FleetNode) => Boolean(node.reportsTo || node.parent);
  for (const node of input.nodes)
    if (!parentOf.has(node.id) && node.parent && byId.has(node.parent) && node.parent !== node.id)
      parentOf.set(node.id, node.parent);
  for (const edge of input.edges ?? [])
    if (!parentOf.has(edge.to) && byId.has(edge.from) && byId.has(edge.to) && edge.from !== edge.to)
      parentOf.set(edge.to, edge.from);
  // The team as it was set up: a lead answers to the main assistant, a worker to its project's lead. Recorded
  // supervision above wins; this only places chats that have no recorded leader.
  for (const node of input.nodes) {
    if (parentOf.has(node.id) || node.id === main || input.mainSessionIds?.has(node.id)) continue;
    if (input.leadSessionIds?.has(node.id)) {
      if (main) parentOf.set(node.id, main);
      continue;
    }
    const lead = node.project ? input.leadByProject?.get(node.project) : undefined;
    if (lead && lead !== node.id && byId.has(lead)) parentOf.set(node.id, lead);
  }
  const childrenOf = new Map<string, string[]>();
  for (const [child, parent] of parentOf)
    childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), child]);

  const roleOf = (node: FleetNode): TeamRole => {
    if (input.mainSessionIds?.has(node.id) || node.role === "prime") return "main";
    if (
      input.leadSessionIds?.has(node.id) ||
      node.role === "project-orchestrator" ||
      node.role === "lead" ||
      (childrenOf.get(node.id)?.length ?? 0) > 0
    )
      return "lead";
    return "worker";
  };
  const roleLabel = (node: FleetNode, role: TeamRole) => {
    if (role === "main") return "Main assistant";
    const project = node.project ? input.projectNames?.get(node.project) : undefined;
    const base = role === "lead" ? "Project lead" : "Worker";
    return project ? `${base} · ${project}` : base;
  };

  const counts: Record<TeamState, number> = {
    waiting: 0,
    working: 0,
    paused: 0,
    idle: 0,
    offline: 0,
  };
  const placed = new Set<string>();
  const card = (node: FleetNode): TeamCard => {
    placed.add(node.id);
    const state = stateOf(node, offlineHosts);
    counts[state] += 1;
    const role = roleOf(node);
    const children = (childrenOf.get(node.id) ?? [])
      .filter((id) => !placed.has(id)) // a recorded loop is cut, not followed
      .map((id) => card(byId.get(id)!));
    return {
      id: node.id,
      role,
      roleLabel: roleLabel(node, role),
      title: node.title,
      state,
      stateLabel: STATE_LABEL[state],
      now: nowSentence(node, state, formatTime),
      host: node.host,
      serverId: node.serverId ?? null,
      agentId: node.agentId,
      runs: runsLabel(node),
      noLine: role !== "main" && !recorded(node),
      directLink: node.directLink ? (byId.get(node.directLink)?.title ?? "a chat") : null,
      sessions: 1,
      children: sortCards(children),
    };
  };

  const roots = input.nodes.filter((node) => !parentOf.has(node.id)).map(card);
  // A loop with no way in still shows, rather than vanishing.
  for (const node of input.nodes) if (!placed.has(node.id)) roots.push(card(node));

  return { roots: sortCards(mergeOfflineRoots(roots)), counts, summary: summarise(counts) };
}

/** Offline sessions with nothing under them collapse to one card per computer. */
function mergeOfflineRoots(roots: TeamCard[]): TeamCard[] {
  const kept: TeamCard[] = [];
  const byHost = new Map<string, TeamCard[]>();
  for (const root of roots) {
    if (root.state === "offline" && root.children.length === 0)
      byHost.set(root.host, [...(byHost.get(root.host) ?? []), root]);
    else kept.push(root);
  }
  for (const [host, cards] of byHost) {
    if (cards.length === 1) {
      kept.push(cards[0]!);
      continue;
    }
    kept.push({
      ...cards[0]!,
      id: `offline:${host}`,
      roleLabel: "Offline computer",
      title: host,
      now: `${cards.length} sessions on ${host} can't be reached right now`,
      agentId: null,
      runs: null,
      sessions: cards.length,
    });
  }
  return kept;
}

function sortCards(cards: TeamCard[]): TeamCard[] {
  const roleRank: Record<TeamRole, number> = { main: 0, lead: 1, worker: 2 };
  return [...cards].sort(
    (a, b) =>
      roleRank[a.role] - roleRank[b.role] ||
      STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
      a.title.localeCompare(b.title),
  );
}

function summarise(counts: Record<TeamState, number>): string {
  const parts = [
    counts.working && `${counts.working} working`,
    counts.waiting && `${counts.waiting} waiting for you`,
    counts.paused && `${counts.paused} paused`,
    counts.offline && `${counts.offline} offline`,
    counts.idle && `${counts.idle} idle`,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "No sessions yet";
}
