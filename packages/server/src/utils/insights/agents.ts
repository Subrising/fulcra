// Agent insights: sessions started, finished and blocked per day, time blocked waiting on the person ("needs you"),
// and usage-limit stops, by project. Started and finished come from the host's own agent records, so they reach
// back as far as the records do. Blocked time and usage-limit stops are not in those records: they come from the
// host's insights event log (see recorder.ts), which starts when this host first runs with it.

const DAY = 24 * 60 * 60 * 1000;
export const OTHER_PROJECT = "";

export interface AgentRecordFacts {
  id: string;
  cwd: string;
  workspaceId?: string | null;
  createdAt: string;
  archivedAt?: string | null;
  attentionReason?: string | null;
  attentionTimestamp?: string | null;
  requiresAttention?: boolean;
  lastError?: string | null;
  internal?: boolean;
}

export interface AgentEvent {
  type: "recording-started" | "blocked" | "unblocked" | "limit";
  agentId?: string;
  at: string;
}

export interface ProjectFacts {
  projectId: string;
  name: string;
  rootPath: string;
}

export interface DayPoint {
  day: string;
  started: number;
  finished: number;
  blocked: number;
  limitStops: number;
}

export interface ProjectAgentFacts {
  projectId: string;
  /** Empty for sessions outside every registered project. */
  name: string;
  started: number;
  finished: number;
  blockedHours: number;
  limitStops: number;
}

export interface AgentInsights {
  days: number;
  perDay: DayPoint[];
  totals: {
    started: number;
    finished: number;
    blocked: number;
    blockedHours: number;
    limitStops: number;
    waitingNow: number;
  };
  byProject: ProjectAgentFacts[];
  /** When the event log began (blocked time and usage limits count from here); null when it has not. */
  recordingSince: string | null;
  previous: { started: number; blocked: number };
}

export const USAGE_LIMIT =
  /usage limit|rate.?limit|quota|hit your limit|limit reached|too many requests|\b429\b/i;

const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);
const parse = (t: string | null | undefined) => (t ? Date.parse(t) : Number.NaN);

/** Which registered project a session belongs to: its workspace's project, else the deepest project root. */
export function projectOf(
  record: AgentRecordFacts,
  projects: readonly Pick<ProjectFacts, "projectId" | "rootPath">[],
  workspaceProject: ReadonlyMap<string, string>,
): string {
  const viaWorkspace = record.workspaceId ? workspaceProject.get(record.workspaceId) : undefined;
  if (viaWorkspace) return viaWorkspace;
  let best: Pick<ProjectFacts, "projectId" | "rootPath"> | null = null;
  for (const p of projects) {
    const inside = record.cwd === p.rootPath || record.cwd.startsWith(`${p.rootPath}/`);
    if (inside && (!best || p.rootPath.length > best.rootPath.length)) best = p;
  }
  return best?.projectId ?? OTHER_PROJECT;
}

/**
 * When a session finished: its turn ended normally ("finished" attention). A failed turn is not a finish, and
 * archiving alone is not either.
 */
function finishedAt(record: AgentRecordFacts): number {
  if (record.attentionReason !== "finished") return Number.NaN;
  return parse(record.attentionTimestamp);
}

/** When a session stopped (a turn ended, well or not, or it was archived): a wait still open ends there. */
function endedAt(record: AgentRecordFacts): number {
  const ends = [parse(record.archivedAt)];
  if (record.attentionReason === "finished" || record.attentionReason === "error") {
    ends.push(parse(record.attentionTimestamp));
  }
  const known = ends.filter(Number.isFinite);
  return known.length > 0 ? Math.min(...known) : Number.NaN;
}

/**
 * Blocked spans per agent from the event log. A span with no "unblocked" closes when its session stopped after it
 * began, else it is still open and runs until now.
 */
function blockedSpans(
  events: readonly AgentEvent[],
  now: number,
  endOf: (agentId: string) => number = () => Number.NaN,
) {
  const open = new Map<string, number>();
  const spans: { agentId: string; start: number; end: number }[] = [];
  for (const e of [...events].sort((a, b) => parse(a.at) - parse(b.at))) {
    if (!e.agentId) continue;
    const at = parse(e.at);
    if (e.type === "blocked" && !open.has(e.agentId)) open.set(e.agentId, at);
    if (e.type === "unblocked" && open.has(e.agentId)) {
      spans.push({ agentId: e.agentId, start: open.get(e.agentId) ?? at, end: at });
      open.delete(e.agentId);
    }
  }
  for (const [agentId, start] of open) {
    const ended = endOf(agentId);
    spans.push({ agentId, start, end: Number.isFinite(ended) && ended > start ? ended : now });
  }
  return spans;
}

interface Tally {
  from: number;
  now: number;
  days: number;
  perDay: Map<string, DayPoint>;
  project: (id: string) => ProjectAgentFacts;
  projectFor: ReadonlyMap<string, string>;
}

const inWindow = (tally: Tally, t: number) =>
  Number.isFinite(t) && t >= tally.from && t <= tally.now;
