// Seating defaults: PROPOSAL.md §1, §2, §3, §5 and the ADDITION, approved by the prime 2026-09-23.
//
// The property under test throughout is that a default is a FLOOR for routine work, never a budget the seat
// chooses. Every one of them is bounded, revision-pinned, visible as a default rather than as a decision,
// and removable by an operator. Seating itself must never fail because a default could not be conferred.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { FENCE_PROTOCOL } from "./native-fence.mjs";
import { ControlStore } from "./store.mjs";
import { Controller } from "./controller.mjs";
import { Bindings } from "./bindings.mjs";
import { RoleChannels } from "./role-channels.mjs";
import { RoleSessions } from "./role-sessions.mjs";
import { COMPANY, PROGRAMME } from "./authority.mjs";
import { rpc } from "./rpc.mjs";

const P = (n) => `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`;
const T = (n) => `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;
const issue = (id) => ({
  id,
  companyId: COMPANY,
  parentId: id === PROGRAMME ? null : PROGRAMME,
  assigneeUserId: "local-board",
  assigneeAgentId: null,
  status: "in_progress",
});

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-seating-defaults-")));
  const store = new ControlStore(path.join(dir, "journal.sqlite"));
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const created = [],
    sent = [],
    states = new Map();
  const native = {
    route: () => undefined,
    create: async (a) => {
      const id = randomUUID();
      created.push({ ...a, id });
      return {
        id,
        cwd: path.join(dir, a.messageId),
        managerToolsVersion: "1",
        roleToolsVersion: "1",
      };
    },
    inspect: async (id) => ({
      boot: "fixture",
      fenceProtocol: FENCE_PROTOCOL,
      saturated: false,
      humanAt: 0,
      status: "idle",
      pending: 0,
      lastPromptId: null,
      ...states.get(id),
    }),
    send: async (id, text, messageId) => {
      sent.push({ id, text, messageId });
      states.set(id, { ...states.get(id), lastPromptId: messageId });
    },
  };
  const control = new Controller({ store, native, authority: async (id) => issue(id) });
  const source = {
    value: {
      observedAt: "2026-09-19T00:00:00.000Z",
      available: true,
      partial: false,
      projects: [
        { id: P(1), name: "One", description: null, status: "in_progress" },
        { id: P(2), name: "Two", description: null, status: "in_progress" },
      ],
      membership: [
        { taskId: T(1), projectId: P(1) },
        { taskId: T(2), projectId: P(1) },
        { taskId: T(3), projectId: P(2) },
      ],
      note: "test project source",
    },
  };
  control.bindings = new Bindings(
    control,
    async () => source.value,
    path.join(dir, "grants", "role"),
  );
  control.channels = new RoleChannels(control, () => Date.now());
  control.roleSessions = new RoleSessions(control);
  const enrol = (task) => {
    const id = randomUUID();
    store.created(id, task, path.join(dir, id));
    return id;
  };
  const capabilityFor = (id) =>
    JSON.parse(
      fs.readFileSync(
        control.bindings.grantRole({ sessionId: id, expectedGeneration: store.get(id).generation })
          .grantFile,
        "utf8",
      ),
    ).capability;
  const assign = (
    role,
    seat,
    sessionId,
    expectedRevision,
    note = "Seating for the defaults verification",
  ) =>
    control.bindings.assign({
      role,
      seat,
      sessionId,
      expectedSessionGeneration: store.get(sessionId).generation,
      expectedRevision,
      note,
    });
  return {
    dir,
    store,
    control,
    created,
    sent,
    states,
    source,
    enrol,
    capabilityFor,
    assign,
    request: rpc(control, "test-operator"),
    delegate: (id) => control.handback(id, "Delegated for the defaults verification"),
  };
}
// A seated project orchestrator with no prime anywhere, so §1 can be measured without §2 interfering.
async function project(t) {
  const f = fixture(t),
    lead = f.enrol(T(1));
  const seated = await f.assign("project-orchestrator", P(1), lead, 0);
  await f.delegate(lead);
  return { ...f, lead, seated, capability: f.capabilityFor(lead) };
}
const start = (f, extra = {}) =>
  f.request({
    method: "roles-create-session",
    capability: f.capability,
    input: {
      sessionId: f.lead,
      seat: P(1),
      taskId: T(1),
      messageId: randomUUID(),
      provider: "claude",
      title: "Routine work for this project",
      ...extra,
    },
  });

test("intercom seat throughput is finite per window and rollover cannot revive a revoked seat", async (t) => {
  const f = await project(t);
  let clock = Date.now();
  f.control.rates.now = () => clock;
  await f.request({
    method: "roles-allowance-set",
    operator: "test-operator",
    input: {
      role: "project-orchestrator",
      seat: P(1),
      expectedRevision: 1,
      maxSessions: 1,
      note: "One creation each finite rolling hour",
    },
  });
  const first = await start(f);
  assert.equal(first.state, "delivered");
  await assert.rejects(start(f), /allowance reached/);
  const generation = f.store.get(f.lead).generation;
  clock += 3600001;
  const next = await start(f);
  assert.equal(next.state, "delivered");
  assert.equal(next.remaining, 0);
  assert.equal(f.store.get(f.lead).generation, generation);
  f.control.takeover(f.lead, "Owner ends delegated seat actions");
  clock += 3600001;
  await assert.rejects(start(f), /human|delegat|current|revoked|control/i);
  assert.equal(f.created.length, 2);
});
