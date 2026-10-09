import test from "node:test";
import assert from "node:assert/strict";
import type { Fleet } from "../shared/fleet";
import { buildTeamTree, modelLabel, type TeamCard } from "./team-tree";

type FleetNode = Fleet["nodes"][number];
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const TASK = "10000000-0000-4000-8000-000000000001";
const PROJECT = "20000000-0000-4000-8000-000000000001";
const node = (over: Partial<FleetNode>): FleetNode => ({
  id: uuid(),
  task: TASK,
  host: "Studio Mac",
  agentId: null,
  title: "Session",
  provider: "claude",
  model: "Opus 5.5",
  mode: "default",
  status: "idle",
  pending: 0,
  observedAt: null,
  updatedAt: null,
  error: null,
  ...over,
});
const shape = (card: TeamCard): unknown => ({
  role: card.roleLabel,
  state: card.stateLabel,
  ...(card.children.length ? { children: card.children.map(shape) } : {}),
});

test("main assistant leads project leads, which run workers, each in plain words", () => {
  const main = node({ title: "Fulcra main", status: "running" });
  const lead = node({ title: "Forecast", parent: main.id, project: PROJECT, pending: 1 });
  const working = node({ title: "Table", parent: lead.id, status: "running" });
  const paused = node({
    title: "Units",
    parent: lead.id,
    quotaWait: {
      messageId: uuid(),
      sessionId: uuid(),
      taskId: TASK,
      state: "waiting",
      reason: "provider-limit",
      since: null,
      checkedAt: null,
      nextCheckAt: "2026-10-07T04:20:00.000Z",
    },
  });
  const tree = buildTeamTree({
    nodes: [paused, working, lead, main],
    mainSessionIds: new Set([main.id]),
    projectNames: new Map([[PROJECT, "weather-cli"]]),
    formatTime: () => "14:20",
  });
  assert.deepEqual(tree.roots.map(shape), [
    {
      role: "Main assistant",
      state: "Working",
      children: [
        {
          role: "Project lead · weather-cli",
          state: "Waiting for you",
          children: [
            { role: "Worker", state: "Working" },
            { role: "Worker", state: "Paused" },
          ],
        },
      ],
    },
  ]);
  const leadCard = tree.roots[0]!.children[0]!;
  assert.equal(leadCard.now, "Has a question for you about Forecast");
  assert.equal(leadCard.children[0]!.now, "Working on Table");
  assert.equal(leadCard.children[1]!.now, "Paused: usage limit, checks again at 14:20");
  assert.equal(tree.roots[0]!.runs, "Claude · Opus 5.5");
  assert.equal(tree.summary, "2 working · 1 waiting for you · 1 paused");
});

test("supervision edges place workers when the session has no parent label", () => {
  const lead = node({ title: "Lead", role: "project-orchestrator" });
  const worker = node({ title: "Worker one" });
  const tree = buildTeamTree({
    nodes: [worker, lead],
    edges: [{ from: lead.id, to: worker.id, active: true, state: "working", event: null }],
  });
  assert.deepEqual(tree.roots.map(shape), [
    { role: "Project lead", state: "Idle", children: [{ role: "Worker", state: "Idle" }] },
  ]);
  assert.equal(tree.roots[0]!.children[0]!.now, "Finished its last message on Worker one");
});

test("offline sessions on one computer show once", () => {
  const tree = buildTeamTree({
    nodes: [
      node({ host: "Book", title: "A" }),
      node({ host: "Book", title: "B", status: "unavailable" }),
      node({ host: "Book", title: "C" }),
      node({ host: "Mini", title: "D", status: "running" }),
    ],
    offlineHosts: new Set(["Book"]),
  });
  assert.equal(tree.roots.length, 2);
  const offline = tree.roots.find((card) => card.state === "offline")!;
  assert.equal(offline.roleLabel, "Offline computer");
  assert.equal(offline.sessions, 3);
  assert.equal(offline.now, "3 sessions on Book can't be reached right now");
  assert.equal(tree.summary, "1 working · 3 offline");
});

test("a recorded loop is cut and still shown; an empty fleet says so", () => {
  const a = node({ title: "A" });
  const b = node({ title: "B", parent: a.id });
  a.parent = b.id;
  const tree = buildTeamTree({ nodes: [a, b] });
  assert.equal(tree.roots.length, 1);
  assert.equal(tree.roots[0]!.children.length, 1);
  assert.equal(buildTeamTree({ nodes: [] }).summary, "No sessions yet");
});

test("Claude model ids read as people say them; other names stay as they are", () => {
  assert.equal(modelLabel("claude-haiku-4-5"), "Haiku 4.5");
  assert.equal(modelLabel("claude-haiku-4-5-20251001"), "Haiku 4.5");
  assert.equal(modelLabel("claude-opus-5"), "Opus 5");
  assert.equal(modelLabel("Opus 5.5"), "Opus 5.5");
  assert.equal(modelLabel("gpt-6.1-sol"), "gpt-6.1-sol");
  const tree = buildTeamTree({ nodes: [node({ provider: "claude", model: "claude-haiku-4-5" })] });
  assert.equal(tree.roots[0]!.runs, "Claude · Haiku 4.5");
});

test("a team set up from existing chats shows the main assistant above every lead, and workers under their lead", () => {
  const main = node({ title: "Main assistant" });
  const lead = node({ title: "Fulcra thin fork", project: PROJECT });
  const worker = node({ title: "Review", project: PROJECT });
  const loose = node({ title: "Scratch" });
  const tree = buildTeamTree({
    nodes: [worker, loose, lead, main],
    mainSessionIds: new Set([main.id]),
    mainSessionId: main.id,
    leadSessionIds: new Set([lead.id]),
    leadByProject: new Map([[PROJECT, lead.id]]),
    projectNames: new Map([[PROJECT, "Fulcra"]]),
  });
  assert.deepEqual(tree.roots.map(shape), [
    {
      role: "Main assistant",
      state: "Idle",
      children: [
        {
          role: "Project lead · Fulcra",
          state: "Idle",
          children: [{ role: "Worker · Fulcra", state: "Idle" }],
        },
      ],
    },
    { role: "Worker", state: "Idle" },
  ]);
});

test("reporting lines place chats, follow the main assistant role, and mark a chat with no line", () => {
  const main = node({ title: "Main assistant" });
  const lead = node({ title: "Mac ops", reportsTo: "role:main-assistant" });
  const worker = node({ title: "Installer", reportsTo: lead.id, directLink: main.id });
  const loose = node({ title: "Scratch" });
  const tree = buildTeamTree({
    nodes: [main, lead, worker, loose],
    mainSessionIds: new Set([main.id]),
    mainSessionId: main.id,
  });
  const top = tree.roots.find((c) => c.id === main.id)!;
  assert.equal(top.noLine, false);
  const leadCard = top.children.find((c) => c.id === lead.id)!;
  assert.equal(leadCard.noLine, false);
  const workerCard = leadCard.children.find((c) => c.id === worker.id)!;
  assert.equal(workerCard.noLine, false);
  assert.equal(workerCard.directLink, "Main assistant");
  const looseCard = tree.roots.find((c) => c.id === loose.id)!;
  assert.equal(looseCard.noLine, true);
});