const inPrevious = (tally: Tally, t: number) =>
  t >= tally.from - tally.days * DAY && t < tally.from;

function emptyDays(from: number, now: number): Map<string, DayPoint> {
  const perDay = new Map<string, DayPoint>();
  for (let t = from; t <= now; t += DAY) {
    const day = dayOf(t);
    if (!perDay.has(day))
      perDay.set(day, { day, started: 0, finished: 0, blocked: 0, limitStops: 0 });
  }
  return perDay;
}

/** Sessions started and finished per day; returns how many started in the period before. */
function tallySessions(tally: Tally, records: readonly AgentRecordFacts[]): number {
  let previousStarted = 0;
  for (const r of records) {
    const owner = () => tally.project(tally.projectFor.get(r.id) ?? OTHER_PROJECT);
    const created = parse(r.createdAt);
    if (inWindow(tally, created)) {
      const point = tally.perDay.get(dayOf(created));
      if (point) point.started += 1;
      owner().started += 1;
    } else if (inPrevious(tally, created)) previousStarted += 1;
    const done = finishedAt(r);
    if (inWindow(tally, done)) {
      const point = tally.perDay.get(dayOf(done));
      if (point) point.finished += 1;
      owner().finished += 1;
    }
  }
  return previousStarted;
}

/** Times sessions waited on the person, and for how long (clipped to the window). */
function tallyBlocked(
  tally: Tally,
  events: readonly AgentEvent[],
  records: readonly AgentRecordFacts[],
) {
  let blocked = 0;
  let previous = 0;
  let ms = 0;
  const byId = new Map(records.map((r) => [r.id, r]));
  const endOf = (agentId: string) => {
    const record = byId.get(agentId);
    return record ? endedAt(record) : Number.NaN;
  };
  for (const span of blockedSpans(events, tally.now, endOf)) {
    const owner = tally.project(tally.projectFor.get(span.agentId) ?? OTHER_PROJECT);
    if (inWindow(tally, span.start)) {
      blocked += 1;
      const point = tally.perDay.get(dayOf(span.start));
      if (point) point.blocked += 1;
    } else if (inPrevious(tally, span.start)) previous += 1;
    const overlap = Math.max(0, Math.min(span.end, tally.now) - Math.max(span.start, tally.from));
    ms += overlap;
    owner.blockedHours += overlap / 3_600_000;
  }
  return { blocked, previous, ms };
}

function tallyLimits(tally: Tally, events: readonly AgentEvent[]): number {
  let stops = 0;
  for (const e of events) {
    const at = parse(e.at);
    if (e.type !== "limit" || !inWindow(tally, at)) continue;
    stops += 1;
    const point = tally.perDay.get(dayOf(at));
    if (point) point.limitStops += 1;
    tally.project(tally.projectFor.get(e.agentId ?? "") ?? OTHER_PROJECT).limitStops += 1;
  }
  return stops;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function agentInsights(input: {
  records: readonly AgentRecordFacts[];
  events: readonly AgentEvent[];
  projects: readonly ProjectFacts[];
  workspaceProject: ReadonlyMap<string, string>;
  days: number;
  now: number;
}): AgentInsights {
  const { days, now } = input;
  const from = now - days * DAY;
  const records = input.records.filter((r) => !r.internal);
  const byProject = new Map<string, ProjectAgentFacts>();
  const tally: Tally = {
    from,
    now,
    days,
    perDay: emptyDays(from, now),
    projectFor: new Map(
      records.map((r) => [r.id, projectOf(r, input.projects, input.workspaceProject)]),
    ),
    project: (id) => {
      const known = byProject.get(id);
      if (known) return known;
      const name = input.projects.find((p) => p.projectId === id)?.name ?? "";
      const fresh = {
        projectId: id,
        name,
        started: 0,
        finished: 0,
        blockedHours: 0,
        limitStops: 0,
      };
      byProject.set(id, fresh);
      return fresh;
    },
  };
  const previousStarted = tallySessions(tally, records);
  const blocked = tallyBlocked(tally, input.events, input.records);
  const limitStops = tallyLimits(tally, input.events);
  const perDay = [...tally.perDay.values()].sort((a, b) => a.day.localeCompare(b.day));
  return {
    days,
    perDay,
    totals: {
      started: perDay.reduce((n, p) => n + p.started, 0),
      finished: perDay.reduce((n, p) => n + p.finished, 0),
      blocked: blocked.blocked,
      blockedHours: round1(blocked.ms / 3_600_000),
      limitStops,
      waitingNow: records.filter(
        (r) => r.requiresAttention && r.attentionReason === "permission" && !r.archivedAt,
      ).length,
    },
    byProject: [...byProject.values()]
      .map((p) => Object.assign({}, p, { blockedHours: round1(p.blockedHours) }))
      .sort((a, b) => b.started - a.started || a.name.localeCompare(b.name)),
    recordingSince: input.events.find((e) => e.type === "recording-started")?.at ?? null,
    previous: { started: previousStarted, blocked: blocked.previous },
  };
}
