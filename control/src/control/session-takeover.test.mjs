import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { takeOverSession } from "./session-takeover.mjs";
import { ControlStore } from "./store.mjs";
import {
  addAccount,
  choose,
  assign,
  update,
  readAccounts,
  setAccount,
  prepareCodexHome,
  sessionOpenHook,
} from "../../orca-organization/server/accounts.mjs";

async function world(t, provider = "claude", { enrolled = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "w2-takeover-"));
  const root = path.join(home, "pool"),
    cwd = path.join(home, "project");
  fs.mkdirSync(cwd);
  const base = path.join(home, ".codex"),
    env = { HOME: home, PATH: "/usr/bin:/bin", CODEX_HOME: base };
  const a = await addAccount(root, { provider, name: "A" }),
    b = await addAccount(root, { provider, name: "B" });
  for (const account of [a, b]) {
    await setAccount(root, account.id, { auth: "ok" });
    if (provider === "codex")
      fs.writeFileSync(
        path.join(prepareCodexHome(root, account.id, base), "auth.json"),
        JSON.stringify({ fixtureAccount: account.id }),
      );
  }
  const id = randomUUID(),
    nativeId = randomUUID(),
    secret = "fixture-" + randomUUID();
  const transcript =
    provider === "claude"
      ? path.join(cwd, `${nativeId}.jsonl`)
      : path.join(base, "sessions", `${nativeId}.jsonl`);
  fs.writeFileSync(transcript, "earlier user question\nearlier assistant answer\n");
  await assign(root, id, provider);
  const store = new ControlStore(path.join(home, "journal.sqlite"));
  if (enrolled) store.created(id, randomUUID(), cwd);
  const stub = path.join(home, "stub-cli.cjs");
  fs.writeFileSync(
    stub,
    `const fs=require('fs'),path=require('path'); const id=process.argv[3];
    if(process.argv[2]!=='--resume')process.exit(2);
    const p=process.env.PROVIDER==='claude'?path.join(process.cwd(),id+'.jsonl'):path.join(process.env.CODEX_HOME,'sessions',id+'.jsonl');
    const history=fs.readFileSync(p,'utf8');
    const account=process.env.PROVIDER==='claude'?process.env.FULCRA_ACCOUNT_ID:JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME,'auth.json'),'utf8')).fixtureAccount;
    process.stdout.write(JSON.stringify({id,history,account,tokenPresent:!!process.env.CLAUDE_CODE_OAUTH_TOKEN,tokenMatchesB:require('crypto').createHash('sha256').update(process.env.CLAUDE_CODE_OAUTH_TOKEN||'').digest('hex')===process.env.EXPECTED_TOKEN_HASH,sqliteBase:process.env.CODEX_SQLITE_HOME,argv:process.argv.slice(2),realTranscript:fs.realpathSync(p)}));`,
  );
  const hook = sessionOpenHook({
    root: () => root,
    env,
    keychain: { get: async (accountId) => (accountId === b.id ? secret : "fixture-account-A") },
  });
  let status = "idle",
    calls = 0,
    launched;
  const control = {
    poolRoot: root,
    store,
    exclusive: async (_, fn) => fn(),
    native: {
      inspect: async () => ({ status, pending: 0 }),
      snapshot: async () => ({ provider, status, pendingPermissions: [], cwd }),
      recover: async () => {
        calls++;
        const launch = await hook({
          request: { provider, agentId: id, cwd, purpose: "interactive", reason: "refresh" },
        });
        launched = JSON.parse(
          execFileSync(process.execPath, [stub, "--resume", nativeId], {
            cwd,
            env: {
              ...env,
              ...launch.env,
              PROVIDER: provider,
              EXPECTED_TOKEN_HASH: createHash("sha256").update(secret).digest("hex"),
            },
            encoding: "utf8",
          }),
        );
        return { outcome: "refreshed" };
      },
    },
  };
  t.after(() => {
    store.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  return {
    root,
    cwd,
    base,
    a,
    b,
    id,
    nativeId,
    secret,
    transcript,
    store,
    control,
    hook,
    provider,
    status: (x) => {
      status = x;
    },
    calls: () => calls,
    launched: () => launched,
  };
}
for (const provider of ["claude", "codex"])
  test(`${provider}: B resumes the same id and complete transcript via a scratch CLI`, async (t) => {
    const w = await world(t, provider);
    const result = await takeOverSession(w.id, w.b.id, { control: w.control });
    assert.equal(result.ok, true);
    assert.equal(w.launched().id, w.nativeId);
    assert.equal(w.launched().account, w.b.id);
    assert.equal(w.launched().history, fs.readFileSync(w.transcript, "utf8"));
    assert.equal(w.launched().realTranscript, fs.realpathSync(w.transcript));
    assert.equal(w.launched().tokenPresent, provider === "claude");
    assert.equal(w.launched().tokenMatchesB, provider === "claude");
    if (provider === "codex") assert.equal(w.launched().sqliteBase, w.base);
    assert.equal(JSON.stringify(w.launched().argv).includes(w.secret), false);
    const history = w.store.db
      .prepare("SELECT result FROM deliveries WHERE session=? AND kind='account-switch'")
      .all(w.id);
    assert.equal(history.length, 1);
    assert.match(JSON.parse(history[0].result).message, /Switched to account "B" at/);
    assert.equal(
      JSON.stringify([result, history, readAccounts(w.root), w.launched()]).includes(w.secret),
      false,
    );
  });
test("running turn refuses plainly and leaves assignment intact", async (t) => {
  const w = await world(t);
  w.status("running");
  const result = await takeOverSession(w.id, w.b.id, { control: w.control });
  assert.equal(result.ok, false);
  assert.match(result.message, /turn.*running|finish/i);
  assert.equal(w.calls(), 0);
  assert.equal(readAccounts(w.root).assignments[w.id].accountId, w.a.id);
});
test("limited target refuses without reconnecting", async (t) => {
  const w = await world(t);
  await update(w.root, (s) => {
    s.accounts.find((a) => a.id === w.b.id).limitedUntil = new Date(
      Date.now() + 60000,
    ).toISOString();
  });
  const result = await takeOverSession(w.id, w.b.id, { control: w.control });
  assert.equal(result.ok, false);
  assert.match(result.message, /limited/i);
  assert.equal(w.calls(), 0);
});
test("host refusal rolls back assignment; raw errors never enter evidence", async (t) => {
  const w = await world(t);
  w.control.native.recover = async () => ({ outcome: "refused", reason: w.secret });
  const result = await takeOverSession(w.id, w.b.id, { control: w.control });
  assert.equal(result.ok, false);
  assert.equal(readAccounts(w.root).assignments[w.id].accountId, w.a.id);
  assert.equal(JSON.stringify(result).includes(w.secret), false);
});
test("lost reconnect reply is uncertain and cannot be replayed as a new switch", async (t) => {
  const w = await world(t);
  w.control.native.recover = async () => {
    throw Error(w.secret);
  };
  const result = await takeOverSession(w.id, w.b.id, { control: w.control });
  assert.equal(result.outcome, "uncertain");
  assert.equal(JSON.stringify(result).includes(w.secret), false);
  assert.equal((await takeOverSession(w.id, w.a.id, { control: w.control })).ok, false);
});
test("pinned takeover never falls back to another account when B loses its credential", async (t) => {
  const w = await world(t);
  await update(w.root, (s) => {
    s.assignments[w.id] = { ...s.assignments[w.id], accountId: w.b.id, takeover: "pending" };
  });
  const hook = sessionOpenHook({ root: () => w.root, keychain: { get: async () => null } });
  await assert.rejects(
    hook({ request: { provider: "claude", agentId: w.id, purpose: "interactive" } }),
    /pooled account launch could not be admitted/i,
  );
  assert.equal(readAccounts(w.root).assignments[w.id].accountId, w.b.id);
});
test("pinned takeover still refuses when every provider account is disabled", async (t) => {
  const w = await world(t);
  await update(w.root, (s) => {
    for (const a of s.accounts) a.enabled = false;
    s.assignments[w.id].takeover = "pending";
  });
  await assert.rejects(
    w.hook({ request: { provider: "claude", agentId: w.id, purpose: "interactive" } }),
    /pooled account launch could not be admitted/i,
  );
});
test("an explicit same-identity reconciliation can resolve a lost reply", async (t) => {
  const w = await world(t),
    recover = w.control.native.recover;
  w.control.native.recover = async () => {
    throw Error("reply lost");
  };
  await takeOverSession(w.id, w.b.id, { control: w.control });
  w.control.native.recover = recover;
  assert.equal(
    (await takeOverSession(w.id, w.b.id, { control: w.control, reconcile: true })).ok,
    true,
  );
  assert.equal((await takeOverSession(w.id, w.a.id, { control: w.control })).ok, true);
});
test("failed reconciliation preparation retains the earlier uncertainty", async (t) => {
  const w = await world(t),
    recover = w.control.native.recover;
  w.control.native.recover = async () => {
    throw Error("lost reply");
  };
  await takeOverSession(w.id, w.b.id, { control: w.control });
  w.control.native.recover = recover;
  let reads = 0;
  const result = await takeOverSession(w.id, w.b.id, {
    control: w.control,
    reconcile: true,
    now: () => {
      if (++reads === 2) throw Error("preparation failed");
      return Date.now();
    },
  });
  assert.equal(result.outcome, "uncertain");
  assert.equal(
    w.store.delivery(readAccounts(w.root).assignments[w.id].takeover).state,
    "uncertain",
  );
  assert.equal(
    (await takeOverSession(w.id, w.b.id, { control: w.control, reconcile: true })).ok,
    true,
  );
});
for (const gap of ["before assignment", "after pin cleanup"])
  test(`reconcile survives interruption ${gap}`, async (t) => {
    const w = await world(t);
    let switchId;
    if (gap === "before assignment") {
      switchId = randomUUID();
      w.store.admit(switchId, w.id, "account-switch", {
        accountId: w.b.id,
        at: new Date().toISOString(),
        generation: 1,
        boot: null,
        humanAt: 0,
      });
    } else {
      const finish = w.store.finish.bind(w.store);
      let failed = false;
      w.store.finish = (id, state, result) => {
        if (state === "delivered" && !failed) {
          failed = true;
          throw Error("completion write failed");
        }
        return finish(id, state, result);
      };
      assert.equal(
        (await takeOverSession(w.id, w.b.id, { control: w.control })).outcome,
        "uncertain",
      );
      switchId = w.store.db
        .prepare("SELECT id FROM deliveries WHERE session=? AND kind='account-switch'")
        .get(w.id).id;
    }
    assert.equal(readAccounts(w.root).assignments[w.id].takeover, undefined);
    assert.equal(
      (await takeOverSession(w.id, w.b.id, { control: w.control, reconcile: true, switchId })).ok,
      true,
    );
    assert.equal(w.store.delivery(switchId).state, "delivered");
    const moves = readAccounts(w.root).rotations;
    assert.equal(moves.length, 1);
    assert.equal(moves[0].switchId, switchId);
    assert.equal(moves[0].from, w.a.id);
    assert.equal(moves[0].to, w.b.id);
    assert.equal(moves[0].reason, "manual");
  });

for (const change of ["provider", "disabled", "expired", "limited"])
  test(`account-store lock revalidates target after session inspection: ${change}`, async (t) => {
    const w = await world(t),
      admit = w.store.admit.bind(w.store);
    w.store.admit = (...args) => {
      const result = admit(...args),
        state = readAccounts(w.root);
      const b = state.accounts.find((a) => a.id === w.b.id);
      if (change === "provider") b.provider = "codex";
      if (change === "disabled") b.enabled = false;
      if (change === "expired") b.auth = "expired";
      if (change === "limited") b.limitedUntil = new Date(Date.now() + 60000).toISOString();
      fs.writeFileSync(path.join(w.root, "accounts", "accounts.json"), JSON.stringify(state));
      return result;
    };
    const result = await takeOverSession(w.id, w.b.id, { control: w.control });
    assert.deepEqual(result, {
      ok: false,
      outcome: "refused",
      message: "The account changed before switching; refresh and try again",
    });
    assert.equal(w.calls(), 0);
    assert.equal(readAccounts(w.root).assignments[w.id].accountId, w.a.id);
    assert.equal(readAccounts(w.root).rotations.length, 0);
  });
test("reconciliation cannot treat a limit intent as a human manual switch", async (t) => {
  const w = await world(t),
    switchId = randomUUID();
  w.store.admit(switchId, w.id, "account-switch", {
    accountId: w.b.id,
    reason: "limit",
    at: new Date().toISOString(),
    generation: 1,
    boot: null,
    humanAt: 0,
  });
  const result = await takeOverSession(w.id, w.b.id, {
    control: w.control,
    reconcile: true,
    switchId,
  });
  assert.equal(result.outcome, "refused");
  assert.equal(w.calls(), 0);
});

// FIX-8 B-1: the owner's OWN chat -- an ordinary app chat the controller never enrolled -- switches accounts too. It has no
// delegation to fence; the switch keeps every other guard (idle, target account, the durable intent, rollback).
for (const provider of ["claude", "codex"])
  test(`${provider}: an owner's ordinary (unenrolled) chat continues on B with its transcript`, async (t) => {
    const w = await world(t, provider, { enrolled: false });
    assert.equal(w.store.get(w.id), null);
    const result = await takeOverSession(w.id, w.b.id, { control: w.control });
    assert.equal(result.ok, true, result.message);
    assert.equal(w.launched().id, w.nativeId);
    assert.equal(w.launched().account, w.b.id);
    assert.equal(w.launched().history, fs.readFileSync(w.transcript, "utf8"));
    assert.equal(readAccounts(w.root).assignments[w.id].accountId, w.b.id);
    const rows = w.store.db
      .prepare(
        "SELECT body FROM deliveries WHERE session=? AND kind='account-switch' AND state='delivered'",
      )
      .all(w.id);
    assert.equal(rows.length, 1);
    assert.equal(JSON.parse(rows[0].body).generation, null);
    assert.equal(readAccounts(w.root).rotations.filter((r) => r.reason === "manual").length, 1);
    assert.equal(w.store.get(w.id), null, "the switch does not enrol the chat in the controller");
  });
test("an unenrolled chat: automatic (limit) rotation still needs delegation; a running turn is refused", async (t) => {
  const w = await world(t, "claude", { enrolled: false });
  assert.match(
    (await takeOverSession(w.id, w.b.id, { control: w.control, reason: "limit" })).message,
    /requires delegation/,
  );
  w.status("running");
  assert.match(
    (await takeOverSession(w.id, w.b.id, { control: w.control })).message,
    /turn is running/,
  );
  assert.equal(w.calls(), 0);
  assert.equal(readAccounts(w.root).assignments[w.id].accountId, w.a.id);
});
test("an unenrolled chat whose host reconnect refuses: the switch rolls back and says so", async (t) => {
  const w = await world(t, "claude", { enrolled: false });
  w.control.native.recover = async () => ({ outcome: "refused", reason: "prepare_failed" });
  const r = await takeOverSession(w.id, w.b.id, { control: w.control });
  assert.equal(r.ok, false);
  assert.equal(readAccounts(w.root).assignments[w.id].accountId, w.a.id);
});

test("a dormant session switches quietly with its native id, history and control intact", async (t) => {
  const w = await world(t);
  w.status("closed");
  const before = w.store.get(w.id);
  const result = await takeOverSession(w.id, w.b.id, { control: w.control });
  assert.equal(result.ok, true);
  assert.equal(w.launched().id, w.nativeId);
  assert.equal(w.launched().history, fs.readFileSync(w.transcript, "utf8"));
  assert.deepEqual(w.store.get(w.id), before);
});

// PR #55 repair: exercise budget automation through the real takeover gate and journal.
import { createAccountBudgets, BUDGET_RETRY_MS, MAX_BUDGET_REFUSALS } from "./account-budgets.mjs";
import { recordAccountCost } from "../../orca-organization/server/account-billing.mjs";
async function budgetWorld(t) {
  const w = await world(t);
  await setAccount(w.root, w.a.id, { name: "personal-workspace-api", credentialKind: "api-key" });
  await setAccount(w.root, w.b.id, { name: "work-workspace-api", credentialKind: "api-key" });
  w.control.promptIdentityChanged = () => false;
  const notices = [];
  w.control.wakes = {
    accountBudget: (key, value) => {
      notices.push({ key, ...value });
      return 1;
    },
  };
  await recordAccountCost(w.root, { id: "budget-trigger", accountId: w.a.id, costUsd: 190 });
  return { ...w, notices };
}
for (const enrolled of [true, false])
  test(`M1: budget takeover refuses ${enrolled ? "human-mode" : "owner's unregistered"} chats`, async (t) => {
    const w = await world(t, "claude", { enrolled });
    const result = await takeOverSession(
      w.id,
      { id: w.b.id, fromAccountId: w.a.id },
      {
        control: w.control,
        reason: "budget",
      },
    );
    assert.equal(result.ok, false);
    assert.match(result.message, /requires delegation/);
    assert.equal(w.calls(), 0);
    assert.equal(readAccounts(w.root).assignments[w.id].accountId, w.a.id);
    assert.equal(w.store.db.prepare("SELECT count(*) n FROM deliveries").get().n, 0);
  });
test("M1: the budget notice counts human and unregistered chats without moving them", async (t) => {
  const w = await budgetWorld(t),
    own = randomUUID();
  await update(w.root, (s) => {
    s.assignments[own] = { ...s.assignments[w.id] };
  });
  const budgets = createAccountBudgets(w.control, w.root);
  await budgets.check();
  await budgets.check();
  assert.equal(w.calls(), 0);
  assert.equal(w.notices.length, 1);
  assert.equal(w.notices[0].held, 2);
  assert.equal(readAccounts(w.root).assignments[own].accountId, w.a.id);
});
test("M2: the real budget takeover moves only active delegated sessions on the source API account", async (t) => {
  const w = await budgetWorld(t);
  w.store.transfer(w.id, "delegated", "Fixture delegation for budget test");
  const subscription = await addAccount(w.root, { provider: "claude", name: "Subscription" });
  const subSession = randomUUID(),
    endedSession = randomUUID();
  await update(w.root, (s) => {
    s.assignments[subSession] = { accountId: subscription.id, provider: "claude", ended: false };
    s.assignments[endedSession] = { accountId: w.a.id, provider: "claude", ended: true };
    s.defaults.claude = subscription.id;
    s.budgetActions = {
      [`${w.a.id}:${s.accounts[0].createdAt}`]: {
        accountId: w.a.id,
        targetId: w.b.id,
        pending: [w.id, subSession, endedSession],
        notified: false,
      },
    };
  });
  await createAccountBudgets(w.control, w.root).check();
  const state = readAccounts(w.root);
  assert.equal(w.calls(), 1);
  assert.equal(state.assignments[w.id].accountId, w.b.id);
  assert.equal(state.assignments[subSession].accountId, subscription.id);
  assert.equal(state.assignments[endedSession].accountId, w.a.id);
  assert.equal(state.defaults.claude, subscription.id);
  assert.equal(choose(state, "claude").id, subscription.id);
  assert.equal(
    w.store.db.prepare("SELECT count(*) n FROM deliveries WHERE kind='account-switch'").get().n,
    1,
  );
  assert.equal(state.rotations.at(-1).reason, "budget");
});
test("M3: real refused reconnect and rollback writes cannot feed a watch loop; retries have backoff and a fixed end", async (t) => {
  const w = await budgetWorld(t);
  w.store.transfer(w.id, "delegated", "Fixture delegation for refused budget switch");
  let attempts = 0,
    time = Date.now();
  w.control.native.recover = async () => {
    attempts++;
    return { outcome: "refused", reason: "not_resident" };
  };
  let budgets = createAccountBudgets(w.control, w.root, { now: () => time });
  t.after(() => budgets.close());
  await budgets.start();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(attempts, 1);
  budgets.close();
  budgets = createAccountBudgets(w.control, w.root, { now: () => time });
  await budgets.start();
  assert.equal(attempts, 1, "restart does not replay the persisted refusal");
  const file = path.join(w.root, "accounts/accounts.json");
  const before = fs.statSync(file).mtimeMs;
  await update(w.root, () => {});
  assert.equal(fs.statSync(file).mtimeMs, before, "no-op rollback/update does not write");
  await budgets.check({ id: w.id, status: "idle" });
  assert.equal(attempts, 1);
  time += BUDGET_RETRY_MS + 1;
  await budgets.check({ id: randomUUID(), status: "idle" });
  assert.equal(attempts, 1);
  for (let n = 1; n < MAX_BUDGET_REFUSALS; n++) {
    await budgets.check({ id: w.id, status: "idle" });
    time += BUDGET_RETRY_MS + 1;
  }
  await budgets.check({ id: w.id, status: "idle" });
  assert.equal(attempts, MAX_BUDGET_REFUSALS);
  const action = Object.values(readAccounts(w.root).budgetActions)[0];
  assert.deepEqual(action.pending, []);
  assert.equal(action.refusals[w.id].attempts, MAX_BUDGET_REFUSALS);
  assert.equal(action.skipped[w.id], "refused");
  assert.equal(readAccounts(w.root).assignments[w.id].accountId, w.a.id);
  assert.equal(
    w.store.db.prepare("SELECT count(*) n FROM deliveries WHERE kind='account-switch'").get().n,
    MAX_BUDGET_REFUSALS,
  );
  assert.equal(w.notices.at(-1).failed, 1);
});
test("L5: unavailable and remote pending sessions leave the queue with a notice", async (t) => {
  const w = await budgetWorld(t),
    remote = randomUUID();
  w.store.transfer(w.id, "delegated", "Fixture delegation for unavailable session");
  w.store.created(remote, randomUUID(), w.cwd);
  w.store.transfer(remote, "delegated", "Fixture delegation for remote session");
  await update(w.root, (s) => {
    s.assignments[remote] = { ...s.assignments[w.id] };
  });
  w.control.native.route = (id) => (id === remote ? "other-host" : null);
  w.control.native.snapshot = async () => {
    throw Error("Session not found");
  };
  await createAccountBudgets(w.control, w.root).check();
  const action = Object.values(readAccounts(w.root).budgetActions)[0];
  assert.deepEqual(action.pending, []);
  assert.equal(w.calls(), 0);
  assert.equal(action.skipped[w.id], "session-unavailable");
  assert.equal(action.skipped[remote], "remote-host");
  assert.equal(w.notices[0].failed, 2);
});

test("M1: a handback during budget inspection keeps the account and emits one held-session notice", async (t) => {
  const w = await budgetWorld(t);
  w.store.transfer(w.id, "delegated", "Fixture delegation before handback race");
  w.control.native.inspect = async () => {
    w.store.transfer(w.id, "human", "Fixture owner handback during budget inspection");
    return { pending: 0, status: "idle" };
  };
  const budgets = createAccountBudgets(w.control, w.root);
  await budgets.check();
  await budgets.check();
  assert.equal(readAccounts(w.root).assignments[w.id].accountId, w.a.id);
  assert.equal(w.calls(), 0);
  assert.equal(w.notices.length, 1);
  assert.equal(w.notices[0].held, 1);
});

test("phone switch keeps busy, limit, history and ownership guards", async (t) => {
  const w = await world(t, "claude", { enrolled: false });
  w.status("running");
  assert.equal(
    (await takeOverSession(w.id, w.b.id, { control: w.control, requireUnowned: true })).ok,
    false,
  );
  w.status("idle");
  await setAccount(w.root, w.b.id, { enabled: false });
  assert.equal(
    (await takeOverSession(w.id, w.b.id, { control: w.control, requireUnowned: true })).ok,
    false,
  );
  await setAccount(w.root, w.b.id, { enabled: true });
  assert.equal(
    (await takeOverSession(w.id, w.b.id, { control: w.control, requireUnowned: true })).ok,
    true,
  );
  assert.equal(w.launched().id, w.nativeId);
  assert.equal(w.launched().history, fs.readFileSync(w.transcript, "utf8"));
  w.store.created(w.id, randomUUID(), w.cwd);
  w.store.transfer(w.id, "delegated", "Synthetic owner");
  const result = await takeOverSession(w.id, w.a.id, {
    control: w.control,
    generation: w.store.get(w.id).generation,
    requireUnowned: true,
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /Another owner/);
  assert.equal(w.calls(), 1);
});
