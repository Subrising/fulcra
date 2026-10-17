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
  launchEnv,
} from "./accounts.mjs";
import { accountSpend, recordAccountCost, readBilling } from "./account-billing.mjs";
import { createAccountBudgets } from "../../src/control/account-budgets.mjs";
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
test("API costs persist once per producing call and respect the account's start date", async (t) => {
  const root = world(t);
  const personal = await addAccount(root, { provider: "claude", name: "personal-workspace-api" });
  const work = await addAccount(root, { provider: "claude", name: "work-workspace-api" });
  await setAccount(root, personal.id, {
    budget: { limitUsd: 200, startAt: "2026-10-01T00:00:00Z" },
  });
  for (const [id, accountId, costUsd, at] of [
    ["old", personal.id, 99, "2026-09-30T23:59:59Z"],
    ["turn:one", personal.id, 37.2, "2026-10-02T00:00:00Z"],
    ["turn:two", work.id, 5, new Date().toISOString()],
  ])
    await recordAccountCost(root, { id, accountId, costUsd, at });
  assert.equal(
    await recordAccountCost(root, { id: "turn:one", accountId: work.id, costUsd: 100 }),
    false,
  );
  const stored = readAccounts(root);
  assert.equal(accountSpend(root, stored.accounts[0]).usedUsd, 37.2);
  assert.equal(accountSpend(root, stored.accounts[1]).limitUsd, null);
  assert.equal(accountSpend(root, stored.accounts[1]).usedUsd, 5);
});
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
test("95% switches all pooled Claude sessions after busy turns finish and notifies once across restart", async (t) => {
  const root = world(t),
    time = Date.now();
  const a = await addAccount(root, { provider: "claude", name: "personal-workspace-api" }, time);
  const b = await addAccount(root, { provider: "claude", name: "work-workspace-api" }, time);
  await setAccount(root, a.id, { budget: { limitUsd: 200, startAt: a.createdAt } });
  await setAccount(root, b.id, { budget: { limitUsd: 500, startAt: b.createdAt } });
  const ids = [randomUUID(), randomUUID()];
  for (const id of ids) await assign(root, id, "claude", time);
  await update(root, (s) => {
    s.defaults.claude = a.id;
  });
  await recordAccountCost(root, { id: "one", accountId: a.id, costUsd: 189.99 });
  let timeNow = time;
  let busy = true,
    notices = 0;
  const control = {
    store: { get: () => ({ mode: "delegated", generation: 1 }) },
    native: { snapshot: async () => ({ status: "idle" }) },
    wakes: {
      accountBudget: (_key, payload) => {
        if (!payload.scope) notices++;
        return 1;
      },
    },
  };
  const deps = {
    now: () => timeNow,
    switchSession: async (id, account) => {
      if (id === ids[1] && busy) return { ok: false };
      await update(root, (s) => {
        s.assignments[id].accountId = account.id;
      });
      return { ok: true };
    },
  };
  let budgets = createAccountBudgets(control, root, deps);
  await budgets.check();
  assert.equal(notices, 0);
  await recordAccountCost(root, { id: "two", accountId: a.id, costUsd: 0.01 });
  await budgets.check();
  assert.equal(notices, 1);
  assert.equal(readAccounts(root).assignments[ids[0]].accountId, b.id);
  assert.equal(readAccounts(root).assignments[ids[1]].accountId, a.id);
  busy = false;
  budgets = createAccountBudgets(control, root, deps);
  timeNow += 60_001;
  await budgets.check({ id: ids[1], status: "idle" });
  assert.equal(readAccounts(root).assignments[ids[1]].accountId, b.id);
  assert.equal(readAccounts(root).defaults.claude, b.id);
  assert.equal(notices, 1);
  await recordAccountCost(root, { id: "work", accountId: b.id, costUsd: 475 });
  await budgets.check();
  await budgets.check();
  assert.equal(notices, 2);
});
test("credit errors persist secret-free ask.billing_error and cause failover below budget", async (t) => {
  const root = world(t);
  const a = await addAccount(root, { provider: "claude", name: "personal-workspace-api" });
  const b = await addAccount(root, { provider: "claude", name: "work-workspace-api" });
  const token = "sk-ant-api03-NEVER-STORE-THIS",
    at = new Date().toISOString();
  await assert.rejects(
    askOnce({
      root,
      input: { prompt: "private prompt", model: "claude-sonnet-5-5", account: a.id },
      keychain: { get: async () => token },
      now: () => Date.parse(at),
      spawnClaude: async () => ({ is_error: true, result: `credit balance too low ${token}` }),
    }),
    /insufficient credit/,
  );
  assert.deepEqual(readBilling(root).events, [{ type: "ask.billing_error", accountId: a.id, at }]);
  const serialized = fs.readFileSync(path.join(root, "accounts/billing.json"), "utf8");
  assert.equal(serialized.includes(token), false);
  assert.equal(serialized.includes("private prompt"), false);
  await update(root, (s) => {
    s.defaults.claude = a.id;
  });
  await createAccountBudgets({ store: { get: () => null } }, root).check();
  assert.equal(readAccounts(root).defaults.claude, b.id);
  assert.equal(readAccounts(root).accounts[0].limitedUntil, null);
  assert.equal(readAccounts(root).budgetActions[`${a.id}:${a.createdAt}`].cause, "billing-error");
  await setAccount(root, b.id, { enabled: false });
  assert.equal(choose(readAccounts(root), "claude"), null);
  if (["darwin", "win32"].includes(process.platform)) {
    assert.equal(launchEnv("claude", a, { token, root }).ANTHROPIC_API_KEY, "");
    assert.equal(JSON.stringify(launchEnv("claude", a, { token, root })).includes(token), false);
  } else
    assert.throws(
      () => launchEnv("claude", a, { token, root }),
      /require macOS Keychain or Windows DPAPI/,
    );
});

