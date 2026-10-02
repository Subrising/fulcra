// Source-focused transport checks for a role seat held by an explicitly enrolled Book Claude session.
// The signed receiver is exercised through the real host-routing admission path with a named local test
// double standing in for the ssh exchange; no live receiver, no session creation, no service change.
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
import { HostNative } from "./host-native.mjs";
import { canonical } from "../book/protocol.mjs";
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
// host-native.send reads the wall clock, so the fixture pins RoleChannels to the SAME clock rather than a
// fixed date. A hardcoded NOW silently degrades once wall time passes it: the positive case starts failing
// while every mutation case keeps passing, because an expiry refusal raises the message they match on.
const NOW = Date.now();
const EXPIRES = new Date(NOW + 86400000).toISOString();

// Host routing exactly as HostNative records it, plus the receiver acknowledgements the real transport
// returns. Named a double so nothing here reads as a live receiver.
function bookTestDouble() {
  const routes = new Map(),
    sent = [];
  return {
    routes,
    sent,
    enrol: (id, provider = "claude") =>
      routes.set(id, {
        id,
        host: "macbook",
        phase: "human",
        generation: 1,
        creation: canonical({ provider }),
      }),
    acknowledgeDelegation: (id, generation) => {
      const r = routes.get(id);
      routes.set(id, { ...r, phase: "active", generation });
    },
    beginRevoke: (id) => {
      const r = routes.get(id);
      routes.set(id, { ...r, phase: "revoking" });
    },
    route: (id) => routes.get(id),
  };
}
function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-role-remote-")));
  const store = new ControlStore(path.join(dir, "journal.sqlite"));
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const book = bookTestDouble(),
    states = new Map();
  const native = {
    route: book.route,
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
      book.sent.push({ id, text, messageId, remote: Boolean(book.route(id)) });
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
      projects: [{ id: P(1), name: "Orca", description: null, status: "in_progress" }],
      membership: [{ taskId: T(1), projectId: P(1) }],
      note: "test project source",
    }),
    path.join(dir, "grants", "role"),
  );
  control.channels = new RoleChannels(control, () => NOW);
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
    book,
    states,
    enrol,
    capabilityFor,
    request: rpc(control, "test-operator"),
    delegate: (id) => control.handback(id, "Delegated for the remote role verification"),
  };
}
const assign = (f, role, seat, sessionId, revision, note) =>
  f.control.bindings.assign({
    role,
    seat,
    sessionId,
    expectedSessionGeneration: f.store.get(sessionId).generation,
    expectedRevision: revision,
    note,
  });

async function seated(t) {
  const f = fixture(t),
    prime = f.enrol(PROGRAMME),
    project = f.enrol(T(1));
  f.book.enrol(project); // the project seat lives on the Book
  await assign(f, "prime", "delivery", prime, 0, "Accountable prime seat for delivery");
  await assign(f, "project-orchestrator", P(1), project, 0, "Enrolled Book Claude project leader");
  await f.delegate(prime);
  await f.delegate(project);
  f.book.acknowledgeDelegation(project, f.store.get(project).generation);
  // Seating conferred a default channel between these seats; close it so each test opens the channel it
  // means to exercise. See role-defaults-fixture.mjs.
  closeSeatingDefaults(f.control);
  return { ...f, prime, project };
}

test("an enrolled Book Claude session holds a seat and is addressable, but is provisioned no capability", async (t) => {
  const f = await seated(t);
  const seat = f.control.bindings.describe("project-orchestrator", P(1));
  assert.equal(seat.sessionId, f.project);
  assert.equal(seat.dispatch.host, "macbook");
  // Receiver-acknowledged delegation makes it reachable for a role message.
  assert.equal(seat.dispatch.supported, true);
  assert.equal(seat.dispatch.phase, "active");
  // It still cannot originate one: no controller socket and no supervisor MCP server on the Book.
  assert.equal(seat.dispatch.capability.supported, false);
  assert.match(seat.dispatch.capability.reason, /reaches no controller socket/);
  assert.throws(
    () =>
      f.control.bindings.grantRole({
        sessionId: f.project,
        expectedGeneration: f.store.get(f.project).generation,
      }),
    /reaches no controller socket/,
  );
  // A Book Codex session is not an enrolled Claude seat and is refused by name.
  const codex = f.enrol(T(1));
  f.book.enrol(codex, "codex");
  await assert.rejects(
    assign(f, "project-orchestrator", P(1), codex, 1, "Book Codex should not hold a seat"),
    /enrolled Book Claude session/,
  );
  // An unenrolled session is not in this journal at all, so an observation-only Book session cannot be seated.
  await assert.rejects(
    f.control.bindings.assign({
      role: "project-orchestrator",
      seat: P(1),
      sessionId: randomUUID(),
      expectedSessionGeneration: 1,
      expectedRevision: 1,
      note: "Observation-only session",
    }),
    /saved session identity/,
  );
});

