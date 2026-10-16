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
