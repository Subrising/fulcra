import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink, chmod, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  LegacyTrustedPluginServer as TrustedPluginServer,
  LegacyTrustedPluginContribution as TrustedPluginContribution,
} from "@getpaseo/plugin/server";
import {
  loadTrustedPlugins,
  refuseUntrustedHook,
  untrustedHostHooks,
  TrustedPlugins,
} from "./trusted.js";
import {
  applyTrustedClaudeDeny,
  claudeQuery,
  type ClaudeQueryInput,
} from "../agent/providers/claude/query.js";

const noop = () => undefined;
const noDenyRules = () => [];
const hosts: TrustedPlugins[] = [];
const directories: string[] = [];
const quota = {
  provider: "codex",
  sessionId: "fixture",
  model: null,
  serviceTier: null,
  accountScope: null,
  observedAt: "2030-01-01T00:00:00Z",
  ordinaryUsageAllowed: null,
  limits: [],
};
const agent = { id: "agent-test", provider: "claude", cwd: "/fixture" };
function host(setup?: TrustedPluginContribution): TrustedPlugins {
  const value = new TrustedPlugins();
  hosts.push(value);
  if (setup) value.register("fixture-guard", true, setup);
  return value;
}
afterEach(async () => {
  for (const value of hosts.splice(0)) value.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

const cases = [
  {
    name: "input",
    register: (s: TrustedPluginServer, allow: boolean) =>
      s.admission.onInput(() => (allow ? "allow" : "deny")),
    invoke: (h: TrustedPlugins) => h.input(agent, "prompt", undefined, () => "ran"),
  },
  {
    name: "permission",
    register: (s: TrustedPluginServer, allow: boolean) =>
      s.guard("agent.permission_respond", () => (allow ? "allow" : "deny")),
    invoke: (h: TrustedPlugins) => h.permission(agent, "request", { behavior: "allow" }),
  },
  {
    name: "MCP refresh",
    register: (s: TrustedPluginServer, allow: boolean) =>
      s.admission.mcpRefresh(() => ({ allowed: allow, revision: "revision" })),
    invoke: (h: TrustedPlugins) => h.mcpRefresh(agent),
  },
  {
    name: "Codex turn",
    register: (s: TrustedPluginServer, allow: boolean) =>
      s.admission.codexTurn(() => (allow ? "allow" : "deny")),
    invoke: (h: TrustedPlugins) => h.codexTurn(agent, quota),
  },
];
for (const test of cases) {
  it(`${test.name}: allows, denies, refuses untrusted registration`, () => {
    expect(() => test.invoke(host((s) => test.register(s, true)))).not.toThrow();
    expect(() => test.invoke(host((s) => test.register(s, false)))).toThrow();
    const untrusted = host();
    const setup = vi.fn((s: TrustedPluginServer) => test.register(s, true));
    expect(() => untrusted.register("downloaded", false, setup)).toThrow(/trusted bundled/);
    expect(setup).not.toHaveBeenCalled();
    expect(untrusted.catalog()).toEqual([]);
  });
}

it.each(["input", "permission", "mcp", "codex", "deny"])("%s throws fail closed", (kind) => {
  const fail = () => {
    throw new Error("fixture failure");
  };
  const h = host((s) => {
    if (kind === "input") s.admission.onInput(fail);
    if (kind === "permission") s.guard("agent.permission_respond", fail);
    if (kind === "mcp") s.admission.mcpRefresh(fail);
    if (kind === "codex") s.admission.codexTurn(fail);
    if (kind === "deny") s.claude.deny(fail);
  });
  const effect = vi.fn();
  expect(() => {
    if (kind === "input") h.input(agent, "prompt", undefined, effect);
    if (kind === "permission") h.permission(agent, "request", { behavior: "allow" });
    if (kind === "mcp") h.mcpRefresh(agent);
    if (kind === "codex") h.codexTurn(agent, quota);
    if (kind === "deny") applyTrustedClaudeDeny({});
    effect();
  }).toThrow("fixture failure");
  expect(effect).not.toHaveBeenCalled();
});

it("rejects async and missing decisions", () => {
  const h = host((s) => s.admission.onInput((() => Promise.resolve("allow")) as never));
  expect(() => h.input(agent, "cancel", undefined, noop)).toThrow(/denied/);
  const empty = host((s) => s.admission.onInput((() => undefined) as never));
  expect(() => empty.input(agent, "cancel", undefined, noop)).toThrow(/denied/);
});

it("rewrites permission ids through every guard without changing the response", () => {
  const h = host((s) => s.guard("agent.permission_respond", () => ({ requestId: "canonical" })));
  h.register("second", true, (s) =>
    s.guard("agent.permission_respond", (_a, id, response) => {
      expect(id).toBe("canonical");
      expect(response).toEqual({ behavior: "deny" });
      return "allow";
    }),
  );
  expect(h.permission(agent, "alias", { behavior: "deny" })).toBe("canonical");
});

it("uses daemon provenance, consumes once, and never trusts message prefixes", () => {
  let sdk!: TrustedPluginServer;
  const seen: unknown[] = [];
  const h = host((s) => {
    sdk = s;
    s.admission.onInput((_a, input) => {
      seen.push(input);
      return "allow";
    });
  });
  h.rpc(undefined, () =>
    h.input(agent, "prompt", "orca-control:fake", () =>
      h.input(agent, "prompt", "orca-control:fake", noop),
    ),
  );
  expect(h.sequence(agent.id).humanAt).toBe(1);
  expect(seen[0]).toMatchObject({ source: "human", provenance: null });
  const token = sdk.issueProvenance({ agentId: agent.id, kind: "prompt", messageId: "genuine" });
  h.rpc(token, () => h.input(agent, "prompt", "genuine", noop));
  expect(seen[2]).toMatchObject({ source: "plugin", provenance: { pluginId: "fixture-guard" } });
  expect(h.sequence(agent.id).humanAt).toBe(1);
  expect(() => h.rpc(token, () => h.input(agent, "prompt", "genuine", noop))).toThrow(/provenance/);
  expect(() => h.rpc("orca-control:fake", () => h.input(agent, "prompt", "genuine", noop))).toThrow(
    /provenance/,
  );
  const mismatched = sdk.issueProvenance({ agentId: agent.id, kind: "prompt", messageId: "bound" });
  expect(() => h.rpc(mismatched, () => h.input(agent, "cancel", "bound", noop))).toThrow(
    /provenance/,
  );
  const other = sdk.issueProvenance({ agentId: "other", kind: "prompt" });
  expect(() => h.rpc(other, () => h.input(agent, "prompt", undefined, noop))).toThrow(/provenance/);
});

it("the ordinary plugin process context refuses every privileged method", () => {
  const s = untrustedHostHooks;
  for (const invoke of [
    () => s.admission.onInput(() => "allow"),
    () => s.admission.mcpRefresh(() => ({ allowed: true, revision: "x" })),
    () => s.admission.codexTurn(() => "allow"),
    () => s.guard("agent.permission_respond", () => "allow"),
    () => s.claude.deny(noDenyRules),
    () => s.permissions.automatic(() => "allow"),
    () => s.issueProvenance({ agentId: agent.id, kind: "prompt" }),
  ])
    expect(invoke).toThrow("Only trusted bundled plugins may register host security hooks");
});

it("expires provenance and refuses explicitly empty tokens", () => {
  let sdk!: TrustedPluginServer;
  const h = host((s) => {
    sdk = s;
  });
  const now = vi.spyOn(Date, "now").mockReturnValue(1000);
  try {
    const token = sdk.issueProvenance({ agentId: agent.id, kind: "prompt" });
    now.mockReturnValue(61_001);
    expect(() => h.rpc(token, () => h.input(agent, "prompt", undefined, noop))).toThrow(/expired/);
    expect(() => h.rpc("", () => h.input(agent, "prompt", undefined, noop))).toThrow(/provenance/);
  } finally {
    now.mockRestore();
  }
});

it("reports plugin identity and registered hooks, never bearer tokens", () => {
  const h = host((s) => {
    s.admission.onInput(() => "allow");
    s.claude.deny(noDenyRules);
  });
  expect(h.catalog()).toEqual([{ id: "fixture-guard", hooks: ["input", "deny"] }]);
  expect(refuseUntrustedHook).toThrow(/trusted bundled/);
});

it("merges additive denies into both Claude channels at the actual launch", () => {
  host((s) => s.claude.deny(() => ["Read(/protected/**)", "Bash(secret:*)"]));
  const queryFactory = vi.fn((_input: ClaudeQueryInput) => ({}) as ReturnType<typeof claudeQuery>);
  const original = {
    disallowedTools: ["Existing"],
    settings: { permissions: { deny: ["Prior"], allow: ["Safe"] } },
  };
  claudeQuery({ prompt: "probe", options: original }, { queryFactory });
  const options = queryFactory.mock.calls[0]![0].options;
  expect(options.disallowedTools).toEqual(["Existing", "Read(/protected/**)", "Bash(secret:*)"]);
  expect(options.settings).toEqual({
    permissions: { deny: ["Prior", "Read(/protected/**)", "Bash(secret:*)"], allow: ["Safe"] },
  });
  expect(original.disallowedTools).toEqual(["Existing"]);
  expect(() => host().register("downloaded", false, (s) => s.claude.deny(noDenyRules))).toThrow(
    /trusted bundled/,
  );
});

it("allows Claude launches when a trusted deny hook adds no restrictions", () => {
  host((s) => s.claude.deny(noDenyRules));
  const options = { disallowedTools: ["Existing"] };
  expect(applyTrustedClaudeDeny(options)).toBe(options);
});

it("leaves Claude settings and admission unchanged without trusted plugins", () => {
  const options = { disallowedTools: ["Existing"] };
  expect(applyTrustedClaudeDeny(options)).toBe(options);
  expect(host().input(agent, "prompt", undefined, () => 42)).toBe(42);
});

// POSIX ownership admission; the paired Win32 case below asserts host refusal.
it.runIf(process.platform !== "win32")(
  "loads distribution entries but refuses home plugins and escaped symlinks",
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "trusted-bundle-test-"));
    directories.push(directory);
    const home = path.join(directory, "home");
    const bundles = path.join(directory, "bundled-plugins");
    await mkdir(home);
    await mkdir(path.join(bundles, "fixture"), { recursive: true });
    await writeFile(
      path.join(bundles, "fixture", "paseo-plugin.json"),
      JSON.stringify({ id: "fixture" }),
    );
    await writeFile(
      path.join(bundles, "fixture", "index.host.js"),
      'module.exports = (s) => { s.admission.onInput(() => "allow"); };',
    );
    const loaded = await loadTrustedPlugins(bundles, home);
    hosts.push(loaded);
    expect(loaded.catalog()).toEqual([{ id: "fixture", hooks: ["input"] }]);
    await expect(loadTrustedPlugins(home, home)).rejects.toThrow(/outside PASEO_HOME/);
    await symlink(home, path.join(bundles, "escape"));
    await expect(loadTrustedPlugins(bundles, home)).rejects.toThrow(/directories/);
  },
);

