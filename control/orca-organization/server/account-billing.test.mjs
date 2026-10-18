import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  addAccount,
  assign,
  update,
  readAccounts,
  markAccountLimited,
  accountLimit,
  rotate as rotateAccount,
  switchSession,
  setAccount,
  choose,
} from "./accounts.mjs";
import { accountSpend, recordAccountCost, readBilling } from "./account-billing.mjs";
import { createCreditWarnings } from "../../src/control/credit-warnings.mjs";
import { askOnce } from "./ask.mjs";
const rotate = (root, session, provider, options = {}, now) =>
  rotateAccount(
    root,
    session,
    provider,
    {
      ...options,
      confirmLimit: async ({ accountId }) => ({
        accountId,
        resetAt: options.resetAt,
        kind: options.kind ?? "session",
      }),
    },
    now,
  );
function world(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "api-accounts-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
test("local, remote and ask limit records never limit API accounts", async (t) => {
  const root = world(t);
  const a = await addAccount(root, { provider: "claude", name: "API" });
  await setAccount(root, a.id, { credentialKind: "api-key" });
  assert.equal(await markAccountLimited(root, a.id), null);
  assert.equal(
    accountLimit({
      ...a,
      credentialKind: "api-key",
      limitedUntil: "2099-01-01T00:00:00Z",
      remoteLimits: [
        { resetAt: "2099-01-01T00:00:00Z", observedAt: "2026-10-17T00:00:00Z", source: "peer" },
      ],
    }),
    null,
  );
  const id = randomUUID();
  await assign(root, id, "claude");
  assert.equal(await rotate(root, id, "claude", { stopId: randomUUID() }), null);
});

test("a reconnect cannot replay a stop against the session's new account", async (t) => {
  const root = world(t),
    time = Date.now();
  const a = await addAccount(root, { provider: "claude", name: "Subscription" }, time - 1000);
  const b = await addAccount(root, { provider: "claude", name: "work-workspace-api" }, time - 1000);
  const id = randomUUID(),
    stopId = randomUUID();
  await assign(root, id, "claude", time);
  await rotate(root, id, "claude", { stopId, kind: "weekly" }, time + 1);
  await switchSession(root, { sessionId: id, provider: "claude", account: b.id }, {}, time + 2);
  assert.equal(await rotate(root, id, "claude", { stopId, kind: "weekly" }, time + 3), null);
  assert.equal(readAccounts(root).accounts.find((x) => x.id === b.id).limitedUntil, null);
  // A previously unseen historical stop resolves through the switch history as well.
  const old = await rotate(
    root,
    id,
    "claude",
    { stopId: randomUUID(), stoppedAt: new Date(time + 1).toISOString() },
    time + 4,
  );
  assert.equal(old.from, a.id);
  assert.equal(readAccounts(root).assignments[id].accountId, b.id);
});

test("existing recorded turns restore session totals without another paid turn", async (t) => {
  const { readSessionBilling } = await import("./account-billing.mjs");
  const root = world(t),
    id = randomUUID();
  const created = Date.parse("2026-10-17T00:00:00Z");
  const a = await addAccount(root, { provider: "claude", name: "API A" }, created);
  const b = await addAccount(root, { provider: "claude", name: "API B" }, created);
  for (const account of [a, b])
    await setAccount(root, account.id, {
      credentialKind: "api-key",
    });
  for (const [turn, accountId, costUsd, at] of [
    ["one", a.id, 9.65, "2026-10-17T01:00:00Z"],
    ["two", b.id, 7.87, "2026-10-17T02:00:00Z"],
    ["three", b.id, 0, "2026-10-17T03:00:00Z"],
  ])
    await recordAccountCost(root, {
      id: `turn:${id}:${turn}`,
      accountId,
      costUsd,
      at,
      sessionId: id,
    });
  const input = { agentId: id, provider: "claude", runtimeSessionId: "native" };
  const restored = readSessionBilling(root, input);
  assert.deepEqual(
    Object.values(restored.records.turns).map((row) => row.amountUsd),
    [9.65, 7.87, 0],
  );
  assert.deepEqual(readSessionBilling(root, restored), restored);
  assert.equal(
    readSessionBilling(root, { ...input, agentId: randomUUID() }).records.turns.one,
    undefined,
  );
});

test("older billing checkpoints cannot replace newer unpooled session cursors", async (t) => {
  const { readSessionBilling } = await import("./account-billing.mjs");
  const root = world(t),
    account = await addAccount(root, { provider: "claude", name: "Fixture" });
  const sessionId = randomUUID(),
    key = JSON.stringify(["claude", "native"]);
  await recordAccountCost(root, {
    id: `turn:${sessionId}:pooled`,
    accountId: account.id,
    sessionId,
    costUsd: 4,
    cursorCheckpoint: { [key]: 4 },
    costRevision: 1,
  });
  const records = {
    cursors: { [key]: 9 },
    revision: 2,
    turns: {
      pooled: { accountId: account.id, amountUsd: 4, at: new Date().toISOString() },
      unpooled: { accountId: null, amountUsd: 5, at: new Date().toISOString() },
    },
  };
  assert.deepEqual(
    readSessionBilling(root, { provider: "claude", agentId: sessionId, records }).records,
    records,
  );
  await recordAccountCost(root, {
    id: `turn:${sessionId}:newer`,
    accountId: account.id,
    sessionId,
    costUsd: 3,
    cursorCheckpoint: { [key]: 12 },
    costRevision: 3,
  });
  await recordAccountCost(root, {
    id: `turn:${sessionId}:late-recovery`,
    accountId: account.id,
    sessionId,
    costUsd: 1,
    cursorCheckpoint: { [key]: 6 },
    costRevision: 2,
  });
  assert.equal(readBilling(root).checkpoints[sessionId][key], 12);
  assert.equal(readBilling(root).checkpointRevisions[sessionId], 3);
});

test("account spend counts each producing call once and top-up dates only change the report", async (t) => {
  const root = world(t),
    created = Date.parse("2026-10-01T00:00:00Z");
  const a = await addAccount(root, { provider: "claude", name: "personal-workspace-api" }, created);
  for (const [id, costUsd, at] of [
    ["one", 25, "2026-10-02T00:00:00Z"],
    ["two", 7, "2026-10-11T00:00:00Z"],
  ])
    await recordAccountCost(root, { id, accountId: a.id, costUsd, at });
  assert.equal(await recordAccountCost(root, { id: "two", accountId: a.id, costUsd: 100 }), false);
  assert.equal(accountSpend(root, readAccounts(root).accounts[0]).usedUsd, 32);
  await setAccount(root, a.id, { topUpAt: "2026-10-10T00:00:00Z" });
  assert.equal(accountSpend(root, readAccounts(root).accounts[0]).usedUsd, 7);
  assert.equal(Object.keys(readBilling(root).calls).length, 2);
  await setAccount(root, a.id, { topUpAt: null });
  assert.equal(accountSpend(root, readAccounts(root).accounts[0]).usedUsd, 32);
});

test("runtime cumulative cursors survive top-up reporting changes", async (t) => {
  const root = world(t),
    a = await addAccount(
      root,
      { provider: "claude", name: "personal-workspace-api" },
      Date.parse("2026-10-01T00:00:00Z"),
    );
  await recordAccountCost(root, {
    id: "old",
    accountId: a.id,
    costUsd: 25,
    cumulativeUsd: 25,
    runtimeSessionId: "native",
    at: "2026-10-02T00:00:00Z",
  });
  await setAccount(root, a.id, { topUpAt: "2026-10-10T00:00:00Z" });
  await recordAccountCost(root, {
    id: "new",
    accountId: a.id,
    costUsd: 32,
    cumulativeUsd: 32,
    runtimeSessionId: "native",
    at: "2026-10-11T00:00:00Z",
  });
  assert.equal(accountSpend(root, readAccounts(root).accounts[0]).usedUsd, 7);
  assert.equal(readBilling(root).calls.new.costUsd, 7);
});

test("legacy cap fields and holds never prevent API account selection", async (t) => {
  const root = world(t),
    a = await addAccount(root, { provider: "claude", name: "personal-workspace-api" });
  await update(root, (s) => {
    s.accounts[0].budget = { limitUsd: 1, startAt: a.createdAt };
    s.accounts[0].dailyLimitUsd = 1;
    s.budgetActions = {
      [`${a.id}:${a.createdAt}`]: { targetId: randomUUID(), cause: "billing-error" },
    };
  });
  await recordAccountCost(root, { id: "large", accountId: a.id, costUsd: 10000 });
  assert.equal(choose(readAccounts(root), "claude").id, a.id);
  const result = await askOnce({
    root,
    input: { prompt: "fixture", model: "claude-sonnet-5-5", account: a.id },
    keychain: { get: async () => "sk-ant-api03-fixture-only" },
    spawnClaude: async () => ({ result: "OK", total_cost_usd: 2 }),
  });
  assert.equal(result.output, "OK");
});

test("one warning per billing incident survives restart and clears after a later successful turn", async (t) => {
  const { recordBillingError, recordBillingSuccess } = await import("./account-billing.mjs");
  const root = world(t),
    a = await addAccount(root, { provider: "claude", name: "personal-workspace-api" });
  const worker = randomUUID();
  await assign(root, worker, "claude");
  const notices = [],
    control = {
      wakes: {
        apiCreditLow: (key, payload) => {
          notices.push({ key, payload });
          return { main: "main", owner: "lead" };
        },
      },
    };
  const at = Date.parse(a.createdAt) + 100;
  assert.equal(
    await recordBillingError(
      root,
      a.id,
      new Date(at).toISOString(),
      "session.billing_error",
      worker,
    ),
    true,
  );
  assert.equal(await recordBillingError(root, a.id, new Date(at + 1).toISOString()), false);
  await createCreditWarnings(control, root).check();
  await createCreditWarnings(control, root).check();
  assert.equal(notices.length, 1);
  assert.deepEqual(notices[0].payload.sessions, [worker]);
  assert.equal(choose(readAccounts(root), "claude").id, a.id);
  await recordBillingSuccess(root, a.id, new Date(at + 2).toISOString());
  assert.equal(readBilling(root).events[0].clearedAt, new Date(at + 2).toISOString());
  await recordBillingError(root, a.id, new Date(at + 3).toISOString());
  await createCreditWarnings(control, root).check();
  assert.equal(notices.length, 2);
  assert.notEqual(notices[0].key, notices[1].key);
  assert.equal(await recordBillingError(root, a.id, new Date(at + 1).toISOString()), false);
});

test("a successful one-shot call clears the account's billing incident without a balance estimate", async (t) => {
  const { recordBillingError } = await import("./account-billing.mjs");
  const root = world(t),
    a = await addAccount(root, { provider: "claude", name: "personal-workspace-api" });
  await recordBillingError(root, a.id);
  await askOnce({
    root,
    input: { prompt: "fixture", model: "claude-sonnet-5-5", account: a.id },
    keychain: { get: async () => "sk-ant-api03-fixture-only" },
    spawnClaude: async () => ({ result: "OK" }),
  });
  assert.ok(readBilling(root).events[0].clearedAt);
});

test("warnings wait durably for recipients and include the producing closed worker", async (t) => {
  const { recordBillingError } = await import("./account-billing.mjs");
  const root = world(t),
    a = await addAccount(root, { provider: "claude", name: "personal-workspace-api" }),
    worker = randomUUID();
  await recordBillingError(root, a.id, undefined, "session.billing_error", worker);
  const notices = [];
  let routes = 0;
  const control = {
    wakes: {
      apiCreditLow: (key, payload) => {
        notices.push(payload);
        return routes ? { main: "main", owner: "lead" } : {};
      },
    },
  };
  await createCreditWarnings(control, root).check();
  assert.equal(readBilling(root).events[0].notified, undefined);
  routes = 2;
  await createCreditWarnings(control, root).check();
  assert.deepEqual(notices.at(-1).sessions, [worker]);
  assert.equal(readBilling(root).events[0].notified, true);
});

test("billing warnings use a file event, never a spend threshold", async (t) => {
  const { recordBillingError } = await import("./account-billing.mjs");
  const root = world(t),
    a = await addAccount(root, { provider: "claude", name: "personal-workspace-api" });
  let resolveNotice;
  const noticed = new Promise((resolve) => {
    resolveNotice = resolve;
  });
  const monitor = createCreditWarnings(
    {
      wakes: {
        apiCreditLow: () => {
          resolveNotice();
          return { main: "main" };
        },
      },
    },
    root,
  );
  t.after(() => monitor.close());
  await monitor.start();
  await recordAccountCost(root, { id: "large", accountId: a.id, costUsd: 100000 });
  assert.equal(readBilling(root).events.length, 0);
  await recordBillingError(root, a.id);
  const timeout = setTimeout(() => resolveNotice(new Error("No billing file event")), 5000);
  try {
    assert.equal(await noticed, undefined);
  } finally {
    clearTimeout(timeout);
  }
});

test("billing classification never stores provider text and ignores non-billing failures", async (t) => {
  const { isBillingError } = await import("./account-billing.mjs");
  assert.equal(isBillingError("HTTP 400 billing_error"), true);
  assert.equal(isBillingError("HTTP 402 payment required"), true);
  assert.equal(isBillingError("HTTP 400 invalid prompt"), false);
  const root = world(t),
    a = await addAccount(root, { provider: "claude", name: "personal-workspace-api" });
  await assert.rejects(
    askOnce({
      root,
      input: { prompt: "private fixture", model: "claude-sonnet-5-5", account: a.id },
      keychain: { get: async () => "sk-ant-api03-secret-fixture" },
      spawnClaude: async () => ({
        is_error: true,
        result: "credit balance too low sk-ant-api03-secret-fixture",
      }),
    }),
    /billing error/,
  );
  const serialized = JSON.stringify(readBilling(root));
  assert.equal(serialized.includes("secret-fixture"), false);
  assert.equal(serialized.includes("private fixture"), false);
});

test("success watermarks reject delayed errors and distinct equal-time turns start a new incident", async (t) => {
  const { recordBillingError, recordBillingSuccess } = await import("./account-billing.mjs");
  const root = world(t),
    a = await addAccount(root, { provider: "claude", name: "personal-workspace-api" });
  const at = new Date().toISOString(),
    earlier = new Date(Date.parse(at) - 1).toISOString();
  await recordBillingSuccess(root, a.id, at, "success-1");
  assert.equal(await recordBillingError(root, a.id, earlier), false);
  assert.equal(
    await recordBillingError(root, a.id, at, "session.billing_error", null, "error-1"),
    true,
  );
  await recordBillingSuccess(root, a.id, at, "success-2");
  assert.equal(
    await recordBillingError(root, a.id, at, "session.billing_error", null, "error-1"),
    false,
  );
  assert.equal(
    await recordBillingError(root, a.id, at, "session.billing_error", null, "error-2"),
    true,
  );
  assert.equal(readBilling(root).events.length, 2);
});

test("completed asks keep output and retry accounting after corrupt billing storage", async (t) => {
  const { accountsDir } = await import("./accounts.mjs");
  const { recoverAccountObservations } = await import("./account-billing.mjs");
  const root = world(t),
    a = await addAccount(root, { provider: "claude", name: "personal-workspace-api" });
  const file = path.join(accountsDir(root), "billing.json");
  fs.writeFileSync(file, "broken");
  const result = await askOnce({
    root,
    input: { prompt: "fixture", model: "claude-sonnet-5-5", account: a.id },
    keychain: { get: async () => "sk-ant-api03-fixture-only" },
    spawnClaude: async () => ({ result: "OK", total_cost_usd: 7 }),
  });
  assert.equal(result.output, "OK");
  assert.equal(result.costUsd, 7);
  const noCost = await askOnce({
    root,
    input: { prompt: "fixture", model: "claude-sonnet-5-5", account: a.id },
    keychain: { get: async () => "sk-ant-api03-fixture-only" },
    spawnClaude: async () => ({ result: "Still OK" }),
  });
  assert.equal(noCost.output, "Still OK");
  assert.equal(noCost.costUsd, null);
  assert.equal(fs.readdirSync(path.join(accountsDir(root), "pending-observations")).length, 2);
  fs.unlinkSync(file);
  await recoverAccountObservations(root);
  await recoverAccountObservations(root);
  assert.equal(accountSpend(root, a).usedUsd, 7);
  assert.equal(fs.readdirSync(path.join(accountsDir(root), "pending-observations")).length, 0);
});

test("durable events retain routing after account removal and one-shot calls retain their caller", async (t) => {
  const root = world(t),
    a = await addAccount(root, { provider: "claude", name: "personal-workspace-api" }),
    worker = randomUUID();
  await assert.rejects(
    askOnce({
      root,
      sessionId: worker,
      input: { prompt: "fixture", model: "claude-sonnet-5-5", account: a.id },
      keychain: { get: async () => "sk-ant-api03-fixture-only" },
      spawnClaude: async () => ({ is_error: true, result: "HTTP 402 payment required" }),
    }),
  );
  await update(root, (state) => {
    state.accounts = [];
  });
  let payload;
  await createCreditWarnings(
    {
      wakes: {
        apiCreditLow: (_key, value) => {
          payload = value;
          return { main: "main", owner: "lead" };
        },
      },
    },
    root,
  ).check();
  assert.deepEqual(payload.sessions, [worker]);
  assert.equal(payload.account, "API account");
  assert.equal(readBilling(root).events[0].notified, true);
});

test("recipient receipts keep the unresolved lead pending without sending Main twice", async (t) => {
  const { recordBillingError } = await import("./account-billing.mjs");
  const root = world(t),
    a = await addAccount(root, { provider: "claude", name: "personal-workspace-api" }),
    worker = randomUUID();
  const unrelated = randomUUID();
  await assign(root, unrelated, "claude");
  await recordBillingError(root, a.id, undefined, "session.billing_error", worker);
  let calls = 0;
  const control = {
    wakes: {
      apiCreditLow: (_key, payload, saved) => {
        assert.deepEqual(payload.sessions, [worker]);
        calls++;
        return calls === 1 ? { main: "main" } : { ...saved, owner: "lead" };
      },
    },
  };
  await createCreditWarnings(control, root).check();
  assert.equal(readBilling(root).events[0].notified, false);
  await createCreditWarnings(control, root).check();
  await createCreditWarnings(control, root).check();
  assert.equal(calls, 2);
  assert.equal(readBilling(root).events[0].notified, true);
});

test("a delayed success splits repeated failures into the next incident", async (t) => {
  const { recordBillingError, recordBillingSuccess } = await import("./account-billing.mjs");
  const root = world(t),
    a = await addAccount(root, { provider: "claude", name: "personal-workspace-api" });
  const at = Date.now();
  await recordBillingError(root, a.id, new Date(at).toISOString(), undefined, null, "error-1");
  await recordBillingError(root, a.id, new Date(at + 2).toISOString(), undefined, null, "error-3");
  await recordBillingSuccess(root, a.id, new Date(at + 1).toISOString(), "success-2");
  const events = readBilling(root).events;
  assert.equal(events.length, 2);
  assert.ok(events[0].clearedAt);
  assert.equal(events[1].clearedAt, undefined);
  assert.equal(events[1].at, new Date(at + 2).toISOString());
});

test("two delayed successes split closed incidents and retain the active incident", async (t) => {
  const { recordBillingError, recordBillingSuccess } = await import("./account-billing.mjs");
  const root = world(t),
    a = await addAccount(root, { provider: "claude", name: "personal-workspace-api" });
  const start = Date.now(),
    at = (n) => new Date(start + n).toISOString();
  for (const n of [1, 3, 5])
    await recordBillingError(root, a.id, at(n), undefined, null, `error-${n}`);
  await recordBillingSuccess(root, a.id, at(4), "success-4");
  await recordBillingSuccess(root, a.id, at(2), "success-2");
  await recordBillingError(root, a.id, at(6), undefined, null, "error-6");
  const events = readBilling(root).events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  assert.deepEqual(
    events.map((e) => [e.at, e.clearedAt]),
    [
      [at(1), at(2)],
      [at(3), at(4)],
      [at(5), undefined],
    ],
  );
  assert.equal(events[2].failures.length, 2);
});

test("host order separates equal-time incidents even when successes arrive late", async (t) => {
  const { recordBillingError, recordBillingSuccess } = await import("./account-billing.mjs");
  const root = world(t),
    a = await addAccount(root, { provider: "claude", name: "personal-workspace-api" }),
    at = new Date().toISOString();
  for (const order of ["1", "3", "5"])
    await recordBillingError(root, a.id, at, undefined, null, `failure-${order}`, order);
  await recordBillingSuccess(root, a.id, at, "success-4", "4");
  await recordBillingSuccess(root, a.id, at, "success-2", "2");
  const events = readBilling(root).events.sort(
    (a, b) => Number(a.failures[0].order) - Number(b.failures[0].order),
  );
  assert.equal(events.length, 3);
  assert.deepEqual(
    events.map((e) => e.clearedOrder),
    ["2", "4", undefined],
  );
});

test("warning observation storage cannot stop the controller at startup", async (t) => {
  const { accountsDir } = await import("./accounts.mjs");
  const root = world(t);
  fs.mkdirSync(accountsDir(root), { recursive: true });
  fs.writeFileSync(path.join(accountsDir(root), "billing.json"), "broken");
  const control = {},
    monitor = createCreditWarnings(control, root);
  t.after(() => monitor.close());
  await monitor.start();
  assert.equal(typeof control.creditWarningError, "string");
});

test("structured billing status and native error codes create durable incidents", async (t) => {
  const { isBillingError, recordAccountTurnEnd } = await import("./account-billing.mjs");
  assert.equal(isBillingError({ api_error_status: 402, result: "Request failed" }), true);
  assert.equal(isBillingError({ api_error_status: 400, result: "Invalid prompt" }), false);
  const root = world(t),
    a = await addAccount(root, { provider: "claude", name: "personal-workspace-api" });
  const worker = randomUUID();
  await recordAccountTurnEnd(root, {
    agent: { id: worker, provider: "claude", accountId: a.id },
    outcome: { kind: "failed", error: { message: "Request failed", code: "billing_error" } },
  });
  assert.equal(readBilling(root).events.length, 1);
  assert.equal(readBilling(root).events[0].sessionId, worker);
});
