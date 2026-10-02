// DESIGN-NEXT-BUILD A3 (C8): every control creation path carries what the session is for. A manager's worker is
// `implementation`; a seat starts `implementation` or `planning`; an operator may name any role; an omitted provider is
// the role's configured one (prime Q1); a creation journaled before roles existed keeps its identity when retried.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { ControlStore } from "./store.mjs";
import { Controller } from "./controller.mjs";
import { Events } from "./events.mjs";
import { Manager } from "./manager.mjs";
import { Bindings } from "./bindings.mjs";
import { RoleChannels } from "./role-channels.mjs";
import { RoleSessions } from "./role-sessions.mjs";
import { FENCE_PROTOCOL } from "./native-fence.mjs";
import { COMPANY, PROGRAMME } from "./authority.mjs";
import { rpc } from "./rpc.mjs";
import { observation } from "../../tools/legacy-host-admission.fixture.mjs";
import { portable } from "../portable-config.mjs";
import { requireUnpinnedAdmissionGuard } from "./admission-guard-precondition.mjs";
requireUnpinnedAdmissionGuard();

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
const configFile = path.join(portable.home, "config.json"),
  original = fs.readFileSync(configFile, "utf8");
const roles = (value) => {
  const c = JSON.parse(original);
  c.defaults = { ...c.defaults, roles: value };
  fs.writeFileSync(configFile, JSON.stringify(c, null, 2), { mode: 0o600 });
};
const IMPLEMENTATION_CLAUDE = {
  implementation: {
    provider: "claude",
    claude: { model: "claude/claude-sonnet-5-5", thinkingOptionId: "high" },
  },
};
// W3 (gap a): with no provider chosen for a role, an omitted provider is the role default's (the seed's, claude) -- but only
// when this host lists that provider's models, checked before anything is reserved; otherwise the plain refusal stands.
const withoutClaude = (w) => {
  w.control.native.checkProvider = async (p) => {
    throw Error(`The installed ${p} provider is not available`);
  };
};
const withClaude = (w) => {
  delete w.control.native.checkProvider;
};

function world(t) {
  t.after(() => fs.writeFileSync(configFile, original, { mode: 0o600 }));
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-creation-roles-")));
  const store = new ControlStore(path.join(dir, "journal.sqlite"));
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const created = [],
    states = new Map();
  const native = {
    route: () => undefined,
    verifyNew: async () => {},
    create: async (a, ownership) => {
      const id = randomUUID(),
        cwd = path.join(dir, id);
      fs.mkdirSync(cwd);
      created.push({ ...a, id, ownership });
      states.set(id, {
        status: "idle",
        pending: 0,
        lastPromptId: null,
        lastUserAt: null,
        pendingPermissions: [],
        runtimeInfo: { sessionId: randomUUID() },
      });
      return {
        id,
        cwd,
        runtimeInstanceId: "instance-" + id,
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
      ...observation(id),
      nativeId: states.get(id)?.runtimeInfo?.sessionId,
    }),
    snapshot: async (id) => ({ id, ...states.get(id) }),
    send: async (id, _text, messageId) => {
      states.set(id, { ...states.get(id), lastPromptId: messageId });
    },
  };
  const control = new Controller({ store, native, authority: async (id) => issue(id) });
  const source = {
    observedAt: "2026-09-19T00:00:00.000Z",
    available: true,
    partial: false,
    projects: [{ id: P(1), name: "One", description: null, status: "in_progress" }],
    membership: [
      { taskId: T(1), projectId: P(1) },
      { taskId: T(2), projectId: P(1) },
    ],
    note: "test project source",
  };
  control.bindings = new Bindings(control, async () => source, path.join(dir, "grants", "role"));
  control.channels = new RoleChannels(control, () => Date.now());
  control.roleSessions = new RoleSessions(control);
  control.events = new Events(control, path.join(dir, "inbox"));
  control.manager = new Manager(control, path.join(dir, "manager"));
  const enrol = (task) => {
    const id = randomUUID();
    const cwd = path.join(dir, id);
    fs.mkdirSync(cwd);
    states.set(id, {
      status: "idle",
      pending: 0,
      lastPromptId: null,
      lastUserAt: null,
      pendingPermissions: [],
      runtimeInfo: { sessionId: randomUUID() },
    });
    store.created(id, task, cwd);
    return id;
  };
  return { dir, store, control, created, enrol, request: rpc(control, "test-operator") };
}
async function seat(t) {
  const w = world(t),
    lead = w.enrol(T(1));
  await w.control.bindings.assign({
    role: "project-orchestrator",
    seat: P(1),
    sessionId: lead,
    expectedSessionGeneration: 1,
    expectedRevision: 0,
    note: "Owns delivery of this project",
  });
  await w.control.handback(lead, "Delegated for the creation-roles verification");
  const capability = JSON.parse(
    fs.readFileSync(
      w.control.bindings.grantRole({
        sessionId: lead,
        expectedGeneration: w.store.get(lead).generation,
      }).grantFile,
      "utf8",
    ),
  ).capability;
  await w.request({
    method: "roles-allowance-set",
    operator: "test-operator",
    input: {
      role: "project-orchestrator",
      seat: P(1),
      expectedRevision: 1,
      maxSessions: 6,
      note: "Sessions for this delivery cycle",
    },
  });
  const start = (extra = {}, omitProvider = false) => {
    const input = {
      sessionId: lead,
      seat: P(1),
      taskId: T(1),
      messageId: randomUUID(),
      provider: "claude",
      title: "Implement the release flag",
      ...extra,
    };
    if (omitProvider) delete input.provider;
    return w.request({ method: "roles-create-session", capability, input });
  };
  return { ...w, start };
}
async function manager(t) {
  const w = world(t),
    s = w.enrol(PROGRAMME),
    sg = await w.control.handback(s, "Explicitly delegate test supervisor");
  const grant = await w.control.manager.grant({
    sessionId: s,
    expectedGeneration: sg.generation,
    capability: sg.capability,
    maxWorkers: 3,
    reason: "Manage bounded owned test workers",
  });
  const token = JSON.parse(fs.readFileSync(grant.grantFile)).capability;
  return {
    ...w,
    create: (extra) =>
      w.control.manager.create(
        { sessionId: s, messageId: randomUUID(), title: "Owned test worker", ...extra },
        token,
      ),
  };
}

