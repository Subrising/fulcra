// Update-7 W3: Settings -> Accounts & models shows the owner's rule before anything is chosen, edits it in the Fulcra-owned
// store, and refuses a model the installed provider does not list (plainly, and the store is left as it was).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAccountHandlers } from "./accounts-rpc";
import { withManagementInvocation } from "./management-context.mjs";
import { readRoleDefaults } from "./role-defaults-store.mjs";
import { addAccount, readAccounts, setAccount, update } from "./accounts.mjs";

const scratch = () =>
  fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fulcra-accounts-rpc-")));
const efforts = ["low", "medium", "high"].map((id) => ({ id }));
const MODELS: Record<string, unknown[]> = {
  claude: [
    { id: "claude-opus-5-5", provider: "claude", label: "Opus 5.5", thinkingOptions: efforts },
    { id: "claude-sonnet-5-5", provider: "claude", label: "Sonnet 5.5", thinkingOptions: efforts },
  ],
  codex: [{ id: "gpt-6.1-sol", provider: "codex", label: "GPT-6.1-Sol", thinkingOptions: efforts }],
};
const paseo = {
  providers: { listModels: async (p: string) => ({ provider: p, models: MODELS[p] }) },
};
// Account RPCs run inside the host's management invocation (W1, accounts.manage); these tests act as this Mac's owner.
const OWNER = {
  management: {
    invoke: async () => ({}),
    principal: {
      id: "owner",
      authentication: "daemon-password",
      permissions: ["command-centre.manage", "daemon.manage", "accounts.manage"],
    },
    accountsManage: true,
    recordAccountAction: async () => ({ recorded: false }),
  },
};
const asOwner = <T>(run: () => Promise<T>) =>
  withManagementInvocation(OWNER, false, run) as Promise<T>;
const handlers = (root: string) => {
  const h = createAccountHandlers({
    root: () => root,
    configRoles: () => null,
    keychain: { put: async () => {}, remove: async () => {}, get: async () => null } as any,
  });
  return {
    read: (paseo: any) => asOwner(() => h.read(paseo)),
    settings: (input: any, paseo?: any, readOnly = false) =>
      asOwner(() => h.settings(input, paseo, readOnly)),
  };
};

test("Settings shows the rule for every role before anything is chosen, with gpt-6.1-sol in the Codex list", async () => {
  const view = await handlers(scratch()).read(paseo as any);
  for (const role of ["orchestration", "planning", "review"] as const)
    assert.deepEqual(
      view.defaults.roles[role].claude,
      { model: "claude/claude-opus-5-5", thinkingOptionId: "medium" },
      role,
    );
  assert.deepEqual(view.defaults.roles.implementation.claude, {
    model: "claude/claude-sonnet-5-5",
    thinkingOptionId: "medium",
  });
  assert.deepEqual(view.defaults.roles.implementation.codex, {
    model: "codex/gpt-6.1-sol",
    thinkingOptionId: "medium",
  });
  assert.ok(view.catalog.codex?.some((m) => m.id === "codex/gpt-6.1-sol"));
});

test("Settings edits a role in the Fulcra-owned store; a model the provider does not list is refused plainly", async () => {
  const root = scratch(),
    h = handlers(root);
  const codex = (model: string) => ({
    provider: "codex",
    claude: { model: "claude/claude-sonnet-5-5", thinkingOptionId: "medium" },
    codex: { model, thinkingOptionId: "high" },
  });
  assert.deepEqual(
    await h.settings(
      { role: "implementation", defaults: codex("codex/gpt-6.1-sol") },
      paseo as any,
    ),
    { ok: true, message: null },
  );
  assert.deepEqual(readRoleDefaults(root).roles.implementation.codex, {
    model: "codex/gpt-6.1-sol",
    thinkingOptionId: "high",
  });
  const refused = await h.settings(
    { role: "implementation", defaults: codex("codex/gpt-9-imaginary") },
    paseo as any,
  );
  assert.equal(refused.ok, false);
  assert.match(refused.message!, /Codex does not list gpt-9-imaginary on this host/);
  assert.deepEqual(
    readRoleDefaults(root).roles.implementation.codex,
    { model: "codex/gpt-6.1-sol", thinkingOptionId: "high" },
    "unchanged",
  );
  // No catalog (provider unavailable): the choice is kept; every create path checks it again at launch.
  assert.equal(
    (
      await h.settings({ role: "review", defaults: codex("codex/gpt-6.1-sol") }, {
        providers: {
          listModels: async () => {
            throw Error("down");
          },
        },
      } as any)
    ).ok,
    true,
  );
});

