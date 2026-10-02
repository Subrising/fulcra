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
import { IntercomRates } from "./intercom-rates.mjs";
import { closeSeatingDefaults } from "./role-defaults-fixture.mjs";
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
const NOW = Date.parse("2026-09-19T00:00:00.000Z");
const EXPIRES = new Date(NOW + 86400000).toISOString();

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-channels-"))),
    store = new ControlStore(path.join(dir, "journal.sqlite"));
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const states = new Map();
  let sends = 0,
    now = NOW;
  const native = {
    route: () => undefined,
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
  const source = {
    value: {
      observedAt: "2026-09-19T00:00:00.000Z",
      available: true,
      partial: false,
      projects: [{ id: P(1), name: "Orca", description: null, status: "in_progress" }],
      membership: [{ taskId: T(1), projectId: P(1) }],
      note: "test project source",
    },
  };
  const control = new Controller({
    store,
    native,
    authority: async (id) => issue(id),
    now: () => now,
  });
  control.bindings = new Bindings(
    control,
    async () => source.value,
    path.join(dir, "grants", "role"),
  );
  control.channels = new RoleChannels(control, () => now);
  const enrol = (task) => {
    const id = randomUUID();
    store.created(id, task, path.join(dir, id));
    states.set(id, { lastPromptId: null });
    return id;
  };
  return {
    dir,
    store,
    control,
    states,
    source,
    request: rpc(control, "test-operator"),
    enrol,
    sends: () => sends,
    setNow: (value) => {
      now = value;
    },
    delegate: (id) => control.handback(id, "Delegated for the channel verification"),
  };
}
async function seated(t) {
  const f = fixture(t),
    prime = f.enrol(PROGRAMME),
    project = f.enrol(T(1));
  await f.control.bindings.assign({
    role: "prime",
    seat: "delivery",
    sessionId: prime,
    expectedSessionGeneration: 1,
    expectedRevision: 0,
    note: "Accountable prime seat for delivery",
  });
  await f.control.bindings.assign({
    role: "project-orchestrator",
    seat: P(1),
    sessionId: project,
    expectedSessionGeneration: 1,
    expectedRevision: 0,
    note: "Owns delivery of this project",
  });
  await f.delegate(prime);
  await f.delegate(project);
  // Seating conferred a default channel between these two seats; close it so the operator approvals below
  // are the channel under test. See role-defaults-fixture.mjs.
  closeSeatingDefaults(f.control);
  const role = async (id) =>
    JSON.parse(
      fs.readFileSync(
        (
          await f.control.bindings.grantRole({
            sessionId: id,
            expectedGeneration: f.store.get(id).generation,
          })
        ).grantFile,
        "utf8",
      ),
    ).capability;
  return {
    ...f,
    prime,
    project,
    role,
    primeGrant: { capability: await role(prime) },
    projectGrant: { capability: await role(project) },
  };
}
const opening = (extra = {}) => ({
  primeSeat: "delivery",
  projectSeat: P(1),
  purpose: "Weekly delivery check-in between the board seat and this project",
  maxMessages: 4,
  expiresAt: EXPIRES,
  expectedPrimeRevision: 1,
  expectedProjectRevision: 1,
  ...extra,
});

test("a role binding opens only the bounded seating default; the seat can never approve one itself", async (t) => {
  const f = await seated(t);
  assert.deepEqual(
    (
      await f.request({
        method: "channels-list",
        input: { sessionId: f.project },
        capability: f.projectGrant.capability,
      })
    ).channels,
    [],
  );
  const self = await f.request({
    method: "bindings-self",
    input: { sessionId: f.project },
    capability: f.projectGrant.capability,
  });
  assert.equal(self.send.available, false);
  assert.equal(self.send.method, "channels-list");
  await assert.rejects(
    f.request({ method: "channels-open", input: opening(), capability: f.projectGrant.capability }),
    /Operator authorization/,
  );
  // Seating now confers ONE bounded default channel (PROPOSAL.md §2), which this fixture closed. That is
  // the only row here: nothing the project seat itself did created a channel, and it still cannot open,
  // widen or redirect one. The seat's inability to approve its own channel is what this asserts.
  assert.equal(
    f.store.db.prepare("SELECT count(*) n FROM role_channels WHERE state='open'").get().n,
    0,
  );
  assert.deepEqual(
    f.store.db
      .prepare("SELECT state FROM role_channels")
      .all()
      .map((r) => r.state),
    ["closed"],
  );
  const channel = await f.request({
    method: "channels-open",
    input: opening(),
    operator: "test-operator",
  });
  assert.equal(channel.sendable, true);
  assert.equal(channel.remaining, 4);
  assert.equal(channel.grantsAuthority, false);
  assert.equal(channel.primeSessionId, f.prime);
  assert.equal(channel.projectSessionId, f.project);
  // Approval alone delivers nothing.
  assert.equal(f.sends(), 0);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM deliveries").get().n, 0);
});

