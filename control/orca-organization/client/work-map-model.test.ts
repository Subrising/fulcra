import test from "node:test";
import assert from "node:assert/strict";
import {
  buildOutline,
  changeAnnouncement,
  displayGlyph,
  freshness,
  initialExpanded,
  layoutMap,
  LIMITS,
  seatText,
  statusOf,
  toggleExpanded,
  type Row,
} from "./work-map-model";
import { liveMapRows } from "./live-map-model";
import type { PluginObservedAgent } from "@getpaseo/plugin/client";
import type { Fleet } from "../shared/fleet";
import type { RemitsView } from "../shared/cc/remit";
import type { MapSeat, MapSession, WorkMapOverview, WorkMapProject } from "../shared/work-map";
import { plainLanguageCheck } from "../shared/cc/refs";

const uuid = (n: number) => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
const T0 = Date.parse("2026-09-23T12:00:00.000Z");
const at = new Date(T0).toISOString();

const seat = (extra: Partial<MapSeat> = {}): MapSeat => ({
  role: "prime",
  seat: "delivery",
  projectId: null,
  state: "assigned",
  revision: 3,
  task: uuid(900),
  sessionId: uuid(901),
  session: { id: uuid(901), task: uuid(900), mode: "human", generation: 4 },
  note: null,
  at,
  membershipAt: at,
  sessionPresent: true,
  sessionGenerationChanged: false,
  sessionTaskMatches: true,
  dispatch: { host: "mini", supported: true, reason: null },
  hold: null,
  ...extra,
});
const runtime = (status = "running", extra = {}) => ({
  title: `S-${status}`,
  provider: "claude",
  model: "opus",
  host: "mini" as const,
  status,
  pending: 0,
  error: null,
  updatedAt: at,
  ...extra,
});
const session = (n: number, task: string, extra: Partial<MapSession> = {}): MapSession => ({
  sessionId: uuid(n),
  taskId: task,
  mode: "delegated",
  generation: 1,
  ownership: "recorded",
  seat: null,
  seatRole: null,
  parentSession: null,
  adoptedUnder: null,
  leaderChanged: false,
  runtime: runtime("running", { title: `Session ${n}` }),
  ...extra,
});

function overview(projects: number, extra: Partial<WorkMapOverview> = {}): WorkMapOverview {
  return {
    observedAt: at,
    available: true,
    unavailable: null,
    primes: [seat({ hold: "effective" })],
    projects: Array.from({ length: projects }, (_, i) => ({
      projectId: uuid(1000 + i),
      name: `Project ${String(i).padStart(3, "0")}`,
      status: "in_progress",
      seat: seat({
        role: "project-orchestrator",
        seat: uuid(1000 + i),
        projectId: uuid(1000 + i),
        session: { id: uuid(902), task: uuid(900), mode: "delegated", generation: 1 },
      }),
      channels: [],
      workstreams: 64,
      sessions: 0,
      running: 0,
    })),
    unplaced: [],
    attention: [],
    sources: {
      seats: true,
      channels: true,
      projects: { available: true, partial: false, note: "" },
      fleet: { available: true, partial: false, observedAt: at },
    },
    note: "n",
    ...extra,
  };
}

function project(
  projectId: string,
  workstreams: { taskId: string; sessions: MapSession[] }[],
  extra: Partial<WorkMapProject> = {},
): WorkMapProject {
  return {
    observedAt: at,
    available: true,
    unavailable: null,
    projectId,
    name: "P",
    status: "in_progress",
    membership: {
      known: true,
      partial: false,
      truncated: false,
      memberTaskCount: workstreams.length,
      note: "",
    },
    leader: null,
    workstreams: workstreams.map((w) => ({ ...w, recorded: 1, unresolved: 0, truncated: false })),
    needed: [],
    blockers: [],
    issues: {
      observedAt: at,
      providers: [{ source: "board", available: true, note: "" }],
      issues: [],
      truncated: false,
    },
    note: "n",
    ...extra,
  };
}

const P0 = uuid(1000),
  W1 = uuid(2001),
  W2 = uuid(2002);
const ids = (rows: Row[]) => rows.map((r) => r.id);

// ---------- T4 ----------

