import type { WorkMapOverview } from "../shared/work-map";
import type { RemitsView, Owner, RemitHistoryEntry, Remit } from "../shared/cc/remit";
import type { Fleet } from "../shared/fleet";
import { workName } from "./work-labels";

/**
 * The Organisation tree: prime → projects → orchestrator → live session count. A pure join of three reads the
 * app already makes: the work map overview (projects, their orchestrator seat and running counts), the remits
 * (which prime owns which project, CONTRACTS §5) and the fleet (conversation titles). Nothing here decides
 * ownership: the controller resolves it (project remit, then area, then nobody) and this only groups by it.
 */
export interface TreeOrchestrator {
  state: "working" | "idle" | "not-seen" | "none" | "unknown";
  name: string | null;
  sessionId: string | null;
}
export interface TreeProject {
  projectId: string;
  name: string;
  owner: Owner;
  orchestrator: TreeOrchestrator;
  running: number;
  sessions: number;
}
export interface TreePrime {
  seat: string;
  name: string;
  filled: boolean;
  holder: string | null;
  remitLine: string;
  areas: string[];
  projects: TreeProject[];
}
export interface OrgTree {
  primes: TreePrime[];
  unassigned: TreeProject[];
  ownersKnown: boolean;
  seatsKnown: boolean;
}
const UNASSIGNED: Owner = { kind: "unassigned", primeSeat: null, remitId: null };