// Base rule B3 (defence in depth): a read-only device's invocation never saves role defaults, even if it gets here.
test("Settings refuses to save for a read-only invocation, and nothing is written", async () => {
  const root = scratch(),
    h = handlers(root);
  const out = await h.settings(
    {
      role: "review",
      defaults: {
        provider: "codex",
        claude: { model: "claude/claude-opus-5-5", thinkingOptionId: "medium" },
        codex: { model: "codex/gpt-6.1-sol", thinkingOptionId: "medium" },
      },
    },
    paseo as any,
    true,
  );
  assert.equal(out.ok, false);
  assert.match(out.message!, /read-only/);
  assert.equal(fs.existsSync(path.join(root, "accounts", "defaults.json")), false);
});

test("W3: Settings shows the default permission modes and their choices, and edits one per provider", async () => {
  const root = scratch(),
    h = handlers(root);
  const view = await h.read(paseo as any);
  // The Codex default is auto-review since 0.2.5 (SEED_MODES); full-access is a choice, never the seed.
  assert.deepEqual(view.defaults.modes, { claude: "auto", codex: "auto-review" });
  assert.deepEqual(view.defaults.modeChoices.codex, ["full-access", "auto-review", "auto"]);
  assert.ok(!view.defaults.modeChoices.claude.includes("bypassPermissions"));
  assert.equal(
    (await h.settings({ mode: { provider: "codex", modeId: "full-access" } }, paseo as any)).ok,
    true,
  );
  assert.deepEqual(readRoleDefaults(root).modes, { claude: "auto", codex: "full-access" });
  const bad = await h.settings(
    { mode: { provider: "claude", modeId: "bypassPermissions" } } as any,
    paseo as any,
  );
  assert.equal(bad.ok, false);
  assert.equal(
    (await h.settings({ mode: { provider: "codex", modeId: "full-access" } }, paseo as any, true))
      .ok,
    false,
    "read-only",
  );
});

test("W3-3: Settings refuses an effort the chosen model does not list, and nothing is saved", async () => {
  const root = scratch(),
    h = handlers(root);
  const out = await h.settings(
    {
      role: "implementation",
      defaults: {
        provider: "claude",
        claude: { model: "claude/claude-sonnet-5-5", thinkingOptionId: "max" },
        codex: { model: null, thinkingOptionId: null },
      },
    },
    paseo as any,
  );
  assert.equal(out.ok, false);
  assert.match(out.message!, /Sonnet 5\.5 does not offer max effort/);
  assert.equal(fs.existsSync(path.join(root, "accounts", "defaults.json")), false);
});

// ---- 7b fold: "Move up" swaps two accounts' order on the server, under the store lock --------------------------
const DEVICE = (recorded: unknown[], extra: Record<string, unknown> = {}) => ({
  management: {
    invoke: async () => ({}),
    principal: {
      id: "device:dev_phone000000000000",
      authentication: "paired-device",
      deviceId: "dev_phone000000000000",
      permissions: ["command-centre.manage", "daemon.manage", "accounts.manage"],
    },
    accountsManage: true,
    recordAccountAction: async (entry: unknown) => {
      recorded.push(entry);
      return { recorded: true };
    },
    ...extra,
  },
});
const mover = (root: string, context: any = OWNER) => {
  const h = createAccountHandlers({
    root: () => root,
    configRoles: () => null,
    keychain: { put: async () => {}, remove: async () => {}, get: async () => null } as any,
  });
  return (input: any) =>
    withManagementInvocation(context, false, () => h.update(input)) as Promise<{
      ok: boolean;
      message: string | null;
    }>;
};
const order = (root: string, provider = "claude") =>
  readAccounts(root)
    .accounts.filter((a) => a.provider === provider)
    .sort((a, b) => a.priority - b.priority)
    .map((a) => [a.name, a.priority]);

test("Move up swaps with the account above: [1,2] -> [2,1], never a tie; Move down is the mirror", async () => {
  const root = scratch();
  const a = await addAccount(root, { provider: "claude", name: "Work" }),
    b = await addAccount(root, { provider: "claude", name: "Personal" });
  assert.deepEqual(order(root), [
    ["Work", 1],
    ["Personal", 2],
  ]);
  assert.deepEqual(await mover(root)({ id: b.id, move: "up" }), { ok: true, message: null });
  assert.deepEqual(order(root), [
    ["Personal", 1],
    ["Work", 2],
  ]);
  assert.deepEqual(await mover(root)({ id: b.id, move: "down" }), { ok: true, message: null });
  assert.deepEqual(order(root), [
    ["Work", 1],
    ["Personal", 2],
  ]);
  void a;
});