test("T4 human-held needs the effective hold AND a human-mode holder", () => {
  assert.equal(seatText(seat({ hold: "effective" })), "Held by you");
  assert.notEqual(
    seatText(
      seat({
        hold: "effective",
        session: { id: uuid(901), task: uuid(900), mode: "delegated", generation: 4 },
      }),
    ),
    "Held by you",
  );
  assert.notEqual(seatText(seat({ hold: "declared" })), "Held by you");
  assert.match(
    seatText(
      seat({
        hold: "declared",
        session: { id: uuid(901), task: uuid(900), mode: "delegated", generation: 4 },
      }),
    ),
    /a hold was asked for but is not in force/,
  );
});

// J0 plain language: the same states, in sentences a busy reader understands (J7 walkthrough, screen 01).
test("T4 seat states read in words: vacant, holder missing, generation changed, task changed", () => {
  assert.equal(seatText(null), "No orchestrator yet");
  assert.equal(seatText(seat({ state: "vacant" })), "No orchestrator yet");
  assert.equal(seatText(seat({ sessionPresent: false })), "Its orchestrator session is gone");
  assert.equal(
    seatText(seat({ sessionGenerationChanged: true })),
    "This orchestrator was restarted since it was assigned",
  );
  assert.equal(
    seatText(seat({ sessionTaskMatches: false })),
    "Its orchestrator moved to other work",
  );
  for (const state of [
    null,
    seat({ state: "vacant" }),
    seat({ sessionPresent: false }),
    seat({ sessionGenerationChanged: true }),
    seat({ sessionTaskMatches: false }),
    seat({ hold: "effective" }),
    seat({
      hold: "declared",
      session: { id: uuid(901), task: uuid(900), mode: "delegated", generation: 4 },
    }),
    seat(),
  ])
    assert.deepEqual(plainLanguageCheck(seatText(state)), [], seatText(state));
});

test("T4 idle is never shown as done; missing runtime is unavailable, not invented", () => {
  assert.equal(statusOf(runtime("idle")).text, "idle — not done");
  assert.equal(statusOf(null).text, "runtime unavailable");
  assert.equal(statusOf(runtime("running", { pending: 1 })).text, "waiting for permission");
  assert.equal(statusOf(runtime("running", { error: "x" })).glyph, "✕");
});

test("T4 recorded parents nest as solid children; adoption nests dashed; declared and unknown sit at the root", () => {
  const lead = session(1, W1),
    child = session(2, W1, { parentSession: uuid(1) }),
    grand = session(3, W1, { parentSession: uuid(2) });
  const adopted = session(4, W1, { ownership: "adopted", adoptedUnder: uuid(1) });
  const declared = session(5, W1, { ownership: "declared" }),
    unknown = session(6, W1, { ownership: "unknown" });
  const o = buildOutline({
    overview: overview(1),
    projects: {
      [P0]: project(P0, [
        { taskId: W1, sessions: [lead, child, grand, adopted, declared, unknown] },
      ]),
    },
    expanded: [P0],
  });
  const s = Object.fromEntries(
    o.rows.filter((r) => r.kind === "session").map((r) => [r.target.sessionId, r]),
  );
  assert.equal(s[uuid(2)].parent, `session:${W1}:${uuid(1)}`);
  assert.equal(s[uuid(2)].link, "parent");
  assert.equal(s[uuid(3)].depth, s[uuid(2)].depth + 1);
  assert.equal(s[uuid(4)].link, "adopted");
  assert.match(s[uuid(4)].label, /adopted by an operator/);
  for (const root of [uuid(1), uuid(5), uuid(6)])
    assert.equal(s[root].parent, `workstream:${P0}:${W1}`);
  assert.match(s[uuid(5)].detail, /no leader recorded/);
  assert.match(s[uuid(6)].detail, /Owner not recorded/);
  assert.doesNotMatch(
    s[uuid(5)].detail,
    /gen \d|ownership/,
    "no generation counter or engineering term in the row",
  );
  assert.match(s[uuid(2)].label, /child of Session 1/);
});