test("a role message reaches the Book seat through host routing and the receiver generation", async (t) => {
  const f = await seated(t);
  const capability = f.capabilityFor(f.prime);
  const channel = await f.request({
    method: "channels-open",
    operator: "test-operator",
    input: {
      primeSeat: "delivery",
      projectSeat: P(1),
      purpose: "Remote role dispatch verification",
      maxMessages: 4,
      expiresAt: EXPIRES,
      expectedPrimeRevision: 1,
      expectedProjectRevision: 1,
    },
  });
  const messageId = randomUUID();
  const sent = await f.request({
    method: "channels-send",
    capability,
    input: {
      sessionId: f.prime,
      channelId: channel.channelId,
      messageId,
      text: "Board decision for your project",
    },
  });
  assert.equal(sent.state, "delivered");
  assert.equal(sent.toSeat, P(1));
  // It went out over the routed path, not the local one.
  assert.deepEqual(
    f.book.sent.map((x) => [x.id, x.remote]),
    [[f.project, true]],
  );
  assert.equal(f.store.delivery(messageId).session, f.project);
  const audited = f.store.db
    .prepare("SELECT toSession,toGeneration,state FROM role_channel_messages WHERE messageId=?")
    .get(messageId);
  assert.deepEqual(
    { ...audited },
    { toSession: f.project, toGeneration: f.store.get(f.project).generation, state: "delivered" },
  );
});

test("a receiver generation or revocation acknowledgement closes remote role dispatch", async (t) => {
  const f = await seated(t);
  const capability = f.capabilityFor(f.prime);
  const open = () =>
    f.request({
      method: "channels-open",
      operator: "test-operator",
      input: {
        primeSeat: "delivery",
        projectSeat: P(1),
        purpose: "Remote role dispatch verification",
        maxMessages: 4,
        expiresAt: EXPIRES,
        expectedPrimeRevision: 1,
        expectedProjectRevision: 1,
      },
    });
  const channel = await open();
  // A revocation in flight: host_routes leaves 'active' before the receiver acknowledges the takeover.
  f.book.beginRevoke(f.project);
  const seat = f.control.bindings.describe("project-orchestrator", P(1));
  assert.equal(seat.dispatch.supported, false);
  assert.match(seat.dispatch.reason, /route is revoking at receiver generation/);
  await assert.rejects(
    f.request({
      method: "channels-send",
      capability,
      input: {
        sessionId: f.prime,
        channelId: channel.channelId,
        messageId: randomUUID(),
        text: "During revocation",
      },
    }),
    /route is revoking/,
  );
  assert.equal(f.book.sent.length, 0);
  assert.equal(
    f.store.db.prepare("SELECT used FROM role_channels WHERE id=?").get(channel.channelId).used,
    0,
  );
  // A receiver generation behind the controller's is equally refused; only an acknowledged one admits.
  f.book.acknowledgeDelegation(f.project, f.store.get(f.project).generation - 1);
  assert.equal(f.control.bindings.describe("project-orchestrator", P(1)).dispatch.supported, false);
  await assert.rejects(
    f.request({
      method: "channels-send",
      capability,
      input: {
        sessionId: f.prime,
        channelId: channel.channelId,
        messageId: randomUUID(),
        text: "Stale receiver generation",
      },
    }),
    /receiver generation/,
  );
  assert.equal(f.book.sent.length, 0);
});

