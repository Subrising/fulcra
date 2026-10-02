import test from "node:test";
import assert from "node:assert/strict";
import { buildToday, plain, plainTitle, limitWords, type TodayInputs } from "./today-model";

const P = "00000000-0000-46cd-9b65-000000002006",
  Q = "00000000-0000-46cd-9b65-000000002009";
const T = "00000000-0000-43b8-b458-000000002008";
const sid = (n: number) => `4c111479-b424-43e5-bd1e-${String(n).padStart(12, "0")}`;
const NOW = Date.parse("2026-09-29T02:20:00.000Z"),
  SINCE = Date.parse("2026-09-28T20:00:00.000Z");
const node = (n: number, status: string, updatedAt: string, extra: object = {}) => ({
  id: sid(n),
  task: T,
  host: "local",
  agentId: sid(n),
  title: `Session ${n}`,
  provider: "claude",
  model: null,
  mode: "delegated",
  status,
  pending: null,
  observedAt: null,
  updatedAt,
  error: null,
  ...extra,
});
const fleet = (nodes: object[]) =>
  ({
    observedAt: "x",
    total: nodes.length,
    partial: false,
    note: "",
    nodes,
    tasks: [],
    edges: [],
  }) as any;
const seat = {
  role: "project",
  seat: P,
  state: "assigned",
  sessionId: sid(99),
  revision: 1,
  hold: null,
} as any;
const map = (projects: object[]) =>
  ({
    observedAt: "2026-09-29T02:20:00.000Z",
    available: true,
    unavailable: null,
    primes: [],
    projects,
    unplaced: [],
    attention: [],
    sources: {} as any,
    note: "",
  }) as any;
const project = (projectId: string, name: string, sessions: number, withSeat = true) => ({
  projectId,
  name,
  status: "in_progress",
  seat: withSeat ? seat : null,
  channels: [],
  workstreams: 1,
  sessions,
  running: 0,
});
const observed = (held: number, decisions = 0) =>
  ({
    version: 1,
    observedAt: "x",
    partial: false,
    error: null,
    projectId: P,
    brief: null,
    authorName: null,
    stale: false,
    observed: {
      sessionsRunning: 0,
      sessionsTotal: 0,
      openDecisions: decisions,
      heldMessages: held,
      lastActivityAt: null,
      observedAt: "x",
    },
  }) as any;
const base = (over: Partial<TodayInputs> = {}): TodayInputs => ({
  now: NOW,
  since: SINCE,
  map: map([project(P, "Fulcra Command Centre", 3)]),
  fleets: {},
  briefs: {},
  inbox: undefined,
  inboxFailed: false,
  recovery: undefined,
  timeZone: "Australia/Brisbane",
  ...over,
});
const stop = (n: number, resetAt: string, stoppedAt = "2026-09-28T11:06:35.349Z") => ({
  id: sid(500 + n),
  sessionId: sid(n),
  line: "You've hit your weekly limit · resets 8am (Australia/Brisbane)",
  resetAt,
  stoppedAt,
  state: "notified",
});

test("operator words become plain words, and tracking codes leave titles", () => {
  assert.equal(plain("Command Centre project orchestrator"), "Command Centre project lead");
  assert.equal(
    plain("the delivery prime took the seat after a generation change; ack pending"),
    "the delivery lead took the role after a restart change; receipt pending",
  );
  assert.equal(
    plainTitle("CC R-V11B: adversarial security review of V1.1b"),
    "Adversarial security review of V1.1b",
  );
  assert.equal(
    plainTitle("C2-review (security, high): adversarial review of the sweep"),
    "Adversarial review of the sweep",
  );
  assert.equal(
    plainTitle("Build: Today front door"),
    "Build: Today front door",
    "a word label is kept",
  );
  assert.equal(plainTitle("E3 OpenClaw proof"), "E3 OpenClaw proof", "no colon, nothing stripped");
  assert.equal(
    plainTitle("CC FIX: manager-created worker never starts"),
    "Manager-created worker never starts",
  );
  assert.equal(plainTitle("CC INT: v0.2 integration branches"), "V0.2 integration branches");
});

test("a usage-limit stop reads as the owner would say it, before and after the reset", () => {
  const before = Date.parse("2026-09-28T20:00:00.000Z"),
    after = Date.parse("2026-09-28T23:00:00.000Z");
  assert.equal(
    limitWords(
      "You've hit your weekly limit · resets 8am (Australia/Brisbane)",
      "2026-09-28T22:00:00.000Z",
      before,
    ),
    "hit its weekly usage limit, resets 8am",
  );
  assert.equal(
    limitWords(
      "You've hit your weekly limit · resets 8am (Australia/Brisbane)",
      "2026-09-28T22:00:00.000Z",
      after,
    ),
    "hit its weekly usage limit; that reset at 8am, so it can carry on when you say",
  );
  assert.equal(
    limitWords(null, "2026-09-28T22:00:00.000Z", before, "Australia/Brisbane"),
    "hit its usage limit, resets 8am",
  );
});