test("either seat holder sends through the ordinary send path, and every message is audited", async (t) => {
  const f = await seated(t);
  const channel = await f.request({
    method: "channels-open",
    input: opening(),
    operator: "test-operator",
  });
  const up = randomUUID();
  const sent = await f.request({
    method: "channels-send",
    capability: f.projectGrant.capability,
    input: {
      sessionId: f.project,
      channelId: channel.channelId,
      messageId: up,
      text: "Blocked on the release decision",
    },
  });
  assert.equal(sent.state, "delivered");
  assert.equal(sent.fromSeat, P(1));
  assert.equal(sent.toSeat, "delivery");
  assert.equal(sent.remaining, 3);
  assert.equal(sent.accepted, false);
  // The real delivery journal recorded it against the receiving session, not the sender.
  const delivery = f.store.delivery(up);
  assert.equal(delivery.session, f.prime);
  assert.equal(delivery.state, "delivered");
  assert.equal(JSON.parse(delivery.body).text, "Blocked on the release decision");
  // It went through the ordinary path: the recorded output context is the receiver's own delegation generation.
  assert.equal(delivery.result.outputContext.generation, f.store.get(f.prime).generation);
  const down = randomUUID();
  const back = await f.request({
    method: "channels-send",
    capability: f.primeGrant.capability,
    input: {
      sessionId: f.prime,
      channelId: channel.channelId,
      messageId: down,
      text: "Ship behind the flag; I will take the decision",
    },
  });
  assert.equal(back.state, "delivered");
  assert.equal(back.fromSeat, "delivery");
  assert.equal(back.toSeat, P(1));
  assert.equal(back.remaining, 2);
  assert.equal(f.store.delivery(down).session, f.project);
  assert.equal(f.sends(), 2);
  const status = await f.request({ method: "channels-status", operator: "test-operator" });
  assert.deepEqual(
    status.messages.map((m) => [m.fromSeat, m.toSeat, m.state]),
    [
      ["delivery", P(1), "delivered"],
      [P(1), "delivery", "delivered"],
    ],
  );
  assert.deepEqual(
    status.messages.map((m) => [m.fromSession, m.toSession]),
    [
      [f.prime, f.project],
      [f.project, f.prime],
    ],
  );
  assert.equal(status.channels[0].used, 2);
  const listed = await f.request({
    method: "channels-list",
    input: { sessionId: f.project },
    capability: f.projectGrant.capability,
  });
  assert.deepEqual(
    listed.channels.map((c) => [
      c.holding,
      c.toSeat,
      c.counterpartSessionId,
      c.remaining,
      c.sendable,
    ]),
    [["project-orchestrator", "delivery", f.prime, 2, true]],
  );
});

test("a channel grants no authority over the receiving task and cannot bypass its fences", async (t) => {
  const f = await seated(t);
  const channel = await f.request({
    method: "channels-open",
    input: opening(),
    operator: "test-operator",
  });
  const send = (capability, input) =>
    f.request({
      method: "channels-send",
      capability,
      input: {
        sessionId: f.project,
        channelId: channel.channelId,
        messageId: randomUUID(),
        text: "Status please",
        ...input,
      },
    });
  // The sender's own capability is still required, and a stranger holds no seat on the channel.
  await assert.rejects(send("guess"), /Role capability revoked or invalid/);
  // A delegated session with no seat has no role capability at all, so it never reaches the channel check.
  const stranger = f.enrol(T(1));
  await f.delegate(stranger);
  assert.throws(
    () =>
      f.control.bindings.grantRole({
        sessionId: stranger,
        expectedGeneration: f.store.get(stranger).generation,
      }),
    /holds no current role binding/,
  );
  // Human control of the receiver refuses before anything is spent.
  f.control.takeover(f.prime, "Human takes the prime seat back");
  await assert.rejects(send(f.projectGrant.capability), /under human control/);
  assert.equal(
    f.store.db.prepare("SELECT used FROM role_channels WHERE id=?").get(channel.channelId).used,
    0,
  );
  const regrant = await f.delegate(f.prime);
  await f.role(f.prime);
  // Unattributed native input on the receiver revokes delegation inside the ordinary send path.
  f.states.set(f.prime, { lastPromptId: randomUUID() });
  await assert.rejects(send(f.projectGrant.capability), /Human activity or changed identity/);
  assert.equal(f.store.get(f.prime).mode, "human");
  assert.equal(f.sends(), 0);
  // The refused attempt spent its allowance and stays visible rather than being replayable.
  const spent = f.store.db
    .prepare("SELECT used FROM role_channels WHERE id=?")
    .get(channel.channelId);
  assert.equal(spent.used, 1);
  assert.deepEqual(
    f.store.db
      .prepare("SELECT state FROM role_channel_messages")
      .all()
      .map((m) => m.state),
    ["failed"],
  );
  // The channel conferred no control over the other task: nothing was created, transferred by the sender, or granted.
  assert.equal(
    f.store.db.prepare("SELECT count(*) n FROM deliveries WHERE kind='create'").get().n,
    0,
  );
  assert.equal(
    regrant.generation,
    f.store.db.prepare("SELECT generation FROM sessions WHERE id=?").get(f.prime).generation - 1,
  );
});

