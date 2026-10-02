// Behaviour checks for the independent review findings: a role capability must not outlive the seat it
// was issued for (F1), and a seat that legitimately continues must keep working.
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
import { COMPANY, PROGRAMME } from "./authority.mjs";
import { closeSeatingDefaults } from "./role-defaults-fixture.mjs";
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
const NOW = Date.parse("2026-09-19T00:00:00.000Z");
const EXPIRES = new Date(NOW + 86400000).toISOString();

function fixture(t, { route = () => undefined, routing = true } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-role-revocation-")));
  const store = new ControlStore(path.join(dir, "journal.sqlite"));
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const states = new Map();
  let sends = 0;
  const native = {
    ...(routing ? { route } : {}),
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
    send: async (id, _text, messageId) => {
      sends++;
      states.set(id, { ...states.get(id), lastPromptId: messageId });
    },
  };
  const control = new Controller({ store, native, authority: async (id) => issue(id) });
  control.bindings = new Bindings(
    control,
    async () => ({
      observedAt: "2026-09-19T00:00:00.000Z",
      available: true,
      partial: false,
      projects: [
        { id: P(1), name: "One", description: null, status: "in_progress" },
        { id: P(2), name: "Two", description: null, status: "in_progress" },
      ],
      membership: [
        { taskId: T(1), projectId: P(1) },
        { taskId: T(1), projectId: P(2) },
      ],
      note: "test project source",
    }),
    path.join(dir, "grants", "role"),
  );
  control.channels = new RoleChannels(control, () => NOW);
  const request = rpc(control, "test-operator");
  const enrol = (task) => {
    const id = randomUUID();
    store.created(id, task, path.join(dir, id));
    states.set(id, { lastPromptId: null });
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
  return {
    dir,
    store,
    control,
    native,
    request,
    enrol,
    capabilityFor,
    sends: () => sends,
    delegate: (id) => control.handback(id, "Delegated for the revocation verification"),
  };
}
const assign = (f, role, seat, sessionId, expectedRevision, note) =>
  f.control.bindings.assign({
    role,
    seat,
    sessionId,
    expectedSessionGeneration: f.store.get(sessionId).generation,
    expectedRevision,
    note,
  });

test("a released seat ends its capability: no receipt write, no seat enumeration, no thread read", async (t) => {
  const f = fixture(t);
  const prime = f.enrol(PROGRAMME),
    project = f.enrol(T(1));
  await assign(f, "prime", "delivery", prime, 0, "Accountable prime seat for delivery");
  await assign(f, "project-orchestrator", P(1), project, 0, "Owns delivery of this project");
  await f.delegate(prime);
  await f.delegate(project);
  // Seating conferred a default channel between these seats; close it so the operator approval below is
  // the channel under test. See role-defaults-fixture.mjs.
  closeSeatingDefaults(f.control);
  const primeCapability = f.capabilityFor(prime),
    projectCapability = f.capabilityFor(project);
  const channel = await f.request({
    method: "channels-open",
    operator: "test-operator",
    input: {
      primeSeat: "delivery",
      projectSeat: P(1),
      purpose: "Revocation verification between the seats",
      maxMessages: 4,
      expiresAt: EXPIRES,
      expectedPrimeRevision: 1,
      expectedProjectRevision: 1,
    },
  });
  const raised = randomUUID();
  await f.request({
    method: "channels-send",
    capability: projectCapability,
    input: {
      sessionId: project,
      channelId: channel.channelId,
      messageId: raised,
      text: "Blocked on the release decision",
    },
  });
  // Before release the prime can read the thread and record a receipt.
  await f.request({
    method: "channels-read",
    capability: primeCapability,
    input: {
      sessionId: prime,
      channelId: channel.channelId,
      messageId: raised,
      note: "Read before the seat was released",
    },
  });

  f.control.bindings.unassign({
    role: "prime",
    seat: "delivery",
    expectedRevision: 1,
    note: "Prime seat released by the operator",
  });
  // The session generation is untouched, so neither the generation pin nor a takeover closes this. Since
  // N1 the credential is destroyed outright as well, so the refusals below hold for two independent reasons.
  assert.equal(f.store.get(prime).mode, "delegated");
  assert.equal(
    f.store.db.prepare("SELECT count(*) n FROM role_credentials WHERE session=?").get(prime).n,
    0,
  );
  for (const [method, input] of [
    ["bindings-self", { sessionId: prime }],
    ["channels-list", { sessionId: prime }],
    ["channels-thread", { sessionId: prime, channelId: channel.channelId }],
    [
      "channels-read",
      {
        sessionId: prime,
        channelId: channel.channelId,
        messageId: raised,
        note: "Rewriting the receipt after removal",
      },
    ],
    [
      "channels-send",
      {
        sessionId: prime,
        channelId: channel.channelId,
        messageId: randomUUID(),
        text: "Still speaking for the board",
      },
    ],
  ])
    await assert.rejects(
      f.request({ method, capability: primeCapability, input }),
      /Role capability revoked or invalid/,
      method,
    );
  // The receipt written while seated is intact and was not overwritten.
  assert.equal(
    f.store.db.prepare("SELECT readNote FROM role_channel_messages WHERE messageId=?").get(raised)
      .readNote,
    "Read before the seat was released",
  );
  assert.equal(f.sends(), 1);
});

test("a replaced holder loses its capability while the replacement gets its own", async (t) => {
  const f = fixture(t);
  const prime = f.enrol(PROGRAMME),
    first = f.enrol(T(1)),
    second = f.enrol(T(1));
  await assign(f, "prime", "delivery", prime, 0, "Accountable prime seat for delivery");
  await assign(f, "project-orchestrator", P(1), first, 0, "Initial project leader");
  await f.delegate(prime);
  await f.delegate(first);
  await f.delegate(second);
  const firstCapability = f.capabilityFor(first);
  assert.deepEqual(
    (
      await f.request({
        method: "bindings-self",
        capability: firstCapability,
        input: { sessionId: first },
      })
    ).primes.map((p) => p.seat),
    ["delivery"],
  );

  await assign(
    f,
    "project-orchestrator",
    P(1),
    second,
    1,
    "Handing the project to the second session",
  );
  // The removed holder can no longer enumerate prime seats or act anywhere.
  for (const [method, input] of [
    ["bindings-self", { sessionId: first }],
    ["channels-list", { sessionId: first }],
  ])
    await assert.rejects(
      f.request({ method, capability: firstCapability, input }),
      /Role capability revoked or invalid/,
      method,
    );
  // It cannot be re-issued either, because it holds no seat.
  assert.throws(
    () =>
      f.control.bindings.grantRole({
        sessionId: first,
        expectedGeneration: f.store.get(first).generation,
      }),
    /holds no current role binding/,
  );
  // The replacement is a distinct identity with its own capability and its own token.
  const secondCapability = f.capabilityFor(second);
  assert.notEqual(secondCapability, firstCapability);
  const self = await f.request({
    method: "bindings-self",
    capability: secondCapability,
    input: { sessionId: second },
  });
  assert.deepEqual(
    self.roles.map((r) => [r.role, r.seat, r.task]),
    [["project-orchestrator", P(1), T(1)]],
  );
  assert.equal(self.sessionId, second);
});

test("a session holding several seats keeps working until the last one goes", async (t) => {
  const f = fixture(t);
  const holder = f.enrol(T(1));
  await assign(f, "project-orchestrator", P(1), holder, 0, "Owns the first project");
  await assign(f, "project-orchestrator", P(2), holder, 0, "Owns the second project too");
  await f.delegate(holder);
  const capability = f.capabilityFor(holder);
  assert.deepEqual(
    (
      await f.request({ method: "bindings-self", capability, input: { sessionId: holder } })
    ).roles.map((r) => r.seat),
    [P(1), P(2)],
  );

  // Releasing one seat must not disturb the other: the capability continues, and only the held seat shows.
  f.control.bindings.unassign({
    role: "project-orchestrator",
    seat: P(1),
    expectedRevision: 1,
    note: "First project handed elsewhere",
  });
  const remaining = await f.request({
    method: "bindings-self",
    capability,
    input: { sessionId: holder },
  });
  assert.deepEqual(
    remaining.roles.map((r) => r.seat),
    [P(2)],
  );
  assert.equal(remaining.sessionId, holder);

  // Releasing the last one fails closed.
  f.control.bindings.unassign({
    role: "project-orchestrator",
    seat: P(2),
    expectedRevision: 1,
    note: "Second project handed elsewhere",
  });
  await assert.rejects(
    f.request({ method: "bindings-self", capability, input: { sessionId: holder } }),
    /Role capability revoked or invalid/,
  );
});

test("absent host routing is unknown routing, not local routing", async (t) => {
  const f = fixture(t);
  const prime = f.enrol(PROGRAMME),
    project = f.enrol(T(1));
  await assign(f, "prime", "delivery", prime, 0, "Accountable prime seat for delivery");
  await assign(f, "project-orchestrator", P(1), project, 0, "Owns delivery of this project");
  await f.delegate(prime);
  await f.delegate(project);
  // Seating conferred a default channel between these seats; close it so the operator approval below is
  // the channel under test. See role-defaults-fixture.mjs.
  closeSeatingDefaults(f.control);
  // Routing becomes unreadable after the seats exist, as it would if the native runtime detached.
  delete f.native.route;
  const seat = f.control.bindings.describe("prime", "delivery");
  assert.equal(seat.dispatch.supported, false);
  assert.equal(seat.dispatch.host, null);
  assert.match(seat.dispatch.reason, /Host routing state is unavailable/);
  // Neither a capability nor a channel may be granted on evidence that was never read.
  assert.throws(
    () =>
      f.control.bindings.grantRole({
        sessionId: prime,
        expectedGeneration: f.store.get(prime).generation,
      }),
    /Host routing state is unavailable/,
  );
  await assert.rejects(
    f.request({
      method: "channels-open",
      operator: "test-operator",
      input: {
        primeSeat: "delivery",
        projectSeat: P(1),
        purpose: "Should not be approved without routing",
        maxMessages: 4,
        expiresAt: EXPIRES,
        expectedPrimeRevision: 1,
        expectedProjectRevision: 1,
      },
    }),
    /cannot be reached/,
  );
  // Nothing was approved on unread evidence. The one row is the seating default from BEFORE routing became
  // unreadable, and this fixture already closed it; no channel is open.
  assert.equal(
    f.store.db.prepare("SELECT count(*) n FROM role_channels WHERE state='open'").get().n,
    0,
  );
  // The Book-provider gate treats unreadable routing the same way rather than skipping itself, so a new
  // seat cannot be assigned on evidence that was never read.
  const another = f.enrol(T(1));
  await assert.rejects(
    assign(f, "project-orchestrator", P(2), another, 0, "Seat assigned with routing unreadable"),
    /Host routing state is unavailable/,
  );
  assert.equal(f.control.bindings.describe("project-orchestrator", P(2)).state, "vacant");
});

test("a revoked capability is destroyed, not suspended: re-seating never revives the same token", async (t) => {
  const f = fixture(t);
  const holder = f.enrol(T(1));
  await assign(f, "project-orchestrator", P(1), holder, 0, "Owns the first project");
  await f.delegate(holder);
  const capability = f.capabilityFor(holder);
  const file = path.join(f.dir, "grants", "role", path.basename(f.store.get(holder).cwd) + ".json");
  assert.equal(fs.existsSync(file), true);
  assert.equal(
    (await f.request({ method: "bindings-self", capability, input: { sessionId: holder } }))
      .sessionId,
    holder,
  );

  // Revoke by vacating the only seat. The credential row and the grant file both go.
  f.control.bindings.unassign({
    role: "project-orchestrator",
    seat: P(1),
    expectedRevision: 1,
    note: "Revoked because the token may have leaked",
  });
  assert.equal(
    f.store.db.prepare("SELECT count(*) n FROM role_credentials WHERE session=?").get(holder).n,
    0,
  );
  assert.equal(fs.existsSync(file), false);

  // Re-seat the same session at an unchanged generation while still delegated. The old token stays dead.
  // G1 (G-FIXES-REPORT.md): re-seating is itself an explicit operator act, and since G1 it issues the seat's role
  // credential -- a FRESH token, never the revoked one.
  assert.equal(f.store.get(holder).mode, "delegated");
  const reseated = await assign(
    f,
    "project-orchestrator",
    P(2),
    holder,
    0,
    "Re-seated on a different project",
  );
  assert.equal(f.store.get(holder).generation, 2);
  assert.equal(reseated.defaults.roleGrant.issued, true);
  await assert.rejects(
    f.request({ method: "bindings-self", capability, input: { sessionId: holder } }),
    /Role capability revoked or invalid/,
  );
  const fresh = JSON.parse(fs.readFileSync(file, "utf8")).capability;
  assert.notEqual(fresh, capability);
  assert.deepEqual(
    (
      await f.request({ method: "bindings-self", capability: fresh, input: { sessionId: holder } })
    ).roles.map((r) => r.seat),
    [P(2)],
  );
  // A re-delegation rotates the current credential; the revoked one never comes back.
  f.control.takeover(holder, "Human takes it back before any new grant");
  await f.delegate(holder);
  await assert.rejects(
    f.request({ method: "bindings-self", capability, input: { sessionId: holder } }),
    /Role capability revoked or invalid/,
  );
  await assert.rejects(
    f.request({ method: "bindings-self", capability: fresh, input: { sessionId: holder } }),
    /Role capability revoked or invalid/,
  );
  // An explicit operator grant still works, and is a different token again.
  const reissued = f.capabilityFor(holder);
  assert.notEqual(reissued, capability);
  assert.notEqual(reissued, fresh);
  assert.deepEqual(
    (
      await f.request({
        method: "bindings-self",
        capability: reissued,
        input: { sessionId: holder },
      })
    ).roles.map((r) => r.seat),
    [P(2)],
  );

  // Replacement releases the outgoing holder the same way, and a multi-seat holder is untouched.
  const second = f.enrol(T(1));
  await assign(f, "project-orchestrator", P(2), second, 1, "Replacing the holder");
  assert.equal(
    f.store.db.prepare("SELECT count(*) n FROM role_credentials WHERE session=?").get(holder).n,
    0,
  );
  assert.equal(fs.existsSync(file), false);
});

test("a receipt needs a live channel; the thread stays readable and the route agrees with approval", async (t) => {
  const f = fixture(t);
  const prime = f.enrol(PROGRAMME),
    project = f.enrol(T(1)),
    replacement = f.enrol(T(1));
  await assign(f, "prime", "delivery", prime, 0, "Accountable prime seat for delivery");
  await assign(f, "project-orchestrator", P(1), project, 0, "Owns delivery of this project");
  await f.delegate(prime);
  await f.delegate(project);
  await f.delegate(replacement);
  // Seating conferred a default channel between these seats; close it so the operator approval below is
  // the channel under test. See role-defaults-fixture.mjs.
  closeSeatingDefaults(f.control);
  const primeCapability = f.capabilityFor(prime),
    projectCapability = f.capabilityFor(project);
  const channel = await f.request({
    method: "channels-open",
    operator: "test-operator",
    input: {
      primeSeat: "delivery",
      projectSeat: P(1),
      purpose: "Receipt verification between the seats",
      maxMessages: 4,
      expiresAt: EXPIRES,
      expectedPrimeRevision: 1,
      expectedProjectRevision: 1,
    },
  });
  const raised = randomUUID();
  await f.request({
    method: "channels-send",
    capability: projectCapability,
    input: {
      sessionId: project,
      channelId: channel.channelId,
      messageId: raised,
      text: "Blocked on the release decision",
    },
  });

  // Invalidate the channel by replacing the far seat. The prime still holds its own seat.
  await assign(
    f,
    "project-orchestrator",
    P(1),
    replacement,
    1,
    "Replacing the project leader mid-conversation",
  );
  // N2: the still-seated prime may no longer write a receipt onto an invalidated channel.
  await assert.rejects(
    f.request({
      method: "channels-read",
      capability: primeCapability,
      input: {
        sessionId: prime,
        channelId: channel.channelId,
        messageId: raised,
        note: "Reading after the seat changed",
      },
    }),
    /project seat changed since this channel was approved/,
  );
  assert.equal(
    f.store.db.prepare("SELECT readAt FROM role_channel_messages WHERE messageId=?").get(raised)
      .readAt,
    null,
  );
  // It may still read the history, so nothing is hidden from either side.
  const thread = await f.request({
    method: "channels-thread",
    capability: primeCapability,
    input: { sessionId: prime, channelId: channel.channelId },
  });
  assert.deepEqual(
    thread.messages.map((m) => [m.messageId, m.text, m.receipt]),
    [[raised, "Blocked on the release decision", null]],
  );

  // N3: an unreachable seat must not be advertised as deliverable.
  const route = await f.request({
    method: "bindings-route",
    operator: "test-operator",
    input: { role: "prime", seat: "delivery" },
  });
  assert.equal(route.routing.deliverable, true);
  f.control.takeover(prime, "Human takes the prime seat back");
  const human = await f.request({
    method: "bindings-route",
    operator: "test-operator",
    input: { role: "prime", seat: "delivery" },
  });
  assert.equal(human.routing.deliverable, false);
  assert.match(human.routing.blocked, /under human control/);
  // A vacant seat has no dispatch to read and must not throw.
  const vacant = await f.request({
    method: "bindings-route",
    operator: "test-operator",
    input: { role: "prime", seat: "platform" },
  });
  assert.equal(vacant.routing.deliverable, false);
  assert.equal(vacant.dispatch, null);
});
