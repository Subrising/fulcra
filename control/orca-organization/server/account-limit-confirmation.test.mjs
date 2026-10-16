import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  addAccount,
  setAccount,
  assign,
  rotate,
  readAccounts,
  update,
  switchSession,
  confirmAccountLimit,
  accountStatus,
  markAccountLimited,
} from "./accounts.mjs";
import { askOnce, spawnClaudeOnce } from "./ask.mjs";
const NOW = Date.parse("2026-10-17T00:00:00Z");
const LINE = "You've hit your session limit · resets 11pm (UTC)";
async function world(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "limit-ask-confirm-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const a = await addAccount(root, { provider: "claude", name: "Subscription A" }, NOW - 1000);
  const b = await addAccount(root, { provider: "claude", name: "Subscription B" }, NOW - 1000);
  const session = randomUUID();
  await assign(root, session, "claude", NOW - 500);
  return { root, a, b, session };
}
function realAskProbe(w, result, onSpawn = async () => {}) {
  const bin = path.join(w.root, randomUUID() + ".cjs");
  fs.writeFileSync(
    bin,
    `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(JSON.stringify(result))}));\n`,
    { mode: 0o700 },
  );
  let count = 0;
  return {
    count: () => count,
    confirm: (input) =>
      confirmAccountLimit({
        ...input,
        keychain: {
          get: async (id) => {
            assert.equal(id, w.a.id);
            return "sk-ant-oat01-SYNTHETIC-PROBE-CREDENTIAL";
          },
        },
        spawnClaude: async (options) => {
          count++;
          assert.equal(readAccounts(w.root).accounts[0].limitedUntil, null);
          await onSpawn();
          return spawnClaudeOnce({ ...options, bin });
        },
      }),
  };
}
test("M4: an old stop cannot mark a subscription limited when a fresh pinned ask succeeds", async (t) => {
  const w = await world(t),
    stopId = randomUUID();
  const probe = realAskProbe(w, { is_error: false, result: "OK", total_cost_usd: 0 });
  const options = {
    stopId,
    stoppedAt: new Date(NOW).toISOString(),
    resetAt: "2099-01-01T00:00:00Z",
    confirmLimit: probe.confirm,
  };
  assert.equal(await rotate(w.root, w.session, "claude", options, NOW), null);
  assert.equal(await rotate(w.root, w.session, "claude", options, NOW + 1000), null);
  assert.equal(probe.count(), 1);
  assert.equal(readAccounts(w.root).accounts[0].limitedUntil, null);
  assert.equal(readAccounts(w.root).limitChecks[stopId].outcome, "clear");
});
test("M4: only the fresh ask's account and reset can receive a limit, including a switch during the ask", async (t) => {
  const w = await world(t),
    stopId = randomUUID();
  const probe = realAskProbe(w, { is_error: true, result: LINE, total_cost_usd: 0 }, async () => {
    await switchSession(
      w.root,
      { sessionId: w.session, provider: "claude", account: w.b.id },
      {},
      NOW + 1,
    );
  });
  const result = await rotate(
    w.root,
    w.session,
    "claude",
    {
      stopId,
      stoppedAt: new Date(NOW).toISOString(),
      resetAt: "2099-01-01T00:00:00Z",
      confirmLimit: probe.confirm,
    },
    NOW,
  );
  assert.equal(result.from, w.a.id);
  assert.equal(result.to, null);
  assert.equal(readAccounts(w.root).accounts[0].limitedUntil, "2026-10-17T23:00:00.000Z");
  assert.equal(readAccounts(w.root).accounts[1].limitedUntil, null);
  assert.equal(readAccounts(w.root).assignments[w.session].accountId, w.b.id);
  assert.equal(
    await rotate(w.root, w.session, "claude", { stopId, confirmLimit: probe.confirm }, NOW + 2),
    null,
  );
  assert.equal(probe.count(), 1);
});
test("M4: incomplete switch history and inconclusive asks fail closed, with a probe backoff", async (t) => {
  const w = await world(t);
  let asks = 0;
  const confirmLimit = async () => {
    asks++;
    throw Error("fixture process unavailable");
  };
  const stopId = randomUUID();
  await rotate(w.root, w.session, "claude", { stopId, confirmLimit }, NOW);
  await rotate(w.root, w.session, "claude", { stopId, confirmLimit }, NOW + 1);
  assert.equal(asks, 1);
  assert.equal(readAccounts(w.root).accounts[0].limitedUntil, null);
  await update(w.root, (s) => {
    s.assignments[w.session].at = new Date(NOW + 100).toISOString();
    s.rotations = [];
  });
  await rotate(
    w.root,
    w.session,
    "claude",
    { stopId: randomUUID(), stoppedAt: new Date(NOW).toISOString(), confirmLimit },
    NOW + 200,
  );
  assert.equal(asks, 1);
  assert.equal(readAccounts(w.root).accounts[1].limitedUntil, null);
});
test("L1: a known subscription keeps its limit even when its label resembles an API account", async (t) => {
  const w = await world(t);
  await setAccount(w.root, w.a.id, {
    name: "personal-workspace-api",
    credentialKind: "subscription",
  });
  await markAccountLimited(w.root, w.a.id, { resetAt: new Date(NOW + 60000).toISOString() }, NOW);
  assert.equal(accountStatus(readAccounts(w.root).accounts[0], NOW).state, "limited");
});
test("L2: an ask-only legacy API account is classified before its rate error can create a limit mark", async (t) => {
  const w = await world(t);
  await markAccountLimited(w.root, w.a.id, { resetAt: new Date(NOW + 60000).toISOString() }, NOW);
  await assert.rejects(
    askOnce({
      root: w.root,
      input: { account: w.a.id, model: "claude-haiku-5-5", prompt: "OK" },
      now: () => NOW,
      keychain: { get: async () => "sk-ant-api03-SYNTHETIC-LEGACY-KEY" },
      spawnClaude: async () => ({ is_error: true, result: LINE }),
    }),
    (e) => e.code === "API_RATE_LIMITED",
  );
  const stored = readAccounts(w.root).accounts[0];
  assert.equal(stored.credentialKind, "api-key");
  assert.equal(stored.limitedUntil, null);
});

test("M4: an inconclusive stop stays bound to its original account when retried after a switch", async (t) => {
  const w = await world(t),
    stopId = randomUUID(),
    accounts = [];
  const confirmLimit = async ({ accountId }) => {
    accounts.push(accountId);
    return null;
  };
  await rotate(w.root, w.session, "claude", { stopId, confirmLimit }, NOW);
  await switchSession(
    w.root,
    { sessionId: w.session, provider: "claude", account: w.b.id },
    {},
    NOW + 1,
  );
  await rotate(w.root, w.session, "claude", { stopId, confirmLimit }, NOW + 300_001);
  assert.deepEqual(accounts, [w.a.id, w.a.id]);
  assert.equal(readAccounts(w.root).limitChecks[stopId].accountId, w.a.id);
  assert.equal(readAccounts(w.root).accounts[1].limitedUntil, null);
});