test("a channel is pinned to the approved seat revisions and does not follow a role to a new holder", async (t) => {
  const f = await seated(t);
  const channel = await f.request({
    method: "channels-open",
    input: opening(),
    operator: "test-operator",
  });
  const replacement = f.enrol(T(1));
  await f.control.bindings.assign({
    role: "project-orchestrator",
    seat: P(1),
    sessionId: replacement,
    expectedSessionGeneration: 1,
    expectedRevision: 1,
    note: "Replacing the project leader mid-channel",
  });
  // The replaced holder no longer holds any seat, so its capability is gone entirely (review F1).
  await assert.rejects(
    f.request({
      method: "channels-list",
      input: { sessionId: f.project },
      capability: f.projectGrant.capability,
    }),
    /Role capability revoked or invalid/,
  );
  // The counterpart still holds its own seat, and sees exactly why the channel can no longer be used.
  const blocked = await f.request({
    method: "channels-list",
    input: { sessionId: f.prime },
    capability: f.primeGrant.capability,
  });
  assert.deepEqual(
    blocked.channels.map((c) => [c.sendable, c.blocked]),
    [
      [
        false,
        "The project seat changed since this channel was approved; a new operator approval is required",
      ],
    ],
  );
  const stale = f.request({
    method: "channels-send",
    capability: f.primeGrant.capability,
    input: {
      sessionId: f.prime,
      channelId: channel.channelId,
      messageId: randomUUID(),
      text: "Are you still there",
    },
  });
  await assert.rejects(stale, /project seat changed since this channel was approved/);
  // The new holder inherits no channel either; the operator must approve again.
  await f.delegate(replacement);
  const newCapability = await f.role(replacement);
  await assert.rejects(
    f.request({
      method: "channels-send",
      capability: newCapability,
      input: {
        sessionId: replacement,
        channelId: channel.channelId,
        messageId: randomUUID(),
        text: "Taking over the conversation",
      },
    }),
    /project seat changed/,
  );
  assert.equal(f.sends(), 0);
  // Even at the current revisions, the stale channel must be closed before another joins the same seats.
  await assert.rejects(
    f.request({
      method: "channels-open",
      input: opening({ expectedProjectRevision: 2 }),
      operator: "test-operator",
    }),
    /already joins these seats/,
  );
  const closed = await f.request({
    method: "channels-close",
    input: { channelId: channel.channelId, note: "Superseded by the leadership change" },
    operator: "test-operator",
  });
  assert.equal(closed.state, "closed");
  const reopened = await f.request({
    method: "channels-open",
    input: opening({ expectedProjectRevision: 2 }),
    operator: "test-operator",
  });
  assert.equal(reopened.projectSessionId, replacement);
  assert.equal(reopened.sendable, true);
  // History is preserved: the closed channel and its note remain.
  const status = await f.request({ method: "channels-status", operator: "test-operator" });
  // Scoped to operator-approved channels: the seating default is a third, already-closed row here and is
  // not what this test is about.
  assert.deepEqual(
    status.channels
      .filter((c) => c.conferredBy === "operator")
      .map((c) => c.state)
      .sort(),
    ["closed", "open"],
  );
  assert.equal(
    status.channels.find((c) => c.state === "closed").note,
    "Superseded by the leadership change",
  );
});