test("a manager's worker is an implementation session; an omitted provider is that role's, never stored in the worker identity", async (t) => {
  const m = await manager(t);
  await m.create({ provider: "codex" });
  assert.deepEqual([m.created.at(-1).provider, m.created.at(-1).role], ["codex", "implementation"]);
  const reserved = () => m.store.db.prepare("SELECT count(*) n FROM manager_workers").get().n,
    before = [m.created.length, reserved()];
  withoutClaude(m);
  await assert.rejects(
    m.create({}),
    /no provider is configured for the implementation role, and its default \(claude\) is not available on this host/,
  );
  assert.deepEqual([m.created.length, reserved()], before, "refused before anything is reserved");
  withClaude(m);
  await m.create({});
  assert.deepEqual(
    [m.created.at(-1).provider, m.created.at(-1).role],
    ["claude", "implementation"],
    "nothing chosen: the role default provider",
  );
  roles(IMPLEMENTATION_CLAUDE);
  const out = await m.create({});
  assert.deepEqual(
    [m.created.at(-1).provider, m.created.at(-1).role],
    ["claude", "implementation"],
  );
  assert.ok(out);
  const row = m.store.db
    .prepare("SELECT body FROM manager_workers ORDER BY rowid DESC LIMIT 1")
    .get();
  assert.equal(
    Object.hasOwn(JSON.parse(row.body), "role"),
    false,
    "the stored worker specification is unchanged in shape",
  );
});

test("a seat starts implementation by default or planning when asked; orchestration is not the seat's to start", async (t) => {
  const f = await seat(t);
  await f.start();
  assert.equal(f.created.at(-1).role, "implementation");
  await f.start({ role: "planning", title: "Review the release flag" });
  assert.equal(f.created.at(-1).role, "planning");
  await assert.rejects(
    f.start({ role: "orchestration" }),
    /implementation, planning, review or research/,
  );
  const owned = () => f.store.db.prepare("SELECT count(*) n FROM session_ownership").get().n,
    before = [f.created.length, owned()];
  withoutClaude(f);
  await assert.rejects(
    f.start({}, true),
    /no provider is configured for the implementation role, and its default \(claude\) is not available/,
  );
  assert.deepEqual(
    [f.created.length, owned()],
    before,
    "no ownership reserved, no allowance spent",
  );
  withClaude(f);
  await f.start({}, true);
  assert.equal(f.created.at(-1).provider, "claude");
  roles(IMPLEMENTATION_CLAUDE);
  const out = await f.start({}, true);
  assert.equal(out.state, "delivered");
  assert.deepEqual(
    [f.created.at(-1).provider, f.created.at(-1).role],
    ["claude", "implementation"],
  );
});

