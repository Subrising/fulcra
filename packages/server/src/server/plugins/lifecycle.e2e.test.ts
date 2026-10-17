import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, onTestFinished, test } from "vitest";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { resolveDaemonVersion } from "../daemon-version.js";

test("a plugin transforms workspace creation once across receipt replays and observes its committed lifecycle", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-lifecycle-"));
  const daemon = await createTestPaseoDaemon({ daemonVersion: "0.8.0" });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.8.0" });
  try {
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: "lifecycle", requirements: { paseo: ">=0.8.0" } }),
    );
    await writeFile(
      path.join(directory, "index.server.ts"),
      `
export default function contribute(server) {
  server.before("workspace.create", ({ request }) => {
    console.log(JSON.stringify({ hook: "workspace.before" }));
    return { ...request, title: "Created through a hook" };
  });
  server.on("workspace.created", (event) => {
    console.log(JSON.stringify({ hook: "workspace.created", event }));
  });
  server.on("workspace.archived", (event) => {
    console.log(JSON.stringify({ hook: "workspace.archived", event }));
  });
  return () => {};
}
`,
    );
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    const created = await client.createWorkspace({
      idempotencyKey: "plugin-workspace",
      source: { kind: "directory", path: directory },
    });
    expect(created.workspace?.name).toBe("Created through a hook");
    const workspaceId = created.workspace!.id;
    const replay = await client.createWorkspace({
      idempotencyKey: "plugin-workspace",
      source: { kind: "directory", path: directory },
    });
    expect(replay.error).toBeNull();
    expect(replay.workspace?.id).toBe(workspaceId);
    await client.archiveWorkspace(workspaceId);
    await expect
      .poll(async () => {
        const logs = await client.getPluginLogs("lifecycle");
        return logs
          .filter((entry) => {
            return entry.message.startsWith('{"hook":');
          })
          .map((entry) => {
            return JSON.parse(entry.message);
          });
      })
      .toMatchObject([
        { hook: "workspace.before" },
        { hook: "workspace.created", event: { workspace: { id: workspaceId, cwd: directory } } },
        { hook: "workspace.archived", event: { workspace: { id: workspaceId } } },
      ]);
  } finally {
    await client.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("plugins observe turns, answer permissions, and observe archive without blocking the agent", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-turn-hooks-"));
  const daemon = await createTestPaseoDaemon({ daemonVersion: "0.8.0" });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.8.0" });
  try {
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: "turn-hooks", requirements: { paseo: ">=0.8.0" } }),
    );
    await writeFile(
      path.join(directory, "index.server.ts"),
      `
export default function contribute(server) {
  server.on("agent.turn_started", (event) => {
    console.log(JSON.stringify({ hook: "agent.turn_started", event }));
  });
  server.on("agent.turn_ended", (event) => {
    console.log(JSON.stringify({ hook: "agent.turn_ended", event }));
  });
  server.on("agent.permission_requested", async (event, context) => {
    console.log(JSON.stringify({ hook: "agent.permission_requested", event }));
    await context.paseo.agents.ref(event.agent.id).respondToPermission({
      requestId: event.request.id,
      response: { behavior: "deny", message: "Declined by plugin" },
    });
  });
  server.on("agent.permission_resolved", (event) => {
    console.log(JSON.stringify({ hook: "agent.permission_resolved", event }));
  });
  server.on("agent.archived", (event) => {
    console.log(JSON.stringify({ hook: "agent.archived", event }));
  });
  return () => {};
}
`,
    );
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    const agent = await client.createAgent({
      provider: "claude",
      cwd: directory,
      title: "Turn hooks",
      modeId: "default",
    });
    await client.sendMessage(agent.id, "Run rm -f permission.txt");
    await expect
      .poll(
        async () => {
          const logs = await client.getPluginLogs("turn-hooks");
          return logs
            .filter((entry) => {
              return entry.message.startsWith('{"hook":');
            })
            .map((entry) => {
              return JSON.parse(entry.message);
            })
            .sort((left, right) => {
              return left.hook.localeCompare(right.hook);
            });
        },
        { timeout: 10_000 },
      )
      .toMatchObject([
        {
          hook: "agent.permission_requested",
          event: { request: { input: { command: "rm -f permission.txt" } } },
        },
        { hook: "agent.permission_resolved", event: { resolution: { behavior: "deny" } } },
        {
          hook: "agent.turn_ended",
          event: { outcome: { kind: "completed" }, timeline: expect.any(Array) },
        },
        { hook: "agent.turn_started", event: { agent: { id: agent.id } } },
      ]);
    await client.archiveAgent(agent.id);
    await expect
      .poll(async () => {
        const logs = await client.getPluginLogs("turn-hooks");
        return logs.filter((entry) => {
          return entry.message.startsWith('{"hook":"agent.archived"');
        }).length;
      })
      .toBe(1);
  } finally {
    await client.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("agent creation hooks change the provider and environment before the session opens", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-agent-hooks-"));
  const daemon = await createTestPaseoDaemon({ daemonVersion: "0.8.0" });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.8.0" });
  try {
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: "agent-hooks", requirements: { paseo: ">=0.8.0" } }),
    );
    await writeFile(
      path.join(directory, "index.server.ts"),
      `
export default function contribute(server) {
  server.before("agent.create", ({ request }) => {
    return { ...request, config: { ...request.config, provider: "codex" }, env: { ...request.env, HOOK_CREATE: "created" } };
  });
  server.before("agent.session_open", ({ request }) => {
    console.log(JSON.stringify({ hook: "agent.session_open", request }));
    return { ...request, env: { ...request.env, HOOK_OPEN: "opened" } };
  });
  server.on("agent.created", (event) => {
    console.log(JSON.stringify({ hook: "agent.created", event }));
  });
  return () => {};
}
`,
    );
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    const agent = await client.createAgent({
      provider: "claude",
      cwd: directory,
      title: "Hook test",
    });
    expect(agent.provider).toBe("codex");
    await expect
      .poll(async () => {
        const logs = await client.getPluginLogs("agent-hooks");
        return logs
          .filter((entry) => {
            return entry.message.startsWith('{"hook":');
          })
          .map((entry) => {
            return JSON.parse(entry.message);
          });
      })
      .toMatchObject([
        {
          hook: "agent.session_open",
          request: { agentId: agent.id, env: { HOOK_CREATE: "created" } },
        },
        { hook: "agent.created", event: { agent: { id: agent.id, provider: "codex" } } },
      ]);
    await client.archiveAgent(agent.id);
  } finally {
    await client.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("invalid output from an untyped plugin rejects creation before later callbacks run", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-invalid-hook-"));
  const daemon = await createTestPaseoDaemon({ daemonVersion: "0.8.0" });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.8.0" });
  try {
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: "invalid-hook", requirements: { paseo: ">=0.8.0" } }),
    );
    await writeFile(
      path.join(directory, "index.server.ts"),
      `
export default function contribute(server) {
  server.before("workspace.create", () => {
    return { source: { kind: "worktree", branchName: 42 } };
  });
  server.before("workspace.create", ({ request }) => {
    console.log("Unexpected later callback");
    return request;
  });
  return () => {};
}
`,
    );
    await client.connect();
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    const result = await client.createWorkspace({ source: { kind: "directory", path: directory } });
    expect(result.workspace).toBeNull();
    expect(result.error).toContain("Plugin invalid-hook before workspace.create failed");
    const logs = await client.getPluginLogs("invalid-hook");
    expect(
      logs.some((entry) => {
        return entry.message.includes("Unexpected later callback");
      }),
    ).toBe(false);
  } finally {
    await client.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

const PROVIDER_ID = "shutdown-provider";

async function createProviderPlugin(
  root: string,
  options: { acknowledgeClose: boolean } = { acknowledgeClose: true },
): Promise<string> {
  const directory = path.join(root, "plugin");
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({
      id: "shutdown-provider-plugin",
      requirements: { paseo: `>=${resolveDaemonVersion(import.meta.url)}` },
    }),
  );
  await writeFile(
    path.join(directory, "index.server.ts"),
    `import type {
  ProviderEvent,
  ProviderInput,
  ProviderRegistration,
} from "@getpaseo/plugin/server/provider";

const CAPABILITIES = ["prompt.message", "session.persistence"];

const provider: ProviderRegistration = {
  id: ${JSON.stringify(PROVIDER_ID)},
  label: "Shutdown provider",
  async connect() {
    let listener: ((event: ProviderEvent) => void) | null = null;
    const emit = (event: ProviderEvent) => listener?.(event);
    let turn = 0;
    return {
      version: 1,
      capabilities: CAPABILITIES,
      async send(input: ProviderInput) {
        if (input.type === "catalog") {
          emit({
            type: "catalog",
            requestId: input.requestId,
            catalog: {
              models: [{ id: "shutdown-model", label: "Shutdown model" }],
              modes: [],
              thinkingOptions: [],
              defaultModel: "shutdown-model",
            },
          });
          return;
        }
        if (input.type === "session.open") {
          emit({
            type: "session.opened",
            requestId: input.requestId,
            sessionId: input.sessionId,
            capabilities: CAPABILITIES,
            restoration: "core",
            persistence: { version: 1, data: { token: "root" } },
            cwd: input.config.cwd,
          });
          emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
          return;
        }
        if (input.type === "session.prompt") {
          turn += 1;
          const turnId = "turn-" + turn;
          emit({
            type: "session.prompt_result",
            sessionId: input.sessionId,
            clientMessageId: input.prompt.clientMessageId,
            result: { type: "turn", turnId },
          });
          emit({ type: "session.turn", sessionId: input.sessionId, turnId, state: "started" });
          emit({
            type: "timeline.item",
            sessionId: input.sessionId,
            item: { type: "assistant_message", id: "answer-" + turn, text: "Done" },
          });
          emit({ type: "session.turn", sessionId: input.sessionId, turnId, state: "completed" });
          return;
        }
        if (input.type === "session.close") {
          if (!${JSON.stringify(options.acknowledgeClose)}) return;
          emit({ type: "session.closed", sessionId: input.sessionId });
        }
        if ("requestId" in input) {
          emit({ type: "request.completed", requestId: input.requestId });
        }
      },
      onEvent(next: (event: ProviderEvent) => void) {
        listener = next;
        return () => {
          if (listener === next) listener = null;
        };
      },
      async close() {},
    };
  },
};

export default function contribute(server: { registerProvider(p: ProviderRegistration): void }) {
  server.registerProvider(provider);
  return () => undefined;
}`,
  );
  return directory;
}