// m1: a hook that returns a rejected Promise is refused (good) but the rejection is never
// observed, so Node reports an unhandled rejection (daemon crash under --unhandled-rejections=throw).
it("m1: a Promise-returning hook fails closed without an unhandled rejection", async () => {
  const authority = new TrustedPlugins();
  authority.register("probe", true, (server) =>
    server.admission.onInput((() => Promise.reject(new Error("async policy"))) as never),
  );
  const unhandled = vi.fn();
  process.on("unhandledRejection", unhandled);
  try {
    expect(() => authority.input({ id: "a" }, "prompt", undefined, () => undefined)).toThrow(
      "Trusted plugin denied admission",
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(unhandled).not.toHaveBeenCalled();
  } finally {
    process.off("unhandledRejection", unhandled);
    authority.close();
  }
});

// Invalid tokens are refused before attribution or counting, as documented.
it("m2: invalid tokens are refused before counting human input", () => {
  const authority = new TrustedPlugins();
  authority.register("probe", true, (server) => server.admission.onInput(() => "allow"));
  try {
    expect(() =>
      authority.rpc("forged-token", () => authority.input(agent, "prompt", undefined, noop)),
    ).toThrow();
    expect(authority.sequence(agent.id).humanAt).toBe(0);
  } finally {
    authority.close();
  }
});

// Arbitrary cancel targets and snapshot reads must not allocate per-agent host state.
it("m3: unknown agent ids do not grow host state without bound", () => {
  const authority = new TrustedPlugins();
  try {
    for (let i = 0; i < 10_000; i += 1) {
      authority.rpc(undefined, () =>
        authority.input({ id: `junk-${i}` }, "cancel", undefined, () => 0),
      );
    }
    const size = (Reflect.get(authority, "sequences") as Map<string, unknown>).size;
    expect(size).toBeLessThan(10_000);
  } finally {
    authority.close();
  }
});

it("human, agent and daemon sources have distinct sequence semantics", () => {
  const seen: string[] = [];
  const h = host((s) =>
    s.admission.onInput((_a, input) => {
      seen.push(input.source);
      return "allow";
    }),
  );
  h.input(agent, "configure", undefined, noop);
  h.agentInput(() => h.input(agent, "configure", undefined, noop));
  h.rpc(undefined, () => h.input(agent, "configure", undefined, noop));
  expect(seen).toEqual(["daemon", "agent", "human"]);
  expect(h.sequence(agent.id).humanAt).toBe(1);
});

it("permission guards receive verified provenance and human answers count", () => {
  let sdk!: TrustedPluginServer;
  const guard = vi.fn<Parameters<TrustedPluginServer["guard"]>[1]>(() => "allow");
  const h = host((s) => {
    sdk = s;
    s.guard("agent.permission_respond", guard);
  });
  const answer = () =>
    h.input(agent, "permission", "request", () =>
      h.permission(agent, "request", { behavior: "allow" }),
    );
  h.rpc(undefined, answer);
  expect(guard.mock.calls[0]?.[3]).toMatchObject({ source: "human", provenance: null });
  const token = sdk.issueProvenance({
    agentId: agent.id,
    kind: "permission",
    messageId: "request",
  });
  h.rpc(token, answer);
  expect(guard.mock.calls[1]?.[3]).toMatchObject({
    source: "plugin",
    provenance: { pluginId: "fixture-guard" },
  });
  expect(h.sequence(agent.id).humanAt).toBe(1);
});

it.each(["permission", "mcp", "codex", "deny", "setup"])(
  "observes rejected Promise from %s and fails closed",
  async (kind) => {
    const fail = (() => Promise.reject(new Error("async policy"))) as never;
    const h = host();
    if (kind === "setup") {
      expect(() => h.register("async-setup", true, fail)).toThrow(/synchronous/);
    } else {
      h.register("async-policy", true, (s) => {
        if (kind === "permission") s.guard("agent.permission_respond", fail);
        if (kind === "mcp") s.admission.mcpRefresh(fail);
        if (kind === "codex") s.admission.codexTurn(fail);
        if (kind === "deny") s.claude.deny(fail);
      });
      expect(() => {
        if (kind === "permission") h.permission(agent, "request", { behavior: "allow" });
        if (kind === "mcp") h.mcpRefresh(agent);
        if (kind === "codex") h.codexTurn(agent, quota);
        if (kind === "deny") h.claudeDenyRules();
      }).toThrow(/synchronous/);
    }
    // Vitest reports any unobserved rejection as an error even after this assertion.
    await new Promise((resolve) => setTimeout(resolve, 20));
  },
);

it.runIf(process.platform === "win32")(
  "Windows refuses even readonly trusted distribution code before setup",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trusted-windows-"));
    const bundles = path.join(root, "bundles"),
      directory = path.join(bundles, "fixture");
    const entry = path.join(directory, "index.host.js"),
      marker = path.join(root, "executed");
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "paseo-plugin.json"), JSON.stringify({ id: "fixture" }));
      await writeFile(
        entry,
        `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed"); module.exports = () => {};`,
      );
      await chmod(entry, 0o444);
      await chmod(directory, 0o555);
      await expect(loadTrustedPlugins(bundles, path.join(root, "home"))).rejects.toMatchObject({
        code: "TRUSTED_PLUGIN_HOST_UNSUPPORTED",
      });
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await chmod(directory, 0o700);
      await chmod(entry, 0o600);
      await rm(root, { recursive: true, force: true });
    }
  },
);
