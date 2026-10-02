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
import { Controller, AUTOMATED_SOURCES } from "./controller.mjs";
import { Bindings } from "./bindings.mjs";
import { RoleChannels, DEFAULT_CHANNEL_MESSAGES, DEFAULT_CHANNEL_DAYS } from "./role-channels.mjs";
import {
  RoleSessions,
  DEFAULT_SEAT_SESSIONS,
  MAX_DEFAULT_CONFERRALS,
  MAX_BRIEF_ATTEMPTS,
  sessionCwd,
  TASKS_ROOT,
} from "./role-sessions.mjs";
import { COMPANY, PROGRAMME } from "./authority.mjs";
import { rpc } from "./rpc.mjs";
import { Manager } from "./manager.mjs";
import { Events } from "./events.mjs";
import { Permissions } from "./permissions.mjs";
import { AUTOMATION_LIMIT } from "./journal-capacity.mjs";

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

// ---------------------------------------------------------------- §1 default session allowance

test("seating confers a bounded default allowance, and the seat can spend exactly it", async (t) => {
  const f = await project(t);
  // Literal, for the same reason as the channel budget: asserting the constant against itself would let the
  // approved number be raised silently. 3 lifetime conferrals are what the prime approved; the default rose from 2
  // to 8 sessions at the prime's G4 request (G-FIXES-REPORT.md), stated here rather than raised silently.
  assert.equal(f.seated.defaults.sessionAllowance.maxSessions, 8);
  assert.equal(DEFAULT_SEAT_SESSIONS, 8, "the G4 default is 8 sessions");
  assert.equal(MAX_DEFAULT_CONFERRALS, 3, "the approved lifetime cap is 3 conferrals");
  assert.equal(f.seated.defaults.sessionAllowance.conferredBy, "seating");
  assert.equal(f.seated.defaults.sessionAllowance.conferral, 1);

  for (let i = 0; i < DEFAULT_SEAT_SESSIONS; i++) assert.equal((await start(f)).state, "delivered");
  // The bound is real: the default is a floor for routine work, not an open budget.
  await assert.rejects(start(f), /allowance reached/);
  assert.equal(f.created.length, DEFAULT_SEAT_SESSIONS);
});

test("a default is pinned to its revision: reaffirming confers nothing and re-seating does not resurrect a spend", async (t) => {
  const f = await project(t);
  await start(f);
  // Reaffirming the SAME holder is not a new seating. It must not mint a fresh count, or a seat could be
  // refilled indefinitely by re-asserting what is already true.
  const again = await f.assign(
    "project-orchestrator",
    P(1),
    f.lead,
    1,
    "Reaffirming the same holder",
  );
  assert.equal(again.action, "reaffirm");
  assert.deepEqual(again.defaults, { sessionAllowance: null, channel: null });
  const after = await f.request({ method: "roles-allowances", operator: "test-operator" });
  assert.equal(after.allowances[0].used, 1, "the spend survives a reaffirmation");
  assert.equal(after.allowances[0].defaultConferrals, 1, "no second conferral was spent");
});

test("the lifetime conferral cap bounds re-seating, and a spent cap never blocks the seating itself", async (t) => {
  const f = fixture(t);
  let revision = 0;
  // Each replacement is an operator act (bindings-assign is operator-only), so this is the operator
  // deliberately re-seating, not a model refilling itself.
  for (let i = 0; i < MAX_DEFAULT_CONFERRALS; i++) {
    const holder = f.enrol(T(1));
    const out = await f.assign("project-orchestrator", P(1), holder, revision++);
    assert.equal(out.defaults.sessionAllowance.conferral, i + 1);
  }
  const extra = f.enrol(T(1));
  const beyond = await f.assign("project-orchestrator", P(1), extra, revision);
  // THE PROPERTY: the default is refused and says why, and the seat is still assigned.
  assert.equal(beyond.action, "replace");
  assert.equal(beyond.defaults.sessionAllowance.conferred, false);
  assert.match(
    beyond.defaults.sessionAllowance.blocked,
    /already received its 3 default session allowances/,
  );
  assert.equal(f.control.bindings.describe("project-orchestrator", P(1)).state, "assigned");
  assert.equal(f.control.bindings.describe("project-orchestrator", P(1)).sessionId, extra);
});

test("an operator may withdraw or raise a default, and only an operator may choose the number", async (t) => {
  const f = await project(t);
  await f.request({
    method: "roles-allowance-set",
    operator: "test-operator",
    input: {
      role: "project-orchestrator",
      seat: P(1),
      expectedRevision: 1,
      maxSessions: 0,
      note: "Withdrawing the seating default",
    },
  });
  await assert.rejects(start(f), /allowance reached/);
  const withdrawn = await f.request({ method: "roles-allowances", operator: "test-operator" });
  assert.equal(
    withdrawn.allowances[0].conferredBy,
    "operator",
    "an operator decision stops being reported as a default",
  );
  assert.equal(
    withdrawn.allowances[0].defaultConferrals,
    1,
    "an operator decision spends no lifetime conferral",
  );
  // Raised again by the operator, and never by the seat.
  await f.request({
    method: "roles-allowance-set",
    operator: "test-operator",
    input: {
      role: "project-orchestrator",
      seat: P(1),
      expectedRevision: 1,
      maxSessions: 3,
      note: "Raising above the default for this cycle",
    },
  });
  assert.equal((await start(f)).state, "delivered");
  await assert.rejects(
    f.request({
      method: "roles-allowance-set",
      capability: f.capability,
      input: {
        role: "project-orchestrator",
        seat: P(1),
        expectedRevision: 1,
        maxSessions: 32,
        note: "A seat trying to fund itself",
      },
    }),
    /Operator authorization/,
  );
});

test("a prime seat receives no default: it is board level, and its defaults are a separate question", async (t) => {
  const f = fixture(t),
    prime = f.enrol(PROGRAMME);
  const seated = await f.assign("prime", "delivery", prime, 0);
  assert.deepEqual(seated.defaults, { sessionAllowance: null, channel: null });
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM role_session_allowances").get().n, 0);
});

// ---------------------------------------------------------------- §2 default prime<->project channel

test("seating opens one bounded default channel to an unambiguous prime", async (t) => {
  const f = fixture(t),
    prime = f.enrol(PROGRAMME),
    lead = f.enrol(T(1));
  await f.assign("prime", "delivery", prime, 0);
  await f.delegate(prime);
  const seated = await f.assign("project-orchestrator", P(1), lead, 0);
  const channel = seated.defaults.channel;
  // The bound is asserted as a LITERAL, not against the constant: comparing the constant to itself would
  // let the approved budget be raised without a single test noticing. 8 is what the prime approved, and an
  // operator's own maximum is 64 -- a default must stay far below what a deliberate approval may choose.
  assert.equal(channel.maxMessages, 8);
  assert.equal(DEFAULT_CHANNEL_MESSAGES, 8, "the approved default is 8 messages");
  assert.ok(channel.maxMessages < 64, "a default is never as wide as an operator approval may be");
  assert.equal(channel.conferredBy, "seating");
  assert.equal(channel.primeSeat, "delivery");
  assert.equal(channel.projectSeat, P(1));
  // Bounded well below what an operator may approve (64 messages, 30 days).
  const days = (Date.parse(channel.expiresAt) - Date.now()) / 86400000;
  assert.equal(DEFAULT_CHANNEL_DAYS, 7, "the approved default expiry is 7 days");
  assert.ok(
    days > 6 && days <= 7,
    `expiry ${days} days is the approved 7-day bound, well inside the 30-day maximum`,
  );
});

test("an ambiguous or absent prime confers no channel, and the seating still succeeds", async (t) => {
  const f = fixture(t),
    lead = f.enrol(T(1));
  // No prime at all.
  const none = await f.assign("project-orchestrator", P(1), lead, 0);
  assert.equal(none.defaults.channel.conferred, false);
  assert.match(none.defaults.channel.blocked, /No usable prime seat/);
  assert.equal(
    f.control.bindings.describe("project-orchestrator", P(1)).state,
    "assigned",
    "seating succeeded anyway",
  );

  // Two usable primes: which one owns this project is not for seating to decide.
  for (const [seat, task] of [
    ["delivery", PROGRAMME],
    ["platform", PROGRAMME],
  ]) {
    const p = f.enrol(task);
    await f.assign("prime", seat, p, 0);
    await f.delegate(p);
  }
  const second = f.enrol(T(3));
  const ambiguous = await f.assign("project-orchestrator", P(2), second, 0);
  assert.equal(ambiguous.defaults.channel.conferred, false);
  assert.match(ambiguous.defaults.channel.blocked, /exactly one usable prime seat; 2 are assigned/);
  assert.equal(f.control.bindings.describe("project-orchestrator", P(2)).state, "assigned");
});