test("a clean daemon shutdown leaves a completed plugin-provider agent without an error", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "plugin-provider-shutdown-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const pluginDirectory = await createProviderPlugin(root);
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });

  const daemon = await createTestPaseoDaemon({
    paseoHomeRoot: path.join(root, "daemon"),
    staticDir: path.join(root, "static"),
    cleanup: false,
    pluginsEnabled: true,
    plugins: {
      "shutdown-provider-plugin": { source: "directory", path: pluginDirectory, enabled: true },
    },
  });

  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.9.1" });
  await client.connect();
  await client.fetchAgents({ subscribe: {} });

  const agent = await client.createAgent({
    provider: PROVIDER_ID,
    model: "shutdown-model",
    cwd: workspace,
    title: "Shutdown provider agent",
  });
  await client.sendMessage(agent.id, "hello");
  const finished = await client.waitForFinish(agent.id, 30_000);
  expect(finished.status).toBe("idle");

  const beforeShutdown = await daemon.daemon.agentStorage.get(agent.id);
  expect(beforeShutdown?.lastError ?? null).toBeNull();

  await client.close();
  await daemon.daemon.stop();
  await daemon.daemon.agentStorage.flush().catch(() => undefined);

  const persisted = await daemon.daemon.agentStorage.get(agent.id);
  expect(persisted).not.toBeNull();
  expect(persisted?.lastError ?? null).toBeNull();
  expect(persisted?.attentionReason ?? null).not.toBe("error");
}, 60_000);

