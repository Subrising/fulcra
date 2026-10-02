// R-F-A1 (prime S-2): the controller-home deny reaches every Claude launch and refresh boundary.
// Real compiled Claude provider and AgentManager, copied into a private folder and patched by the staging route
// (patchNativeHooks); the overlay route (permission-overlay.py) is proven to write the same launch module bytes.
// The SDK is replaced by a query factory that records the options each launch would hand it; no Claude process
// starts. Uses the pinned pre-trusted-hook fixture prepared under heavy-lock; see docs/historical-overlay-tests.md.
// ORCA_MCP_TEST_NATIVE may point to current product dist for other suites, but is never the patch target here.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { controllerDenyRules } from "./admission-guard.mjs";
import { CLAUDE_QUERY_MODULE, patchNativeHooks } from "./native-release-hooks.mjs";

import {
  historicalRepairFixture,
  historicalCommit,
} from "../../tools/test-support.historical-repair.mjs";
const source = historicalRepairFixture();
test("historical fixture is pinned independently of current ORCA_MCP_TEST_NATIVE", (t) => {
  const previous = process.env.ORCA_MCP_TEST_NATIVE;
  try {
    process.env.ORCA_MCP_TEST_NATIVE = "/not-a-historical-target";
    assert.equal(historicalRepairFixture(), source);
  } finally {
    if (previous === undefined) delete process.env.ORCA_MCP_TEST_NATIVE;
    else process.env.ORCA_MCP_TEST_NATIVE = previous;
  }
  t.diagnostic(
    "Pre-trusted-hook repair scope: " +
      historicalCommit +
      "; no current-product repair or provider launch is exercised.",
  );
});
const guardFile = fileURLToPath(new URL("./admission-guard.mjs", import.meta.url));
const names = [
  "agent/agent-manager.js",
  "agent/agent-prompt.js",
  "session.js",
  "agent/lifecycle-command.js",
  CLAUDE_QUERY_MODULE,
];
const sources = Object.fromEntries(
  names.map((name) => [name, fs.readFileSync(path.join(source, name), "utf8")]),
);
const patched = patchNativeHooks(sources, guardFile);

// A private copy of the compiled package, so patching never touches the dist it came from.
const pkg = path.resolve(source, "../../.."),
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-claude-deny-")));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
fs.cpSync(path.join(pkg, "dist"), path.join(root, "pkg/dist"), { recursive: true });
fs.copyFileSync(path.join(pkg, "package.json"), path.join(root, "pkg/package.json"));
if (fs.existsSync(path.join(pkg, "node_modules")))
  fs.symlinkSync(path.join(pkg, "node_modules"), path.join(root, "pkg/node_modules"));
fs.symlinkSync(path.resolve(pkg, "../../node_modules"), path.join(root, "node_modules"));
const server = path.join(root, "pkg/dist/server/server");
for (const [name, text] of Object.entries(patched)) fs.writeFileSync(path.join(server, name), text);
const load = (name) => import(pathToFileURL(path.join(server, name)).href);
const { ClaudeAgentClient } = await load("agent/providers/claude/agent.js");
const { AgentManager } = await load("agent/agent-manager.js");

const logger = {
  child: () => logger,
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
};
function fakeQuery() {
  return {
    async next() {
      return { done: true, value: undefined };
    },
    async return() {
      return { done: true, value: undefined };
    },
    [Symbol.asyncIterator]() {
      return this;
    },
    close() {},
    async interrupt() {},
    async applyFlagSettings() {},
    async setPermissionMode() {},
    async setModel() {},
    async supportedCommands() {
      return [];
    },
  };
}
function claude(t) {
  const launches = [],
    cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-claude-work-")));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const client = new ClaudeAgentClient({
    logger,
    resolveBinary: async () => "/private/claude-never-started",
    resolveVersion: async () => null,
    queryFactory: ({ options }) => {
      launches.push(options);
      return fakeQuery();
    },
  });
  return { client, launches, cwd };
}
function assertDenied(options, label) {
  assert(options, label + ": no Claude launch was recorded");
  for (const rule of controllerDenyRules()) {
    assert(options.disallowedTools?.includes(rule), `${label}: disallowedTools lacks ${rule}`);
    assert(
      options.settings?.permissions?.deny?.includes(rule),
      `${label}: settings.permissions.deny lacks ${rule}`,
    );
  }
}
const assertStoredClean = (config, label) =>
  assert(
    !JSON.stringify(config).includes("operator.secret"),
    label + ": stored config carries the deny",
  );