test("stuck work names the session and the reason; work that moved on since is not stuck", () => {
  const t = buildToday(
    base({
      now: Date.parse("2026-09-28T21:00:00.000Z"),
      fleets: {
        [P]: fleet([
          node(1, "idle", "2026-09-28T11:06:00.000Z"),
          node(2, "running", "2026-09-28T20:59:00.000Z"),
        ]),
      },
      recovery: {
        usageLimits: {
          stops: [stop(1, "2026-09-28T22:00:00.000Z"), stop(2, "2026-09-28T22:00:00.000Z")],
        },
      },
    }),
  );
  assert.deepEqual(
    t.blocked.map((b) => b.text),
    ["Session 1: hit its weekly usage limit, resets 8am"],
  );
  assert.deepEqual(
    t.projects[0].running.map((r) => r.text),
    ["Session 2"],
  );
  assert.equal(t.projects[0].story.health, "at-risk");
});

test("permission waits, errors and restarts are stuck work too, in plain words", () => {
  const t = buildToday(
    base({
      fleets: {
        [P]: fleet([
          node(1, "idle", "2026-09-29T01:00:00.000Z", { pending: 2 }),
          node(2, "error", "2026-09-29T01:00:00.000Z", { error: "provider refused the request" }),
          node(3, "idle", "2026-09-28T01:00:00.000Z"),
        ]),
      },
      recovery: {
        items: [
          { sessionId: sid(3), state: "interrupted-turn", since: "2026-09-28T09:43:08.721Z" },
        ],
      },
    }),
  );
  assert.deepEqual(t.blocked.map((b) => b.text).sort(), [
    "Session 2: stopped with an error: provider refused the request",
    "Session 3: stopped mid-task when the computer restarted",
  ]);
});

test("done since you last looked, running now, and waiting sessions are told apart", () => {
  const t = buildToday(
    base({
      fleets: {
        [P]: fleet([
          node(1, "idle", "2026-09-29T01:00:00.000Z"),
          node(2, "closed", "2026-09-29T00:00:00.000Z"),
          node(3, "running", "2026-09-29T02:19:00.000Z", { backgroundWork: { count: 2 } }),
          node(4, "idle", "2026-09-28T10:00:00.000Z"),
          node(5, "closed", "2026-09-20T10:00:00.000Z"),
        ]),
      },
    }),
  );
  assert.deepEqual(
    t.done.map((d) => d.text),
    ["Session 1", "Session 2"],
  );
  assert.match(t.done[1].detail!, /^Finished and closed/);
  assert.deepEqual(
    t.projects[0].running.map((r) => [r.text, r.detail]),
    [["Session 3", "Working · last active 1 min ago"]],
    "background work stays on the Sessions display (MH3 §6.3)",
  );
  assert.deepEqual(
    t.projects[0].waiting.map((r) => r.text),
    ["Session 4"],
  );
  assert.equal(t.firstLook, false);
  assert.equal(
    buildToday(base({ since: null })).firstLook,
    true,
    "a first look covers the last day",
  );
});