test("reloading a plugin leaves a completed plugin-provider agent without an error", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "plugin-provider-reload-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const pluginDirectory = await createProviderPlugin(root);
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });

  const daemon = await createTestPaseoDaemon({
    paseoHomeRoot: path.join(root, "daemon"),
    staticDir: path.join(root, "static"),
    pluginsEnabled: true,
    plugins: {
      "shutdown-provider-plugin": { source: "directory", path: pluginDirectory, enabled: true },
    },
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.9.1" });
  onTestFinished(async () => {
    await client.close();
    await daemon.close();
  });
  await client.connect();
  await client.fetchAgents({ subscribe: {} });

  const agent = await client.createAgent({
    provider: PROVIDER_ID,
    model: "shutdown-model",
    cwd: workspace,
    title: "Reload provider agent",
  });
  await client.sendMessage(agent.id, "hello");
  expect((await client.waitForFinish(agent.id, 30_000)).status).toBe("idle");

  const reloaded = await client.reloadPlugin("shutdown-provider-plugin");
  expect(reloaded.status).toBe("running");

  const afterReload = await daemon.daemon.agentStorage.get(agent.id);
  expect(afterReload?.lastError ?? null).toBeNull();
  expect(afterReload?.attentionReason ?? null).not.toBe("error");
  const timeline = await client.fetchAgentTimeline(agent.id, {
    direction: "tail",
    limit: 0,
    projection: "canonical",
  });
  expect(JSON.stringify(timeline.entries)).not.toContain("Provider connection closed");

  await client.sendMessage(agent.id, "after reload");
  expect((await client.waitForFinish(agent.id, 30_000)).status).toBe("idle");
}, 60_000);