test('T4 a session on two member tasks appears under both, with "also in"', () => {
  const shared = session(7, W1);
  const o = buildOutline({
    overview: overview(1),
    projects: {
      [P0]: project(P0, [
        { taskId: W1, sessions: [shared] },
        { taskId: W2, sessions: [{ ...shared, taskId: W2 }] },
      ]),
    },
    expanded: [P0],
  });
  const rows = o.rows.filter((r) => r.target.sessionId === uuid(7));
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].id, rows[1].id);
  assert.match(rows[0].detail, /also in 1 other workstream$/);
  assert.doesNotMatch(rows[0].detail, new RegExp(W2.slice(0, 8)), "no id in the row");
});

test("T4 a parent cycle does not hang and places the sessions at the root", () => {
  const a = session(8, W1, { parentSession: uuid(9) }),
    b = session(9, W1, { parentSession: uuid(8) });
  const o = buildOutline({
    overview: overview(1),
    projects: { [P0]: project(P0, [{ taskId: W1, sessions: [a, b] }]) },
    expanded: [P0],
  });
  assert.equal(o.rows.filter((r) => r.kind === "session").length, 2);
});

test("T4 the workstream is named by its own board issue; other links are listed; a missing issue is normal", () => {
  const p = project(
    P0,
    [
      { taskId: W1, sessions: [] },
      { taskId: W2, sessions: [] },
    ],
    {
      issues: {
        observedAt: at,
        truncated: false,
        providers: [
          { source: "board", available: true, note: "" },
          { source: "github", available: false, note: "token missing" },
        ],
        issues: [
          {
            source: "board",
            key: "AIN-107",
            title: "Work view",
            state: "in_progress",
            rawState: "in_progress",
            assignee: null,
            url: null,
            updatedAt: null,
            linkedTo: { scope: "workstream", scopeId: W1 },
            relation: "is",
          },
          {
            source: "github",
            key: "org/repo#88",
            title: "PR",
            state: "open",
            rawState: "OPEN",
            assignee: null,
            url: "https://github.com/org/repo/pull/88",
            updatedAt: null,
            linkedTo: { scope: "workstream", scopeId: W1 },
            relation: "links",
          },
        ],
      },
    },
  );
  const o = buildOutline({ overview: overview(1), projects: { [P0]: p }, expanded: [P0] });
  const w = o.rows.filter((r) => r.kind === "workstream");
  assert.equal(w[0].title, "AIN-107 · Work view");
  assert.match(w[0].detail, /board: in progress · org\/repo#88 \(open\)/);
  assert.equal(w[1].title, "Untitled workstream", "no id stands in for a name");
  assert.match(w[1].detail, /no linked issue/);
  assert.ok(
    o.rows.some(
      (r) => r.kind === "notice" && /Issues unavailable from github: token missing/.test(r.title),
    ),
    "unavailable is not rendered as none",
  );
});

test("T4 an unreadable project shows unknown, not absent; a loading one says so", () => {
  const bad = project(P0, [], { available: false, unavailable: "Control timed out" });
  const o = buildOutline({ overview: overview(1), projects: { [P0]: bad }, expanded: [P0] });
  assert.ok(o.rows.some((r) => /unknown, not absent/.test(r.title)));
  const loading = buildOutline({ overview: overview(1), projects: {}, expanded: [P0] });
  assert.ok(loading.rows.some((r) => /Reading this project/.test(r.title)));
});

// ---------- T5: scale ----------

test("T5 128 projects × 64 workstreams × 20 sessions stays within the row cap and says what it cut", () => {
  const big = overview(128);
  const projects: Record<string, WorkMapProject> = {};
  const expanded: string[] = [];
  for (const p of big.projects.slice(0, LIMITS.expandedProjects)) {
    expanded.push(p.projectId);
    projects[p.projectId] = project(
      p.projectId,
      Array.from({ length: 64 }, (_, w) => ({
        taskId: uuid(5000 + w),
        sessions: Array.from({ length: 20 }, (_, s) =>
          session(100000 + w * 100 + s, uuid(5000 + w)),
        ),
      })),
    );
  }
  const o = buildOutline({ overview: big, projects, expanded });
  assert.ok(o.rows.length <= LIMITS.rows + 1);
  assert.ok(o.truncated > 0);
  assert.match(o.rows.at(-1)!.title, /more rows not shown/);
  const g = layoutMap(o.rows);
  assert.ok(g.nodes.length <= LIMITS.rows + 1);
  assert.ok(g.edges.length <= LIMITS.edges);
});

test('T5 each workstream shows at most six root sessions and a "+N more" that expands in place', () => {
  const sessions = Array.from({ length: 10 }, (_, i) => session(300 + i, W1));
  const p = { [P0]: project(P0, [{ taskId: W1, sessions }]) };
  const closed = buildOutline({ overview: overview(1), projects: p, expanded: [P0] });
  assert.equal(
    closed.rows.filter((r) => r.kind === "session").length,
    LIMITS.childrenPerWorkstream,
  );
  const more = closed.rows.find((r) => r.kind === "more")!;
  assert.equal(more.title, "+4 more");
  const open = buildOutline({ overview: overview(1), projects: p, expanded: [P0], moreOpen: [W1] });
  assert.equal(open.rows.filter((r) => r.kind === "session").length, 10);
  assert.ok(!open.rows.some((r) => r.kind === "more"));
});

test("T5 parent chains nest three levels; deeper levels collapse into a count", () => {
  const chain = Array.from({ length: 6 }, (_, i) =>
    session(400 + i, W1, { parentSession: i ? uuid(400 + i - 1) : null }),
  );
  const o = buildOutline({
    overview: overview(1),
    projects: { [P0]: project(P0, [{ taskId: W1, sessions: chain }]) },
    expanded: [P0],
  });
  const shown = o.rows.filter((r) => r.kind === "session");
  assert.equal(shown.length, LIMITS.depth);
  assert.ok(o.rows.some((r) => r.kind === "notice" && r.title === "… 3 more in deeper levels"));
});

test("T5 projects start collapsed except those needing attention, capped at eight", () => {
  const o = overview(20, {
    attention: Array.from({ length: 10 }, (_, i) => ({
      kind: "no-project-orchestrator",
      detail: "x",
      projectId: uuid(1000 + i),
      taskId: null,
      sessionId: null,
    })),
  });
  assert.deepEqual(
    initialExpanded(o),
    Array.from({ length: 8 }, (_, i) => uuid(1000 + i)),
  );
  let open: string[] = [];
  for (let i = 0; i < 10; i++) open = toggleExpanded(open, `p${i}`);
  assert.equal(open.length, LIMITS.expandedProjects);
  assert.deepEqual(open.slice(0, 2), ["p2", "p3"], "the oldest expansions close first");
  assert.deepEqual(toggleExpanded(["a", "b"], "a"), ["b"]);
});

test("T5 layout is deterministic and a status change moves no node", () => {
  const sessions = Array.from({ length: 5 }, (_, i) => session(500 + i, W1));
  const input = {
    overview: overview(3),
    projects: { [P0]: project(P0, [{ taskId: W1, sessions }]) },
    expanded: [P0],
  };
  const a = layoutMap(buildOutline(input).rows),
    b = layoutMap(buildOutline(input).rows);
  assert.deepEqual(
    a.nodes.map((n) => [n.id, n.x, n.y]),
    b.nodes.map((n) => [n.id, n.x, n.y]),
  );
  const changed = {
    ...input,
    projects: {
      [P0]: project(P0, [
        {
          taskId: W1,
          sessions: sessions.map((s, i) =>
            i === 2 ? { ...s, runtime: runtime("idle", { title: s.runtime!.title }) } : s,
          ),
        },
      ]),
    },
  };
  const c = layoutMap(buildOutline(changed).rows);
  assert.deepEqual(
    c.nodes.map((n) => [n.id, n.x, n.y]),
    a.nodes.map((n) => [n.id, n.x, n.y]),
  );
  assert.equal(
    changeAnnouncement(buildOutline(input).rows, buildOutline(changed).rows),
    "1 session changed status",
  );
  assert.equal(changeAnnouncement(buildOutline(input).rows, buildOutline(input).rows), null);
});

test("T5 graph links: recorded channel only, never a fabricated all-prime escalation, membership, recorded parent, adoption", () => {
  const ov = overview(2);
  ov.projects[0].channels = [{ primeSeat: "delivery", state: "open", open: true }];
  const lead = session(1, W1),
    child = session(2, W1, { parentSession: uuid(1) }),
    adopted = session(3, W1, { ownership: "adopted", adoptedUnder: uuid(1) });
  const g = layoutMap(
    buildOutline({
      overview: ov,
      projects: { [P0]: project(P0, [{ taskId: W1, sessions: [lead, child, adopted] }]) },
      expanded: [P0],
    }).rows,
  );
  const kinds = (to: string) => g.edges.filter((e) => e.to === to).map((e) => e.kind);
  assert.deepEqual(kinds(`project:${P0}`), ["channel"]);
  assert.deepEqual(kinds(`project:${uuid(1001)}`), []);
  assert.deepEqual(kinds(`workstream:${P0}:${W1}`), ["membership"]);
  assert.deepEqual(kinds(`session:${W1}:${uuid(2)}`), ["parent"]);
  assert.deepEqual(kinds(`session:${W1}:${uuid(3)}`), ["adopted"]);
});

// ---------- filters and search ----------

test("filters: needs-attention hides quiet projects; delegated/human filter sessions by control mode", () => {
  const ov = overview(3, {
    attention: [
      {
        kind: "no-project-orchestrator",
        detail: "x",
        projectId: uuid(1001),
        taskId: null,
        sessionId: null,
      },
    ],
  });
  const only = buildOutline({ overview: ov, projects: {}, expanded: [], filter: "attention" });
  assert.deepEqual(
    only.rows.filter((r) => r.kind === "project").map((r) => r.target.projectId),
    [uuid(1001)],
  );
  assert.equal(only.hidden, 2);
  const mixed = {
    [P0]: project(P0, [
      { taskId: W1, sessions: [session(1, W1), session(2, W1, { mode: "human" })] },
    ]),
  };
  const human = buildOutline({
    overview: overview(1),
    projects: mixed,
    expanded: [P0],
    filter: "human",
  });
  assert.deepEqual(
    human.rows.filter((r) => r.kind === "session").map((r) => r.target.sessionId),
    [uuid(2)],
  );
});

test("search opens the path to a matching session and hides the rest", () => {
  const p = {
    [P0]: project(P0, [
      { taskId: W1, sessions: [session(1, W1), session(2, W1)] },
      { taskId: W2, sessions: [session(3, W2)] },
    ]),
  };
  const o = buildOutline({ overview: overview(2), projects: p, expanded: [], search: "session 3" });
  assert.deepEqual(
    ids(o.rows).filter((id) => !id.startsWith("prime:")),
    [`project:${P0}`, `workstream:${P0}:${W2}`, `session:${W2}:${uuid(3)}`],
  );
  assert.equal(o.rows.find((r) => r.kind === "project")!.expanded, true);
});

// ---------- T6: freshness ----------

test("T6 freshness: live under 45 s; stale after 45 s, on error, or from the future; frozen wins", () => {
  assert.equal(freshness(at, T0 + 44_000, false, false), "live");
  assert.equal(freshness(at, T0 + 46_000, false, false), "stale");
  assert.equal(freshness(at, T0, true, false), "stale");
  assert.equal(freshness(at, T0 - 6_000, false, false), "stale");
  assert.equal(freshness(undefined, T0, false, false), "stale");
  assert.equal(freshness(at, T0 + 999_000, true, true), "frozen");
});

test("T6 a stale view draws hollow glyphs so a retained status cannot pass for live", () => {
  for (const g of ["●", "◐", "✕", "◆", "▣", "▤"]) {
    assert.notEqual(displayGlyph(g, "stale"), g);
    assert.equal(displayGlyph(g, "live"), g);
  }
});

test("unplaced sessions list separately and never under a project", () => {
  const ov = overview(1, {
    unplaced: [{ sessionId: uuid(77), taskId: uuid(78), mode: "delegated", runtime: null }],
  });
  const o = buildOutline({ overview: ov, projects: {}, expanded: [] });
  const row = o.rows.find((r) => r.target.sessionId === uuid(77))!;
  assert.equal(row.parent, "unplaced");
  assert.match(row.label, /not placed in a project/);
});

test("managed workers name their current manager without a fabricated parent or role row", () => {
  const lead = session(1, W1),
    managed = session(2, W1, { ownership: "managed", managedBy: uuid(1) });
  const unknown = session(3, W1, { ownership: "unknown" });
  const o = buildOutline({
    overview: overview(1),
    projects: { [P0]: project(P0, [{ taskId: W1, sessions: [lead, managed, unknown] }]) },
    expanded: [P0],
  });
  const rows = Object.fromEntries(
    o.rows.filter((r) => r.kind === "session").map((r) => [r.target.sessionId, r]),
  );
  assert.match(rows[uuid(2)].detail, /Managed by Session 1; role-session: n\/a/);
  assert.equal(rows[uuid(2)].parent, `workstream:${P0}:${W1}`);
  assert.match(rows[uuid(3)].detail, /Owner not recorded/);
});

test("FR-2 work map keeps validated management readable when the leader is outside the visible rows", () => {
  const managed = session(2, W1, { ownership: "managed", managedBy: uuid(99) });
  const o = buildOutline({
    overview: overview(1),
    projects: { [P0]: project(P0, [{ taskId: W1, sessions: [managed] }]) },
    expanded: [P0],
  });
  const row = o.rows.find((r) => r.target.sessionId === uuid(2))!;
  assert.match(row.detail, /Managed by Current manager \(name unavailable\); role-session: n\/a/);
  assert.doesNotMatch(row.detail, new RegExp(uuid(99)));
});

const nativeEntry = (
  serverId: string,
  extra: Partial<PluginObservedAgent> = {},
): PluginObservedAgent => ({
  serverId,
  agentId: uuid(800),
  hostName: serverId,
  connection: "online",
  title: `${serverId} worker`,
  provider: "codex",
  model: "gpt-6.1-sol",
  status: "running",
  activity: "working",
  observedAt: at,
  creatorAgentId: null,
  workspace: {
    id: uuid(810),
    projectId: uuid(811),
    projectName: "Game",
    kind: "worktree",
    changesAvailable: true,
  },
  ...extra,
});
const liveInput = (rows: Row[], entries: PluginObservedAgent[]) => ({
  rows,
  native: { entries, total: entries.length, truncated: 0, source: "native-cache" as const },
  activity: "all" as const,
  host: "",
  project: "",
  search: "",
  now: T0,
});

test("live map links only the recorded responsible prime and explicitly opened channel", () => {
  const ov = overview(2);
  ov.primes.push(seat({ seat: "research", sessionId: uuid(903) }));
  ov.projects[0].channels = [{ primeSeat: "research", open: true, state: "open" }];
  const base = buildOutline({ overview: ov, projects: {}, expanded: [] });
  const remits: RemitsView = {
    version: 1,
    observedAt: at,
    partial: false,
    stale: false,
    error: null,
    primes: [],
    remits: [],
    domains: [],
    history: [],
    projects: [
      {
        projectId: ov.projects[0].projectId,
        name: "P",
        domain: null,
        domainRevision: 0,
        owner: { kind: "project", primeSeat: "delivery", remitId: uuid(70) },
      },
    ],
  };
  const result = liveMapRows({ ...liveInput(base.rows, []), remits });
  const edges = layoutMap(result.rows).edges.filter(
    (edge) => edge.to === `project:${ov.projects[0].projectId}`,
  );
  assert.deepEqual(
    edges.map((edge) => [edge.from, edge.kind]),
    [
      ["prime:research", "channel"],
      ["prime:delivery", "ownership"],
    ],
  );
  assert.equal(
    layoutMap(result.rows).edges.filter((edge) => edge.to === `project:${ov.projects[1].projectId}`)
      .length,
    0,
  );
  assert.equal(
    layoutMap(
      liveMapRows({ ...liveInput(base.rows, []), remits: { ...remits, stale: true } }).rows,
    ).edges.filter((edge) => edge.kind === "ownership").length,
    0,
  );
});

test("same native agent ID on two hosts remains two exact identities; ambiguous controller rows do not guess", () => {
  const native = [nativeEntry("mini"), nativeEntry("book")];
  const result = liveMapRows(liveInput([], native));
  const sessions = result.rows.filter((row) => row.kind === "session");
  assert.equal(sessions.length, 2);
  assert.notEqual(sessions[0].id, sessions[1].id);
  assert.deepEqual(
    sessions.map((row) => row.target.serverId),
    ["mini", "book"],
  );
  const controllerRow: Row = { ...sessions[0], id: "controller", target: { sessionId: uuid(100) } };
  const nodes = native.map((entry) => ({
    id: uuid(100),
    task: uuid(20),
    host: entry.hostName,
    serverId: entry.serverId,
    agentId: entry.agentId,
    title: entry.title,
    provider: "codex",
    model: "gpt-6.1-sol",
    mode: "human",
    status: "running",
    pending: 0,
    observedAt: at,
    updatedAt: at,
    error: null,
  }));
  const fleet: Fleet = {
    observedAt: at,
    total: 2,
    partial: false,
    note: "",
    nodes,
    tasks: [],
    edges: [],
  };
  const ambiguous = liveMapRows({ ...liveInput([controllerRow], native), fleet });
  assert.equal(ambiguous.rows[0].target.serverId, undefined);
  assert.equal(ambiguous.rows[0].changesAvailable, false);
});

test("native turn events update activity; process-only and stale/disconnected work never pass a model-turn filter", () => {
  const runningProcess = nativeEntry("mini", { activity: "idle" });
  assert.equal(
    liveMapRows({ ...liveInput([], [runningProcess]), activity: "working" }).rows.length,
    0,
  );
  const active = nativeEntry("book");
  assert.equal(
    liveMapRows({ ...liveInput([], [active]), activity: "working" }).rows.filter(
      (row) => row.kind === "session",
    ).length,
    1,
  );
  assert.equal(
    liveMapRows({ ...liveInput([], [active]), activity: "working", now: T0 + 60000 }).rows.length,
    0,
  );
  const offline = nativeEntry("book", { connection: "offline", activity: "unavailable" });
  assert.equal(liveMapRows(liveInput([], [offline])).rows.at(-1)?.changesAvailable, false);
  assert.equal(liveMapRows({ ...liveInput([], [active]), host: "mini" }).hidden, 1);
  assert.equal(liveMapRows({ ...liveInput([], [active]), project: "other" }).hidden, 1);
});

test("active enrolled native work remains visible outside collapsed branches and is deduplicated once expanded", () => {
  const entry = nativeEntry("book");
  const fleet: Fleet = {
    observedAt: at,
    total: 1,
    partial: false,
    note: "",
    tasks: [],
    edges: [],
    nodes: [
      {
        id: uuid(100),
        task: uuid(20),
        host: "book",
        serverId: "book",
        agentId: entry.agentId,
        project: uuid(1000),
        title: "Book",
        provider: "codex",
        model: null,
        mode: "human",
        status: "running",
        pending: 0,
        observedAt: at,
        updatedAt: at,
        error: null,
      },
    ],
  };
  const collapsed = liveMapRows({ ...liveInput([], [entry]), fleet });
  assert.equal(collapsed.rows.filter((row) => row.kind === "session").length, 1);
  assert.equal(collapsed.rows[0].id, "observed-branches");
  const expanded = liveMapRows({
    ...liveInput(
      [{ ...collapsed.rows[1], id: "controller", target: { sessionId: uuid(100) } }],
      [entry],
    ),
    fleet,
  });
  assert.equal(expanded.rows.length, 1);
  assert.equal(expanded.rows[0].target.serverId, "book");
});

test("active default keeps top-level organisation but excludes idle/unknown history until requested", () => {
  const entry = nativeEntry("book", { activity: "unknown" });
  const org = buildOutline({ overview: overview(2), projects: {}, expanded: [] }).rows;
  const active = liveMapRows({ ...liveInput(org, [entry]), activity: "active" });
  assert.equal(active.rows.filter((row) => row.kind === "prime").length, 1);
  assert.equal(active.rows.filter((row) => row.kind === "project").length, 2);
  assert.equal(active.rows.filter((row) => row.kind === "session").length, 0);
  assert.equal(active.hidden, 1);
  assert.equal(
    liveMapRows({ ...liveInput(org, [entry]), activity: "unknown" }).rows.filter(
      (row) => row.kind === "session",
    ).length,
    1,
  );
});