test("the first account can't move up and the last can't move down; nothing changes", async () => {
  const root = scratch();
  const a = await addAccount(root, { provider: "claude", name: "Work" }),
    b = await addAccount(root, { provider: "claude", name: "Personal" });
  assert.deepEqual(await mover(root)({ id: a.id, move: "up" }), {
    ok: false,
    message: "It is already first",
  });
  assert.deepEqual(await mover(root)({ id: b.id, move: "down" }), {
    ok: false,
    message: "It is already last",
  });
  assert.deepEqual(order(root), [
    ["Work", 1],
    ["Personal", 2],
  ]);
});

test("a move stays within its provider: Codex order is untouched by a Claude move, and the reverse", async () => {
  const root = scratch();
  await addAccount(root, { provider: "codex", name: "Codex one" });
  await addAccount(root, { provider: "claude", name: "Work" });
  const b = await addAccount(root, { provider: "claude", name: "Personal" });
  const c2 = await addAccount(root, { provider: "codex", name: "Codex two" });
  await mover(root)({ id: b.id, move: "up" });
  assert.deepEqual(order(root, "claude"), [
    ["Personal", 1],
    ["Work", 2],
  ]);
  assert.deepEqual(order(root, "codex"), [
    ["Codex one", 1],
    ["Codex two", 2],
  ]);
  await mover(root)({ id: c2.id, move: "up" });
  assert.deepEqual(order(root, "codex"), [
    ["Codex two", 1],
    ["Codex one", 2],
  ]);
  assert.deepEqual(order(root, "claude"), [
    ["Personal", 1],
    ["Work", 2],
  ]);
});

test("a tie already on disk (the old Move up) is repaired: the list is renumbered in its shown order, then swapped", async () => {
  const root = scratch();
  // Distinct creation times: among tied priorities the shown order is creation order.
  const a = await addAccount(root, { provider: "claude", name: "Work" }, 1000),
    b = await addAccount(root, { provider: "claude", name: "Personal" }, 2000);
  const c = await addAccount(root, { provider: "claude", name: "Spare" }, 3000);
  await setAccount(root, b.id, { priority: 1 }); // what `Math.max(1, list[i-1].priority - 1)` left behind: [1,1,3]
  await mover(root)({ id: c.id, move: "up" });
  assert.deepEqual(order(root), [
    ["Work", 1],
    ["Spare", 2],
    ["Personal", 3],
  ]);
  void a;
});

test("concurrent moves and saves run one at a time under the store lock: no tie, nothing lost", async () => {
  const root = scratch();
  const ids: string[] = [];
  for (const name of ["A", "B", "C", "D"])
    ids.push((await addAccount(root, { provider: "claude", name })).id);
  const move = mover(root);
  const h = createAccountHandlers({
    root: () => root,
    configRoles: () => null,
    keychain: {} as any,
  });
  await Promise.all([
    move({ id: ids[1], move: "up" }),
    move({ id: ids[3], move: "up" }),
    move({ id: ids[2], move: "down" }),
    withManagementInvocation(OWNER, false, () =>
      h.update({ id: ids[0], name: "A renamed" } as any),
    ),
  ]);
  const claude = readAccounts(root).accounts;
  assert.deepEqual(
    claude.map((a) => a.priority).sort(),
    [1, 2, 3, 4],
    "a permutation: no tie, no gap",
  );
  assert.ok(
    claude.some((a) => a.name === "A renamed"),
    "the concurrent save kept",
  );
});