test("either seat may close a channel it holds; a seat that holds neither cannot, and none may open one", async (t) => {
  const f = fixture(t),
    prime = f.enrol(PROGRAMME),
    lead = f.enrol(T(1)),
    bystander = f.enrol(T(3));
  await f.assign("prime", "delivery", prime, 0);
  await f.delegate(prime);
  const seated = await f.assign("project-orchestrator", P(1), lead, 0);
  await f.delegate(lead);
  await f.assign("project-orchestrator", P(2), bystander, 0);
  await f.delegate(bystander);
  const channelId = seated.defaults.channel.channelId;
  const outsider = f.capabilityFor(bystander);

  // A seat on neither side cannot close it.
  await assert.rejects(
    f.request({
      method: "channels-close-seat",
      capability: outsider,
      input: { sessionId: bystander, channelId, note: "Closing a channel that is not mine" },
    }),
    /holds neither seat/,
  );

  // The receiving side can. This is the counterweight to seating opening channels without an operator:
  // a prime being talked at by a misbehaving project seat can stop it itself.
  const closed = await f.request({
    method: "channels-close-seat",
    capability: f.capabilityFor(prime),
    input: { sessionId: prime, channelId, note: "The prime declines this default conversation" },
  });
  assert.equal(closed.state, "closed");
  assert.equal(closed.closedBy, "prime");

  // Closing removes a route and grants nothing: neither seat can open or widen one.
  await assert.rejects(
    f.request({
      method: "channels-open",
      capability: f.capabilityFor(lead),
      input: {
        primeSeat: "delivery",
        projectSeat: P(1),
        purpose: "Reopening what the prime closed",
        maxMessages: 64,
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        expectedPrimeRevision: 1,
        expectedProjectRevision: 1,
      },
    }),
    /Operator authorization/,
  );
  // History is retained, not deleted: the closed row is still there with the reason the prime gave.
  const kept = f.store.db.prepare("SELECT state,note FROM role_channels WHERE id=?").get(channelId);
  assert.equal(kept.state, "closed");
  assert.equal(kept.note, "The prime declines this default conversation");
});

// ---------------------------------------------------------------- §3 brief

test("a brief is delivered once as the new session’s first message, and never twice", async (t) => {
  const f = await project(t);
  const messageId = randomUUID();
  const out = await start(f, {
    messageId,
    brief: "Implement the release flag behind a configuration toggle and report what you verified.",
  });
  assert.equal(out.brief.state, "delivered");
  const delivered = f.sent.filter((s) => s.id === out.sessionId);
  assert.equal(delivered.length, 1);
  assert.match(delivered[0].text, /Implement the release flag/);

  // Retrying the SAME creation identity is idempotent and must not send a second brief. There is no second
  // message on this path at all: a brief is not a channel.
  const retry = await start(f, {
    messageId,
    brief: "Implement the release flag behind a configuration toggle and report what you verified.",
  });
  assert.equal(retry.reserved, false);
  assert.equal(f.sent.filter((s) => s.id === out.sessionId).length, 1, "still exactly one brief");

  // Directly against the delivery guard, with a session that IS deliverable. The retry above does not
  // reach this code -- its handback refuses, so it proves nothing about exactly-once on its own. This
  // calls the deliverer again the way a recovery path would, and it must refuse to send a second time.
  const generation = f.store.get(out.sessionId).generation;
  const second = await f.control.roleSessions.deliverBrief(messageId, out.sessionId, generation);
  assert.equal(
    second.state,
    "delivered",
    "the recorded state is the first delivery, not a new one",
  );
  assert.equal(second.attempts, 1, "no second attempt was made");
  assert.equal(
    f.sent.filter((s) => s.id === out.sessionId).length,
    1,
    "exactly one brief reached the session",
  );
});

test("a brief is bounded at the schema, and a session without one is started unchanged", async (t) => {
  const f = await project(t);
  await assert.rejects(start(f, { brief: "too short" }), /Invalid project session brief/);
  await assert.rejects(start(f, { brief: "x".repeat(8193) }), /Invalid project session brief/);
  const plain = await start(f);
  assert.equal(plain.brief, null);
  assert.equal(
    f.sent.filter((s) => s.id === plain.sessionId).length,
    0,
    "no brief means no message",
  );
});

test("a brief belongs to the seated session that wrote it, and a seat that moved cannot deliver it", async (t) => {
  const f = await project(t);
  const messageId = randomUUID();
  const out = await start(f, {
    messageId,
    brief: "Stage the migration and report what you verified before touching production.",
  });
  assert.equal(out.brief.state, "delivered");

  // Put the brief back to undelivered, the state a crash between reservation and delivery leaves, then
  // replace the seat before it is retried. A brief is instruction from a PARTICULAR seated session; a
  // successor does not get to deliver the instruction its predecessor wrote.
  f.store.db
    .prepare("UPDATE role_session_briefs SET state='reserved' WHERE request=?")
    .run(messageId);
  const successor = f.enrol(T(1));
  await f.assign(
    "project-orchestrator",
    P(1),
    successor,
    1,
    "Replacing the leader before the brief is retried",
  );
  const sentBefore = f.sent.filter((s) => s.id === out.sessionId).length;

  const retried = await f.control.roleSessions.deliverBrief(
    messageId,
    out.sessionId,
    f.store.get(out.sessionId).generation,
  );
  assert.equal(retried.state, "failed");
  assert.match(retried.failure, /seat changed before its brief could be delivered/);
  assert.equal(
    f.sent.filter((s) => s.id === out.sessionId).length,
    sentBefore,
    "nothing was delivered on the stale seat",
  );
});

test("a session that was touched before delegation is not delegated, briefed, or silently left half-ready", async (t) => {
  const f = await project(t);
  // The next created session looks touched the instant it exists -- a human got to it first. handback's
  // `untouched` gate is what must refuse here; without it a seat would delegate a session a person is using.
  const realCreate = f.control.native.create;
  f.control.native.create = async (a) => {
    const r = await realCreate(a);
    f.states.set(r.id, { lastPromptId: randomUUID(), humanAt: 1 });
    return r;
  };

  const out = await start(f, {
    brief: "This brief must never reach a session a human had already touched.",
  });
  assert.equal(
    out.state,
    "delivered",
    "the session itself still exists and its ownership is recorded",
  );
  assert.equal(out.delegated, null, "it was NOT delegated");
  assert.match(out.delegationBlocked, /was not delegated/);
  assert.equal(f.store.get(out.sessionId).mode, "human", "the human keeps it");
  // And the consequences are refused together rather than half-applied.
  assert.equal(out.routineGrant, null, "no routine grant was inherited");
  assert.equal(out.brief.state, "reserved", "the brief was not delivered");
  assert.equal(f.sent.filter((s) => s.id === out.sessionId).length, 0);
});

// ---------------------------------------------------------------- ADDITION: the job directory

test("a seat can read a job directory before it starts the session, and reading creates nothing", async (t) => {
  const f = await project(t);
  const messageId = randomUUID();
  const preview = await f.request({
    method: "roles-job-directory",
    capability: f.capability,
    input: { sessionId: f.lead, seat: P(1), messageId },
  });
  // The SAME derivation native.create uses: HOME/tasks/<messageId>. The fixture's native double writes into
  // its own temp dir, so this asserts the derivation rather than the double's path.
  assert.equal(preview.cwd, sessionCwd(messageId));
  assert.ok(preview.cwd.endsWith(path.join("tasks", messageId)));
  assert.equal(preview.grantsAuthority, false);
  assert.equal(f.created.length, 0, "nothing was created by reading");
  assert.equal(
    f.store.db.prepare("SELECT count(*) n FROM session_ownership").get().n,
    0,
    "nothing was reserved by reading",
  );

  // It is scoped like every other role read: a seat this session does not hold is refused.
  await assert.rejects(
    f.request({
      method: "roles-job-directory",
      capability: f.capability,
      input: { sessionId: f.lead, seat: P(2), messageId: randomUUID() },
    }),
    /seat this session currently holds/,
  );
  // And an identity already spent is refused, so a preview can never be mistaken for a free messageId.
  const used = await start(f);
  await assert.rejects(
    f.request({
      method: "roles-job-directory",
      capability: f.capability,
      input: { sessionId: f.lead, seat: P(1), messageId: used.requestId },
    }),
    /already belongs to another operation/,
  );
});

test("a started session is delegated and reports its own working directory", async (t) => {
  const f = await project(t);
  const out = await start(f);
  assert.equal(out.cwd, f.created[0].cwd ?? out.cwd);
  assert.ok(
    out.delegated,
    "the session the seat just started is delegated, so it can be briefed and can work",
  );
  assert.equal(f.store.get(out.sessionId).mode, "delegated");
  // Delegation is bounded to the untouched session this seat just created: it is not a general power to
  // delegate. A human touching it takes it straight back.
  assert.equal(out.delegationBlocked, null);
});