/** "delivery" → "Delivery main assistant"; "north-america" → "North america main assistant". A seat slug is not a person. */
/** "delivery" reads "Delivery main assistant"; a seat already named main or prime reads "Main assistant". */
export function primeName(seat: string) {
  const words = seat
    .replace(/-/g, " ")
    .replace(/\b(main|prime|assistant)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!words) return "Main assistant";
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} main assistant`;
}

function list(names: string[]) {
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}
/** One line per prime: the areas it owns, then how many projects. */
export function remitLine(areas: string[], projects: string[]) {
  const count = `${projects.length} ${projects.length === 1 ? "project" : "projects"}`;
  if (areas.length) return `Owns ${list(areas)} · ${count}`;
  if (projects.length) return `Owns ${count}: ${list(projects)}`;
  return "Owns no projects yet";
}

export function buildTree(
  map: WorkMapOverview | undefined,
  remits: RemitsView | undefined,
  fleet: Fleet | undefined,
): OrgTree {
  // A read that is missing its lists is treated as unknown, never as "nobody owns anything".
  if (
    remits &&
    (!Array.isArray(remits.projects) ||
      !Array.isArray(remits.primes) ||
      !Array.isArray(remits.remits))
  )
    remits = undefined;
  const ownersKnown = Boolean(remits && !remits.error),
    seatsKnown = Boolean(map?.available);
  const owners = new Map((remits?.projects ?? []).map((p) => [p.projectId, p]));
  const title = (sessionId: string | null) => {
    const node = sessionId ? fleet?.nodes.find((n) => n.id === sessionId) : undefined;
    return node ? { name: workName(node.title), status: node.status } : null;
  };
  const ids = [
    ...new Set([
      ...(map?.projects ?? []).map((p) => p.projectId),
      ...(remits?.projects ?? []).map((p) => p.projectId),
    ]),
  ];
  const projects: TreeProject[] = ids
    .map((projectId) => {
      const m = map?.projects.find((p) => p.projectId === projectId),
        r = owners.get(projectId);
      const seat = m?.seat,
        held = seat?.state === "assigned" ? (seat.sessionId ?? null) : null,
        live = title(held);
      const orchestrator: TreeOrchestrator = !map
        ? { state: "unknown", name: null, sessionId: null }
        : !held
          ? { state: "none", name: null, sessionId: null }
          : live
            ? {
                state: live.status === "running" ? "working" : "idle",
                name: live.name,
                sessionId: held,
              }
            : { state: "not-seen", name: null, sessionId: held };
      return {
        projectId,
        name: m?.name ?? r?.name ?? "Unnamed project",
        owner: r?.owner ?? UNASSIGNED,
        orchestrator,
        running: m?.running ?? 0,
        sessions: m?.sessions ?? 0,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.projectId.localeCompare(b.projectId));
  // Primes are the recorded prime seats (role_bindings), never a hard-coded one; several are normal.
  const seats = remits?.primes.length
    ? remits.primes
    : (map?.primes ?? []).map((p) => ({
        seat: p.seat,
        state: p.state === "assigned" ? ("assigned" as const) : ("vacant" as const),
        sessionId: p.sessionId ?? null,
      }));
  const active = (remits?.remits ?? []).filter((r) => r.state === "active");
  const primes: TreePrime[] = seats.map((p) => {
    const owned = projects.filter((x) => x.owner.primeSeat === p.seat);
    const areas = active
      .filter((r) => r.primeSeat === p.seat && r.scope.kind === "domain")
      .map((r) => (r.scope as { label: string }).label);
    return {
      seat: p.seat,
      name: primeName(p.seat),
      filled: p.state === "assigned",
      holder: title(p.sessionId)?.name ?? null,
      remitLine: remitLine(
        areas,
        owned.map((x) => x.name),
      ),
      areas,
      projects: owned,
    };
  });
  const primeSeats = new Set(primes.map((p) => p.seat));
  // A project whose owner is not a recorded prime seat any more is shown as unowned, never dropped.
  return {
    primes,
    unassigned: projects.filter((x) => !x.owner.primeSeat || !primeSeats.has(x.owner.primeSeat)),
    ownersKnown,
    seatsKnown,
  };
}

export function orchestratorLine(o: TreeOrchestrator) {
  switch (o.state) {
    case "working":
      return `${o.name} · working now`;
    case "idle":
      return `${o.name} · waiting`;
    case "not-seen":
      return "Orchestrator not running right now";
    case "none":
      return "No orchestrator yet";
    default:
      return "Orchestrator unknown";
  }
}
export function sessionsLine(p: TreeProject) {
  if (!p.sessions) return "No sessions";
  return `${p.running} of ${p.sessions} ${p.sessions === 1 ? "session" : "sessions"} working`;
}
export function ownerLine(owner: Owner) {
  return owner.primeSeat
    ? `Owned by the ${primeName(owner.primeSeat)}${owner.kind === "domain" ? " (through its area)" : ""}`
    : "No prime yet";
}

export function relativeTime(iso: string, now = Date.now()) {
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
  if (!Number.isFinite(m)) return "at an unknown time";
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return h < 48 ? "yesterday" : `${Math.round(h / 24)} days ago`;
}
const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
/** "2026-10-01" → "1 Oct". A due date is a calendar day, read without a timezone shift. */
export function dayLabel(date: string) {
  const [y, mo, d] = date.split("-").map(Number);
  return DATE.format(new Date(y, mo - 1, d));
}
export const HEALTH_LABEL = {
  "on-track": "On track",
  "at-risk": "At risk",
  blocked: "Blocked",
  idle: "Quiet",
} as const;

/** What changed for this project, newest first, in words. */
export function historyLines(history: RemitHistoryEntry[], projectId: string) {
  const isRemit = (v: unknown): v is Remit =>
    Boolean(v && typeof v === "object" && "primeSeat" in v);
  const about = (h: RemitHistoryEntry) =>
    h.entityId === projectId ||
    [h.before, h.after].some(
      (v) => isRemit(v) && v.scope.kind === "project" && v.scope.projectId === projectId,
    );
  return history.filter(about).map((h) => {
    const before = isRemit(h.before) ? primeName(h.before.primeSeat) : null,
      after = isRemit(h.after) ? primeName(h.after.primeSeat) : null;
    const what =
      h.action === "moved"
        ? `Moved from the ${before} to the ${after}`
        : h.action === "assigned"
          ? `Given to the ${after}`
          : h.action === "ended"
            ? `The ${before ?? after} stopped owning it`
            : h.after && "domain" in h.after && h.after.domain
              ? `Grouped under the ${h.after.domain.replace(/-/g, " ")} area`
              : "Taken out of its area";
    return {
      id: h.id,
      what,
      why: h.note,
      at: h.at,
      by: h.actor === "human" ? "you" : "the Fulcra app",
    };
  });
}