test("an operator create may name any role, directly or declared under a project; an unknown role is refused", async (t) => {
  const w = world(t);
  const op = (input) =>
    w.request({
      method: "create",
      operator: "test-operator",
      input: { messageId: randomUUID(), taskId: T(1), title: "Project lead", ...input },
    });
  await op({ provider: "claude", role: "orchestration" });
  assert.deepEqual([w.created.at(-1).provider, w.created.at(-1).role], ["claude", "orchestration"]);
  await op({ provider: "claude", role: "planning", projectId: P(1) });
  assert.equal(w.created.at(-1).role, "planning");
  await assert.rejects(op({ provider: "claude", role: "reviewer" }), /role|Invalid/);
  withoutClaude(w);
  const id = randomUUID();
  await assert.rejects(
    op({ role: "orchestration", messageId: id }),
    /no provider is configured for the orchestration role, and its default \(claude\) is not available/,
  );
  assert.ok(!w.store.delivery(id), "refused before the journal");
  await assert.rejects(op({ role: "orchestration", projectId: P(1) }), /not available/);
  assert.equal(
    w.store.db.prepare("SELECT count(*) n FROM session_ownership WHERE declaredBy='operator'").get()
      .n,
    1,
    "no ownership row for the refused declared create",
  );
  withClaude(w);
  await op({ role: "orchestration" });
  assert.deepEqual([w.created.at(-1).provider, w.created.at(-1).role], ["claude", "orchestration"]);
  roles(IMPLEMENTATION_CLAUDE);
  await op({ role: "implementation" });
  assert.deepEqual(
    [w.created.at(-1).provider, w.created.at(-1).role],
    ["claude", "implementation"],
  );
  const count = w.created.length;
  await op({ provider: "codex" });
  assert.equal(Object.hasOwn(w.created.at(-1), "role"), false, "no role: exactly as before");
  assert.equal(w.created.length, count + 1);
});

test("update-7: a manager's worker records the manager as its parent and the manager's declared project", async (t) => {
  const w = world(t),
    messageId = randomUUID();
  await w.request({
    method: "create",
    operator: "test-operator",
    input: {
      messageId,
      taskId: T(1),
      provider: "claude",
      title: "Project lead",
      role: "orchestration",
      projectId: P(1),
    },
  });
  assert.deepEqual(w.created.at(-1).ownership, { project: P(1) });
  const lead = { id: w.created.at(-1).id };
  const sg = await w.control.handback(lead.id, "Explicitly delegate the project lead");
  const grant = await w.control.manager.grant({
    sessionId: lead.id,
    expectedGeneration: sg.generation,
    capability: sg.capability,
    maxWorkers: 2,
    reason: "Manage bounded owned test workers",
  });
  const token = JSON.parse(fs.readFileSync(grant.grantFile)).capability;
  await w.control.manager.create(
    { sessionId: lead.id, messageId: randomUUID(), title: "Level worker", provider: "claude" },
    token,
  );
  assert.deepEqual(w.created.at(-1).ownership, { fresh: true, parent: lead.id, project: P(1) });
  // A manager with no declared project: parent only, nothing inferred.
  const m = await manager(t);
  await m.create({ provider: "claude" });
  assert.deepEqual(m.created.at(-1).ownership, {
    fresh: true,
    parent: m.created.at(-1).ownership.parent,
    project: null,
  });
});

test("a creation journaled before roles existed is the same identity when retried with a role", async (t) => {
  const w = world(t),
    messageId = randomUUID(),
    body = { messageId, taskId: T(1), provider: "claude", title: "Created before the upgrade" };
  const first = await w.control.create(body);
  assert.equal(first.state, "delivered");
  assert.equal(w.created.length, 1);
  const again = await w.control.create({ ...body, role: "implementation" });
  assert.equal(again.id, first.id);
  assert.equal(w.created.length, 1, "not created twice, and not refused as a conflict");
  await assert.rejects(
    w.control.create({ ...body, title: "A different request" }),
    /Delivery identity conflict/,
  );
});

// Update-7 W3: an explicit model and effort on every control create path. The fixture's provider lists these models;
// an explicit value it does not list is refused before any reservation, allowance or journal row exists.
const OFFERED = { claude: ["claude-opus-5-5", "claude-sonnet-5-5"], codex: ["gpt-6.1-sol"] };
function offering(w) {
  w.control.native.checkOverride = async (a) => {
    const m = a.defaults?.model;
    if (m && !OFFERED[a.provider].includes(m.slice(m.indexOf("/") + 1)))
      throw Error(
        `The installed ${a.provider} provider does not offer ${m} (model-not-offered); nothing was created`,
      );
  };
}