test("a persisted billing update triggers budget failover without a polling monitor", async (t) => {
  const root = world(t);
  const a = await addAccount(root, { provider: "claude", name: "personal-workspace-api" });
  const b = await addAccount(root, { provider: "claude", name: "work-workspace-api" });
  await setAccount(root, a.id, { budget: { limitUsd: 200, startAt: a.createdAt } });
  let notice;
  const notified = new Promise((resolve) => {
    notice = resolve;
  });
  await update(root, (s) => {
    s.defaults.claude = a.id;
  });
  const budgets = createAccountBudgets(
    {
      store: { get: () => ({ mode: "delegated", generation: 1 }) },
      native: { snapshot: async () => ({ status: "idle" }) },
      wakes: {
        accountBudget: () => {
          notice();
          return 1;
        },
      },
    },
    root,
  );
  t.after(() => budgets.close());
  await budgets.start();
  await recordAccountCost(root, { id: "crossing", accountId: a.id, costUsd: 190 });
  const timeout = setTimeout(
    () => notice(new Error("No billing file event within five seconds")),
    5000,
  );
  try {
    assert.equal(await notified, undefined);
  } finally {
    clearTimeout(timeout);
  }
  await budgets.check();
  assert.equal(readAccounts(root).defaults.claude, b.id);
});

