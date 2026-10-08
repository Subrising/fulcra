// Update-7 W3: the owner's model rule on every create path, before anyone opens Settings.
//   leads (orchestration, planning, review) -> claude-opus-5-5, medium effort
//   implementers                            -> claude-sonnet-5-5 medium, or codex gpt-6.1-sol medium
// An explicit per-call model / effort wins; one the installed provider does not list is refused plainly, before
// anything is reserved or journaled.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { firstRun } from "../config.mjs";

// Installation settings are read during module import. The test owns that root
// before loading provider-mode, even when the invoking process has a real home.
const installationRoot = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "fulcra-role-install-")),
);
firstRun({ ORCA_HOME: installationRoot });
process.env.ORCA_HOME = installationRoot;
after(() => fs.rmSync(installationRoot, { recursive: true, force: true }));
const { sessionDefaults, explicitSelection } = await import("./provider-mode.mjs");
const { checkOverride, checkProvider } = await import("./provider-model.mjs");
const { readRoleDefaults, writeRoleDefaults, initializeRoleDefaults } =
  await import("../../orca-organization/server/role-defaults-store.mjs");

const scratch = () => fs.realpathSync(fs.mkdtempSync(path.join(installationRoot, "case-")));
const pick = (d) => [d.model, d.thinkingOptionId, d.source.model, d.source.thinkingOptionId];
const OPUS = { model: "claude/claude-opus-5-5", thinkingOptionId: "medium" };

test("with nothing chosen, the store holds the owner's rule: leads Opus 5.5 medium, implementers Sonnet 5.5 or gpt-6.1-sol medium", () => {
  const t = readRoleDefaults(scratch());
  for (const role of ["orchestration", "planning", "review"])
    assert.deepEqual(t.roles[role].claude, OPUS, role);
  assert.deepEqual(t.roles.implementation.claude, {
    model: "claude/claude-sonnet-5-5",
    thinkingOptionId: "medium",
  });
  assert.deepEqual(t.roles.implementation.codex, {
    model: "codex/gpt-6.1-sol",
    thinkingOptionId: "medium",
  });
});

test("a stored Settings choice still wins over the rule", async () => {
  const root = scratch();
  await writeRoleDefaults(root, {
    role: "review",
    defaults: {
      provider: "codex",
      claude: OPUS,
      codex: { model: "codex/gpt-6.1-sol", thinkingOptionId: "high" },
    },
  });
  assert.deepEqual(readRoleDefaults(root).roles.review.codex, {
    model: "codex/gpt-6.1-sol",
    thinkingOptionId: "high",
  });
});

test("every controller create path gets the role default from the store; an explicit value wins field by field", () => {
  const config = { home: scratch() };
  for (const role of ["orchestration", "planning", "review"])
    assert.deepEqual(
      pick(sessionDefaults("claude", {}, config, role)),
      ["claude/claude-opus-5-5", "medium", "role", "role"],
      role,
    );
  assert.deepEqual(pick(sessionDefaults("claude", {}, config, "implementation")), [
    "claude/claude-sonnet-5-5",
    "medium",
    "role",
    "role",
  ]);
  assert.deepEqual(pick(sessionDefaults("codex", {}, config, "implementation")), [
    "codex/gpt-6.1-sol",
    "medium",
    "role",
    "role",
  ]);
  assert.deepEqual(
    pick(sessionDefaults("codex", { thinkingOptionId: "high" }, config, "implementation")),
    ["codex/gpt-6.1-sol", "high", "role", "override"],
  );
  assert.deepEqual(
    pick(sessionDefaults("claude", { model: "claude/claude-sonnet-5-5" }, config, "orchestration")),
    ["claude/claude-sonnet-5-5", "medium", "override", "role"],
  );
});

test("an explicit model / effort from a tool call is normalised to the provider family, or refused plainly", () => {
  assert.equal(explicitSelection("claude", {}), undefined);
  assert.deepEqual(explicitSelection("claude", { model: "claude-opus-5-5", effort: "high" }), {
    model: "claude/claude-opus-5-5",
    thinkingOptionId: "high",
  });
  assert.deepEqual(explicitSelection("codex", { model: "codex/gpt-6.1-sol" }), {
    model: "codex/gpt-6.1-sol",
  });
  assert.deepEqual(explicitSelection("codex", { effort: "medium" }), {
    thinkingOptionId: "medium",
  });
  assert.throws(
    () => explicitSelection("claude", { model: "codex/gpt-6.1-sol" }),
    /codex\/gpt-6\.1-sol is not a claude model/,
  );
  assert.throws(
    () => explicitSelection("claude", { model: "claude opus; rm -rf" }),
    /not a model name/,
  );
  assert.throws(() => explicitSelection("claude", { effort: "turbo" }), /turbo is not an effort/);
});

