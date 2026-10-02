// DESIGN-NEXT-BUILD A2/A4 (C7): role-aware defaults reach the created session through the real native.create, and the
// capability check never launches a model / effort the installed provider does not offer. Runs under the host-test
// harness (throwaway portable ORCA_HOME); only the host transport is replaced, as in native-memory-route.test.mjs.
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { portable } from "../portable-config.mjs";

const captures = [],
  listed = [];
const effort = ["low", "medium", "high", "max"].map((id) => ({ id, label: id }));
const OPUS = {
  id: "claude-opus-5-5",
  provider: "claude",
  isDefault: true,
  thinkingOptions: [...effort, { id: "xhigh" }],
  defaultThinkingOptionId: "high",
};
const SONNET = {
  id: "claude-sonnet-5-5",
  provider: "claude",
  thinkingOptions: effort,
  defaultThinkingOptionId: "high",
};
const ASTRA = {
  id: "gpt-6-astra",
  provider: "codex",
  isDefault: true,
  thinkingOptions: effort,
  defaultThinkingOptionId: "high",
};
let inventory = { claude: [OPUS, SONNET], codex: [ASTRA] },
  catalogDown = false;
mock.module("./catalog-activation.mjs", {
  namedExports: {
    catalogActivation: () => ({
      refresh: async () => {},
      require: () => "fixture-boot",
      close() {},
    }),
  },
});
mock.module("./trusted-native-input.mjs", {
  namedExports: {
    boundNativeInputs: () => ({
      permission: async () => {
        throw Error("not expected");
      },
    }),
  },
});
mock.module("./permission-channel.mjs", {
  namedExports: { permissionChannel: () => ({ ready: async () => {}, close: async () => {} }) },
});
mock.module("./agent-watch.mjs", {
  namedExports: { agentWatch: () => ({ watch() {}, close: async () => {} }) },
});
mock.module("./client-sdk.mjs", {
  namedExports: {
    DaemonRpcError: class DaemonRpcError extends Error {},
    createPaseoApi: () => ({
      agents: {
        create: async (input) => {
          captures.push(input);
          return {
            id: "fixture-session",
            refresh: async () => {},
            current: () => ({ runtimeInstanceId: "fixture-instance" }),
          };
        },
        subscribe: () => () => {},
        list: async () => [],
      },
      providers: {
        listModels: async (family) => {
          listed.push(family);
          if (catalogDown) throw Error("provider probe timed out");
          return { provider: family, models: inventory[family] };
        },
      },
      dispose: async () => {},
    }),
  },
});
const { connectNative } = await import("./native.mjs");
const daemon = { isConnected: true, close: async () => {}, getLastServerInfoMessage: () => null };
const configFile = path.join(portable.home, "config.json"),
  original = fs.readFileSync(configFile, "utf8");
const withRoles = (roles) => {
  const c = JSON.parse(original);
  c.defaults = { ...c.defaults, roles };
  fs.writeFileSync(configFile, JSON.stringify(c, null, 2), { mode: 0o600 });
};
const DAVID = {
  planning: { claude: { model: "claude/claude-opus-5-5", thinkingOptionId: "high" } },
  orchestration: { claude: { model: "claude/claude-opus-5-5", thinkingOptionId: "medium" } },
  implementation: {
    provider: "claude",
    claude: { model: "claude/claude-sonnet-5-5", thinkingOptionId: "high" },
  },
};
let n = 0;
const create = async (native, provider, role, defaults) => {
  const a = {
    provider,
    messageId: `roles-${++n}`,
    taskId: "fixture-task",
    title: "Role defaults proof",
    ...(role ? { role } : {}),
    ...(defaults ? { defaults } : {}),
  };
  const before = captures.length,
    result = await native.create(a);
  return { result, config: captures.length > before ? captures.at(-1).config : null };
};
const setup = async (t) => {
  inventory = { claude: [OPUS, SONNET], codex: [ASTRA] };
  catalogDown = false;
  listed.length = 0;
  t.after(() => fs.writeFileSync(configFile, original, { mode: 0o600 }));
  return connectNative({ daemon, issueProvenance: () => "fixture-provenance" });
};

test("David's table: implementation Sonnet 5.5 high, planning Opus 5.5 high, orchestration Opus 5.5 medium", async (t) => {
  const native = await setup(t);
  withRoles(DAVID);
  for (const [role, model, effortId] of [
    ["implementation", "claude/claude-sonnet-5-5", "high"],
    ["planning", "claude/claude-opus-5-5", "high"],
    ["orchestration", "claude/claude-opus-5-5", "medium"],
  ]) {
    const { result, config } = await create(native, "claude", role);
    assert.deepEqual([config.provider, config.thinkingOptionId], [model, effortId], role);
    assert.deepEqual(
      [result.role, result.mode.source.model, result.mode.source.thinkingOptionId],
      [role, "role", "role"],
    );
    assert.equal(result.fallback, undefined);
  }
});

