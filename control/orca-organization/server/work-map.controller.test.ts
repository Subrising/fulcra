// Controller contract test: the J2 readers against the REAL controller (in-process, temporary journal,
// a local native double that never starts a session). Hand-written fixtures in work-map.test.ts can
// drift from what bindings-status / bindings-project / channels-status actually return; this cannot.
// Needs the sibling controller source (../../src/control), so it runs from verify-controller-contract.mjs,
// not from the standalone plugin suite.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
// @ts-ignore controller source is plain ESM without declarations
import { FENCE_PROTOCOL } from "../../src/control/native-fence.mjs";
// @ts-ignore
import { ControlStore } from "../../src/control/store.mjs";
// @ts-ignore
import { Controller } from "../../src/control/controller.mjs";
// @ts-ignore
import { Bindings } from "../../src/control/bindings.mjs";
// @ts-ignore
import { RoleChannels } from "../../src/control/role-channels.mjs";
// @ts-ignore
import { RoleSessions } from "../../src/control/role-sessions.mjs";
// @ts-ignore
import { COMPANY, PROGRAMME } from "../../src/control/authority.mjs";
// @ts-ignore
import { rpc } from "../../src/control/rpc.mjs";
import { createWorkMapProjectReader, createWorkMapReader } from "./work-map";
import { buildOutline, seatText } from "../client/work-map-model";
import type { Fleet } from "../shared/fleet";