// ---------------------------------------------------------------- §5
//
// bindings-restore was REMOVED after independent review (B-REVIEW.md F1): it was a second restart route
// that performed no boot comparison, so across a daemon restart it minted a working role capability with no
// inspect at all and laundered away a pre-restart human takeover. Its tests went with it. What §5 still
// asserts is the part that was never in doubt -- the fence itself is untouched, which permission-revocation
// .test.mjs and takeover-control-prompt.test.mjs both pin.
test("no second restart route exists: restoring a seat is not a controller operation", async (t) => {
  const f = await project(t);
  assert.equal(
    typeof f.control.bindings.restore,
    "undefined",
    "the method is gone, not merely unrouted",
  );
  await assert.rejects(
    f.request({
      method: "bindings-restore",
      operator: "test-operator",
      input: {
        role: "project-orchestrator",
        seat: P(1),
        expectedRevision: 1,
        reason: "Attempting the removed route",
      },
    }),
    /Unknown controller method|not a function|Cannot read/,
  );
  // A takeover still ends the capability, and the ordinary operator sequence -- handback, then
  // bindings-grant -- is the only way back at an unchanged boot.
  f.control.takeover(f.lead, "A human answered a permission prompt");
  await assert.rejects(
    f.request({ method: "roles-sessions", capability: f.capability, input: { sessionId: f.lead } }),
    /Role capability revoked or invalid/,
  );
  await f.delegate(f.lead);
  const reissued = await f.request({
    method: "bindings-grant",
    operator: "test-operator",
    input: { sessionId: f.lead, expectedGeneration: f.store.get(f.lead).generation },
  });
  const fresh = JSON.parse(fs.readFileSync(reissued.grantFile, "utf8")).capability;
  assert.notEqual(fresh, f.capability, "the old token stays dead");
  assert.equal(
    (await f.request({ method: "roles-sessions", capability: fresh, input: { sessionId: f.lead } }))
      .sessionId,
    f.lead,
  );
  assert.equal(
    f.control.bindings.describe("project-orchestrator", P(1)).revision,
    1,
    "and no revision moved",
  );
});

// A session that is idle for its delegation -- handback requires that -- and busy from the moment it is
// delegated, which is exactly the window a brief is delivered in.
function busySession(f) {
  let busyId = null;
  const realInspect = f.control.native.inspect;
  f.control.native.inspect = async (id) => {
    const r = await realInspect(id);
    return id === busyId ? { ...r, status: "running" } : r;
  };
  const realHandback = f.control.handback.bind(f.control);
  f.control.handback = async (id, ...rest) => {
    const out = await realHandback(id, ...rest);
    busyId = id;
    return out;
  };
  return {
    idle: () => {
      busyId = null;
    },
  };
}

// ---------------------------------------------------------------- review follow-ups (B-REVIEW.md)

// F2. The brief's admission was correct but unpinned: a mutation replacing control.send with a direct
// native.send left the whole role suite green. These assert the ROUTE, not just the resulting state.
test("a brief travels the admitted send path, and is refused when human input has revoked delegation", async (t) => {
  const f = await project(t);
  const out = await start(f, {
    brief: "Stage the migration and report what you verified before production.",
  });
  assert.equal(out.brief.state, "delivered");

  // control.send journals a delivery for the session; native.send alone does not. This is what a bypass
  // would remove, and what nothing previously asserted.
  const delivered = f.store.db
    .prepare("SELECT * FROM deliveries WHERE session=? AND kind='send' AND state='delivered'")
    .all(out.sessionId);
  assert.equal(delivered.length, 1, "the brief went through control.send, not around it");
  assert.equal(
    JSON.parse(delivered[0].body).text,
    "Stage the migration and report what you verified before production.",
  );

  // The admission fence still applies to a brief. A human touching the new session between delegation and
  // delivery revokes it, and the brief is refused rather than delivered into a session a person has taken.
  const second = await project(t);
  const messageId = randomUUID();
  const realCreate = second.control.native.create;
  second.control.native.create = async (a) => {
    const r = await realCreate(a);
    // Delegation succeeds, then a person touches the session before the brief is sent.
    queueMicrotask(() => second.states.set(r.id, { ...second.states.get(r.id), humanAt: 99 }));
    return r;
  };
  const touched = await start(second, {
    messageId,
    brief: "This brief must not reach a session a human has taken.",
  });
  assert.notEqual(touched.brief.state, "delivered", "a revoked delegation refuses the brief");
  assert.equal(
    second.sent.filter((s) => s.id === touched.sessionId).length,
    0,
    "and nothing was sent",
  );
});

// F3. A brief to a busy recipient must be deferred and delivered, like a channel report -- not lost.
test("a busy new session defers its brief and still receives it, bounded by attempts", async (t) => {
  const f = await project(t);
  // Busy the way control.send actually sees it: the recipient is not idle when the send is attempted. The
  // session is idle for its handback (delegation requires that) and goes busy immediately after, which is
  // the real race -- a new worker that starts working before its brief arrives.
  const busied = busySession(f);
  const out = await start(f, { brief: "Implement the release flag and report what you verified." });
  await f.control.roleSessions.pump(); // the deferral pump is fired and not awaited by the caller
  // NOT failed. Nothing was admitted, so nothing was lost and nothing can be duplicated.
  assert.equal(
    f.control.roleSessions.briefState(out.requestId).state,
    "pending",
    "a busy recipient defers the brief rather than losing it",
  );
  assert.equal(f.sent.filter((s) => s.id === out.sessionId).length, 0);
  // The session is interesting to the wake loop precisely because it is still owed its brief.
  assert.equal(f.control.roleSessions.interested(out.sessionId), true);

  busied.idle();
  await f.control.roleSessions.deliverPendingBriefs();
  assert.equal(f.control.roleSessions.briefState(out.requestId).state, "delivered");
  assert.equal(
    f.sent.filter((s) => s.id === out.sessionId).length,
    1,
    "delivered exactly once, after the wait",
  );
  // And still exactly once: the pump must not re-send what it already delivered.
  await f.control.roleSessions.deliverPendingBriefs();
  assert.equal(f.sent.filter((s) => s.id === out.sessionId).length, 1);
});

test("a brief deferral is bounded: a permanently busy session fails terminally rather than retrying forever", async (t) => {
  const f = await project(t);
  busySession(f); // and it never goes idle again
  const out = await start(f, {
    brief: "This session never goes idle, so this brief must eventually stop.",
  });
  await f.control.roleSessions.pump();
  assert.equal(f.control.roleSessions.briefState(out.requestId).state, "pending");
  for (let i = 0; i < MAX_BRIEF_ATTEMPTS + 2; i++) await f.control.roleSessions.pump();
  const final = f.control.roleSessions.briefState(out.requestId);
  assert.equal(final.state, "failed");
  assert.ok(
    final.attempts <= MAX_BRIEF_ATTEMPTS,
    `attempts ${final.attempts} stayed within the bound`,
  );
  assert.match(final.failure, /bounded number of delivery attempts/);
  assert.equal(
    f.control.roleSessions.interested(out.sessionId),
    false,
    "and it stops waking the session",
  );
});

// F4. Confinement was enforced only by the callers' UUID validation, and nothing pinned it.
test("a job directory cannot escape the controller task root, whatever the identity looks like", async (t) => {
  const f = await project(t);
  for (const bad of ["../outside", "..", "a/b", "/etc/passwd", "", "a/../../b"]) {
    assert.throws(
      () => sessionCwd(bad),
      /escapes the controller task root|needs a creation identity/,
      `sessionCwd(${JSON.stringify(bad)}) must refuse`,
    );
  }
  // The RPC refuses them too, before reaching the derivation at all.
  for (const bad of ["../outside", "a/b", "/etc/passwd"]) {
    await assert.rejects(
      f.request({
        method: "roles-job-directory",
        capability: f.capability,
        input: { sessionId: f.lead, seat: P(1), messageId: bad },
      }),
      /Invalid job directory read/,
    );
  }
  // A real identity still resolves, and resolves inside the root.
  const good = randomUUID();
  assert.equal(path.dirname(sessionCwd(good)), TASKS_ROOT);
});

// ---------------------------------------------------------------- G1 (G-FIXES-REPORT.md): seating issues what the seat's tools need
// The Tally E2E orchestrator was seated and delegated, and then every role tool failed with ENOENT on
// grants/role/<id>.json (and the manager tools on grants/manager/<id>.json) until the prime issued them by hand.
const grantPath = (f, lane, id) =>
  path.join(f.dir, "grants", lane, path.basename(f.store.get(id).cwd) + ".json");