test("L3: retention drops costs before the oldest budget start and collapses repeated billing errors", async (t) => {
  const { recordBillingError } = await import("./account-billing.mjs");
  const root = world(t),
    a = await addAccount(root, { provider: "claude", name: "personal-workspace-api" });
  await setAccount(root, a.id, { budget: { limitUsd: 200, startAt: "2026-10-01T00:00:00Z" } });
  await recordAccountCost(root, {
    id: "old",
    accountId: a.id,
    costUsd: 25,
    at: "2026-10-02T00:00:00Z",
  });
  await setAccount(root, a.id, { budget: { limitUsd: 200, startAt: "2026-10-10T00:00:00Z" } });
  await recordAccountCost(root, {
    id: "kept",
    accountId: a.id,
    costUsd: 7,
    at: "2026-10-11T00:00:00Z",
  });
  await recordBillingError(root, a.id, "2026-10-11T00:00:00Z");
  await recordBillingError(root, a.id, "2026-10-12T00:00:00Z");
  const billing = readBilling(root);
  assert.deepEqual(Object.keys(billing.calls), ["kept"]);
  assert.equal(billing.events.length, 1);
  assert.equal(
    accountSpend("/not-read-with-a-snapshot", readAccounts(root).accounts[0], billing).usedUsd,
    7,
  );
});

test("L3/L4: advancing retention preserves the native cursor across account and budget changes", async (t) => {
  const root = world(t),
    a = await addAccount(root, { provider: "claude", name: "personal-workspace-api" });
  await setAccount(root, a.id, { budget: { limitUsd: 200, startAt: "2026-10-01T00:00:00Z" } });
  await recordAccountCost(root, {
    id: "old-native-turn",
    accountId: a.id,
    costUsd: 25,
    cumulativeUsd: 25,
    runtimeSessionId: "retained-native-id",
    at: "2026-10-02T00:00:00Z",
  });
  await setAccount(root, a.id, { budget: { limitUsd: 200, startAt: "2026-10-10T00:00:00Z" } });
  await recordAccountCost(root, {
    id: "resumed-native-turn",
    accountId: a.id,
    costUsd: 32,
    cumulativeUsd: 32,
    runtimeSessionId: "retained-native-id",
    at: "2026-10-11T00:00:00Z",
  });
  assert.equal(accountSpend(root, readAccounts(root).accounts[0]).usedUsd, 7);
  assert.equal(Object.hasOwn(readBilling(root).calls, "old-native-turn"), false);
});

test("daily cap survives restart, resets at UTC midnight, and leaves subscription accounts alone", async (t) => {
  const { dailySpend, assertApiSpendAllowed } = await import("./account-billing.mjs");
  const root = world(t);
  const a = await addAccount(root, { provider: "claude", name: "API" });
  await setAccount(root, a.id, {
    credentialKind: "api-key",
    dailyLimitUsd: 40,
    budget: { limitUsd: 200, startAt: "2026-10-01T00:00:00Z" },
  });
  const at = "2026-10-17T12:00:00.000Z",
    now = Date.parse(at);
  await recordAccountCost(root, { id: "today", accountId: a.id, costUsd: 40, at });
  const account = readAccounts(root).accounts[0];
  assert.equal(dailySpend(root, account, readBilling(root), now).usedUsd, 40);
  const input = { provider: "claude", accountId: a.id };
  assert.throws(() => assertApiSpendAllowed(root, input, now), /daily UTC cost cap reached/);
  assert.doesNotThrow(() => assertApiSpendAllowed(root, input, Date.parse("2026-10-18T00:00:00Z")));
  await setAccount(root, a.id, { credentialKind: "subscription" });
  assert.doesNotThrow(() => assertApiSpendAllowed(root, input, now));
});

test("explicit account caps refuse at the exact boundary", async (t) => {
  const { assertApiSpendAllowed } = await import("./account-billing.mjs");
  const root = world(t);
  const a = await addAccount(root, { provider: "claude", name: "API" });
  await setAccount(root, a.id, {
    credentialKind: "api-key",
    dailyLimitUsd: 100,
    budget: { limitUsd: 20, startAt: "2026-10-01T00:00:00Z" },
  });
  await recordAccountCost(root, { id: "cap", accountId: a.id, costUsd: 20 });
  assert.throws(
    () => assertApiSpendAllowed(root, { provider: "claude", accountId: a.id }),
    /account cost cap reached/,
  );
  assert.doesNotThrow(() => assertApiSpendAllowed(root, { provider: "codex", accountId: a.id }));
});