// The parts of AgentManager the two refresh paths reach, around the real method under test.
function managerFixture(client, existing) {
  const registered = [];
  const manager = Object.assign(Object.create(AgentManager.prototype), {
    agents: new Map([[existing.id, existing]]),
    paseoToolPolicies: new Map(),
    logger,
    assertAcceptingAgentRegistrations() {},
    requireClient: () => client,
    requireSessionAgent: () => existing,
    hasInFlightRun: () => false,
    applyDaemonAppendSystemPrompt: (config) => config,
    resolveProviderLaunchConfig: (config) => config,
    buildLaunchContext: async () => ({}),
    closeReloadedSession: async () => {},
    drainSessionEvents: async () => {},
    cancelRunningProviderSubagents() {},
    prepareAgentForClosure: async (agent) => agent,
    persistSnapshot: async () => {},
    requireExternalMcpSupport: async () => {},
    registerSession: async (session, storedConfig) => {
      registered.push({ session, storedConfig });
      return { id: existing.id };
    },
  });
  return { manager, registered };
}
function existingClaude(cwd, client) {
  const id = randomUUID(),
    sessionId = randomUUID(),
    config = { provider: "claude", cwd, modeId: "default" };
  return {
    id,
    provider: "claude",
    cwd,
    config,
    labels: {},
    persistence: {
      provider: "claude",
      sessionId,
      nativeHandle: sessionId,
      metadata: { ...config },
    },
    session: { capabilities: client.capabilities },
  };
}

test("boundary: fresh launch of a new Claude session carries the deny", async (t) => {
  const { client, launches, cwd } = claude(t),
    config = { provider: "claude", cwd };
  const session = await client.createSession(config, { agentId: randomUUID() });
  await session.ensureQuery();
  assertDenied(launches.at(-1), "fresh launch");
  assertStoredClean(config, "fresh launch");
});

test("boundary: resume or import of a persisted Claude session carries the deny", async (t) => {
  const { client, launches, cwd } = claude(t),
    sessionId = randomUUID();
  const session = await client.resumeSession(
    { provider: "claude", sessionId, nativeHandle: sessionId, metadata: { cwd } },
    undefined,
    { agentId: randomUUID() },
  );
  await session.ensureQuery();
  assert.equal(launches.at(-1).resume, sessionId);
  assertDenied(launches.at(-1), "resume");
});

test("boundary: a mode, model or thinking change that rebuilds the query carries the deny", async (t) => {
  const { client, launches, cwd } = claude(t);
  const session = await client.createSession(
    { provider: "claude", cwd },
    { agentId: randomUUID() },
  );
  await session.ensureQuery();
  await session.ensureFreshQuery();
  assert.equal(launches.length, 2);
  assertDenied(launches[1], "query rebuild");
});