test("G1: seating a delegated orchestrator issues its role credential, and manager + inbox grants when asked", async (t) => {
  const f = fixture(t);
  f.control.manager = new Manager(f.control, path.join(f.dir, "grants", "manager"));
  f.control.events = new Events(f.control, path.join(f.dir, "grants", "inbox"));
  const lead = f.enrol(T(1));
  await f.delegate(lead);
  const seated = await f.control.bindings.assign({
    role: "project-orchestrator",
    seat: P(1),
    sessionId: lead,
    expectedSessionGeneration: f.store.get(lead).generation,
    expectedRevision: 0,
    note: "Seating the Tally-style orchestrator",
    manager: { maxWorkers: 6, reason: "Prime: this orchestrator may run up to 6 workers" },
  });
  assert.equal(seated.defaults.roleGrant.issued, true);
  assert.equal(seated.defaults.managerGrant.issued, true);
  assert.equal(seated.defaults.managerGrant.maxWorkers, 6);
  const role = JSON.parse(fs.readFileSync(grantPath(f, "role", lead), "utf8")),
    manager = JSON.parse(fs.readFileSync(grantPath(f, "manager", lead), "utf8")),
    inbox = JSON.parse(fs.readFileSync(grantPath(f, "inbox", lead), "utf8"));
  assert.deepEqual(
    (
      await f.request({
        method: "bindings-self",
        capability: role.capability,
        input: { sessionId: lead },
      })
    ).roles.map((r) => r.seat),
    [P(1)],
  );
  assert.deepEqual(
    await f.request({
      method: "manager-workers",
      capability: manager.capability,
      input: { sessionId: lead },
    }),
    [],
  );
  assert.deepEqual(
    (
      await f.request({
        method: "events-inbox",
        capability: inbox.capability,
        input: { sessionId: lead },
      })
    ).events,
    [],
  );
  assert.equal(
    new Set([role.capability, manager.capability, inbox.capability]).size,
    3,
    "three distinct narrow credentials",
  );
  // Without the operator's `manager` input, seating grants no manager authority (PROPOSAL-seating-defaults).
  const other = f.enrol(T(3));
  await f.delegate(other);
  const plain = await f.assign("project-orchestrator", P(2), other, 0);
  assert.equal(plain.defaults.roleGrant.issued, true);
  assert.equal(plain.defaults.managerGrant, undefined);
  assert.equal(fs.existsSync(grantPath(f, "manager", other)), false);
  // A `manager` input is only for a project orchestrator seat.
  await assert.rejects(
    f.control.bindings.assign({
      role: "prime",
      seat: "board",
      sessionId: f.enrol(PROGRAMME),
      expectedSessionGeneration: 1,
      expectedRevision: 0,
      note: "A prime with a manager input",
      manager: { maxWorkers: 1, reason: "Not for a prime seat" },
    }),
    /Invalid role assignment/,
  );
});
test("G1: seated under human control, the role credential arrives at the first delegation and role tools work with no manual grant", async (t) => {
  const f = fixture(t);
  f.control.manager = new Manager(f.control, path.join(f.dir, "grants", "manager"));
  f.control.events = new Events(f.control, path.join(f.dir, "grants", "inbox"));
  const lead = f.enrol(T(1));
  const seated = await f.control.bindings.assign({
    role: "project-orchestrator",
    seat: P(1),
    sessionId: lead,
    expectedSessionGeneration: 1,
    expectedRevision: 0,
    note: "Seated before delegation",
    manager: { maxWorkers: 2, reason: "Manager grant asked for too early" },
  });
  assert.equal(seated.defaults.roleGrant.issued, false);
  assert.match(seated.defaults.managerGrant.blocked, /needs a delegated session/);
  assert.equal(fs.existsSync(grantPath(f, "role", lead)), false);
  await f.delegate(lead);
  const role = JSON.parse(fs.readFileSync(grantPath(f, "role", lead), "utf8"));
  const sessions = await f.request({
    method: "roles-sessions",
    capability: role.capability,
    input: { sessionId: lead },
  });
  assert.deepEqual(
    sessions.projects.map((p) => p.projectId),
    [P(1)],
  );
  assert.ok(sessions.projects[0].allowance.remaining >= 1);
  const started = await f.request({
    method: "roles-create-session",
    capability: role.capability,
    input: {
      sessionId: lead,
      seat: P(1),
      taskId: T(1),
      messageId: randomUUID(),
      provider: "claude",
      title: "First job without a manual grant",
    },
  });
  assert.equal(started.state ?? "delivered", "delivered");
  // Pinned to the seat and revision: once vacated, a later delegation issues nothing.
  const f2 = fixture(t),
    again = f2.enrol(T(1));
  await f2.assign("project-orchestrator", P(1), again, 0);
  f2.control.bindings.unassign({
    role: "project-orchestrator",
    seat: P(1),
    expectedRevision: 1,
    note: "Vacated before its first delegation",
  });
  await f2.delegate(again);
  assert.equal(fs.existsSync(grantPath(f2, "role", again)), false);
});

// ---------------------------------------------------------------- G9 (G-FIXES-REPORT.md): role-started workers get routine authority
test("G9: a session the orchestrator starts inherits its routine grant through the recorded ownership, and loses it with the seat", async (t) => {
  const f = await project(t),
    create = f.control.native.create;
  f.control.native.create = async (a) => {
    const r = await create(a);
    fs.mkdirSync(r.cwd, { recursive: true });
    return r;
  };
  fs.mkdirSync(f.store.get(f.lead).cwd, { recursive: true });
  f.control.events = new Events(f.control, path.join(f.dir, "grants", "inbox"));
  f.control.permissions = new Permissions(f.control, f.dir);
  const root = await f.control.permissions.grant({
    sessionId: f.lead,
    expectedGeneration: f.store.get(f.lead).generation,
    reason: "Orchestrator routine files for the project",
  });
  assert.equal(root.active, true);
  const out = await start(f),
    worker = f.created.at(-1).id;
  assert.equal(out.routineGrant.active, true, out.routineGrant.reason);
  assert.equal(out.routineGrant.pool, f.lead);
  assert.equal(f.control.permissions.status(worker).active, true);
  // A session this orchestrator did not start has no such link.
  const stranger = f.enrol(T(2));
  fs.mkdirSync(f.store.get(stranger).cwd, { recursive: true });
  await f.delegate(stranger);
  const refused = await f.control.permissions.inherit(stranger, f.lead);
  assert.equal(refused.active, false);
  assert.match(refused.reason, /no ownership link/);
  // Vacating the orchestrator's seat ends the inherited authority immediately.
  f.control.bindings.unassign({
    role: "project-orchestrator",
    seat: P(1),
    expectedRevision: 1,
    note: "Project seat released by the operator",
  });
  assert.throws(() => f.control.permissions.binding(worker), /no ownership link/);
});