test("without a written update, the story is generated from the live sessions and says so", () => {
  const t = buildToday(
    base({
      fleets: {
        [P]: fleet([
          node(3, "running", "2026-09-29T02:19:00.000Z"),
          node(1, "idle", "2026-09-29T01:00:00.000Z"),
        ]),
      },
      briefs: { [P]: observed(33) },
    }),
  );
  const s = t.projects[0].story;
  assert.equal(s.written, false);
  assert.equal(s.headline, "1 piece of work going now");
  assert.equal(s.now, "Working now: Session 3. Most recently finished: Session 1 (1 h ago).");
  assert.deepEqual(s.next, ["You: 33 messages waiting for you to read or pass on"]);
  assert.match(s.byline, /hasn't written an update yet/);
});

test("a written update is used as the story, in plain words", () => {
  const brief = {
    version: 1,
    projectId: P,
    revision: 3,
    author: { seat: P, sessionId: sid(99) },
    writtenAt: "2026-09-29T02:00:00.000Z",
    health: "on-track",
    headline: "Inbox fix lands today",
    now: "The orchestrator is testing the fix.",
    next: [{ text: "Ship to the prime", by: null }],
    needsYou: [],
    risks: [],
    shipped: [{ text: "Tracker refresh", ref: null }],
    evidence: [],
  };
  const t = buildToday(base({ briefs: { [P]: { ...observed(0), brief } } }));
  const s = t.projects[0].story;
  assert.equal(s.written, true);
  assert.equal(s.now, "The lead is testing the fix.");
  assert.deepEqual(s.next, ["Ship to the lead"]);
  assert.deepEqual(
    t.done.map((d) => d.text),
    ["Tracker refresh"],
    "shipped since last look counts as done",
  );
});

test("needs you: decisions from the inbox open in place; held counts stand in when the inbox cannot be read", () => {
  const inbox = {
    version: 1,
    observedAt: "2026-09-29T02:20:00.000Z",
    partial: false,
    stale: false,
    error: null,
    counts: {} as any,
    items: [
      {
        key: `decision-${sid(7)}`,
        source: "decision",
        ref: `decision:${sid(7)}`,
        title: "Pick the orchestrator refresh design",
        summary: "Two options.",
        projectId: P,
        urgency: "now",
        createdAt: "2026-09-29T02:00:00.000Z",
        unread: true,
      },
    ],
  } as any;
  const ok = buildToday(base({ inbox, briefs: { [P]: observed(0, 1) } }));
  assert.deepEqual(
    ok.needs.map((n) => [n.text, n.action]),
    [["Pick the lead refresh design", { kind: "decision", id: sid(7) }]],
  );
  assert.deepEqual(ok.gaps, []);
  const failed = buildToday(base({ inboxFailed: true, briefs: { [P]: observed(33, 2) } }));
  assert.deepEqual(
    failed.needs.map((n) => n.text),
    ["33 messages waiting for you to read or pass on", "2 decisions waiting for your answer"],
  );
  assert.equal(failed.gaps.length, 1);
});

test("a project with work and no one leading it needs you; an empty one does not", () => {
  const t = buildToday(
    base({
      map: map([project(P, "Orca platform", 16, false), project(Q, "Product strategy", 0, false)]),
    }),
  );
  assert.deepEqual(
    t.needs.map((n) => n.text),
    ["Orca platform has work but no one leading it"],
  );
  assert.equal(
    t.projects.find((p) => p.projectId === Q)!.story.headline,
    "No work has started here yet",
  );
});

test("nothing readable still gives a page that says what it could not read", () => {
  const t = buildToday(base({ map: undefined, inboxFailed: true }));
  assert.equal(t.projects.length, 0);
  assert.equal(t.gaps.length, 2);
});

test("a session that worked after its usage-limit stop is not stuck, whatever its status now", () => {
  const t = buildToday(
    base({
      fleets: { [P]: fleet([node(1, "idle", "2026-09-28T15:00:00.000Z")]) },
      recovery: { usageLimits: { stops: [stop(1, "2026-09-28T22:00:00.000Z")] } },
    }),
  );
  assert.deepEqual(t.blocked, []);
});

test("a session on another computer that can't be observed is out of sight, not stuck", () => {
  const t = buildToday(
    base({
      fleets: {
        [P]: fleet([
          node(1, "idle", "2026-09-29T01:00:00.000Z", {
            error: "Native observation unavailable; session retained",
          }),
        ]),
      },
    }),
  );
  assert.deepEqual(t.blocked, []);
  assert.deepEqual(t.gaps, ["1 session on another computer can't be seen from here right now."]);
});

test("the latest restart becomes one plain line that links to what stopped", () => {
  const item = (n: number, resumable: boolean) => ({
    sessionId: sid(n),
    interruptionId: sid(300 + n),
    cause: "boot",
    state: resumable ? "idle-at-restart" : "not-resumable",
    resumable,
    since: "2026-09-28T09:43:08.721Z",
    observedBoot: sid(900),
    turn: "ended",
    reason: null,
    generation: 1,
  });
  const t = buildToday(
    base({ recovery: { items: [item(1, true), item(2, false), item(3, false)] } }),
  );
  assert.deepEqual(
    t.needs.map((n) => [n.text, n.detail, n.action]),
    [
      [
        "The computer restarted 17 h ago and 3 sessions stopped",
        "1 can pick up where it left off if you say so. The rest need starting again.",
        { kind: "recovery" },
      ],
    ],
  );
  assert.deepEqual(
    buildToday(
      base({ now: Date.parse("2026-10-09T00:00:00.000Z"), recovery: { items: [item(1, true)] } }),
    ).needs,
    [],
    "an old restart is not news",
  );
});

test("U5-D01: a partial inbox is a named gap on Today, never a silent all-clear", () => {
  const inbox = {
    version: 1,
    observedAt: "2026-09-29T02:20:00.000Z",
    partial: true,
    stale: false,
    error: null,
    counts: {} as any,
    items: [],
  } as any;
  const t = buildToday(base({ inbox }));
  assert.ok(JSON.stringify(t).includes("Part of the inbox could not be read just now"));
});

test("U7 pending running session appears under Needs you and never Working", () => {
  const t = buildToday(
    base({
      fleets: { [P]: fleet([node(1, "running", "2026-09-29T02:19:00.000Z", { pending: 1 })]) },
    }),
  );
  assert.equal(t.projects[0].running.length, 0);
  assert.equal(t.needs.filter((n) => n.action?.kind === "session").length, 1);
  assert.match(t.needs[0].text, /needs you/i);
});
