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
  rotate,
  switchSession,
  setAccount,
  launchEnv,
} from "./accounts.mjs";
import { accountSpend, recordAccountCost, readBilling } from "./account-billing.mjs";
import { createAccountBudgets } from "../../src/control/account-budgets.mjs";
import { askOnce } from "./ask.mjs";
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
  assert.equal(accountSpend(root, stored.accounts[1]).limitUsd, 500);
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
  const ids = [randomUUID(), randomUUID()];
  for (const id of ids) await assign(root, id, "claude", time);
  await recordAccountCost(root, { id: "one", accountId: a.id, costUsd: 189.99 });
  let busy = true,
    notices = 0;
  const control = {
    store: { get: () => null },
    wakes: {
      accountBudget: () => {
        notices++;
        return 1;
      },
    },
  };
  const deps = {
    switchSession: async (id, accountId) => {
      if (id === ids[1] && busy) return { ok: false };
      await update(root, (s) => {
        s.assignments[id].accountId = accountId;
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
  await budgets.check();
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
  await createAccountBudgets({ store: { get: () => null } }, root).check();
  assert.equal(readAccounts(root).defaults.claude, b.id);
  assert.equal(readAccounts(root).accounts[0].limitedUntil, null);
  assert.equal(launchEnv("claude", a, { token, root }).ANTHROPIC_API_KEY, token);
});

test("a persisted billing update triggers budget failover without a polling monitor", async (t) => {
  const root = world(t);
  const a = await addAccount(root, { provider: "claude", name: "personal-workspace-api" });
  const b = await addAccount(root, { provider: "claude", name: "work-workspace-api" });
  let notice;
  const notified = new Promise((resolve) => {
    notice = resolve;
  });
  const budgets = createAccountBudgets(
    {
      store: { get: () => null },
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