// ---------------------------------------------------------------- G7/G8 (G-FIXES-REPORT.md): inspect and follow up owned sessions
async function withWorker(t) {
  const f = await project(t),
    completions = [];
  f.control.native.completion = async (id, messageId, progress) => {
    completions.push({ id, messageId, progress });
    return {
      ended: true,
      interrupted: false,
      progress: { ...progress, outputPreview: "J2 done: 12 tests pass", outputLength: 22 },
    };
  };
  const create = f.control.native.create;
  f.control.native.create = async (a) => {
    const r = await create(a);
    f.states.set(r.id, { timelineCursor: { epoch: "fixture-epoch", seq: 7 } });
    return r;
  };
  const out = await start(f, { brief: "Build J2 in your worktree and report what you verified." });
  const inspect = (target = out.sessionId, capability = f.capability, sessionId = f.lead) =>
    f.request({
      method: "roles-inspect-session",
      capability,
      input: { sessionId, targetSessionId: target },
    });
  const follow = (
    text,
    messageId = randomUUID(),
    target = out.sessionId,
    capability = f.capability,
  ) =>
    f.request({
      method: "roles-send-session",
      capability,
      input: { sessionId: f.lead, targetSessionId: target, messageId, text },
    });
  return { ...f, out, completions, inspect, follow };
}
test("G7: the orchestrator reads its own session’s state and final reply, as untrusted evidence", async (t) => {
  const f = await withWorker(t);
  const seen = await f.inspect();
  assert.equal(seen.sessionId, f.out.sessionId);
  assert.equal(seen.mode, "delegated");
  assert.equal(seen.final.state, "ended");
  assert.equal(seen.final.output, "J2 done: 12 tests pass");
  assert.equal(seen.untrusted, true);
  assert.equal(seen.accepted, false);
  // The output read starts at the pre-send position the controller recorded for the brief.
  assert.deepEqual(f.completions.at(-1).progress, { cursor: { epoch: "fixture-epoch", seq: 7 } });
  assert.equal(f.completions.at(-1).messageId, seen.lastInstructionId);
});
test("G7/G8: only sessions this seat started, while it still holds the seat", async (t) => {
  const f = await withWorker(t);
  const stranger = f.enrol(T(1));
  await f.delegate(stranger);
  await assert.rejects(f.inspect(stranger), /not started by this seat/);
  await assert.rejects(
    f.follow("Do something else", randomUUID(), stranger),
    /not started by this seat/,
  );
  // A replacement holder of the SAME seat did not start this session: the recorded parent decides, not the seat
  // (transfers go through roles-adopt). The replaced holder has lost its role, so it cannot read it either.
  const next = f.enrol(T(1));
  await f.delegate(next);
  const replaced = await f.control.bindings.assign({
    role: "project-orchestrator",
    seat: P(1),
    sessionId: next,
    expectedSessionGeneration: f.store.get(next).generation,
    expectedRevision: 1,
    note: "A new holder replaces the lead",
  });
  assert.equal(replaced.action, "replace");
  assert.equal(replaced.defaults.roleGrant.issued, true);
  const nextCapability = JSON.parse(
    fs.readFileSync(replaced.defaults.roleGrant.grantFile, "utf8"),
  ).capability;
  await assert.rejects(
    f.inspect(f.out.sessionId, nextCapability, next),
    /not started by this seat/,
  );
  await assert.rejects(f.inspect(), /revoked or invalid|no longer hold/);
});
test("G8: a follow-up reaches the same session through the ordinary send path, is idempotent and bounded, and stops at a human takeover", async (t) => {
  const f = await withWorker(t),
    messageId = randomUUID();
  const sent = await f.follow(
    "Fix the two review findings in place and re-run the tests.",
    messageId,
  );
  assert.equal(sent.state, "delivered");
  assert.equal(sent.accepted, false);
  const toWorker = f.sent.filter((s) => s.id === f.out.sessionId);
  assert.equal(toWorker.length, 2);
  assert.match(toWorker[1].text, /Fix the two review findings/);
  f.states.set(f.out.sessionId, { ...f.states.get(f.out.sessionId), status: "idle" });
  assert.equal(
    (await f.follow("Fix the two review findings in place and re-run the tests.", messageId)).state,
    "delivered",
  );
  assert.equal(
    f.sent.filter((s) => s.id === f.out.sessionId).length,
    2,
    "the same messageId is not sent twice",
  );
  assert.equal((await f.inspect()).lastInstructionId, messageId);
  f.control.takeover(f.out.sessionId, "The human lead takes this session over");
  await assert.rejects(f.follow("One more thing"), /human has taken this session over/);
  f.store.db.exec("BEGIN");
  for (let n = 0; n < 40; n++)
    f.store.db
      .prepare("INSERT INTO role_session_followups VALUES (?,?,?,?)")
      .run(randomUUID(), f.out.sessionId, f.lead, "x");
  f.store.db.exec("COMMIT");
  await f.delegate(f.out.sessionId);
  await assert.rejects(f.follow("Beyond the bound"), /received its 32 follow-ups/);
});

// ---------------------------------------------------------------- REVIEW-G (G-1..G-4), folded into H5
async function seatedManager(t) {
  const f = fixture(t);
  f.control.manager = new Manager(f.control, path.join(f.dir, "grants", "manager"));
  f.control.events = new Events(f.control, path.join(f.dir, "grants", "inbox"));
  const lead = f.enrol(T(1));
  await f.delegate(lead);
  const seated = await f.control.bindings.assign({
    role: "project-orchestrator",
    seat: P(1),
    sessionId: lead,
    expectedSessionGeneration: f.store.get(lead).generation,
    expectedRevision: 0,
    note: "Seated with a manager grant",
    manager: { maxWorkers: 2, reason: "Seat-conferred manager authority" },
  });
  const managerCapability = JSON.parse(
    fs.readFileSync(seated.defaults.managerGrant.grantFile, "utf8"),
  ).capability;
  const workers = () =>
    f.request({
      method: "manager-workers",
      capability: managerCapability,
      input: { sessionId: lead },
    });
  return { ...f, lead, seated, workers };
}
test("G-1: manager authority conferred by seating ends with the seat, vacated or replaced", async (t) => {
  const f = await seatedManager(t);
  assert.deepEqual(await f.workers(), []);
  f.control.bindings.unassign({
    role: "project-orchestrator",
    seat: P(1),
    expectedRevision: 1,
    note: "The operator vacates the seat",
  });
  await assert.rejects(f.workers(), /Manager authority revoked or invalid/);
  assert.equal(fs.existsSync(f.seated.defaults.managerGrant.grantFile), false);
  const g = await seatedManager(t),
    next = g.enrol(T(1));
  await g.delegate(next);
  await g.control.bindings.assign({
    role: "project-orchestrator",
    seat: P(1),
    sessionId: next,
    expectedSessionGeneration: g.store.get(next).generation,
    expectedRevision: 1,
    note: "A new holder replaces the lead",
  });
  await assert.rejects(g.workers(), /Manager authority revoked or invalid/);
});
test("G-1: an operator manager-grant stays session-bound, and a reaffirmation with manager over a live grant says why it grants nothing (G-3)", async (t) => {
  const f = await seatedManager(t);
  const again = await f.control.bindings.assign({
    role: "project-orchestrator",
    seat: P(1),
    sessionId: f.lead,
    expectedSessionGeneration: f.store.get(f.lead).generation,
    expectedRevision: 1,
    note: "Reaffirming with a manager request",
    manager: { maxWorkers: 3, reason: "Asked again on a reaffirmation" },
  });
  assert.equal(again.action, "reaffirm");
  assert.equal(again.defaults.managerGrant.issued, false);
  assert.match(
    again.defaults.managerGrant.blocked,
    /already holds manager authority; re-issuing it would orphan its workers/,
  );
  assert.deepEqual(
    await f.workers(),
    [],
    "the seat-conferred grant is untouched by a reaffirmation",
  );
  // An operator's own manager-grant (a new epoch) replaces the seat-conferred one and is not the seat's to revoke.
  f.control.takeover(f.lead, "Take over to re-delegate for an operator grant");
  const d = await f.delegate(f.lead);
  const own = await f.control.manager.grant({
    sessionId: f.lead,
    expectedGeneration: d.generation,
    capability: d.capability,
    maxWorkers: 1,
    reason: "Operator grants manager authority itself",
  });
  f.control.bindings.unassign({
    role: "project-orchestrator",
    seat: P(1),
    expectedRevision: 2,
    note: "The operator vacates the seat",
  });
  const capability = JSON.parse(fs.readFileSync(own.grantFile, "utf8")).capability;
  assert.deepEqual(
    await f.request({ method: "manager-workers", capability, input: { sessionId: f.lead } }),
    [],
  );
});
test("G-2: automated and model-driven sends stop at the automation limit; operator sends keep the manual reserve", async (t) => {
  const f = await withWorker(t);
  f.store.db.exec("BEGIN");
  while (f.store.db.prepare("SELECT count(*) n FROM deliveries").get().n < AUTOMATION_LIMIT)
    f.store.db
      .prepare("INSERT INTO deliveries VALUES (?,NULL,'fixture','{}','delivered',NULL)")
      .run(randomUUID());
  f.store.db.exec("COMMIT");
  await assert.rejects(
    f.follow("A follow-up past the automation limit"),
    /Journal automation budget reached/,
  );
  const sent = await f.request({
    method: "operator-send",
    operator: "test-operator",
    input: {
      sessionId: f.out.sessionId,
      messageId: randomUUID(),
      text: "The operator can still act",
      expectedGeneration: f.store.get(f.out.sessionId).generation,
    },
  });
  assert.equal(sent.state, "delivered");
});
test("G-4: an orchestrator holding two seats cannot reach the sessions of the seat it lost", async (t) => {
  const f = await withWorker(t);
  f.source.value = {
    ...f.source.value,
    membership: [...f.source.value.membership, { taskId: T(1), projectId: P(2) }],
  };
  const second = await f.assign(
    "project-orchestrator",
    P(2),
    f.lead,
    0,
    "The lead also holds a second project",
  );
  // Seating the second project issues a fresh role token at the same path (G1); the session reads it on its next call.
  const capability = JSON.parse(
    fs.readFileSync(second.defaults.roleGrant.grantFile, "utf8"),
  ).capability;
  const next = f.enrol(T(1));
  await f.delegate(next);
  await f.control.bindings.assign({
    role: "project-orchestrator",
    seat: P(1),
    sessionId: next,
    expectedSessionGeneration: f.store.get(next).generation,
    expectedRevision: 1,
    note: "A new holder takes the first project",
  });
  assert.deepEqual(
    (
      await f.request({ method: "bindings-self", capability, input: { sessionId: f.lead } })
    ).roles.map((r) => r.seat),
    [P(2)],
    "the credential lives on through the second seat",
  );
  await assert.rejects(f.inspect(f.out.sessionId, capability), /no longer hold the project seat/);
  await assert.rejects(
    f.follow("Reaching into the lost seat", randomUUID(), f.out.sessionId, capability),
    /no longer hold the project seat/,
  );
});
// REVIEW-G G-5 (brief: tests for the X2/X5 re-checks) and the G-1 re-check at seating.
const vacate = (f) =>
  f.control.bindings.unassign({
    role: "project-orchestrator",
    seat: P(1),
    expectedRevision: 1,
    note: "The operator vacates the seat mid-call",
  });