test("boundary: the quiet MCP refresh carries the deny and leaves the stored config clean", async (t) => {
  const { client, launches, cwd } = claude(t),
    existing = existingClaude(cwd, client);
  const storedConfig = {
    ...existing.config,
    mcpServers: { memory: { type: "stdio", command: "memory-v2" } },
  };
  // H7 (cc/h7-host-recovery) inserted an options argument ({recovering}) before the close fence; an older host takes
  // three. On the H7 host the recovery reconnect (recovering: true) must carry the deny exactly as a quiet refresh does.
  // A live agent always carries its attention state (the H7 host reads it to drop a recovered error attention).
  const reload = AgentManager.prototype.reloadQuietMcpSession,
    h7 = reload.length >= 4;
  existing.attention ??= { requiresAttention: false };
  for (const recovering of h7 ? [false, true] : [false]) {
    const { manager, registered } = managerFixture(client, existing),
      label = recovering ? "recovery reconnect" : "quiet MCP refresh";
    await reload.call(
      manager,
      existing,
      storedConfig,
      ...(h7 ? [{ recovering }] : []),
      async () => () => {},
    );
    assert.equal(registered.length, 1);
    await registered[0].session.ensureQuery();
    assert.equal(launches.at(-1).resume, existing.persistence.sessionId);
    assert(launches.at(-1).mcpServers.memory);
    assertDenied(launches.at(-1), label);
    assertStoredClean(registered[0].storedConfig, label);
  }
});

test("boundary: reload goes through the choke point even when the manager config step is bypassed", async (t) => {
  const { client, launches, cwd } = claude(t),
    existing = existingClaude(cwd, client);
  const { manager, registered } = managerFixture(client, existing);
  // The old per-call-site hook lived in prepareSessionConfig; stand it in with a pass-through to prove it is not needed.
  manager.prepareSessionConfig = async (config) => ({
    storedConfig: config,
    launchConfig: config,
    paseoToolPolicy: undefined,
  });
  await AgentManager.prototype.reloadAgentSessionInternal.call(manager, existing.id, {
    modeId: "plan",
  });
  await registered[0].session.ensureQuery();
  assertDenied(launches.at(-1), "reload");
  assertStoredClean(registered[0].storedConfig, "reload");
});

test("boundary: the Claude model probe carries the deny", async (t) => {
  const launches = [];
  const client = new ClaudeAgentClient({
    logger,
    resolveBinary: async () => "/private/claude-never-started",
    resolveVersion: async () => null,
    queryFactory: ({ options }) => {
      launches.push(options);
      throw Error("Instrumented probe stops at launch");
    },
  });
  assert.equal(await client.discoverRuntimeModels(), null);
  assertDenied(launches.at(-1), "model probe");
  assert.equal(launches.at(-1).settings.disableAllHooks, true);
});

test("boundary: the staging route patches the launch module once, and refuses drift or a second patch", () => {
  const query = patched[CLAUDE_QUERY_MODULE];
  assert.equal(query.split("orcaDenyClaudeQueryOptions(input.options)").length, 2);
  assert(
    query.startsWith(
      `import { denyClaudeQueryOptions as orcaDenyClaudeQueryOptions } from ${JSON.stringify(guardFile)};\n`,
    ),
  );
  assert.throws(
    () =>
      patchNativeHooks(
        {
          ...sources,
          [CLAUDE_QUERY_MODULE]: sources[CLAUDE_QUERY_MODULE].replace(
            "input.options, context",
            "options, context",
          ),
        },
        guardFile,
      ),
    /anchor changed/,
  );
  assert.throws(
    () => patchNativeHooks({ ...sources, [CLAUDE_QUERY_MODULE]: query }, guardFile),
    /already patched/,
  );
});

test("boundary: the overlay route writes the same launch module bytes as the staging route", () => {
  const script =
    'import importlib.util,sys\nspec=importlib.util.spec_from_file_location("overlay",sys.argv[1]);p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)\n' +
    'sys.stdout.write(p.patch_deny_module(open(sys.argv[2],"rb").read(),sys.argv[3]).decode())';
  const overlay = execFileSync(
    "python3",
    [
      "-c",
      script,
      fileURLToPath(new URL("./permission-overlay.py", import.meta.url)),
      path.join(source, CLAUDE_QUERY_MODULE),
      guardFile,
    ],
    { encoding: "utf8" },
  );
  assert.equal(overlay, patched[CLAUDE_QUERY_MODULE]);
});