test("a provider that never acknowledges session.close does not hold the daemon open", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "plugin-provider-stuck-close-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const pluginDirectory = await createProviderPlugin(root, { acknowledgeClose: false });
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });

  const daemon = await createTestPaseoDaemon({
    paseoHomeRoot: path.join(root, "daemon"),
    staticDir: path.join(root, "static"),
    cleanup: false,
    pluginsEnabled: true,
    plugins: {
      "shutdown-provider-plugin": { source: "directory", path: pluginDirectory, enabled: true },
    },
  });

  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.9.1" });
  await client.connect();
  await client.fetchAgents({ subscribe: {} });

  const agent = await client.createAgent({
    provider: PROVIDER_ID,
    model: "shutdown-model",
    cwd: workspace,
    title: "Stuck close agent",
  });
  await client.sendMessage(agent.id, "hello");
  await client.waitForFinish(agent.id, 30_000);
  await client.close();

  // Without a deadline on each agent close, stop() never returns here and the
  // test fails by timing out.
  await expect(daemon.daemon.stop()).resolves.toBeUndefined();
}, 90_000);

const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));

// Hold the provider close until the subprocess has entered shutdown cleanup.
async function createSlowClosingProviderPlugin() {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-slow-close-plugin-"));
  const closeStarted = path.join(directory, "close-started");
  const closeRelease = path.join(directory, "close-release");
  const cleanupStarted = path.join(directory, "cleanup-started");
  await cp(path.join(repoRoot, "plugin-examples/provider-direct"), directory, { recursive: true });
  const providerPath = path.join(directory, "server", "provider.ts");
  const source = (await readFile(providerPath, "utf8")).replaceAll("\r\n", "\n");
  const patched = `import { readFile, writeFile } from "node:fs/promises";\n${source.replace(
    "      closed = true;\n      sessions.clear();",
    `      closed = true;
      await writeFile(${JSON.stringify(closeStarted)}, "started");
      while (true) {
        try { await readFile(${JSON.stringify(closeRelease)}); break; }
        catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
      }
      sessions.clear();
      console.log("provider close completed");`,
  )}`;
  expect(patched).toContain(`await writeFile(${JSON.stringify(closeStarted)}, "started")`);
  await writeFile(providerPath, patched);
  const entryPath = path.join(directory, "index.server.ts");
  const entry = (await readFile(entryPath, "utf8")).replaceAll("\r\n", "\n");
  const withCleanup = `import { writeFile } from "node:fs/promises";\n${entry.replace(
    "  return () => {};",
    `  return async () => { await writeFile(${JSON.stringify(cleanupStarted)}, "started"); console.log("plugin cleanup completed"); };`,
  )}`;
  expect(withCleanup).toContain(`await writeFile(${JSON.stringify(cleanupStarted)}, "started")`);
  await writeFile(entryPath, withCleanup);
  return { directory, closeStarted, closeRelease, cleanupStarted };
}

test("reloading a plugin does not send on a closed IPC channel", async () => {
  const {
    directory: pluginDirectory,
    closeStarted,
    closeRelease,
    cleanupStarted,
  } = await createSlowClosingProviderPlugin();
  const cwd = await mkdtemp(path.join(tmpdir(), "paseo-reload-teardown-"));
  const daemon = await createTestPaseoDaemon();
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await client.connect();
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(pluginDirectory);
    const agent = await client.createAgent({ provider: "direct-example", cwd });
    const turn = client.sendMessage(agent.id, "Say hello").catch(() => undefined);
    const reload = client.reloadPlugin("provider-direct-example");
    await expect
      .poll(() => readFile(closeStarted, "utf8").catch(() => null), { timeout: 20_000 })
      .toBe("started");
    await expect
      .poll(() => readFile(cleanupStarted, "utf8").catch(() => null), { timeout: 20_000 })
      .toBe("started");
    await writeFile(closeRelease, "release");
    const reloaded = await reload;
    expect(reloaded.status).toBe("running");
    const entries = await client.getPluginLogs("provider-direct-example");
    const messages = entries.map((entry) => entry.message).join("\n");
    expect(messages).not.toContain("ERR_IPC_CHANNEL_CLOSED");
    expect(entries.filter((entry) => entry.message === "plugin cleanup completed")).toHaveLength(1);
    expect(entries.filter((entry) => entry.message === "provider close completed")).toHaveLength(1);
    await turn;
    await client.archiveAgent(agent.id).catch(() => undefined);
  } finally {
    await writeFile(closeRelease, "release");
    await client.close();
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
    await rm(pluginDirectory, { recursive: true, force: true });
  }
}, 60_000);