test("REVIEW-G X5: a seat lost while the owned-session read is in flight returns nothing", async (t) => {
  const f = await withWorker(t),
    inspect = f.control.inspect.bind(f.control);
  let fired = false;
  f.control.inspect = async (id) => {
    const r = await inspect(id);
    if (id === f.out.sessionId && !fired) {
      fired = true;
      vacate(f);
    }
    return r;
  };
  await assert.rejects(f.inspect(), /revoked or invalid|no longer hold/);
  assert.equal(fired, true);
});
test("REVIEW-G X2: a seat lost between the follow-up’s checks and its dispatch sends nothing", async (t) => {
  const f = await withWorker(t),
    inspect = f.control.native.inspect;
  let fired = false;
  f.control.native.inspect = async (id, ...rest) => {
    const r = await inspect(id, ...rest);
    if (id === f.out.sessionId && !fired) {
      fired = true;
      vacate(f);
    }
    return r;
  };
  const before = f.sent.filter((s) => s.id === f.out.sessionId).length;
  await assert.rejects(
    f.follow("Continue after the seat is gone"),
    /revoked or invalid|no longer hold/,
  );
  assert.equal(fired, true);
  assert.equal(
    f.sent.filter((s) => s.id === f.out.sessionId).length,
    before,
    "nothing was dispatched",
  );
});
async function seatingWith(t, hook) {
  const f = fixture(t);
  f.control.manager = new Manager(f.control, path.join(f.dir, "grants", "manager"));
  f.control.events = new Events(f.control, path.join(f.dir, "grants", "inbox"));
  const lead = f.enrol(T(1));
  await f.delegate(lead);
  hook(f);
  const seated = await f.control.bindings.assign({
    role: "project-orchestrator",
    seat: P(1),
    sessionId: lead,
    expectedSessionGeneration: f.store.get(lead).generation,
    expectedRevision: 0,
    note: "Seated with a manager grant",
    manager: { maxWorkers: 2, reason: "Seat-conferred manager authority" },
  });
  return {
    ...f,
    lead,
    seated,
    grants: () =>
      f.store.db.prepare("SELECT count(*) n FROM manager_grants WHERE supervisor=?").get(lead).n,
  };
}
test("REVIEW-G G-1: grantSeated re-checks the seat, so a seat vacated during the grant issues nothing", async (t) => {
  const f = await seatingWith(t, (f) => {
    const inspect = f.control.inspect.bind(f.control);
    let fired = false;
    f.control.inspect = async (id) => {
      const r = await inspect(id);
      if (!fired) {
        fired = true;
        vacate(f);
      }
      return r;
    };
  });
  assert.equal(f.seated.defaults.managerGrant.issued, false);
  assert.match(f.seated.defaults.managerGrant.blocked, /seat changed during the manager grant/);
  assert.equal(f.grants(), 0, "no manager grant exists for the session that lost the seat");
});
test("REVIEW-G G-1: a seat vacated just after the grant was issued revokes it, because the grant was recorded with it", async (t) => {
  const f = await seatingWith(t, (f) => {
    const grantSeated = f.control.manager.grantSeated.bind(f.control.manager);
    f.control.manager.grantSeated = async (...a) => {
      const g = await grantSeated(...a);
      vacate(f);
      return g;
    };
  });
  assert.equal(f.seated.defaults.managerGrant.issued, false);
  assert.match(f.seated.defaults.managerGrant.blocked, /revoked with the seat/);
  assert.equal(
    f.grants(),
    0,
    "the grant issued a moment before the vacate was revoked with the seat",
  );
});

