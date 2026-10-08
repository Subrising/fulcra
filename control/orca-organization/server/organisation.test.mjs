// Fulcra J1 Organisation RPC contracts (CONTRACTS.md §4, §5). The server handlers are driven against the REAL
// controller on a temporary journal (src/control/decisions.fixture.mjs plus the J1 stores), so every output schema
// is checked against what the controller actually returns. The TypeScript side is bundled here first (as
// inbox.test.mjs does), so this file runs on its own with `node --test`.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { fixture, P, T } from "../../src/control/decisions.fixture.mjs";
import { Remits } from "../../src/control/remits.mjs";
import { Briefs } from "../../src/control/briefs.mjs";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  require = createRequire(import.meta.url);
const out = path.join(root, "runtime");
fs.mkdirSync(out, { recursive: true });
// The Mini runner prebuilds these under heavy-lock before acquiring a test slot.
if (process.env.FULCRA_TEST_PREBUILT_ORGANISATION !== "1")
  for (const [entry, file] of [
    ["server/organisation.ts", "organisation-server.mjs"],
    ["shared/cc/remit.ts", "cc-remit.mjs"],
    ["shared/cc/brief.ts", "cc-brief.mjs"],
  ])
    await require("esbuild").build({
      entryPoints: [path.join(root, entry)],
      bundle: true,
      platform: "node",
      format: "esm",
      packages: "external",
      outfile: path.join(out, file),
      logLevel: "silent",
    });
const { createOrganisation } = await import(path.join(out, "organisation-server.mjs"));
const R = await import(path.join(out, "cc-remit.mjs"));
const B = await import(path.join(out, "cc-brief.mjs"));
const H = 3600000;
const why = "The delivery main assistant should own this project now";
const brief = (x = {}) => ({
  projectId: P(1),
  health: "at-risk",
  headline: "Launch may slip by a week.",
  now: "Testers found two problems with sign-up; both are being fixed.",
  next: [{ text: "Fix the two sign-up problems", by: null }],
  needsYou: [{ text: "Choose whether to launch on the 1st or the 8th", decision: null }],
  risks: [
    {
      text: "Welcome emails may be slow at launch",
      severity: "medium",
      mitigation: "A second email service is ready",
    },
  ],
  shipped: [],
  evidence: [{ ref: `task:${T(1)}`, label: "The sign-up work" }],
  ...x,
});

async function org(t, nodes = []) {
  const f = await fixture(t);
  f.directory.projects.push({ id: P(2), name: "Tally", description: null, status: "in_progress" });
  f.control.remits = new Remits(f.control, { readProjects: async () => f.directory });
  f.control.briefs = new Briefs(f.control);
  let failing = false;
  const call = (method, input) =>
    failing ? Promise.reject(Error("Controller did not answer")) : f.op(method, input);
  const fleet = {
    observedAt: new Date().toISOString(),
    total: nodes.length,
    partial: false,
    note: "test fleet",
    nodes,
    tasks: [],
    edges: [],
  };
  const o = createOrganisation({
    call,
    fleet: async () => fleet,
    projects: async () => ({ ...f.directory, observedAt: new Date().toISOString() }),
  });
  return {
    f,
    o,
    fleet,
    fail: (v) => {
      failing = v;
    },
  };
}
const node = (task, status, updatedAt = new Date().toISOString()) => ({
  id: randomUUID(),
  task,
  host: "mini",
  agentId: null,
  title: "A worker",
  provider: "claude",
  model: null,
  mode: "delegated",
  status,
  pending: 0,
  observedAt: null,
  updatedAt,
  error: null,
});

test("O1: inputs are strict; no caller can name an actor, a url or a path, and a reason is required", () => {
  const ok = {
    messageId: randomUUID(),
    expectedRevision: 0,
    primeSeat: "delivery",
    scope: { kind: "project", projectId: P(1) },
    note: why,
  };
  assert.equal(R.remitAssignRpc.input.safeParse(ok).success, true);
  for (const extra of [{ actor: "human" }, { url: "https://example.com" }, { path: "a/b" }])
    assert.equal(R.remitAssignRpc.input.safeParse({ ...ok, ...extra }).success, false);
  assert.equal(R.remitAssignRpc.input.safeParse({ ...ok, note: "too short" }).success, false);
  assert.equal(
    R.remitAssignRpc.input.safeParse({ ...ok, note: "Mail it to someone@example.com today" })
      .success,
    false,
  );
  assert.equal(
    R.remitAssignRpc.input.safeParse({
      ...ok,
      scope: { kind: "project", projectId: P(1), label: "x" },
    }).success,
    false,
  );
  assert.equal(R.remitAssignRpc.input.safeParse({ ...ok, primeSeat: "Not A Slug" }).success, false);
  assert.equal(
    R.remitMoveRpc.input.safeParse({
      messageId: randomUUID(),
      expectedRevision: 0,
      remitId: randomUUID(),
      toPrimeSeat: "research",
      note: why,
    }).success,
    false,
    "a move names an existing revision",
  );
  assert.equal(
    R.projectDomainSetRpc.input.safeParse({
      messageId: randomUUID(),
      expectedRevision: 0,
      projectId: P(1),
      domain: null,
      note: why,
    }).success,
    true,
  );
  assert.equal(B.projectBriefRpc.input.safeParse({ projectId: P(1), revision: 2 }).success, false);
});