test("a paired device cannot reorder accounts even with a legacy grant", async () => {
  const root = scratch(),
    recorded: unknown[] = [];
  try {
    await addAccount(root, { provider: "claude", name: "Work" });
    const spare = await addAccount(root, { provider: "claude", name: "Spare" });
    assert.equal((await mover(root, DEVICE(recorded))({ id: spare.id, move: "up" })).ok, false);
    assert.deepEqual(order(root), [
      ["Work", 1],
      ["Spare", 2],
    ]);
    assert.deepEqual(recorded, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a read-only invocation (or a device without accounts.manage) can't move an account", async () => {
  const root = scratch(),
    recorded: unknown[] = [];
  await addAccount(root, { provider: "claude", name: "Work" });
  const b = await addAccount(root, { provider: "claude", name: "Personal" });
  for (const context of [
    DEVICE(recorded, { readOnly: true }),
    DEVICE(recorded, { accountsManage: false }),
  ]) {
    const out = await mover(root, context)({ id: b.id, move: "up" });
    assert.equal(out.ok, false);
    assert.match(out.message!, /local owner/);
  }
  assert.deepEqual(order(root), [
    ["Work", 1],
    ["Personal", 2],
  ]);
  assert.deepEqual(recorded, []);
});

test("local owner can continue a session; an unscoped paired grant cannot", async (t) => {
  const root = scratch();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const account = await addAccount(root, { provider: "claude", name: "Spare" });
  let moved = 0;
  const h = createAccountHandlers({
    root: () => root,
    configRoles: () => null,
    takeOver: async () => {
      moved++;
      return { ok: true };
    },
  });
  const native = { agents: { ref: () => ({ current: () => ({ provider: "claude" }) }) } };
  assert.equal(
    (
      await withManagementInvocation(DEVICE([]), false, () =>
        h.takeover({ agentId: "chat", account: account.id }, native),
      )
    ).ok,
    false,
  );
  assert.equal(
    (await asOwner(() => h.takeover({ agentId: "chat", account: account.id }, native))).ok,
    true,
  );
  assert.equal(moved, 1);
});

test("normal paired phone lists a narrow projection and switches only its bound session", async () => {
  const root = scratch();
  try {
    const account = await addAccount(root, { provider: "claude", name: "Spare" });
    const agentId = "11111111-1111-4111-8111-111111111111";
    const audits: unknown[] = [];
    const moves: unknown[] = [];
    const h = createAccountHandlers({
      root: () => root,
      configRoles: () => null,
      takeOver: async (...args: unknown[]) => {
        moves.push(args);
        return { ok: true, message: "Switched." };
      },
      keychain: {
        put: async () => {
          throw Error("must not write");
        },
      } as any,
    });
    const phone = {
      management: {
        invoke: async () => null,
        principal: {
          id: "device:phone",
          authentication: "paired-device",
          deviceId: "phone",
          permissions: ["daemon.read", "workspace.read", "workspace.write"],
          accountSessionId: agentId,
        },
        recordAccountAction: async (entry: unknown) => {
          audits.push(entry);
          return { recorded: true };
        },
      },
    };
    const native = { agents: { ref: () => ({ current: () => ({ provider: "claude" }) }) } };
    const asPhone = <T>(run: () => Promise<T>) =>
      withManagementInvocation(phone, false, run) as Promise<T>;
    const view = await asPhone(() => h.session({ agentId }, native));
    assert.deepEqual(view, {
      provider: "claude",
      current: null,
      accounts: [{ id: account.id, name: "Spare", status: { state: "ok" } }],
    });
    assert.equal(
      (await asPhone(() => h.switch({ agentId, account: account.id }, native))).ok,
      true,
    );
    assert.equal(moves.length, 1);
    assert.deepEqual(audits, [], "the host owns scoped switch audits");
    assert.equal(
      (await asPhone(() => h.switch({ agentId: "other", account: account.id }, native))).ok,
      false,
    );
    await assert.rejects(asPhone(() => h.session({ agentId: "other" }, native)));
    await assert.rejects(asPhone(() => h.read(native)));
    for (const run of [
      () => h.add({ provider: "codex", name: "Extra" }),
      () => h.update({ id: account.id, remove: true }),
      () => h.update({ id: account.id, revoke: true }),
      () => h.update({ id: account.id, token: "synthetic" }),
      () => h.settings({ policy: "spread" }),
      () => h.settings({ defaultAccount: { provider: "claude", id: account.id } }),
      () => h.settings({ rotateOnLimit: true }),
      () => h.takeover({ agentId, account: account.id }, native),
    ])
      assert.equal((await asPhone(run)).ok, false);
    assert.equal(moves.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("paired list removes secret-shaped legacy labels and status text", async () => {
  const root = scratch();
  try {
    const a = await addAccount(root, { provider: "claude", name: "Spare" });
    const canary = "sk-ant-oat01-" + "S".repeat(60);
    await update(root, (s) => {
      s.accounts[0].name = canary;
      s.accounts[0].revoked = { at: new Date().toISOString(), reason: canary };
      (s.accounts[0] as any).token = canary;
      return null;
    });
    const h = createAccountHandlers({ root: () => root, configRoles: () => null });
    const context = {
      management: {
        invoke: async () => null,
        principal: { authentication: "paired-device", accountSessionId: "viewed" },
      },
    };
    const view = await withManagementInvocation(context, false, () =>
      h.session(
        { agentId: "viewed" },
        { agents: { ref: () => ({ current: () => ({ provider: "claude" }) }) } },
      ),
    );
    assert.deepEqual(view.accounts, [
      {
        id: a.id,
        name: "Pooled account",
        status: { state: "revoked", reason: "Sign-in required" },
      },
    ]);
    assert.equal(JSON.stringify(view).includes(canary), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an old overlong account name is refused before a native switch", async () => {
  const root = scratch();
  try {
    const account = await addAccount(root, { provider: "claude", name: "Spare" });
    await update(root, (state) => {
      state.accounts[0].name = "Legacy account ".repeat(8);
      return null;
    });
    let moved = false;
    const h = createAccountHandlers({
      root: () => root,
      configRoles: () => null,
      takeOver: async () => {
        moved = true;
        return { ok: true };
      },
    });
    const result = await asOwner(() =>
      h.switch(
        { agentId: "chat", account: account.id },
        { agents: { ref: () => ({ current: () => ({ provider: "claude" }) }) } },
      ),
    );
    assert.equal(result.ok, false);
    assert.match(result.message!, /valid name/);
    assert.equal(moved, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const fail of [false, true]) {
  test(`one-step revoke blocks before deletion and preserves archive safety (delete failure: ${fail})`, async (t) => {
    const root = scratch();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const a = await addAccount(root, { provider: "claude", name: "API fixture" });
    const { update, accountStatus } = await import("./accounts.mjs");
    await setAccount(root, a.id, { credentialKind: "api-key" });
    await update(root, (s) => {
      s.assignments["test-session"] = {
        accountId: a.id,
        provider: "claude",
        at: new Date().toISOString(),
        ended: false,
      };
    });
    let deletes = 0,
      archives = 0;
    const h = createAccountHandlers({
      root: () => root,
      configRoles: () => null,
      keychain: {
        put: async () => {},
        get: async () => null,
        remove: async () => {
          assert.equal(accountStatus(readAccounts(root).accounts[0]).state, "revoked");
          deletes++;
          if (fail) throw Error("synthetic private store failure");
        },
      },
    });
    const p = {
      agents: {
        ref: () => ({
          current: () => ({ provider: "claude" }),
          archive: async () => {
            archives++;
          },
        }),
      },
    };
    const result = await asOwner(() => h.update({ id: a.id, revoke: true }, p));
    assert.equal(result.ok, !fail);
    assert.equal(accountStatus(readAccounts(root).accounts[0]).state, "revoked");
    assert.equal(deletes, 1);
    assert.equal(archives, 0);
    assert.equal(JSON.stringify(result).includes("synthetic private"), false);
    if (fail) {
      assert.match(result.message!, /Retry revoke/);
      const epoch = readAccounts(root).accounts[0].keyEpoch;
      await asOwner(() => h.update({ id: a.id, clearLimit: true, enabled: true }));
      await asOwner(() => h.update({ id: a.id, enabled: false }));
      await asOwner(() => h.update({ id: a.id, enabled: true }));
      assert.equal(accountStatus(readAccounts(root).accounts[0]).state, "revoked");
      assert.equal(readAccounts(root).accounts[0].localRevoked, true);
      assert.equal(readAccounts(root).accounts[0].keyEpoch, epoch);
    }
    const denied = await withManagementInvocation(
      { management: { ...OWNER.management, accountsManage: false } },
      false,
      () => h.update({ id: a.id, revoke: true }, p),
    );
    assert.equal(denied.ok, false);
    assert.equal(deletes, 1);
  });
}

function childExit(child: import("node:child_process").ChildProcess) {
  return new Promise<void>((resolve) => child.once("exit", () => resolve()));
}
function latch() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
for (const first of ["replace", "revoke"] as const) {
  test(`credential operations are serialized across readback: ${first} starts first`, async (t) => {
    const root = scratch();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const a = await addAccount(root, { provider: "claude", name: "API fixture" });
    await setAccount(root, a.id, {
      credentialKind: "api-key",
      keyEpoch: "00000000-0000-4000-8000-000000000001",
    });
    const entered = latch(),
      release = latch();
    const events: string[] = [];
    const h = createAccountHandlers({
      root: () => root,
      configRoles: () => null,
      keychain: {
        get: async () => null,
        put: async () => {
          events.push("put");
          assert.equal(readAccounts(root).accounts[0].auth, "expired");
          assert.notEqual(
            readAccounts(root).accounts[0].keyEpoch,
            "00000000-0000-4000-8000-000000000001",
          );
          if (first === "replace") {
            entered.open();
            await release.promise;
          }
        },
        remove: async () => {
          events.push("remove");
          if (first === "revoke") {
            entered.open();
            await release.promise;
          }
        },
      },
    });
    const replace = () =>
      asOwner(() => h.update({ id: a.id, token: "sk-ant-api03-SYNTHETIC-REPLACEMENT-ONLY" }));
    const revoke = () => asOwner(() => h.update({ id: a.id, revoke: true }));
    const pending = first === "replace" ? replace() : revoke();
    await entered.promise;
    const blocked = latch();
    const watcher = fs.watch(path.join(root, "accounts"), () => {
      if (readAccounts(root).accounts[0].localRevoked) blocked.open();
    });
    const next = first === "replace" ? revoke() : replace();
    if (first === "replace") await blocked.promise;
    watcher.close();
    release.open();
    assert.equal((await pending).ok, first !== "replace");
    assert.equal((await next).ok, true);
    assert.deepEqual(events, first === "replace" ? ["put", "remove"] : ["remove", "put"]);
    assert.equal(readAccounts(root).accounts[0].localRevoked, first === "replace");
  });
}

test("failed replacement readback cannot restore availability or an old credential generation", async (t) => {
  const root = scratch();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const a = await addAccount(root, { provider: "claude", name: "API fixture" });
  await setAccount(root, a.id, {
    credentialKind: "api-key",
    keyEpoch: "00000000-0000-4000-8000-000000000001",
  });
  const h = createAccountHandlers({
    root: () => root,
    configRoles: () => null,
    keychain: {
      get: async () => null,
      remove: async () => {},
      put: async () => {
        throw Error("synthetic readback failure");
      },
    },
  });
  assert.equal(
    (await asOwner(() => h.update({ id: a.id, token: "sk-ant-api03-SYNTHETIC-REPLACEMENT-ONLY" })))
      .ok,
    false,
  );
  const current = readAccounts(root).accounts[0];
  assert.equal(current.auth, "expired");
  assert.notEqual(current.keyEpoch, "00000000-0000-4000-8000-000000000001");
});

test(
  "native old helpers cannot read a replacement during readback or recover a failed local revoke",
  { skip: !["darwin", "win32"].includes(process.platform), timeout: 90000 },
  async (t) => {
    const { scratchKeychain } = await import("./scratch-keychain.fixture.mjs");
    const { apiKeyHelperCommand } = await import("./api-key-helper.mjs");
    const { exec } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { randomUUID } = await import("node:crypto");
    const root = scratch();
    const { store, env } = scratchKeychain(root);
    const a = await addAccount(root, { provider: "claude", name: "API native fixture" });
    t.after(async () => {
      await store.remove(a.id);
      fs.rmSync(root, { recursive: true, force: true });
    });
    const oldEpoch = randomUUID();
    const first = `sk-ant-api03-${randomUUID()}-${randomUUID()}`;
    const second = `sk-ant-api03-${randomUUID()}-${randomUUID()}`;
    await store.put(a.id, first);
    await setAccount(root, a.id, { credentialKind: "api-key", keyEpoch: oldEpoch });
    const command = apiKeyHelperCommand({ root, id: a.id, epoch: oldEpoch, env });
    const run = () =>
      promisify(exec)(command, {
        env: { HOME: process.env.HOME, SystemRoot: process.env.SystemRoot, PATH: process.env.PATH },
        timeout: 20000,
      });
    assert.equal((await run()).stdout === first, true);
    const entered = latch(),
      release = latch();
    const h = createAccountHandlers({
      root: () => root,
      configRoles: () => null,
      keychain: {
        ...store,
        put: async (id, key) => {
          await store.put(id, key);
          entered.open();
          await release.promise;
          throw Error("synthetic readback failure");
        },
        remove: async () => {
          throw Error("synthetic deletion refusal");
        },
      },
    });
    const replace = asOwner(() => h.update({ id: a.id, token: second }));
    await entered.promise;
    try {
      assert.equal((await store.get(a.id)) === second, true);
      await assert.rejects(
        run,
        (error: any) =>
          !String(error.stdout).includes(first) && !String(error.stdout).includes(second),
      );
    } finally {
      release.open();
    }
    assert.equal((await replace).ok, false);
    assert.equal((await asOwner(() => h.update({ id: a.id, revoke: true }))).ok, false);
    await asOwner(() => h.update({ id: a.id, clearLimit: true, enabled: true }));
    await assert.rejects(run, (error: any) => !String(error.stdout).includes(second));
    assert.equal((await store.get(a.id)) === second, true);
    assert.equal(readAccounts(root).accounts[0].localRevoked, true);
  },
);

test(
  "stale credential lock: revoke blocks the helper, deletes the key and stops the actual runtime",
  { skip: process.platform !== "darwin", timeout: 90000 },
  async (t) => {
    const { spawn, exec } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { randomUUID } = await import("node:crypto");
    const { scratchKeychain } = await import("./scratch-keychain.fixture.mjs");
    const { apiKeyHelperCommand } = await import("./api-key-helper.mjs");
    const { createApiRuntimeChannel } = await import("./api-runtime-channel.mjs");
    const { stopRecordedTree, processIdentity } = await import("./api-process-tree.mjs");
    const root = scratch();
    const { store, env } = scratchKeychain(root);
    const a = await addAccount(root, { provider: "claude", name: "Stale lock fixture" });
    const epoch = randomUUID();
    const key = `sk-ant-api03-${randomUUID()}-${randomUUID()}`;
    await store.put(a.id, key);
    await setAccount(root, a.id, { credentialKind: "api-key", keyEpoch: epoch });
    const command = apiKeyHelperCommand({ root, id: a.id, epoch, env });
    const runHelper = () =>
      promisify(exec)(command, { env: { HOME: process.env.HOME }, timeout: 15000 });
    assert.equal((await runHelper()).stdout === key, true);
    const dead = spawn(process.execPath, ["-e", ""], { env: {}, stdio: "ignore" });
    await childExit(dead);
    const lock = path.join(root, "accounts", `.credential-${a.id}.lock`);
    fs.writeFileSync(lock, String(dead.pid), { mode: 0o600 });
    fs.utimesSync(lock, new Date(0), new Date(0));
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      env: {},
      stdio: "ignore",
    });
    const exited = childExit(child);
    const start = processIdentity(child.pid);
    const channel = createApiRuntimeChannel({
      root,
      accountId: a.id,
      epoch,
      onStop: () => {
        void stopRecordedTree(child.pid, start).then(() => channel.release());
      },
    });
    channel.attach(child);
    t.after(async () => {
      child.kill("SIGKILL");
      channel.release();
      await store.remove(a.id);
      fs.rmSync(root, { recursive: true, force: true });
    });
    let deleted = false;
    const h = createAccountHandlers({
      root: () => root,
      configRoles: () => null,
      keychain: {
        ...store,
        remove: async (id) => {
          const current = readAccounts(root).accounts[0];
          assert.equal(current.localRevoked, true);
          assert.notEqual(current.keyEpoch, epoch);
          await assert.rejects(runHelper, (e: any) => !String(e.stdout).includes(key));
          await store.remove(id);
          deleted = true;
        },
      },
    });
    const result = await asOwner(() => h.update({ id: a.id, revoke: true }));
    assert.equal(result.ok, true, result.message ?? "");
    await exited;
    assert.equal(deleted, true);
    assert.equal(await store.get(a.id), null);
    assert.equal(processIdentity(child.pid), null);
    assert.equal(fs.existsSync(lock), false);
    await assert.rejects(runHelper, (e: any) => !String(e.stdout).includes(key));
  },
);

test(
  "orphan lease recovery permits explicit key replacement after a daemon crash",
  { timeout: 15000 },
  async (t) => {
    const { spawn } = await import("node:child_process");
    const { randomUUID } = await import("node:crypto");
    const { processIdentity } = await import("./api-process-tree.mjs");
    const root = scratch();
    const a = await addAccount(root, { provider: "claude", name: "Orphan fixture" });
    await setAccount(root, a.id, { credentialKind: "api-key" });
    const dead = spawn(process.execPath, ["-e", ""], { env: {}, stdio: "ignore" });
    await childExit(dead);
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      env: {},
      stdio: "ignore",
    });
    const exit = childExit(child);
    t.after(() => {
      child.kill("SIGKILL");
      fs.rmSync(root, { recursive: true, force: true });
    });
    const dir = path.join(root, "accounts/api-runtimes");
    fs.mkdirSync(dir, { recursive: true });
    const lease = path.join(dir, `${randomUUID()}.json`);
    fs.writeFileSync(
      lease,
      JSON.stringify({
        accountId: a.id,
        ownerPid: dead.pid,
        childPid: child.pid,
        childStart: processIdentity(child.pid),
      }),
    );
    let puts = 0;
    const h = createAccountHandlers({
      root: () => root,
      configRoles: () => null,
      keychain: {
        get: async () => null,
        remove: async () => {},
        put: async () => {
          puts++;
          assert.equal(processIdentity(child.pid), null);
        },
      },
    });
    const result = await asOwner(() =>
      h.update({ id: a.id, token: "sk-ant-api03-SYNTHETIC-REPLACEMENT-ONLY" }),
    );
    assert.equal(result.ok, true, result.message ?? "");
    await exit;
    assert.equal(fs.existsSync(lease), false);
    assert.equal(puts, 1);
    assert.equal(readAccounts(root).accounts[0].auth, "ok");
  },
);

test(
  "dead credential owner recovery is available without native credential storage",
  { timeout: 15000 },
  async (t) => {
    const { spawn } = await import("node:child_process");
    const root = scratch();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const a = await addAccount(root, { provider: "claude", name: "Dead lock fixture" });
    await setAccount(root, a.id, { credentialKind: "api-key" });
    const dead = spawn(process.execPath, ["-e", ""], { env: {}, stdio: "ignore" });
    await childExit(dead);
    const lock = path.join(root, "accounts", `.credential-${a.id}.lock`);
    fs.writeFileSync(lock, String(dead.pid));
    fs.utimesSync(lock, new Date(0), new Date(0));
    let removed = false;
    const h = createAccountHandlers({
      root: () => root,
      configRoles: () => null,
      keychain: {
        get: async () => null,
        put: async () => {},
        remove: async () => {
          assert.equal(readAccounts(root).accounts[0].localRevoked, true);
          removed = true;
        },
      },
    });
    assert.equal((await asOwner(() => h.update({ id: a.id, revoke: true }))).ok, true);
    assert.equal(removed, true);
    assert.equal(fs.existsSync(lock), false);
  },
);

test(
  "revoke reasserts its block after a writer finishes while revoke waits for the credential lock",
  { timeout: 15000 },
  async (t) => {
    const { withCredentialLock } = await import("./accounts.mjs");
    const { randomUUID } = await import("node:crypto");
    const root = scratch();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const a = await addAccount(root, { provider: "claude", name: "Wait ordering fixture" });
    await setAccount(root, a.id, { credentialKind: "api-key" });
    const entered = latch(),
      release = latch(),
      blocked = latch();
    const writer = withCredentialLock(root, a.id, async () => {
      entered.open();
      await release.promise;
      // Model a replacement that reached its final commit before revoke acquired the lock.
      await setAccount(root, a.id, { auth: "ok", localRevoked: false, keyEpoch: randomUUID() });
    });
    await entered.promise;
    const watcher = fs.watch(path.join(root, "accounts"), () => {
      if (readAccounts(root).accounts[0].localRevoked) blocked.open();
    });
    t.after(() => watcher.close());
    let deletes = 0;
    const h = createAccountHandlers({
      root: () => root,
      configRoles: () => null,
      keychain: {
        get: async () => null,
        put: async () => {},
        remove: async () => {
          const current = readAccounts(root).accounts[0];
          assert.equal(current.localRevoked, true);
          assert.equal(current.auth, "expired");
          deletes++;
        },
      },
    });
    const pending = asOwner(() => h.update({ id: a.id, revoke: true }));
    await blocked.promise;
    release.open();
    await writer;
    assert.equal((await pending).ok, true);
    assert.equal(deletes, 1);
    assert.equal(readAccounts(root).accounts[0].localRevoked, true);
  },
);

test("account switch and takeover skip archived native sessions without changing the pool", async (t) => {
  const root = scratch();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const account = await addAccount(root, { provider: "claude", name: "Archive fixture" });
  await setAccount(root, account.id, { auth: "ok" });
  let calls = 0;
  const h = createAccountHandlers({
    root: () => root,
    configRoles: () => null,
    takeOver: async () => {
      calls++;
      return { ok: true };
    },
  });
  const native = {
    agents: {
      ref: () => ({
        refresh: async () => {},
        current: () => ({
          provider: "claude",
          archivedAt: "2026-01-01T00:00:00.000Z",
        }),
      }),
    },
  };
  const before = readAccounts(root);
  for (const run of [
    () => h.switch({ agentId: "archived", account: account.id }, native),
    () => h.takeover({ agentId: "archived", account: account.id }, native),
  ]) {
    const result = await asOwner(run);
    assert.equal(result.ok, false);
    assert.match(result.message!, /archived/i);
    assert.deepEqual(readAccounts(root), before);
    assert.equal(calls, 0);
  }
});