test("50% and 80% warnings carry affected sessions and remain once after restart", async (t) => {
  const root = world(t);
  const a = await addAccount(root, { provider: "claude", name: "API" });
  await setAccount(root, a.id, { credentialKind: "api-key", dailyLimitUsd: 40 });
  const id = randomUUID();
  await assign(root, id, "claude");
  const notices = [];
  const control = {
    wakes: {
      accountBudget: (key, payload) => {
        notices.push({ key, payload });
        return 2;
      },
    },
  };
  await recordAccountCost(root, { id: "half", accountId: a.id, costUsd: 20 });
  await createAccountBudgets(control, root).check();
  assert.deepEqual(
    notices.map((n) => n.payload.threshold),
    [0.5],
  );
  assert.deepEqual(notices[0].payload.sessions, [id]);
  await recordAccountCost(root, { id: "eighty", accountId: a.id, costUsd: 12 });
  await createAccountBudgets(control, root).check();
  assert.deepEqual(
    notices.map((n) => n.payload.threshold),
    [0.5, 0.8],
  );
  await createAccountBudgets(control, root).check();
  assert.equal(notices.length, 2);
});

test("existing recorded turns restore session totals without another paid turn", async (t) => {
  const { readSessionBilling } = await import("./account-billing.mjs");
  const root = world(t),
    id = randomUUID();
  const a = await addAccount(root, { provider: "claude", name: "API A" });
  const b = await addAccount(root, { provider: "claude", name: "API B" });
  for (const account of [a, b])
    await setAccount(root, account.id, {
      credentialKind: "api-key",
      budget: { limitUsd: 200, startAt: "2026-10-01T00:00:00Z" },
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

test("removed subscription launch accounts stay unaffected; missing API accounts refuse", async (t) => {
  const { assertApiSpendAllowed } = await import("./account-billing.mjs");
  const root = world(t),
    accountId = randomUUID();
  const input = {
    provider: "claude",
    accountId,
  };
  assert.doesNotThrow(() => assertApiSpendAllowed(root, { ...input, accountKind: "subscription" }));
  assert.throws(
    () => assertApiSpendAllowed(root, { ...input, accountKind: "api-key" }),
    /unavailable/,
  );
  const sub = await addAccount(root, { provider: "claude", name: "Fixture subscription" });
  assert.throws(
    () => assertApiSpendAllowed(root, { ...input, accountId: sub.id, accountKind: "api-key" }),
    /launch account changed/,
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

test("retention drops old checkpointed turns but preserves live legacy and current daily spend", async (t) => {
  const { readSessionBilling, dailySpend } = await import("./account-billing.mjs");
  const root = world(t),
    account = await addAccount(root, { provider: "claude", name: "Fixture API" });
  const sessionId = randomUUID(),
    legacy = randomUUID();
  const today = new Date().toISOString().slice(0, 10) + "T00:00:00Z";
  const yesterday = new Date(Date.parse(today) - 86400000).toISOString();
  await setAccount(root, account.id, {
    credentialKind: "api-key",
    budget: { limitUsd: 200, startAt: yesterday },
  });
  await update(root, (s) => {
    for (const id of [sessionId, legacy])
      s.assignments[id] = { accountId: account.id, provider: "claude" };
  });
  await recordAccountCost(root, {
    id: `turn:${sessionId}:old`,
    accountId: account.id,
    sessionId,
    costUsd: 4,
    at: yesterday,
    cursorCheckpoint: { native: 4 },
    costRevision: 1,
  });
  await recordAccountCost(root, {
    id: `turn:${legacy}:old`,
    accountId: account.id,
    costUsd: 3,
    at: yesterday,
  });
  const records = readSessionBilling(root, { provider: "claude", agentId: sessionId }).records;
  await setAccount(root, account.id, { budget: { limitUsd: 200, startAt: today } });
  await recordAccountCost(root, { id: "today", accountId: account.id, costUsd: 2 });
  const billing = readBilling(root);
  assert.equal(billing.calls[`turn:${sessionId}:old`], undefined);
  assert.equal(billing.calls[`turn:${legacy}:old`].costUsd, 3);
  assert.equal(
    dailySpend(root, {
      ...account,
      credentialKind: "api-key",
      budget: { limitUsd: 200, startAt: today },
    }).usedUsd,
    2,
  );
  assert.equal(
    readSessionBilling(root, { provider: "claude", agentId: sessionId, records }).records.turns.old
      .amountUsd,
    4,
  );
});

test("fresh API accounts have no caps or spend warnings, including legacy account names", async (t) => {
  const { dailySpend, assertApiSpendAllowed } = await import("./account-billing.mjs");
  const { publicView } = await import("./accounts.mjs");
  const root = world(t);
  const notices = [];
  for (const name of ["personal-workspace-api", "work-workspace-api", "API"]) {
    const a = await addAccount(root, { provider: "claude", name });
    await setAccount(root, a.id, { credentialKind: "api-key" });
    const account = readAccounts(root).accounts.find((row) => row.id === a.id);
    assert.equal(account.budget, undefined);
    assert.equal(account.dailyLimitUsd, undefined);
    await recordAccountCost(root, { id: name, accountId: a.id, costUsd: 1000 });
    assert.deepEqual(accountSpend(root, account), {
      startAt: a.createdAt,
      limitUsd: null,
      usedUsd: 1000,
    });
    assert.equal(dailySpend(root, account).limitUsd, null);
    assert.doesNotThrow(() => assertApiSpendAllowed(root, { provider: "claude", accountId: a.id }));
  }
  await createAccountBudgets(
    {
      wakes: {
        accountBudget: (...args) => {
          notices.push(args);
          return 1;
        },
      },
    },
    root,
  ).check();
  assert.deepEqual(notices, []);
  for (const account of publicView(readAccounts(root)).accounts) {
    assert.equal(account.dailyLimitUsd, null);
    assert.equal(account.budget.limitUsd, null);
  }
});

test("owner can clear explicit daily and account caps without clearing cost totals", async (t) => {
  const { assertApiSpendAllowed } = await import("./account-billing.mjs");
  const root = world(t);
  const a = await addAccount(root, { provider: "claude", name: "API" });
  await setAccount(root, a.id, {
    credentialKind: "api-key",
    dailyLimitUsd: 40,
    budget: { limitUsd: 20, startAt: a.createdAt },
  });
  await recordAccountCost(root, { id: "large", accountId: a.id, costUsd: 1000 });
  const input = { provider: "claude", accountId: a.id };
  assert.throws(() => assertApiSpendAllowed(root, input), /account cost cap/);
  await setAccount(root, a.id, { budget: { limitUsd: null, startAt: a.createdAt } });
  assert.throws(() => assertApiSpendAllowed(root, input), /daily UTC cost cap/);
  await setAccount(root, a.id, { dailyLimitUsd: null });
  assert.doesNotThrow(() => assertApiSpendAllowed(root, input));
  assert.equal(accountSpend(root, readAccounts(root).accounts[0]).usedUsd, 1000);
});

test("old cap actions cannot hold an uncapped API account or a cleared owner budget", async (t) => {
  const root = world(t);
  const a = await addAccount(root, { provider: "claude", name: "personal-workspace-api" });
  await update(root, (state) => {
    state.budgetActions = {
      [`${a.id}:${a.createdAt}`]: { accountId: a.id, targetId: randomUUID() },
    };
  });
  assert.equal(choose(readAccounts(root), "claude").id, a.id);
  await setAccount(root, a.id, { budget: { limitUsd: 20, startAt: a.createdAt } });
  assert.equal(choose(readAccounts(root), "claude"), null);
  await setAccount(root, a.id, { budget: { limitUsd: null, startAt: a.createdAt } });
  assert.equal(choose(readAccounts(root), "claude").id, a.id);
});