test("O2: the remit view and every write parse against what the controller returns", async (t) => {
  const { o, f } = await org(t);
  await f.control.remits.refresh(); // Controller-internal directory refresh, never a read RPC.
  const empty = await o.remits();
  assert.equal(empty.stale, false);
  assert.deepEqual(
    empty.primes.map((p) => p.seat),
    ["delivery", "research"],
  );
  assert.deepEqual(
    empty.projects.map((p) => p.owner.primeSeat),
    ["delivery", "delivery"],
  );
  assert(empty.history.every((h) => h.actor === "operator" && h.note.startsWith("default:")));
  f.directory.projects.push({ ...f.directory.projects[0], id: P(3), name: "Fixture project" });
  const a = await o.assign({
    messageId: randomUUID(),
    expectedRevision: 0,
    primeSeat: "delivery",
    scope: { kind: "project", projectId: P(3) },
    note: why,
  });
  assert.equal(a.ok, true);
  assert.equal(a.remit.primeSeat, "delivery");
  const m = await o.move({
    messageId: randomUUID(),
    expectedRevision: a.remit.revision,
    remitId: a.remit.id,
    toPrimeSeat: "research",
    note: "Research is taking over this project this month",
  });
  assert.equal(m.ok, true);
  assert.equal(m.ended.state, "ended");
  assert.equal(m.remit.primeSeat, "research");
  const d = await o.domainSet({
    messageId: randomUUID(),
    expectedRevision: 0,
    projectId: P(2),
    domain: "platform",
    note: "Tally belongs with the platform work",
  });
  assert.equal(d.ok, true);
  assert.deepEqual(d.domain, { projectId: P(2), domain: "platform", revision: 1 });
  const view = await o.remits();
  assert.equal(R.remitsView.safeParse(view).success, true);
  assert.deepEqual(view.projects.find((p) => p.projectId === P(3)).owner, {
    kind: "project",
    primeSeat: "research",
    remitId: m.remit.id,
  });
  assert.deepEqual(
    view.history.map((h) => h.action),
    ["domain-set", "moved", "assigned", "assigned", "assigned"],
  );
  assert.equal(view.history[1].actor, "operator");
  // A refusal is an answer with a sentence, not a thrown error.
  const stale = await o.move({
    messageId: randomUUID(),
    expectedRevision: a.remit.revision,
    remitId: a.remit.id,
    toPrimeSeat: "delivery",
    note: why,
  });
  assert.deepEqual([stale.ok, stale.remit], [false, null]);
  assert.match(stale.message, /Changed since you looked; refresh/);
  const unknown = await o.assign({
    messageId: randomUUID(),
    expectedRevision: 0,
    primeSeat: "orca",
    scope: { kind: "project", projectId: P(2) },
    note: why,
  });
  assert.equal(unknown.ok, false);
  assert.match(unknown.message, /no prime seat with that name/);
});

test('O3: the project brief carries observed counts from the fleet and journal, and "Written by"', async (t) => {
  const { f, o, fleet } = await org(t, [
    node(T(1), "running"),
    node(T(1), "idle"),
    node(T(9), "running"),
  ]);
  const none = await o.brief({ projectId: P(1) });
  assert.equal(none.brief, null);
  assert.equal(none.stale, false);
  assert.deepEqual([none.observed.sessionsRunning, none.observed.sessionsTotal], [1, 2]);
  await f.role("project", "roles-brief-publish", {
    messageId: randomUUID(),
    expectedRevision: 0,
    brief: brief(),
  });
  const read = await o.brief({ projectId: P(1) });
  assert.equal(B.projectBriefRpc.output.safeParse(read).success, true);
  assert.equal(read.brief.headline, "Launch may slip by a week.");
  assert.equal(read.authorName, "the Orca lead");
  assert.equal(read.stale, false);
  assert.equal(read.partial, false);
  assert.deepEqual(
    { ...read.observed, lastActivityAt: undefined, observedAt: undefined },
    {
      sessionsRunning: 1,
      sessionsTotal: 2,
      openDecisions: 0,
      heldMessages: 0,
      lastActivityAt: undefined,
      observedAt: undefined,
    },
  );
  // Session activity seen by the fleet 7 hours after the brief makes it "May be out of date".
  fleet.nodes[1].updatedAt = new Date(Date.parse(read.brief.writtenAt) + 7 * H).toISOString();
  const later = await o.brief({ projectId: P(1) });
  assert.equal(later.stale, true);
  assert.equal(later.observed.lastActivityAt, fleet.nodes[1].updatedAt);
});

test("O4: a stalled controller returns the last good value, marked out of date, never an empty screen", async (t) => {
  const { f, o, fail } = await org(t);
  await f.role("project", "roles-brief-publish", {
    messageId: randomUUID(),
    expectedRevision: 0,
    brief: brief(),
  });
  const good = await o.brief({ projectId: P(1) }),
    remits = await o.remits();
  fail(true);
  const stalled = await o.brief({ projectId: P(1) });
  assert.equal(stalled.brief.headline, good.brief.headline);
  assert.equal(stalled.stale, true);
  assert.equal(stalled.error, "Controller did not answer");
  const view = await o.remits();
  assert.deepEqual(view.primes, remits.primes);
  assert.equal(view.stale, true);
  const unseen = await o.brief({ projectId: P(2) });
  assert.equal(unseen.brief, null);
  assert.equal(unseen.stale, true);
  assert.equal(unseen.partial, true);
});