test("no role, or a Codex session under Claude-only roles, is exactly as before", async (t) => {
  const native = await setup(t);
  const baseline = { claude: await create(native, "claude"), codex: await create(native, "codex") };
  const calls = listed.length;
  withRoles(DAVID);
  const again = {
    claude: await create(native, "claude"),
    codex: await create(native, "codex", "implementation"),
  };
  for (const p of ["claude", "codex"]) {
    assert.deepEqual(
      { ...again[p].config, mcpServers: null },
      { ...baseline[p].config, mcpServers: null },
      p,
    );
    assert.deepEqual(again[p].result.mode, baseline[p].result.mode, p);
  }
  assert.equal(listed.length, 2 * calls, "no extra provider call where no role value applies");
  assert.deepEqual(
    [baseline.claude.config.provider, baseline.claude.config.thinkingOptionId],
    ["claude/claude-opus-5-5", "medium"],
  );
});

test("a role model the installed provider does not offer falls back one level, and says so", async (t) => {
  const native = await setup(t);
  withRoles(DAVID);
  inventory.claude = [OPUS];
  const { result, config } = await create(native, "claude", "implementation");
  assert.equal(
    config.provider,
    "claude/claude-opus-5-5",
    "the model this creation would have had without the role",
  );
  assert.equal(
    config.thinkingOptionId,
    "high",
    "the role effort still applies to the model it falls back to",
  );
  assert.deepEqual(result.fallback, [
    {
      field: "model",
      requested: "claude/claude-sonnet-5-5",
      used: "claude",
      reason: "model-not-offered",
    },
  ]);
  assert.equal(result.mode.source.model, "product-default");
});

test("a role effort the model does not offer falls back; an explicit request the provider does not offer is refused before create", async (t) => {
  const native = await setup(t);
  withRoles({
    planning: { claude: { model: "claude/claude-sonnet-5-5", thinkingOptionId: "xhigh" } },
  });
  const { result, config } = await create(native, "claude", "planning");
  assert.deepEqual(
    [config.provider, config.thinkingOptionId],
    ["claude/claude-sonnet-5-5", "medium"],
  );
  assert.deepEqual(result.fallback, [
    { field: "thinkingOptionId", requested: "xhigh", used: "medium", reason: "effort-not-offered" },
  ]);
  const before = captures.length;
  await assert.rejects(
    create(native, "claude", null, { model: "claude/claude-nonexistent-9" }),
    /does not offer claude\/claude-nonexistent-9 \(model-not-offered\); nothing was created/,
  );
  await assert.rejects(
    create(native, "claude", null, {
      model: "claude/claude-sonnet-5-5",
      thinkingOptionId: "xhigh",
    }),
    /does not offer xhigh effort/,
  );
  assert.equal(captures.length, before, "nothing reached the daemon");
});

test("with the provider list unavailable, role values fall back and explicit values are refused", async (t) => {
  const native = await setup(t);
  withRoles(DAVID);
  catalogDown = true;
  await assert.rejects(
    create(native, "claude", "implementation"),
    /Cannot resolve claude default model|provider probe timed out|unavailable/,
  );
  catalogDown = false;
  inventory.claude = [OPUS, SONNET];
  // Role-only effort with no model pin: the list is needed for the effort check; unavailable -> fall back.
  withRoles({ orchestration: { claude: { thinkingOptionId: "high" } } });
  catalogDown = true;
  await assert.rejects(
    create(native, "claude", null, { thinkingOptionId: "high", model: "claude/claude-opus-5-5" }),
    /its model list is unavailable/,
  );
});

test("roleCapability reports what a creation under a role would launch here, checked exactly as create checks it", async (t) => {
  const native = await setup(t);
  withRoles(DAVID);
  inventory.claude = [OPUS];
  const r = await native.roleCapability("claude", "implementation");
  assert.deepEqual(
    [r.configured.model, r.effective.model, r.fallback[0].reason],
    ["claude/claude-sonnet-5-5", "claude", "model-not-offered"],
  );
  inventory.claude = [OPUS, SONNET];
  assert.deepEqual((await native.roleCapability("claude", "implementation")).fallback, []);
  // A delivered creation records the model it actually got.
  const { result } = await create(native, "claude", "implementation");
  assert.equal(result.model, "claude/claude-sonnet-5-5");
});