test("a channel needs an originator, and a Book seat is refused at approval while unacknowledged", async (t) => {
  const f = fixture(t),
    prime = f.enrol(PROGRAMME),
    project = f.enrol(T(1));
  f.book.enrol(prime);
  f.book.enrol(project);
  await assign(f, "prime", "delivery", prime, 0, "Book prime seat");
  await assign(f, "project-orchestrator", P(1), project, 0, "Book project seat");
  await f.delegate(prime);
  await f.delegate(project);
  const input = {
    primeSeat: "delivery",
    projectSeat: P(1),
    purpose: "Two Book seats cannot converse",
    maxMessages: 4,
    expiresAt: EXPIRES,
    expectedPrimeRevision: 1,
    expectedProjectRevision: 1,
  };
  // Unacknowledged routes are unreachable, so approval refuses before the originator rule is reached.
  await assert.rejects(
    f.request({ method: "channels-open", operator: "test-operator", input }),
    /seat cannot be reached/,
  );
  f.book.acknowledgeDelegation(prime, f.store.get(prime).generation);
  f.book.acknowledgeDelegation(project, f.store.get(project).generation);
  // Both reachable now, but neither can originate, so the channel would be inert.
  await assert.rejects(
    f.request({ method: "channels-open", operator: "test-operator", input }),
    /At least one seat must be able to originate/,
  );
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM role_channels").get().n, 0);
});