test("scratch daemon keeps recorded session costs and never refuses API turns for spend", async () => {
  const { createTestAgentClient } = await import("../test-utils/fake-agent-client.js");
  const { randomUUID } = await import("node:crypto");
  const root = await mkdtemp(path.join(tmpdir(), "session-cost-daemon-"));
  const plugin = path.join(root, "budget-plugin");
  const account = randomUUID();
  let started = 0;
  const costs = [9.65, 0];
  const provider = createTestAgentClient("claude", {
    onStartTurn: () => {
      started++;
    },
  });
  function instrument(session: Awaited<ReturnType<typeof provider.createSession>>) {
    const subscribe = session.subscribe.bind(session);
    // API launches have no OAuth usage credential. Their immutable binding owns account identity.
    session.usageCredential = () => null;
    session.limitResumeAccountBinding = () => `pool:${account}`;
    session.subscribe = (callback) =>
      subscribe((event) => {
        if (event.type === "turn_completed") {
          const cost = costs.shift() ?? 0;
          callback({
            ...event,
            usage: {
              totalCostUsd: cost,
              turnCostUsd: cost,
              recorded: {
                provider: "claude",
                source: "claude-sdk-result",
                observedAt: "2026-10-17T00:00:00.000Z",
                runtimeSessionId: "native-fixture",
                estimate: {
                  scope: "provider-query",
                  kind: "provider-api-estimate",
                  amountUsd: cost,
                },
              },
            },
          });
        } else callback(event);
      });
    return session;
  }
  const create = provider.createSession.bind(provider),
    resume = provider.resumeSession.bind(provider);
  provider.createSession = async (...args) => instrument(await create(...args));
  provider.resumeSession = async (...args) => instrument(await resume(...args));
  let daemon = await createTestPaseoDaemon({
    paseoHomeRoot: root,
    cleanup: false,
    agentClients: { claude: provider },
  });
  let client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: resolveDaemonVersion(),
  });
  try {
    await mkdir(plugin);
    await cp(path.resolve("../../control/orca-organization/server"), path.join(plugin, "server"), {
      recursive: true,
    });
    await writeFile(
      path.join(plugin, "paseo-plugin.json"),
      JSON.stringify({ id: "cost-guard-fixture", requirements: { paseo: ">=0.8.0" } }),
    );
    await writeFile(
      path.join(plugin, "index.server.ts"),
      `
import { readSessionBilling, recordAccountCost } from "./server/account-billing.mjs";
export default function(server) {
 server.before("agent.cost_commit", async ({ request }) => {
   if (request.accountId) await recordAccountCost(${JSON.stringify(path.join(root, "pool"))}, { id: "turn:" + request.agentId + ":" + request.turnId, accountId: request.accountId, sessionId: request.agentId, costUsd: request.costUsd, at: request.at, cursorCheckpoint: request.cursors, costRevision: request.revision });
   return { ...request, costCommitted: true };
 });
 server.before("agent.cost_read", ({ request }) => readSessionBilling(${JSON.stringify(path.join(root, "pool"))}, request));
 return () => {};
}
`,
    );
    const { addAccount, setAccount } =
      await import("../../../../../control/orca-organization/server/accounts.mjs");
    const pool = path.join(root, "pool");
    const a = await addAccount(pool, { provider: "claude", name: "Fixture API" });
    // The fixture account ID is the launch identity returned by this provider.
    const { update } = await import("../../../../../control/orca-organization/server/accounts.mjs");
    await update(pool, (s) => {
      s.accounts[0].id = account;
    });
    await setAccount(pool, account, {
      credentialKind: "api-key",
    });
    expect(a.provider).toBe("claude");
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(plugin);
    const agent = await client.createAgent({
      provider: "claude",
      cwd: root,
      modeId: "bypassPermissions",
    });
    await client.sendMessage(agent.id, "First fixture turn");
    await client.waitForAgentUpsert(agent.id, (s) => s.status === "idle");
    await client.sendMessage(agent.id, "Zero cost fixture turn");
    const snapshot = await client.waitForAgentUpsert(agent.id, (s) => s.status === "idle");
    expect(snapshot.sessionCost).toMatchObject({ totalUsd: 9.65, lastTurnUsd: 0 });
    expect(snapshot.sessionCost?.accounts).toEqual([{ accountId: account, totalUsd: 9.65 }]);
    await client.close();
    await daemon.close();
    daemon = await createTestPaseoDaemon({
      paseoHomeRoot: root,
      cleanup: false,
      agentClients: { claude: provider },
      pluginsEnabled: true,
      plugins: { "cost-guard-fixture": { source: "directory", path: plugin, enabled: true } },
    });
    client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: resolveDaemonVersion(),
    });
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    const restored = await client.fetchAgent(agent.id);
    expect(restored?.agent?.sessionCost).toMatchObject({ totalUsd: 9.65, lastTurnUsd: 0 });
    const { recordAccountCost } =
      await import("../../../../../control/orca-organization/server/account-billing.mjs");
    const legacy = await client.createAgent({
      provider: "claude",
      cwd: root,
      modeId: "bypassPermissions",
    });
    await recordAccountCost(pool, {
      id: `turn:${legacy.id}:legacy-one`,
      accountId: account,
      costUsd: 4,
      at: "2026-10-17T01:00:00Z",
    });
    await recordAccountCost(pool, {
      id: `turn:${legacy.id}:legacy-two`,
      accountId: account,
      costUsd: 5.65,
      at: "2026-10-17T02:00:00Z",
    });
    const observed = await client.listProviderUsage({ agentId: legacy.id, observationOnly: true });
    expect(observed.sessionCost).toMatchObject({ totalUsd: 9.65, lastTurnUsd: 5.65 });
    const imported = await client.fetchAgent(legacy.id);
    expect(imported?.agent.sessionCost).toMatchObject({ totalUsd: 9.65, lastTurnUsd: 5.65 });
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const inspected = await promisify(execFile)(
      process.execPath,
      [
        path.resolve("../cli/dist/index.js"),
        "--host",
        `127.0.0.1:${daemon.port}`,
        "inspect",
        legacy.id,
        "--json",
      ],
      { env: { ...process.env, PASEO_HOME: daemon.paseoHome }, timeout: 15_000 },
    );
    expect(inspected.stdout).toContain('"SessionCost"');
    expect(inspected.stdout).toContain("9.65");
    const usage = await client.listUsageReports({ agentId: legacy.id });
    expect(usage.sessionCost).toMatchObject({ totalUsd: 9.65, lastTurnUsd: 5.65 });
    // A legacy cap label must not stop another turn.
    await client.fetchAgents({ subscribe: {} });
    await client.updateAgent(agent.id, { labels: { "fulcra.session-cost-cap-usd": "9.65" } });
    costs.push(1);
    await client.sendMessage(agent.id, "Continue with a legacy label");
    await client.waitForAgentUpsert(
      agent.id,
      (s) => s.status === "idle" && s.sessionCost?.recordedTurns === 3,
    );
    expect(started).toBe(3);
    costs.push(2);
    const internal = await daemon.daemon.agentManager.createAgent(
      { provider: "claude", cwd: root, internal: true, modeId: "bypassPermissions" },
      undefined,
      { workspaceId: undefined },
    );
    await daemon.daemon.agentManager.runAgent(internal.id, "Internal fixture helper");
    const { readBilling } =
      await import("../../../../../control/orca-organization/server/account-billing.mjs");
    const calls = Object.entries(readBilling(pool).calls).filter(([id]) =>
      id.startsWith(`turn:${internal.id}:`),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0][1].costUsd).toBe(2);
    expect(await daemon.daemon.agentStorage.get(internal.id)).toBeNull();
    await client.close();
    await daemon.close();
    daemon = await createTestPaseoDaemon({
      paseoHomeRoot: root,
      cleanup: false,
      agentClients: { claude: provider },
      pluginsEnabled: true,
      plugins: { "cost-guard-fixture": { source: "directory", path: plugin, enabled: true } },
    });
    client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: resolveDaemonVersion(),
    });
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    const other = await client.createAgent({
      provider: "claude",
      cwd: root,
      modeId: "bypassPermissions",
    });
    costs.push(10000);
    await client.sendMessage(other.id, "Spend must never refuse this turn");
    await client.waitForAgentUpsert(other.id, (state) => state.status === "idle");
    expect(started).toBe(5);
  } finally {
    await client.close();
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