const P = (n: number) => `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`;
const T = (n: number) => `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;
const OP = "test-operator";
const issue = (id: string) => ({
  id,
  companyId: COMPANY,
  parentId: id === PROGRAMME ? null : PROGRAMME,
  assigneeUserId: "local-board",
  assigneeAgentId: null,
  status: "in_progress",
});
const directory = {
  observedAt: "2026-09-23T00:00:00.000Z",
  available: true,
  partial: false,
  note: "contract project source",
  projects: [
    { id: P(1), name: "Orca platform", description: null, status: "in_progress" },
    { id: P(2), name: "LinkedIn and content", description: null, status: "planned" },
  ],
  membership: [
    { taskId: T(1), projectId: P(1) },
    { taskId: T(2), projectId: P(1) },
    { taskId: T(3), projectId: P(2) },
  ],
};

async function seeded(t: { after: (fn: () => void) => void }) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "j2-contract-")));
  const store = new ControlStore(path.join(dir, "journal.sqlite"));
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const native = {
    route: () => undefined,
    create: async (a: any) => ({
      id: randomUUID(),
      cwd: path.join(dir, a.messageId),
      managerToolsVersion: "1",
      roleToolsVersion: "1",
    }),
    inspect: async () => ({
      boot: "fixture",
      fenceProtocol: FENCE_PROTOCOL,
      saturated: false,
      humanAt: 0,
      status: "idle",
      pending: 0,
      lastPromptId: null,
    }),
    send: async () => undefined,
  };
  const control = new Controller({ store, native, authority: async (id: string) => issue(id) });
  control.bindings = new Bindings(control, async () => directory, path.join(dir, "grants", "role"));
  control.channels = new RoleChannels(control, () => Date.now());
  control.roleSessions = new RoleSessions(control);
  const request = rpc(control, OP);
  const enrol = (task: string) => {
    const id = randomUUID();
    store.created(id, task, path.join(dir, "SECRET-CWD", id));
    return id;
  };
  const methods: string[] = [];
  const call = (method: string, input?: unknown) => {
    methods.push(method);
    return request({ method, input, operator: OP });
  };

  // A human-held prime on the programme root.
  const prime = enrol(PROGRAMME);
  await control.bindings.assign({
    role: "prime",
    seat: "delivery",
    sessionId: prime,
    expectedSessionGeneration: 1,
    expectedRevision: 0,
    note: "Accountable main assistant role for delivery",
  });
  await request({
    method: "seat-hold",
    operator: OP,
    input: {
      role: "prime",
      seat: "delivery",
      expectedRevision: 1,
      expectedSessionGeneration: 1,
      note: "Held by the human-facing lead for this programme",
    },
  });
  // A delegated project orchestrator that starts one session (recorded parent) under project 1.
  const lead = enrol(T(1));
  await control.bindings.assign({
    role: "project-orchestrator",
    seat: P(1),
    sessionId: lead,
    expectedSessionGeneration: 1,
    expectedRevision: 0,
    note: "Owns delivery of this project",
  });
  await control.handback(lead, "Delegated for the contract verification");
  const capability = JSON.parse(
    fs.readFileSync(
      control.bindings.grantRole({
        sessionId: lead,
        expectedGeneration: store.get(lead).generation,
      }).grantFile,
      "utf8",
    ),
  ).capability;
  await request({
    method: "roles-allowance-set",
    operator: OP,
    input: {
      role: "project-orchestrator",
      seat: P(1),
      expectedRevision: 1,
      maxSessions: 2,
      note: "Two sessions for this delivery cycle",
    },
  });
  await request({
    method: "roles-create-session",
    capability,
    input: {
      sessionId: lead,
      seat: P(1),
      taskId: T(1),
      messageId: randomUUID(),
      provider: "claude",
      title: "Implement the release flag",
    },
  });
  const child = (store.list() as any[]).find(
    (s) => s.id !== lead && s.id !== prime && s.task === T(1),
  )?.id;
  // A session on a member task with no recorded owner.
  const loose = enrol(T(2));
  return { dir, store, control, call, methods, prime, lead, child, loose, capability };
}

const fleetOf = (ids: [string, string, string][]): Fleet => ({
  observedAt: new Date().toISOString(),
  total: ids.length,
  partial: false,
  note: "n",
  tasks: [],
  edges: [],
  nodes: ids.map(([id, task, status]) => ({
    id,
    task,
    host: "mini",
    agentId: id,
    title: `Session ${id.slice(0, 4)}`,
    provider: "claude",
    model: null,
    mode: "delegated",
    status,
    pending: 0,
    observedAt: null,
    updatedAt: null,
    error: null,
  })),
});

test("contract: the overview reads the real role, hold and channel tables", async (t) => {
  const f = await seeded(t);
  assert.ok(f.child, "the role created a session");
  const d = await createWorkMapReader({
    call: f.call,
    fleet: async () =>
      fleetOf([
        [f.lead, T(1), "running"],
        [f.child, T(1), "idle"],
      ]),
    projects: async () => directory,
  })();
  assert.equal(d.available, true);
  assert.equal(d.primes.length, 1);
  assert.equal(d.primes[0].hold, "effective");
  assert.equal(d.primes[0].session?.mode, "human");
  assert.equal(seatText(d.primes[0]), "Held by you");
  const p1 = d.projects.find((p) => p.projectId === P(1))!,
    p2 = d.projects.find((p) => p.projectId === P(2))!;
  assert.equal(p1.seat?.state, "assigned");
  assert.equal(p1.seat?.sessionId, f.lead);
  assert.equal(p1.seat?.session?.mode, "delegated");
  assert.equal(p1.sessions, 2);
  assert.equal(p2.seat, null);
  assert.ok(d.attention.some((a) => a.kind === "no-project-orchestrator" && a.projectId === P(2)));
  assert.deepEqual([...new Set(f.methods)].sort(), ["bindings-status", "channels-status"]);
  const json = JSON.stringify(d);
  assert.ok(
    !json.includes("SECRET-CWD") && !json.includes(f.dir) && !json.includes(f.capability),
    "no cwd, journal path or capability",
  );
});

test("contract: the project read yields recorded parent links and unknown ownership from the real projection", async (t) => {
  const f = await seeded(t);
  const issues = async () => ({
    observedAt: new Date().toISOString(),
    providers: [],
    issues: [],
    truncated: false,
  });
  const d = await createWorkMapProjectReader({
    call: f.call,
    fleet: async () => fleetOf([[f.lead, T(1), "running"]]),
    issues,
  })({ projectId: P(1) });
  assert.equal(d.available, true);
  assert.equal(d.name, "Orca platform");
  assert.equal(d.leader?.sessionId, f.lead);
  assert.deepEqual(d.workstreams.map((w) => w.taskId).sort(), [T(1), T(2)]);
  const w1 = d.workstreams.find((w) => w.taskId === T(1))!,
    w2 = d.workstreams.find((w) => w.taskId === T(2))!;
  const child = w1.sessions.find((s) => s.sessionId === f.child)!;
  assert.equal(child.ownership, "recorded");
  assert.equal(child.parentSession, f.lead);
  assert.equal(child.seat, P(1));
  assert.equal(child.seatRole, "project-orchestrator");
  assert.equal(w2.sessions.find((s) => s.sessionId === f.loose)?.ownership, "unknown");
  assert.ok(d.needed.some((n) => n.kind === "unowned-session" && n.sessionId === f.loose));
  assert.deepEqual([...new Set(f.methods)].sort(), ["bindings-project", "bindings-status"]);
  const json = JSON.stringify(d);
  assert.ok(
    !json.includes("SECRET-CWD") && !json.includes(f.dir) && !json.includes(f.capability),
    "no cwd, journal path or capability",
  );

  // And the outline nests the child under its recorded parent.
  const ov = await createWorkMapReader({
    call: f.call,
    fleet: async () => fleetOf([]),
    projects: async () => directory,
  })();
  const rows = buildOutline({ overview: ov, projects: { [P(1)]: d }, expanded: [P(1)] }).rows;
  assert.equal(
    rows.find((r) => r.target.sessionId === f.child)?.parent,
    `session:${T(1)}:${f.lead}`,
  );
});

test("contract: with the operator secret wrong, the controller refuses and the map says unknown, not empty", async (t) => {
  const f = await seeded(t);
  const request = rpc(f.control, OP);
  const wrong = (method: string, input?: unknown) =>
    request({ method, input, operator: "not-the-operator" });
  const d = await createWorkMapReader({
    call: wrong,
    fleet: async () => fleetOf([]),
    projects: async () => directory,
  })();
  assert.equal(d.available, false);
  assert.match(d.unavailable ?? "", /Operator authorization required/);
  assert.ok(!d.attention.some((a) => a.kind === "no-project-orchestrator"));
});