const client = (models, calls = []) => ({
  providers: {
    listModels: async (p) => {
      calls.push(p);
      return models === null ? { provider: p, error: "unavailable" } : { provider: p, models };
    },
  },
});
const LISTED = [
  {
    id: "claude-opus-5-5",
    provider: "claude",
    thinkingOptions: [{ id: "medium" }, { id: "high" }],
  },
];

test("checkOverride refuses a model or effort the provider does not list, and makes no call without one", async () => {
  const calls = [];
  await checkOverride(client(LISTED, calls), "claude", undefined, "/tmp");
  await checkOverride(client(LISTED, calls), "claude", {}, "/tmp");
  assert.deepEqual(calls, [], "no explicit value: no extra provider call");
  await checkOverride(
    client(LISTED, calls),
    "claude",
    { model: "claude/claude-opus-5-5", thinkingOptionId: "high" },
    "/tmp",
  );
  await assert.rejects(
    checkOverride(client(LISTED), "claude", { model: "claude/claude-opus-9" }, "/tmp"),
    /does not offer claude\/claude-opus-9 \(model-not-offered\); nothing was created/,
  );
  await assert.rejects(
    checkOverride(
      client(LISTED),
      "claude",
      { model: "claude/claude-opus-5-5", thinkingOptionId: "max" },
      "/tmp",
    ),
    /effort-not-offered/,
  );
  await assert.rejects(
    checkOverride(client(null), "claude", { model: "claude/claude-opus-5-5" }, "/tmp"),
    /model list is unavailable/,
  );
});

// R1 B2: a Settings save and an account-store write (plugin host and controller are separate processes) take the same
// store lock, so neither loses the other's change; concurrent saves all land.
test("a role-defaults save waits for the account store lock, and concurrent saves all land", async () => {
  const { update } = await import("../../orca-organization/server/accounts.mjs");
  const root = scratch(),
    file = path.join(root, "accounts", "defaults.json");
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const holder = update(root, async () => {
    await gate;
  });
  await new Promise((r) => setTimeout(r, 30));
  const save = writeRoleDefaults(root, {
    role: "review",
    defaults: {
      provider: "claude",
      claude: OPUS,
      codex: { model: null, thinkingOptionId: "medium" },
    },
  });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(fs.existsSync(file), false, "nothing written while another writer holds the lock");
  release();
  await holder;
  await save;
  assert.deepEqual(readRoleDefaults(root).roles.review.claude, OPUS);
  const roles = ["orchestration", "planning", "review", "implementation", "research"];
  await Promise.all(
    roles.map((role) =>
      writeRoleDefaults(root, {
        role,
        defaults: {
          provider: "codex",
          claude: OPUS,
          codex: { model: "codex/gpt-6.1-sol", thinkingOptionId: "high" },
        },
      }),
    ),
  );
  for (const role of roles)
    assert.equal(readRoleDefaults(root).roles[role].provider, "codex", role);
  assert.equal(fs.existsSync(path.join(root, "accounts", ".lock")), false, "the lock is released");
});

test("checkProvider: a provider this host lists models for is available; an erroring or empty list is not", async () => {
  await checkProvider(client(LISTED), "claude", "/tmp");
  await assert.rejects(
    checkProvider(client(null), "claude", "/tmp"),
    /The installed claude provider is not available/,
  );
  await assert.rejects(checkProvider(client([]), "claude", "/tmp"), /not available/);
  await assert.rejects(
    checkProvider(
      {
        providers: {
          listModels: async () => {
            throw Error("spawn claude ENOENT");
          },
        },
      },
      "claude",
      "/tmp",
    ),
    /not available/,
  );
});

// Installation defaults: new sessions use Claude `auto` / Codex `auto-review`, stored per provider in the
// Fulcra-owned store (no shared config key), editable in Settings, applied on every create path; an explicit mode wins.
test("default permission modes: Claude auto, Codex auto-review; a Settings choice wins over config, config over the seed", async () => {
  const root = scratch();
  assert.deepEqual(readRoleDefaults(root).modes, { claude: "auto", codex: "auto-review" });
  assert.deepEqual(
    readRoleDefaults(root, null, { codex: "auto-review" }).modes,
    { claude: "auto", codex: "auto-review" },
    "the live config value reads correctly",
  );
  await writeRoleDefaults(root, { mode: { provider: "codex", modeId: "auto" } });
  assert.deepEqual(readRoleDefaults(root, null, { codex: "auto-review" }).modes, {
    claude: "auto",
    codex: "auto",
  });
  await assert.rejects(
    writeRoleDefaults(root, { mode: { provider: "claude", modeId: "bypassPermissions" } }),
    /Unknown mode/,
  );
  await assert.rejects(
    writeRoleDefaults(root, { mode: { provider: "codex", modeId: "danger" } }),
    /Unknown mode/,
  );
});

