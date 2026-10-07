// Update-7: a session stopped at a usage limit continues on the next account (account-rotation.mjs, wired into
// usage-limits.mjs for Claude and provider-recovery.mjs for Codex).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { FENCE_PROTOCOL } from "./native-fence.mjs";
import { ControlStore } from "./store.mjs";
import { Controller } from "./controller.mjs";
import { Recovery } from "./recovery.mjs";
import { COMPANY, PROGRAMME } from "./authority.mjs";
import { UsageLimits } from "./usage-limits.mjs";
import { ProviderRecovery } from "./provider-recovery.mjs";
import { codexResetAt } from "./account-rotation.mjs";
import {
  addAccount,
  assign,
  readAccounts,
  accountOf,
  setAccount,
  setRotateOnLimit,
  update,
  publicView,
} from "../../orca-organization/server/accounts.mjs";

const T = (n) => `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;
const issue = (id) => ({
  id,
  companyId: COMPANY,
  parentId: id === PROGRAMME ? null : PROGRAMME,
  assigneeUserId: "local-board",
  assigneeAgentId: null,
  status: "in_progress",
});
const at = (s) => Date.parse(s);
const LINE = "You've hit your session limit · resets 12:50am (Australia/Brisbane)";
const entry = (seq, item) => ({
  seqStart: seq,
  seqEnd: seq,
  turnId: "t",
  timestamp: "2026-09-24T11:47:40.818Z",
  item,
});
const tail = () => ({
  provider: "claude",
  status: "idle",
  updatedAt: "2026-09-24T11:47:41.000Z",
  lastUserMessageAt: "2026-09-24T11:30:00.000Z",
  maxSeq: 7,
  entries: [
    entry(5, { type: "tool_call", name: "Bash" }),
    entry(7, { type: "assistant_message", text: LINE, messageId: "m-limit" }),
  ],
});

function world(t, provider = "claude") {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-rotation-")));
  const store = new ControlStore(path.join(dir, "journal.sqlite"));
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const sent = [],
    tails = new Map(),
    snaps = new Map(),
    recovers = [],
    rotated = [],
    states = new Map();
  const clock = { now: at("2026-09-24T11:48:00Z") };
  const native = {
    route: () => undefined,
    inspect: async (id) => ({
      boot: "boot-1",
      fenceProtocol: FENCE_PROTOCOL,
      saturated: false,
      humanAt: 0,
      status: "idle",
      pending: 0,
      lastPromptId: null,
      timelineCursor: { epoch: "e", seq: 1 },
      ...states.get(id),
    }),
    send: async (id, text, messageId) => {
      sent.push({ id, text, messageId });
      states.set(id, { ...states.get(id), lastPromptId: messageId });
    },
    limitTail: async (id) => tails.get(id) ?? null,
    snapshot: async (id) => ({
      id,
      provider,
      status: "idle",
      lastError: null,
      pendingPermissions: [],
      ...snaps.get(id),
    }),
    completion: async () => ({ ended: false, progress: {} }),
    quota: async () => null,
    recover: async (id) => {
      recovers.push(id);
      snaps.set(id, { status: "idle", lastError: null });
      return { outcome: "refreshed", reason: null };
    },
  };
  const control = new Controller({ store, native, authority: async (id) => issue(id) });
  control.poolRoot = path.join(dir, "home");
  fs.mkdirSync(control.poolRoot);
  control.recovery = new Recovery(control, { now: () => clock.now });
  control.usageLimits = new UsageLimits(control, { now: () => clock.now, random: () => 0 });
  control.providerRecovery = new ProviderRecovery(control, { now: () => clock.now });
  control.wakes = {
    accountRotated: (session, r) => rotated.push({ session, from: r.fromName, to: r.toName }),
  };
  const enrol = async () => {
    const id = randomUUID();
    store.created(id, T(1), path.join(dir, id));
    await control.handback(id, "Delegated for the rotation verification");
    return id;
  };
  return {
    dir,
    store,
    control,
    native,
    sent,
    tails,
    snaps,
    recovers,
    rotated,
    clock,
    enrol,
    root: control.poolRoot,
  };
}

test("Claude: a stop at the limit moves the session to the next account now, relaunches it in place and continues it; new sessions avoid the limited account", async (t) => {
  const w = world(t);
  const a = await addAccount(w.root, { provider: "claude", name: "Work" }, w.clock.now),
    b = await addAccount(w.root, { provider: "claude", name: "Personal" }, w.clock.now + 1);
  await setRotateOnLimit(w.root, true);
  const id = await w.enrol();
  w.tails.set(id, tail());
  assert.equal((await assign(w.root, id, "claude", w.clock.now)).account.id, a.id);
  const stop = await w.control.usageLimits.onAgent({
    id,
    provider: "claude",
    status: "idle",
    updatedAt: "u1",
  });
  assert.equal(stop.state, "waiting");
  assert.match(stop.outcome, /moving to account "Personal"/);
  assert.ok(Date.parse(stop.nextAt) - w.clock.now < 60000, "due in seconds, not at the reset");
  assert.deepEqual(w.rotated, [{ session: id, from: "Work", to: "Personal" }]); // the owner is told
  assert.equal(accountOf(readAccounts(w.root), id).name, "Personal");
  const s = readAccounts(w.root);
  assert.equal(s.accounts.find((x) => x.id === a.id).limitedUntil, "2026-09-24T14:50:00.000Z"); // limited until the line's reset
  w.clock.now += 60000;
  await w.control.usageLimits.tick();
  assert.deepEqual(
    w.recovers,
    [id],
    "relaunched in place once (the new account is taken at launch)",
  );
  assert.equal(w.sent.length, 1);
  assert.match(w.sent[0].text, /moved the session to account "Personal" with its history/);
  const done = w.store.db.prepare("SELECT state FROM usage_limit_stops WHERE session=?").get(id);
  assert.equal(done.state, "resumed");
  assert.equal(readAccounts(w.root).rotations.length, 1);
  assert.equal(readAccounts(w.root).rotations[0].reason, "limit");
  assert.equal((await assign(w.root, randomUUID(), "claude", w.clock.now)).account.id, b.id); // a new session avoids Work
});
test("B4: a human-held session at the limit stays on its account (marked limited), nobody is woken and nothing is relaunched", async (t) => {
  const w = world(t);
  const a = await addAccount(w.root, { provider: "claude", name: "Work" }, w.clock.now);
  await addAccount(w.root, { provider: "claude", name: "Personal" }, w.clock.now + 1);
  const id = randomUUID();
  w.store.created(id, T(1), path.join(w.dir, id));
  w.tails.set(id, tail()); // enrolled, never delegated
  assert.equal((await assign(w.root, id, "claude", w.clock.now)).account.id, a.id);
  await w.control.usageLimits.onAgent({ id, provider: "claude", status: "idle", updatedAt: "u1" });
  assert.deepEqual(w.rotated, []);
  assert.equal(accountOf(readAccounts(w.root), id).name, "Work", "not moved");
  assert.equal(
    readAccounts(w.root).accounts.find((x) => x.id === a.id).limitedUntil,
    "2026-09-24T14:50:00.000Z",
  );
  w.clock.now += 60000;
  await w.control.usageLimits.tick();
  assert.deepEqual(w.recovers, []);
  assert.equal(w.sent.length, 0);
});

test("Claude: no pool -> exactly the previous behaviour (waits for the reset); every account limited -> waits for the reset too", async (t) => {
  const w = world(t);
  const id = await w.enrol();
  w.tails.set(id, tail());
  const stop = await w.control.usageLimits.onAgent({
    id,
    provider: "claude",
    status: "idle",
    updatedAt: "u1",
  });
  assert.ok(Date.parse(stop.nextAt) >= at("2026-09-24T14:50:00Z"));
  assert.equal(w.rotated.length, 0);
  const w2 = world(t);
  const only = await addAccount(w2.root, { provider: "claude", name: "Only" }, w2.clock.now);
  const id2 = await w2.enrol();
  w2.tails.set(id2, tail());
  await assign(w2.root, id2, "claude", w2.clock.now);
  const stop2 = await w2.control.usageLimits.onAgent({
    id: id2,
    provider: "claude",
    status: "idle",
    updatedAt: "u1",
  });
  assert.ok(
    Date.parse(stop2.nextAt) >= at("2026-09-24T14:50:00Z"),
    "nobody to move to: wait for the reset",
  );
  assert.deepEqual(w2.rotated, [{ session: id2, from: "Only", to: null }]);
  assert.equal(readAccounts(w2.root).accounts[0].limitedUntil, "2026-09-24T14:50:00.000Z");
  void only;
});
test("Codex: a usage-limit stop moves to the next account and restarts without waiting for a quota read", async (t) => {
  const w = world(t, "codex");
  const a = await addAccount(w.root, { provider: "codex", name: "A" }, w.clock.now),
    b = await addAccount(w.root, { provider: "codex", name: "B" }, w.clock.now + 1);
  for (const x of [a, b]) await setAccount(w.root, x.id, { auth: "ok" });
  await setRotateOnLimit(w.root, true);
  const id = await w.enrol();
  await assign(w.root, id, "codex", w.clock.now);
  const m = randomUUID();
  await w.control.send(
    { sessionId: id, messageId: m, text: "Build C2 and report." },
    undefined,
    w.store.get(id).generation,
    { automated: "test" },
  );
  w.sent.length = 0;
  const error =
    "You've hit your usage limit. Upgrade to Pro, or try again later. Try again at Sep 25, 2026 3:10 PM.";
  w.snaps.set(id, { provider: "codex", status: "error", lastError: error });
  const row = await w.control.providerRecovery.onAgent({
    id,
    provider: "codex",
    status: "error",
    lastError: error,
  });
  assert.equal(row.kind, "quota");
  assert.match(row.outcome, /moving to account "B"/);
  w.clock.now += 60000;
  await w.control.providerRecovery.tick();
  assert.deepEqual(w.recovers, [id]);
  assert.equal(accountOf(readAccounts(w.root), id).name, "B");
  assert.match(w.sent.at(-1)?.text ?? "", /moved the session to account "B"/);
  assert.equal(
    readAccounts(w.root).accounts.find((x) => x.id === a.id).limitedUntil,
    codexResetAt(error, at("2026-09-24T11:48:00Z")),
  );
});
test("the Codex reset time is read from its message (local time), and only when it is in the future", () => {
  const now = at("2026-09-24T00:00:00Z");
  assert.equal(
    codexResetAt("x. Try again at Sep 25, 2026 3:10 PM.", now),
    new Date("Sep 25 2026 3:10 PM").toISOString(),
  );
  assert.equal(codexResetAt("x. Try again at Sep 1, 2026 3:10 PM.", now), null);
  assert.equal(codexResetAt("no time here", now), null);
});
test("an account-switch receipt is reconciled through the shared seam, never a prompt receipt", async (t) => {
  const w = world(t),
    id = await w.enrol();
  await addAccount(w.root, { provider: "claude", name: "A" });
  const b = await addAccount(w.root, { provider: "claude", name: "B" });
  await assign(w.root, id, "claude");
  const { takeOverSession } = await import("./session-takeover.mjs");
  const recover = w.native.recover;
  w.native.recover = async () => {
    throw Error("lost reply");
  };
  assert.equal(
    (
      await takeOverSession(id, b.id, {
        control: w.control,
        generation: w.store.get(id).generation,
      })
    ).outcome,
    "uncertain",
  );
  const row = w.store.db
    .prepare("SELECT id FROM deliveries WHERE session=? AND kind='account-switch'")
    .get(id);
  assert.throws(
    () => w.control.disposition(row.id, "Do not silently abandon a pinned runtime"),
    /Reconcile this account switch/,
  );
  w.native.recover = recover;
  w.native.receipt = async () => {
    throw Error("Account switches are not prompt deliveries");
  };
  assert.equal((await w.control.recover(row.id)).state, "delivered");
  assert.equal(accountOf(readAccounts(w.root), id).id, b.id);
  assert.equal(readAccounts(w.root).assignments[id].takeover, undefined);
});

// The manual plugin command must reach the same seam without becoming a prompt.
const { managementDispatcher, rpc, RPC_METHODS } = await import("./rpc.mjs");
const { parseControllerCommand, READ_METHODS } = await import("./command-parser.mjs");
const { withManagementInvocation, invokeManagement, ManagementUnavailableError } =
  await import("../../orca-organization/server/management-context.mjs");
const owner = {
  id: "owner",
  authentication: "daemon-password",
  permissions: ["command-centre.manage", "daemon.manage"],
};
async function manualWorld(t) {
  const w = world(t),
    id = await w.enrol();
  await addAccount(w.root, { provider: "claude", name: "A" });
  const b = await addAccount(w.root, { provider: "claude", name: "B" });
  await assign(w.root, id, "claude");
  return {
    ...w,
    id,
    b,
    command: { method: "session-takeover", input: { session: id, accountId: b.id } },
  };
}
for (const principal of [
  owner,
  { ...owner, id: "local-ipc-owner", authentication: "protected-local-ipc" },
])
  test(`${principal.id}: manual switch preserves delegation, input identity and one canonical history entry`, async (t) => {
    const w = await manualWorld(t),
      before = { ...w.store.get(w.id) },
      inputBefore = await w.native.inspect(w.id);
    const result = await withManagementInvocation(
      { management: { invoke: (command) => managementDispatcher(w.control)(command, principal) } },
      false,
      () =>
        invokeManagement(
          w.command.method,
          principal.id === "local-ipc-owner"
            ? { ...w.command.input, reason: "manual" }
            : w.command.input,
        ),
    );
    assert.equal(result.state, "delivered");
    assert.match(result.message, /Continued on account "B"/);
    assert.deepEqual(
      { ...w.store.get(w.id) },
      before,
      "the switch never revokes or reissues delegation",
    );
    assert.deepEqual(
      await w.native.inspect(w.id),
      inputBefore,
      "no human input or prompt identity change",
    );
    assert.equal(w.sent.length, 0);
    assert.deepEqual(w.recovers, [w.id]);
    const entries = w.store.db
      .prepare("SELECT * FROM deliveries WHERE session=? AND kind='account-switch'")
      .all(w.id);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].id, result.switchId);
    const moves = readAccounts(w.root).rotations;
    assert.equal(moves.length, 1);
    assert.equal(moves[0].switchId, result.switchId);
    assert.equal(moves[0].reason, "manual");
    assert.equal(publicView(readAccounts(w.root)).rotations[0].to, "B");
    assert.equal(
      w.store.db.prepare("SELECT sessionId FROM management_calls").get().sessionId,
      w.id,
    );
    assert.equal(JSON.parse(entries[0].body).reason, "manual");
    assert.equal(JSON.parse(entries[0].result).reason, "manual");
  });
test("session-takeover has an exact write contract and rejects read, device and session-capability lanes", async (t) => {
  const w = await manualWorld(t);
  assert.deepEqual(JSON.parse(JSON.stringify(parseControllerCommand(w.command))), w.command);
  assert.ok(RPC_METHODS.has("session-takeover"));
  assert.ok(!READ_METHODS.includes("session-takeover"));
  assert.throws(() =>
    parseControllerCommand({ ...w.command, input: { ...w.command.input, reason: "limit" } }),
  );
  for (const principal of [
    null,
    { ...owner, permissions: ["command-centre.manage"] },
    { ...owner, authentication: "paired-device", deviceId: "fixture-device" },
  ]) {
    await assert.rejects(
      async () => managementDispatcher(w.control)(w.command, principal),
      /principal|device|authoris/i,
    );
  }
  await assert.rejects(
    rpc(w.control, "owner-secret")({ ...w.command, capability: "session-capability" }),
    /operator/i,
  );
  await assert.rejects(
    rpc(w.control, "owner-secret", { allowOperatorWrites: false })({
      ...w.command,
      operator: "owner-secret",
    }),
    /management channel/i,
  );
  let invoked = false;
  await withManagementInvocation(
    {
      management: {
        invoke: () => {
          invoked = true;
        },
      },
    },
    true,
    () => {
      assert.throws(
        () => invokeManagement(w.command.method, w.command.input),
        ManagementUnavailableError,
      );
    },
  );
  assert.equal(invoked, false);
  assert.equal(w.recovers.length, 0);
});
test("manual command refuses a running turn plainly without changing delegation or accounts", async (t) => {
  const w = await manualWorld(t),
    before = { ...w.store.get(w.id) },
    accounts = readAccounts(w.root);
  w.snaps.set(w.id, { status: "running" });
  const result = await managementDispatcher(w.control)(w.command, owner);
  assert.equal(result.state, "refused");
  assert.match(result.message, /turn.*running|finish/i);
  assert.deepEqual({ ...w.store.get(w.id) }, before);
  assert.deepEqual(readAccounts(w.root), accounts);
  assert.equal(w.recovers.length, 0);
});
test("real human input before a switch revokes delegation and refuses reconnect", async (t) => {
  const w = await manualWorld(t);
  const inspect = w.native.inspect;
  w.native.inspect = async (id) => ({ ...(await inspect(id)), humanAt: w.store.get(id).grantedAt });
  const result = await managementDispatcher(w.control)(w.command, owner);
  assert.equal(result.state, "refused");
  assert.match(result.message, /revoked delegation/);
  assert.equal(w.store.get(w.id).mode, "human");
  assert.equal(w.recovers.length, 0);
});
test("limit reconnect records one canonical switch with reason limit", async (t) => {
  const w = await manualWorld(t);
  const { fencedRelaunch } = await import("./account-rotation.mjs");
  assert.equal(
    (await fencedRelaunch(w.control, w.id, w.store.get(w.id).generation, w.b.id)).ok,
    true,
  );
  const entries = w.store.db
    .prepare("SELECT body,result FROM deliveries WHERE session=? AND kind='account-switch'")
    .all(w.id);
  assert.equal(entries.length, 1);
  assert.equal(JSON.parse(entries[0].body).reason, "limit");
  assert.equal(JSON.parse(entries[0].result).reason, "limit");
});

test("limit due refuses when delegation becomes human before entering the exclusive fence", async (t) => {
  const w = await manualWorld(t);
  await setRotateOnLimit(w.root, true);
  w.tails.set(w.id, tail());
  await w.control.usageLimits.onAgent({
    id: w.id,
    provider: "claude",
    status: "idle",
    updatedAt: "race",
  });
  const exclusive = w.control.exclusive.bind(w.control);
  let fenced;
  w.control.exclusive = (id, fn) =>
    exclusive(id, async () => {
      w.control.takeover(id, "Fixture human input before fence");
      fenced = await fn();
      return fenced;
    });
  w.clock.now += 60000;
  await w.control.usageLimits.tick();
  assert.equal(fenced.outcome, "refused");
  assert.equal(w.recovers.length, 0);
  assert.equal(w.sent.length, 0);
  assert.equal(w.store.get(w.id).mode, "human");
});
for (const change of ["provider", "disabled", "expired", "limited"])
  test(`controller revalidates target inside fence after stale plugin check: ${change}`, async (t) => {
    const w = await manualWorld(t),
      exclusive = w.control.exclusive.bind(w.control);
    assert.equal(readAccounts(w.root).accounts.find((a) => a.id === w.b.id).enabled, true);
    w.control.exclusive = (id, fn) =>
      exclusive(id, async () => {
        await update(w.root, (state) => {
          const b = state.accounts.find((a) => a.id === w.b.id);
          if (change === "provider") b.provider = "codex";
          if (change === "disabled") b.enabled = false;
          if (change === "expired") b.auth = "expired";
          if (change === "limited") b.limitedUntil = new Date(Date.now() + 60000).toISOString();
        });
        return fn();
      });
    const result = await managementDispatcher(w.control)(w.command, owner);
    assert.equal(result.state, "refused");
    assert.equal(typeof result.message, "string");
    assert.equal(w.recovers.length, 0);
    assert.equal(readAccounts(w.root).rotations.length, 0);
  });