// ---------------------------------------------------------------- H6 item 1: RECHECK-H5 R-1 and R-2
// Every model-driven path is driven through its REAL call site at the automation limit, and must be refused with
// nothing dispatched and nothing written into the manual reserve. A second, static test pins every control.send
// call site, so a new model-driven site cannot quietly use the reserve either.
const padTo = (f, n) => {
  f.store.db.exec("BEGIN");
  for (let c = f.store.db.prepare("SELECT count(*) n FROM deliveries").get().n; c < n; c++)
    f.store.db
      .prepare("INSERT INTO deliveries VALUES (?,NULL,'fixture','{}','delivered',NULL)")
      .run(randomUUID());
  f.store.db.exec("COMMIT");
};
const rows = (f) => f.store.db.prepare("SELECT count(*) n FROM deliveries").get().n;
const BUDGET = /Journal automation budget reached/;
test("R-1: a seat’s own session create stops before the reserve, spending no allowance and writing no row", async (t) => {
  for (const [brief, at] of [
    [undefined, AUTOMATION_LIMIT],
    ["Build it and report what you verified.", AUTOMATION_LIMIT - 1],
  ]) {
    const f = await project(t);
    padTo(f, at);
    await assert.rejects(start(f, brief ? { brief } : {}), BUDGET);
    assert.equal(rows(f), at, "no create row was written into the reserve");
    assert.equal(f.created.length, 0);
    assert.equal(
      f.store.db.prepare("SELECT used FROM role_session_allowances WHERE seat=?").get(P(1)).used,
      0,
      "no allowance was spent",
    );
    assert.equal(
      f.store.db.prepare("SELECT count(*) n FROM session_ownership").get().n,
      0,
      "no ownership was reserved",
    );
  }
  // One row short of the limit, a brief-less create fits exactly; with a brief it needs two rows and is refused (above).
  const g = await project(t);
  padTo(g, AUTOMATION_LIMIT - 1);
  assert.equal((await start(g)).state, "delivered");
  assert.equal(rows(g), AUTOMATION_LIMIT);
});
test("R-1: a seat accepting an operator request stops before the reserve too; an operator declared create keeps it", async (t) => {
  const f = await project(t);
  const asked = await f.request({
    method: "roles-request-session",
    operator: "test-operator",
    input: {
      seat: P(1),
      expectedRevision: 1,
      taskId: T(2),
      provider: "claude",
      title: "Implement the release flag",
      note: "Board asked for this ahead of the cycle",
    },
  });
  await f.control.roleSessions.pump(); // the request's own wake is delivered before the journal fills
  padTo(f, AUTOMATION_LIMIT);
  await assert.rejects(
    f.request({
      method: "roles-accept-session",
      capability: f.capability,
      input: { sessionId: f.lead, requestId: asked.requestId, messageId: randomUUID() },
    }),
    BUDGET,
  );
  assert.equal(rows(f), AUTOMATION_LIMIT);
  assert.equal(f.created.length, 0);
  const declared = await f.request({
    method: "create",
    operator: "test-operator",
    input: {
      projectId: P(1),
      messageId: randomUUID(),
      taskId: T(1),
      provider: "claude",
      title: "An operator’s own session",
    },
  });
  assert.equal(
    declared.state,
    "delivered",
    "an operator create uses the manual reserve, as intended",
  );
  assert.equal(rows(f), AUTOMATION_LIMIT + 1);
});
test("R-2: every automated send kind is refused at the automation limit through its real call site", async (t) => {
  const cases = {
    "role-followup": async () => {
      const f = await withWorker(t);
      padTo(f, AUTOMATION_LIMIT);
      const before = f.sent.length;
      await assert.rejects(f.follow("Past the limit"), BUDGET);
      return [f, before];
    },
    "role-brief (deferred, then pumped)": async () => {
      const f = await project(t),
        busied = busySession(f);
      const out = await start(f, {
        brief: "Implement the release flag and report what you verified.",
      });
      await f.control.roleSessions.pump();
      assert.equal(f.control.roleSessions.briefState(out.requestId).state, "pending");
      padTo(f, AUTOMATION_LIMIT);
      busied.idle();
      const before = f.sent.length;
      await f.control.roleSessions.deliverPendingBriefs();
      const b = f.control.roleSessions.briefState(out.requestId);
      assert.notEqual(b.state, "delivered");
      assert.match(JSON.stringify(b), BUDGET);
      return [f, before];
    },
    "role-channel (direct)": async () => {
      const f = fixture(t),
        prime = f.enrol(PROGRAMME),
        lead = f.enrol(T(1));
      await f.assign("prime", "delivery", prime, 0);
      await f.delegate(prime);
      const seated = await f.assign("project-orchestrator", P(1), lead, 0);
      await f.delegate(lead);
      const capability = f.capabilityFor(lead);
      padTo(f, AUTOMATION_LIMIT);
      const before = f.sent.length;
      await assert.rejects(
        f.request({
          method: "channels-send",
          capability,
          input: {
            sessionId: lead,
            channelId: seated.defaults.channel.channelId,
            messageId: randomUUID(),
            text: "Past the limit",
          },
        }),
        BUDGET,
      );
      return [f, before];
    },
    "role-channel (deferred, then pumped)": async () => {
      const f = fixture(t),
        prime = f.enrol(PROGRAMME),
        lead = f.enrol(T(1));
      await f.assign("prime", "delivery", prime, 0);
      await f.delegate(prime);
      const seated = await f.assign("project-orchestrator", P(1), lead, 0);
      await f.delegate(lead);
      const capability = f.capabilityFor(lead);
      f.states.set(prime, { status: "running" });
      const m = await f.request({
        method: "channels-send",
        capability,
        input: {
          sessionId: lead,
          channelId: seated.defaults.channel.channelId,
          messageId: randomUUID(),
          text: "Deferred then past the limit",
        },
      });
      assert.equal(m.state, "pending");
      padTo(f, AUTOMATION_LIMIT);
      f.states.set(prime, { status: "idle" });
      const before = f.sent.length;
      await f.control.channels.pump();
      assert.equal(
        f.store.db
          .prepare("SELECT state FROM role_channel_messages WHERE messageId=?")
          .get(m.messageId).state,
        "failed",
      );
      return [f, before];
    },
    "role-request-wake (automated)": async () => {
      const f = await project(t);
      f.control.roleSessions.pump = () => Promise.resolve(); // the request's own background wake waits for the limit
      const asked = await f.request({
        method: "roles-request-session",
        operator: "test-operator",
        input: {
          seat: P(1),
          expectedRevision: 1,
          taskId: T(2),
          provider: "claude",
          title: "Implement the release flag",
          note: "Board asked for this ahead of the cycle",
        },
      });
      padTo(f, AUTOMATION_LIMIT);
      const before = f.sent.length;
      await f.control.roleSessions.notifyPending();
      const r = f.store.db
        .prepare("SELECT state,failure FROM role_session_requests WHERE id=?")
        .get(asked.requestId);
      assert.equal(r.state, "failed");
      assert.match(r.failure, BUDGET);
      return [f, before];
    },
  };
  for (const [kind, run] of Object.entries(cases)) {
    const [f, before] = await run();
    assert.equal(f.sent.length, before, `${kind}: nothing was dispatched at the limit`);
    assert.equal(rows(f), AUTOMATION_LIMIT, `${kind}: no row was written into the manual reserve`);
  }
});
test("R-2: every control.send call site is automated or a named operator route (static)", () => {
  const dir = path.dirname(new URL(import.meta.url).pathname),
    sites = [];
  for (const file of fs
    .readdirSync(dir)
    .filter((n) => n.endsWith(".mjs") && !/\.(test|mutations|integration)\.mjs$/.test(n))) {
    const text = fs.readFileSync(path.join(dir, file), "utf8");
    for (const m of text.matchAll(/control\.send\(/g)) {
      const line = text.slice(0, m.index).split("\n").length,
        call = text
          .slice(m.index, m.index + 700)
          .split("\n")
          .slice(0, 3)
          .join("\n");
      // `source: binding` names a binding declared a few lines above the call; follow it to its kind.
      const declared = /source: binding\b/.test(call)
        ? [
            ...text
              .slice(Math.max(0, m.index - 1500), m.index)
              .matchAll(/const binding = \{ kind: '([a-z-]+)'/g),
          ].at(-1)?.[1]
        : null;
      const kind =
        call.match(/kind: '([a-z-]+)'/)?.[1] ??
        declared ??
        (/automated: '/.test(call) ? "automated" : /source: s\b/.test(call) ? "resumed" : null);
      sites.push({ site: `${file}:${line}`, kind });
    }
  }
  const AUTOMATED = new Set([
    "role-brief",
    "role-followup",
    "role-channel",
    "manager",
    "event",
    "leadership",
    "automated",
    "resumed",
  ]);
  // Operator-issued or operator-owned routes that keep the full capacity (RECHECK-H5 R-4). Adding a site here is a
  // decision someone has to make on purpose; a model-driven site that forgets its kind fails below.
  const OPERATOR = new Set(["notification", "ingress", "direct"]);
  const OPERATOR_SITES = new Set([
    "rpc.mjs",
    "recovery.mjs",
    "native-release-hooks.integration.mjs",
  ]);
  const unclassified = sites.filter(
    (s) =>
      !AUTOMATED.has(s.kind) && !OPERATOR.has(s.kind) && !OPERATOR_SITES.has(s.site.split(":")[0]),
  );
  assert.deepEqual(
    unclassified,
    [],
    "every control.send call site carries an automated kind or is a named operator route",
  );
  // The set itself: every automated kind a call site uses is in AUTOMATED_SOURCES.
  for (const s of sites.filter(
    (s) => AUTOMATED.has(s.kind) && !["automated", "resumed"].includes(s.kind),
  ))
    assert.ok(
      AUTOMATED_SOURCES.has(s.kind),
      `${s.site} uses ${s.kind}, which AUTOMATED_SOURCES does not stop`,
    );
  assert.ok(sites.length >= 10, `found ${sites.length} call sites`);
});

// ---------------------------------------------------------------- H6 item 2: a reaffirmation carries the seat's grants forward
const reaffirm = (f, role, seat, session, revision, extra = {}) =>
  f.control.bindings.assign({
    role,
    seat,
    sessionId: session,
    expectedSessionGeneration: f.store.get(session).generation,
    expectedRevision: revision,
    note: "Reaffirming the same holder",
    ...extra,
  });
test("H6-2: a reaffirmation carries the session allowance to the new revision, spending and conferring nothing", async (t) => {
  const f = await project(t);
  await start(f);
  const again = await reaffirm(f, "project-orchestrator", P(1), f.lead, 1);
  assert.equal(again.action, "reaffirm");
  assert.equal(again.revision, 2);
  assert.deepEqual(
    {
      from: again.carried.from,
      to: again.carried.to,
      sessionAllowance: again.carried.sessionAllowance,
    },
    { from: 1, to: 2, sessionAllowance: 1 },
  );
  const [a] = (await f.request({ method: "roles-allowances", operator: "test-operator" }))
    .allowances;
  assert.deepEqual(
    [a.seatRevision, a.current, a.used, a.remaining, a.conferredBy, a.defaultConferrals, a.blocked],
    [2, true, 1, DEFAULT_SEAT_SESSIONS - 1, "seating", 1, null],
  );
  assert.equal(
    (await start(f)).state,
    "delivered",
    'the live gap: before H6 this read "This seat has no current session allowance"',
  );
});
test("H6-2: a reaffirmation of either seat keeps an open channel usable; a closed one stays closed", async (t) => {
  const f = fixture(t),
    prime = f.enrol(PROGRAMME),
    lead = f.enrol(T(1));
  await f.assign("prime", "delivery", prime, 0);
  await f.delegate(prime);
  const seated = await f.assign("project-orchestrator", P(1), lead, 0);
  await f.delegate(lead);
  const channelId = seated.defaults.channel.channelId,
    send = async (capability = f.capabilityFor(lead)) =>
      f.request({
        method: "channels-send",
        capability,
        input: {
          sessionId: lead,
          channelId,
          messageId: randomUUID(),
          text: "Status after a reaffirmation",
        },
      });
  const r1 = await reaffirm(f, "project-orchestrator", P(1), lead, 1);
  assert.equal(r1.carried.channels, 1);
  assert.equal(
    (await send()).state,
    "delivered",
    'the live gap: before H6 this read "The project seat changed since this channel was approved"',
  );
  const r2 = await reaffirm(f, "prime", "delivery", prime, 1);
  assert.equal(r2.carried.channels, 1);
  assert.equal((await send()).state, "delivered");
  const c = f.control.channels.publish(f.control.channels.row(channelId));
  assert.equal(c.blocked, null);
  assert.equal(c.conferredBy, "seating");
  assert.equal(c.projectRevision, 2);
  assert.equal(c.primeRevision, 2);
  await f.request({
    method: "channels-close",
    operator: "test-operator",
    input: { channelId, note: "Closed before the next reaffirmation" },
  });
  assert.equal(
    (await reaffirm(f, "project-orchestrator", P(1), lead, 2)).carried.channels,
    0,
    "a closed channel is history, not carried",
  );
});
test("H6-2: a replacement is unchanged -- the new holder gets fresh defaults and nothing of the old holder’s", async (t) => {
  const f = fixture(t),
    prime = f.enrol(PROGRAMME),
    lead = f.enrol(T(1));
  await f.assign("prime", "delivery", prime, 0);
  await f.delegate(prime);
  const seated = await f.assign("project-orchestrator", P(1), lead, 0);
  await f.delegate(lead);
  const next = f.enrol(T(1));
  await f.delegate(next);
  const replaced = await f.assign(
    "project-orchestrator",
    P(1),
    next,
    1,
    "A new holder replaces the lead",
  );
  assert.equal(replaced.action, "replace");
  assert.equal(replaced.carried, undefined);
  assert.equal(
    replaced.defaults.sessionAllowance.conferral,
    2,
    "a fresh default, counted as a new conferral",
  );
  assert.equal(replaced.defaults.sessionAllowance.used, 0);
  const old = f.store.db
    .prepare("SELECT projectRevision,projectSession FROM role_channels WHERE id=?")
    .get(seated.defaults.channel.channelId);
  assert.deepEqual(
    [old.projectRevision, old.projectSession],
    [1, lead],
    "the old holder’s channel stays pinned to it",
  );
});
test("H6-2: a reaffirmation with manager issues the manager grant and its inbox; vacating the seat then revokes it", async (t) => {
  const f = fixture(t);
  f.control.manager = new Manager(f.control, path.join(f.dir, "grants", "manager"));
  f.control.events = new Events(f.control, path.join(f.dir, "grants", "inbox"));
  const lead = f.enrol(T(1));
  await f.delegate(lead);
  await f.control.bindings.assign({
    role: "project-orchestrator",
    seat: P(1),
    sessionId: lead,
    expectedSessionGeneration: f.store.get(lead).generation,
    expectedRevision: 0,
    note: "Seated without manager authority",
  });
  const again = await reaffirm(f, "project-orchestrator", P(1), lead, 1, {
    manager: { maxWorkers: 2, reason: "The operator asks for manager authority now" },
  });
  assert.equal(again.action, "reaffirm");
  assert.equal(again.defaults.managerGrant.issued, true, "issued, not refused");
  assert.ok(fs.existsSync(again.defaults.managerGrant.inboxFile), "with its inbox");
  const capability = JSON.parse(
    fs.readFileSync(again.defaults.managerGrant.grantFile, "utf8"),
  ).capability;
  assert.deepEqual(
    await f.request({ method: "manager-workers", capability, input: { sessionId: lead } }),
    [],
  );
  assert.equal(
    f.store.db.prepare("SELECT revision FROM seat_manager_grants WHERE session=?").get(lead)
      .revision,
    2,
  );
  f.control.bindings.unassign({
    role: "project-orchestrator",
    seat: P(1),
    expectedRevision: 2,
    note: "The operator vacates the seat",
  });
  await assert.rejects(
    f.request({ method: "manager-workers", capability, input: { sessionId: lead } }),
    /Manager authority revoked or invalid/,
  );
});
test("H6-2: pending work survives a reaffirmation -- a pending role credential, a deferred brief, an open request", async (t) => {
  // A pending role credential (seated under human control), carried: the first delegation after the reaffirm issues it.
  const g = fixture(t),
    human = g.enrol(T(1));
  await g.control.bindings.assign({
    role: "project-orchestrator",
    seat: P(1),
    sessionId: human,
    expectedSessionGeneration: 1,
    expectedRevision: 0,
    note: "Seated before delegation",
  });
  assert.equal(
    (await reaffirm(g, "project-orchestrator", P(1), human, 1)).carried.pendingRoleGrant,
    1,
  );
  await g.delegate(human);
  assert.ok(
    fs.existsSync(
      path.join(g.dir, "grants", "role", path.basename(g.store.get(human).cwd) + ".json"),
    ),
    "issued at the first delegation after the reaffirmation",
  );
  // A deferred brief, carried: delivered once the session goes idle.
  const f = await project(t),
    busied = busySession(f);
  const out = await start(f, { brief: "Implement the release flag and report what you verified." });
  await f.control.roleSessions.pump();
  assert.equal(f.control.roleSessions.briefState(out.requestId).state, "pending");
  const again = await reaffirm(f, "project-orchestrator", P(1), f.lead, 1);
  assert.equal(again.carried.briefs, 1);
  busied.idle();
  await f.control.roleSessions.deliverPendingBriefs();
  assert.equal(f.control.roleSessions.briefState(out.requestId).state, "delivered");
  // An open operator request, carried: the seat can still accept it.
  const asked = await f.request({
    method: "roles-request-session",
    operator: "test-operator",
    input: {
      seat: P(1),
      expectedRevision: 2,
      taskId: T(2),
      provider: "claude",
      title: "Implement the release flag",
      note: "Board asked for this ahead of the cycle",
    },
  });
  await f.control.roleSessions.pump();
  assert.equal(
    (await reaffirm(f, "project-orchestrator", P(1), f.lead, 2)).carried.sessionRequests,
    1,
  );
  const accepted = await f.request({
    method: "roles-accept-session",
    capability: f.capabilityFor(f.lead),
    input: { sessionId: f.lead, requestId: asked.requestId, messageId: randomUUID() },
  });
  assert.equal(accepted.state, "delivered");
});

// ---------------------------------------------------------------- REVIEW-H6 F1: the limit holds under concurrency
// Barrier-controlled: every request is held at its asynchronous boundary until all of them have passed the early
// checks, so they reach the journal insertion together -- the race the reviewer demonstrated (AT1, AT5).
// Bounded: the gate also opens after 3 s, so a change that stops a request short of the barrier (a mutation, a new
// refusal) fails an assertion quickly instead of hanging the suite.
const barrier = (n, ms = 3000) => {
  let arrived = 0,
    open;
  const gate = new Promise((r) => {
    open = r;
    setTimeout(r, ms).unref();
  });
  return async () => {
    if (++arrived === n) open();
    await gate;
  };
};
test("REVIEW-H6 F1 (AT1): concurrent seat creates at 8,999 rows -- one lands, the rest are refused at insertion and release their reservation", async (t) => {
  const f = await project(t);
  padTo(f, AUTOMATION_LIMIT - 1);
  const authority = f.control.authority.bind(f.control),
    wait = barrier(3);
  f.control.authority = async (id) => {
    await wait();
    return authority(id);
  };
  const results = await Promise.allSettled([start(f), start(f), start(f)]);
  assert.equal(
    results.filter((r) => r.status === "fulfilled" && r.value.state === "delivered").length,
    1,
    "exactly one create lands",
  );
  assert.equal(
    results.filter((r) => r.status === "rejected" && BUDGET.test(r.reason.message)).length,
    2,
  );
  assert.equal(rows(f), AUTOMATION_LIMIT, "no row was written into the reserve");
  assert.equal(f.created.length, 1);
  assert.equal(
    f.store.db.prepare("SELECT used FROM role_session_allowances WHERE seat=?").get(P(1)).used,
    1,
    "the refused creates spent nothing",
  );
  assert.equal(
    f.store.db.prepare("SELECT count(*) n FROM session_ownership").get().n,
    1,
    "and left no ownership reservation",
  );
});
test("REVIEW-H6 F1 (AT5): concurrent follow-ups to two workers at 8,999 rows -- one lands, the other is refused at insertion", async (t) => {
  const f = await withWorker(t),
    second = await start(f);
  f.states.set(second.sessionId, { timelineCursor: { epoch: "fixture-epoch", seq: 7 } });
  padTo(f, AUTOMATION_LIMIT - 1);
  const inspect = f.control.native.inspect,
    wait = barrier(2),
    targets = new Set([f.out.sessionId, second.sessionId]);
  let armed = true;
  f.control.native.inspect = async (id, ...rest) => {
    const r = await inspect(id, ...rest);
    if (armed && targets.has(id)) await wait();
    return r;
  };
  const before = f.sent.length;
  const results = await Promise.allSettled([
    f.follow("First, past the limit together"),
    f.follow("Second, past the limit together", randomUUID(), second.sessionId),
  ]);
  armed = false;
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    results.filter((r) => r.status === "rejected" && BUDGET.test(r.reason.message)).length,
    1,
  );
  assert.equal(rows(f), AUTOMATION_LIMIT, "no row was written into the reserve");
  assert.equal(f.sent.length, before + 1);
});
test("REVIEW-H6 F1: an operator send still uses the reserve, and a journaled retry of an automated send is never refused", async (t) => {
  const f = await withWorker(t),
    messageId = randomUUID();
  f.states.set(f.out.sessionId, { ...f.states.get(f.out.sessionId), status: "idle" });
  assert.equal((await f.follow("Sent before the limit", messageId)).state, "delivered");
  padTo(f, AUTOMATION_LIMIT);
  f.states.set(f.out.sessionId, { ...f.states.get(f.out.sessionId), status: "idle" });
  assert.equal(
    (await f.follow("Sent before the limit", messageId)).state,
    "delivered",
    "the same identity again is not a new row",
  );
  const op = await f.request({
    method: "operator-send",
    operator: "test-operator",
    input: {
      sessionId: f.out.sessionId,
      messageId: randomUUID(),
      text: "The operator can still act",
      expectedGeneration: f.store.get(f.out.sessionId).generation,
    },
  });
  assert.equal(op.state, "delivered");
  assert.equal(rows(f), AUTOMATION_LIMIT + 1);
});