test("approval bounds are real: allowance, expiry, closure, duplicate identity and a stale revision all refuse", async (t) => {
  const f = await seated(t);
  await assert.rejects(
    f.request({
      method: "channels-open",
      input: opening({ expectedProjectRevision: 2 }),
      operator: "test-operator",
    }),
    /project seat changed/,
  );
  await assert.rejects(
    f.request({
      method: "channels-open",
      input: opening({ maxMessages: 0 }),
      operator: "test-operator",
    }),
    /Invalid channel approval/,
  );
  await assert.rejects(
    f.request({
      method: "channels-open",
      input: opening({ purpose: "short" }),
      operator: "test-operator",
    }),
    /Invalid channel approval/,
  );
  await assert.rejects(
    f.request({
      method: "channels-open",
      input: opening({ expiresAt: new Date(NOW - 1000).toISOString() }),
      operator: "test-operator",
    }),
    /ahead of now and within 30 days/,
  );
  await assert.rejects(
    f.request({
      method: "channels-open",
      input: opening({ expiresAt: new Date(NOW + 31 * 86400000).toISOString() }),
      operator: "test-operator",
    }),
    /within 30 days/,
  );
  const channel = await f.request({
    method: "channels-open",
    input: opening({ maxMessages: 2 }),
    operator: "test-operator",
  });
  const send = (messageId, text = "Status") =>
    f.request({
      method: "channels-send",
      capability: f.projectGrant.capability,
      input: { sessionId: f.project, channelId: channel.channelId, messageId, text },
    });
  const first = randomUUID();
  assert.equal((await send(first)).state, "delivered");
  // A message identity is never reused for DIFFERENT content, even within the same channel. Resending the
  // same identity with the same content is the sender asking what became of it: answered, not refused,
  // and it spends no allowance -- the f.sends() count at the end of this test is what proves that.
  const again = await send(first);
  assert.equal(again.state, "delivered");
  assert.equal(again.resend, true);
  await assert.rejects(
    send(first, "Different text under the same identity"),
    /Message identity already used/,
  );
  assert.equal((await send(randomUUID())).state, "delivered");
  await assert.rejects(send(randomUUID()), /allowance reached/);
  assert.equal(
    (
      await f.request({
        method: "channels-list",
        input: { sessionId: f.project },
        capability: f.projectGrant.capability,
      })
    ).channels[0].blocked,
    "Channel message allowance reached",
  );
  const wider = await f
    .request({
      method: "channels-close",
      input: { channelId: channel.channelId, note: "Allowance exhausted for this cycle" },
      operator: "test-operator",
    })
    .then(() =>
      f.request({
        method: "channels-open",
        input: opening({ maxMessages: 2 }),
        operator: "test-operator",
      }),
    );
  f.setNow(Date.parse(EXPIRES) + 1);
  await assert.rejects(
    f.request({
      method: "channels-send",
      capability: f.projectGrant.capability,
      input: {
        sessionId: f.project,
        channelId: wider.channelId,
        messageId: randomUUID(),
        text: "Late",
      },
    }),
    /approval has expired/,
  );
  f.setNow(NOW);
  await f.request({
    method: "channels-close",
    input: { channelId: wider.channelId, note: "Closing the replacement channel" },
    operator: "test-operator",
  });
  await assert.rejects(
    f.request({
      method: "channels-send",
      capability: f.projectGrant.capability,
      input: {
        sessionId: f.project,
        channelId: wider.channelId,
        messageId: randomUUID(),
        text: "After closing",
      },
    }),
    /Channel is closed/,
  );
  assert.equal(f.sends(), 2);
});

test("intercom rolling channel budget expires history without renewing seat authority", async (t) => {
  const f = await seated(t);
  let clock = NOW;
  f.control.rates = new IntercomRates(f.store, () => clock);
  const channel = await f.request({
    method: "channels-open",
    input: opening({ maxMessages: 1 }),
    operator: "test-operator",
  });
  const send = () =>
    f.request({
      method: "channels-send",
      capability: f.projectGrant.capability,
      input: {
        sessionId: f.project,
        channelId: channel.channelId,
        messageId: randomUUID(),
        text: "Scoped report requiring delegated action authority",
      },
    });
  assert.equal((await send()).state, "delivered");
  await assert.rejects(send(), /reached|rate|budget/);
  clock += 3600001;
  f.setNow(clock);
  assert.equal((await send()).state, "delivered");
  f.control.takeover(f.project, "Owner revokes action authority");
  clock += 3600001;
  f.setNow(clock);
  await assert.rejects(send(), /delegat|current|capability|authority/i);
  assert.equal(f.sends(), 2);
});