// The admission boundary itself: a real HostNative, a real host_routes row, and the signed receiver
// transport replaced by a named double that records the exact payload it was handed.
test("HostNative admits a role channel dispatch only while every pinned fact still holds", async (t) => {
  const f = await seated(t);
  const capability = f.capabilityFor(f.prime);
  const channel = await f.request({
    method: "channels-open",
    operator: "test-operator",
    input: {
      primeSeat: "delivery",
      projectSeat: P(1),
      purpose: "Remote admission boundary verification",
      maxMessages: 8,
      expiresAt: EXPIRES,
      expectedPrimeRevision: 1,
      expectedProjectRevision: 1,
    },
  });
  const messageId = randomUUID();
  await f.request({
    method: "channels-send",
    capability,
    input: {
      sessionId: f.prime,
      channelId: channel.channelId,
      messageId,
      text: "Board decision for your project",
    },
  });

  assert(
    Date.parse(EXPIRES) > Date.now(),
    "the fixture channel must be unexpired against the wall clock host-native reads",
  );
  const calls = [];
  const book = async (action, input) => {
    calls.push({ action, input });
    return {
      id: input.messageId,
      session: input.sessionId,
      body: canonical(input),
      state: "acknowledged",
    };
  };
  const native = new HostNative({
    store: f.store,
    book,
    local: {
      send: async () => {
        throw Error("A routed session must not take the local path");
      },
    },
  });
  native.attach(f.control);
  native.db
    .prepare(
      "INSERT INTO host_routes(id,request,host,creation,agent,cwd,phase,generation,binding) VALUES (?,?,'macbook',?,?,?,'active',?,?)",
    )
    .run(
      f.project,
      randomUUID(),
      canonical({ provider: "claude" }),
      randomUUID(),
      "/book/owned",
      f.store.get(f.project).generation,
      canonical({ boot: "fixture", boundary: 1, nativeId: null, lastPromptId: null }),
    );
  // Restore the record to the state it actually holds at dispatch time. controller.send writes the
  // supervision binding into the 'intent' result and then overwrites it on 'delivered', so a delivered row
  // no longer carries it; reconstructing the intent is what puts the role binding back in front of the guard.
  const generation = f.store.get(f.project).generation;
  const stage = (id) => {
    f.store.db.prepare("UPDATE deliveries SET state='intent',result=? WHERE id=?").run(
      JSON.stringify({
        nativeAttemptId: randomUUID(),
        generation,
        expectedLastUserAt: null,
        outputContext: {
          generation,
          boot: "fixture",
          nativeId: null,
          cursor: { epoch: "e", seq: 1 },
          quota: { state: "unavailable" },
        },
        // The key production actually writes. It was `supervision` until 935772bf moved it, and because
        // this record is hand-built the test went on asserting a shape nothing produced any more.
        channel: {
          channelId: channel.channelId,
          fromSeat: "delivery",
          toSeat: P(1),
          fromSession: f.prime,
        },
      }),
      id,
    );
    f.store.db
      .prepare("UPDATE role_channel_messages SET state='reserved' WHERE messageId=?")
      .run(id);
  };
  stage(messageId);

  // Negative control first, so the positive case below independently proves the new branch executed: this
  // fact is read ONLY inside the role-channel branch, so if the branch were skipped the send would succeed.
  f.store.db
    .prepare("UPDATE role_channel_messages SET state='acknowledged' WHERE messageId=?")
    .run(messageId);
  await assert.rejects(
    native.send(f.project, "Board decision for your project", messageId),
    /changed remote role channel authority/,
  );
  assert.equal(calls.length, 0, "a role-only precondition must be read, so the branch ran");
  f.store.db
    .prepare("UPDATE role_channel_messages SET state='reserved' WHERE messageId=?")
    .run(messageId);

  await native.send(f.project, "Board decision for your project", messageId);
  f.store.db.prepare("UPDATE deliveries SET state='delivered' WHERE id=?").run(messageId);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, "send");
  assert.equal(calls[0].input.sessionId, f.project);
  assert.equal(calls[0].input.generation, f.store.get(f.project).generation);

  // The deferred states. deliverPending re-offers a message whose row is 'pending' after a busy recipient,
  // and the quota pump replays one that is 'queued'; only 'reserved' was admitted here, so a channel
  // message to a REMOTE seat that had been deferred once was refused at this boundary -- and
  // controller.send turns that refusal into a takeover of the receiving seat.
  for (const deferred of ["pending", "queued"]) {
    stage(messageId);
    f.store.db
      .prepare("UPDATE role_channel_messages SET state=? WHERE messageId=?")
      .run(deferred, messageId);
    const before = calls.length;
    await native.send(f.project, "Board decision for your project", messageId);
    assert.equal(
      calls.length,
      before + 1,
      `a ${deferred} row must still dispatch to a remote seat`,
    );
    f.store.db.prepare("UPDATE deliveries SET state='delivered' WHERE id=?").run(messageId);
  }

  // Each pinned fact, mutated one at a time, must refuse at the boundary rather than dispatch.
  const mutations = {
    "a replaced project seat": () =>
      f.store.db.prepare("UPDATE role_bindings SET revision=revision+1 WHERE seat=?").run(P(1)),
    "a withdrawn originator seat": () =>
      f.store.db.prepare("UPDATE role_bindings SET session=NULL WHERE role=?").run("prime"),
    "a revoked originator capability": () =>
      f.store.db
        .prepare("UPDATE role_credentials SET generation=generation+1 WHERE session=?")
        .run(f.prime),
    "a closed channel": () =>
      f.store.db
        .prepare("UPDATE role_channels SET state='closed' WHERE id=?")
        .run(channel.channelId),
    "a redirected message row": (id) =>
      f.store.db
        .prepare("UPDATE role_channel_messages SET toSession=? WHERE messageId=?")
        .run(randomUUID(), id),
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const next = randomUUID();
    await f.request({
      method: "channels-send",
      capability,
      input: {
        sessionId: f.prime,
        channelId: channel.channelId,
        messageId: next,
        text: "Follow up " + name,
      },
    });
    stage(next);
    const before = calls.length;
    f.store.db.exec("SAVEPOINT probe");
    mutate(next);
    await assert.rejects(
      native.send(f.project, "Follow up " + name, next),
      /changed remote role channel authority/,
      name,
    );
    assert.equal(calls.length, before, name + " must refuse before the receiver is contacted");
    f.store.db.exec("ROLLBACK TO probe");
    f.store.db.exec("RELEASE probe");
    // Discrimination: the same staged message must now admit. Without this an ambient refusal -- an expired
    // channel, say -- would satisfy the assertion above and the mutation would never have been exercised.
    await native.send(f.project, "Follow up " + name, next);
    assert.equal(calls.length, before + 1, name + " must admit once the mutation is rolled back");
    // Resolve it so the next iteration is not blocked by an unreconciled delivery.
    f.store.db.prepare("UPDATE deliveries SET state='delivered' WHERE id=?").run(next);
  }
});