test("every controller create path launches with the default mode; an explicit mode wins; Codex auto-review carries its pins", async () => {
  const config = { home: scratch() };
  initializeRoleDefaults(config.home);
  const claude = sessionDefaults("claude", {}, config, "implementation"),
    codex = sessionDefaults("codex", {}, config, "orchestration");
  assert.equal(claude.modeId, "auto");
  assert.equal(codex.modeId, "auto-review");
  assert.deepEqual(codex.options, {
    approval_policy: "on-request",
    sandbox_mode: "workspace-write",
  });
  assert.equal(
    sessionDefaults("codex", { modeId: "auto-review" }, config).modeId,
    "auto-review",
    "explicit wins",
  );
  assert.equal(
    sessionDefaults("codex", {}, { ...config, defaults: { modes: { codex: "auto-review" } } })
      .modeId,
    "auto-review",
    "the live config value still applies until the one-shot",
  );
  await writeRoleDefaults(config.home, { mode: { provider: "codex", modeId: "auto" } });
  assert.equal(
    sessionDefaults("codex", {}, { ...config, defaults: { modes: { codex: "auto-review" } } })
      .modeId,
    "auto",
    "a Settings choice wins",
  );
  assert.throws(
    () => sessionDefaults("claude", { modeId: "bypassPermissions" }, config),
    /Refused mode for claude/,
    "Claude bypass stays refused",
  );
});

test("fresh and migrated homes seed installation modes once and preserve explicit Settings bytes", async () => {
  const root = scratch();
  const table = initializeRoleDefaults(root);
  assert.deepEqual(table.modes, { claude: "auto", codex: "auto-review" });
  assert.equal(table.roles.implementation.provider, "claude");
  assert.equal(table.roles.research.provider, "claude");
  assert.equal(fs.statSync(path.join(root, "accounts/defaults.json")).mode & 0o777, 0o600);
  assert.equal(sessionDefaults("claude", {}, { home: root }, "implementation").modeId, "auto");
  assert.equal(
    sessionDefaults("codex", {}, { home: root }, "implementation").modeId,
    "auto-review",
  );
  await writeRoleDefaults(root, { mode: { provider: "claude", modeId: "plan" } });
  const before = fs.readFileSync(path.join(root, "accounts/defaults.json"));
  initializeRoleDefaults(root, null, { claude: "auto" });
  assert.deepEqual(fs.readFileSync(path.join(root, "accounts/defaults.json")), before);
  assert.equal(readRoleDefaults(root).modes.claude, "plan");
  const migrated = scratch();
  initializeRoleDefaults(migrated, null, { claude: "acceptEdits", codex: "auto" });
  assert.deepEqual(readRoleDefaults(migrated).modes, { claude: "acceptEdits", codex: "auto" });
});

// FULCRA(light-role): Haiku 5.5 medium by default, never written to defaults.json until someone saves it.
test("light role: seeded, kept out of a fresh defaults.json, saved only on an explicit choice", async () => {
  const root = scratch();
  const table = initializeRoleDefaults(root);
  assert.deepEqual(table.roles.light, {
    provider: "claude",
    claude: { model: "claude/claude-haiku-5-5", thinkingOptionId: "medium" },
    codex: { model: "codex/gpt-6.1-sol", thinkingOptionId: "medium" },
  });
  const file = path.join(root, "accounts/defaults.json");
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(file, "utf8")).roles, "light"), false);
  assert.equal(readRoleDefaults(root).roles.light.claude.model, "claude/claude-haiku-5-5");
  await writeRoleDefaults(root, {
    role: "light",
    defaults: {
      provider: "claude",
      claude: { model: "claude/claude-sonnet-5-5", thinkingOptionId: "low" },
    },
  });
  assert.equal(
    JSON.parse(fs.readFileSync(file, "utf8")).roles.light.claude.model,
    "claude/claude-sonnet-5-5",
  );
  assert.equal(readRoleDefaults(root).roles.light.claude.thinkingOptionId, "low");
});