test("W3: a manager's worker takes an explicit model and effort; an unknown one is refused before anything is reserved", async (t) => {
  const m = await manager(t);
  offering(m);
  await m.create({ provider: "claude", model: "claude-opus-5-5", effort: "high" });
  assert.deepEqual(m.created.at(-1).defaults, {
    model: "claude/claude-opus-5-5",
    thinkingOptionId: "high",
  });
  await m.create({ provider: "codex", model: "codex/gpt-6.1-sol" });
  assert.deepEqual(m.created.at(-1).defaults, { model: "codex/gpt-6.1-sol" });
  await m.create({ provider: "claude" });
  assert.equal(
    Object.hasOwn(m.created.at(-1), "defaults"),
    false,
    "no explicit value: the role default applies at creation",
  );
  assert.equal(m.created.at(-1).role, "implementation");
  const rows = () => m.store.db.prepare("SELECT count(*) n FROM manager_workers").get().n,
    before = [m.created.length, rows()];
  await assert.rejects(
    m.create({ provider: "claude", model: "claude-opus-9" }),
    /does not offer claude\/claude-opus-9/,
  );
  await assert.rejects(
    m.create({ provider: "claude", model: "codex/gpt-6.1-sol" }),
    /not a claude model/,
  );
  await assert.rejects(m.create({ provider: "claude", effort: "turbo" }), /not an effort/);
  assert.deepEqual([m.created.length, rows()], before, "nothing created, nothing reserved");
});

test("W3: role_start_session takes an explicit model and effort; an unknown one spends no allowance", async (t) => {
  const f = await seat(t);
  offering(f);
  await f.start({ model: "claude-sonnet-5-5", effort: "medium" });
  assert.deepEqual(f.created.at(-1).defaults, {
    model: "claude/claude-sonnet-5-5",
    thinkingOptionId: "medium",
  });
  await f.start({ role: "planning", effort: "medium", title: "Review the release flag" });
  assert.deepEqual(
    [f.created.at(-1).role, f.created.at(-1).defaults],
    ["planning", { thinkingOptionId: "medium" }],
  );
  await f.start();
  assert.equal(Object.hasOwn(f.created.at(-1), "defaults"), false);
  const owned = () => f.store.db.prepare("SELECT count(*) n FROM session_ownership").get().n,
    before = [f.created.length, owned()];
  await assert.rejects(f.start({ model: "claude-opus-9" }), /does not offer claude\/claude-opus-9/);
  assert.deepEqual(
    [f.created.length, owned()],
    before,
    "nothing created, no ownership reserved, no allowance spent",
  );
});

test("W3: an operator create takes an explicit model and effort; an unknown one is refused, never journaled as uncertain", async (t) => {
  const w = world(t);
  offering(w);
  const op = (input) =>
    w.request({
      method: "create",
      operator: "test-operator",
      input: {
        messageId: randomUUID(),
        taskId: T(1),
        title: "Project lead",
        provider: "claude",
        role: "orchestration",
        ...input,
      },
    });
  await op({ defaults: { model: "claude/claude-opus-5-5", thinkingOptionId: "medium" } });
  assert.deepEqual(w.created.at(-1).defaults, {
    model: "claude/claude-opus-5-5",
    thinkingOptionId: "medium",
  });
  const messageId = randomUUID(),
    count = w.created.length;
  await assert.rejects(
    op({ messageId, defaults: { model: "claude/claude-opus-9" } }),
    /does not offer claude\/claude-opus-9/,
  );
  assert.equal(w.created.length, count);
  assert.ok(!w.store.delivery(messageId), "no journal row");
});

// R1 W3-4: a lead can start a reviewer (review's defaults, not planning's) or a researcher; orchestration stays the operator's.
test("W3-4: a seat starts review and research sessions with their own role", async (t) => {
  const f = await seat(t);
  await f.start({ role: "review", title: "Review the release flag" });
  assert.equal(f.created.at(-1).role, "review");
  await f.start({ role: "research", title: "Research the release flag" });
  assert.equal(f.created.at(-1).role, "research");
  await assert.rejects(
    f.start({ role: "orchestration" }),
    /implementation, planning, review or research/,
  );
});
