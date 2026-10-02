import { randomUUID } from "node:crypto";
import { ControlStore } from "./store.mjs";
import { Controller } from "./controller.mjs";
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { ROLE_TOOLS } from "./grant-file.mjs";
import { portable } from "../portable-config.mjs";
import { CAPABILITIES } from "./provider-mode.mjs";

// Runs under the host-test harness (tools/host-test-config.mjs): the controller home is a throwaway portable
// ORCA_HOME, so session directories are created for real inside it. Only the V3b host transport is replaced:
// catalogue activation, bound native inputs, the permission channel and the public client SDK. No daemon,
// session or live directory is touched. The legacy Mini native memory core (pinned digest, run labels) was
// removed with the portable configuration; V4 deletes its remaining routes.
const home = portable.controller;
const captures = [];
let failRefresh = false;
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
            refresh: async () => {
              if (failRefresh) throw Error("Snapshot unavailable");
            },
            current: () => ({ runtimeInstanceId: "fixture-instance" }),
          };
        },
        subscribe: () => () => {},
      },
      // The host's model inventory; a unique default resolves the bare family the portable config names.
      providers: {
        listModels: async (family) => ({
          provider: family,
          models: [
            {
              id: family === "claude" ? "claude-opus-5" : "gpt-6-astra",
              provider: family,
              isDefault: true,
            },
          ],
        }),
      },
      dispose: async () => {},
    }),
  },
});
const { connectNative } = await import("./native.mjs");
const { canonicalMemoryConfig } = await import("../canonical-memory-route.mjs");
const daemon = { isConnected: true, close: async () => {}, getLastServerInfoMessage: () => null };
const connect = () => connectNative({ daemon, issueProvenance: () => "fixture-provenance" });

test("both native providers receive scoped memory without changing their other controls", async () => {
  const native = await connect();
  try {
    for (const provider of ["claude", "codex"]) {
      const a = {
        provider,
        messageId: `fixture-${provider}`,
        taskId: "fixture-task",
        title: "Memory configuration proof",
      };
      const result = await native.create(a);
      assert.equal(result.id, "fixture-session");
      assert.equal(result.runtimeInstanceId, "fixture-instance");
      assert.ok(fs.statSync(path.join(home, "tasks", a.messageId)).isDirectory());
      const saved = captures.at(-1),
        config = saved.config;
      assert.deepEqual(config.mcpServers["orca-canonical"], canonicalMemoryConfig(provider));
      assert.equal(
        config.provider,
        provider === "claude" ? "claude/claude-opus-5" : "codex/gpt-6-astra",
      );
      // Every controller-created session is born automatic, at its provider's default thinking level (per provider
      // since 8c2ff2d0), from the one selector.
      assert.equal(config.thinkingOptionId, CAPABILITIES[provider].defaultThinkingOptionId);
      assert.equal(config.modeId, provider === "claude" ? "auto" : "full-access"); // update-7 W3 defaults
      // Codex carries its sandbox and approval pins explicitly, derived from the chosen mode; Claude none.
      assert.deepEqual(
        config.options,
        provider === "codex"
          ? { approval_policy: "never", sandbox_mode: "danger-full-access" }
          : undefined,
      );
      assert.deepEqual(saved.env, { PASEO_PASSWORD: "" });
      assert.equal(saved.cwd, home + "/tasks/" + a.messageId);
      assert.equal(saved.idempotencyKey, a.messageId);
      assert.equal(saved.labels.owner, "orca-control");
      assert.equal(saved.labels.task, a.taskId);
      assert.equal(saved.labels["orca.manager-tools"], "1");
      assert.deepEqual(config.mcpServers["orca-supervisor"].env, {
        ELECTRON_RUN_AS_NODE: "1",
        ORCA_HOME: portable.home,
        ORCA_INBOX_FILE: home + "/grants/inbox/" + a.messageId + ".json",
        ORCA_MANAGER_FILE: home + "/grants/manager/" + a.messageId + ".json",
        ORCA_ROLE_FILE: home + "/grants/role/" + a.messageId + ".json",
      });
      assert.deepEqual(
        config.toolPolicy.preapproved
          .filter((t) => t.server === "orca-canonical")
          .map((t) => t.tool)
          .sort(),
        ["shared_memory_read", "shared_memory_search"],
      );
      assert.deepEqual(
        config.toolPolicy.preapproved
          .filter((t) => t.server === "orca-supervisor")
          .map((t) => t.tool)
          .sort(),
        [
          "manager_assign_worker",
          "manager_create_worker",
          "manager_inspect_worker",
          "manager_workers",
          ...[...ROLE_TOOLS].sort(),
          "supervisor_acknowledge",
          "supervisor_inbox",
        ].sort(),
      );
    }
  } finally {
    await native.close();
  }
});

test("unknown providers refuse before any directory or native creation", async () => {
  const native = await connect();
  const before = captures.length;
  try {
    for (const provider of [
      undefined,
      null,
      "",
      "Claude",
      "codex/other",
      ...Array.from({ length: 32 }, (_, i) => `unknown-${i}`),
    ]) {
      await assert.rejects(
        native.create({ provider, messageId: "must-not-exist" }),
        /Known memory provider required/,
      );
    }
    assert.equal(captures.length, before);
    assert.equal(fs.existsSync(path.join(home, "tasks", "must-not-exist")), false);
  } finally {
    await native.close();
  }
});

test("snapshot refresh failure keeps a successful creation delivered without bootstrap identity", async () => {
  const native = await connect(),
    store = new ControlStore(path.join(home, "refresh-failure.sqlite"));
  const control = new Controller({ store, native, authority: async () => ({}) });
  failRefresh = true;
  try {
    const result = await control.create({
      messageId: randomUUID(),
      taskId: randomUUID(),
      provider: "claude",
      title: "Refresh failure proof",
    });
    assert.equal(result.state, "delivered");
    assert.equal(result.result.id, "fixture-session");
    assert.equal(Object.hasOwn(result.result, "runtimeInstanceId"), false);
    assert.equal(
      fs.readFileSync(path.join(result.result.cwd, "SESSION-ID"), "utf8"),
      "fixture-session\n",
      "H7 identity file survives a failed bootstrap observation",
    );
  } finally {
    failRefresh = false;
    store.close();
    await native.close();
  }
});
