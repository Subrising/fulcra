import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import pino from "pino";

import { createMemoryCredentialBackend } from "../integrations/credential-backend.js";
import { withTimeout } from "../../utils/promise-timeout.js";
import { hashDaemonPassword } from "../auth.js";
import { createPaseoDaemon, type PaseoDaemonConfig } from "../bootstrap.js";
import { createTestAgentClient, createTestAgentClients } from "../test-utils/fake-agent-client.js";
import type {
  AgentClient,
  AgentPromptInput,
  AgentPersistenceHandle,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "./agent-sdk-types.js";

interface StructuredContent {
  [key: string]: unknown;
}

interface McpToolResult {
  structuredContent?: StructuredContent;
  content?: Array<{ structuredContent?: StructuredContent } | StructuredContent>;
  isError?: boolean;
}

interface McpClient {
  callTool: (input: { name: string; args?: StructuredContent }) => Promise<McpToolResult>;
  close: () => Promise<void>;
}

async function waitForPathExists(options: {
  targetPath: string;
  timeoutMs: number;
}): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < options.timeoutMs) {
    if (existsSync(options.targetPath)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out after ${options.timeoutMs}ms waiting for path: ${options.targetPath}`);
}

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to acquire port")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

function getStructuredContent(result: McpToolResult): StructuredContent | null {
  if (result.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }
  const content = result.content?.[0];
  if (content && typeof content === "object" && "structuredContent" in content) {
    if (content.structuredContent) return content.structuredContent;
  }
  if (content && typeof content === "object") {
    return content;
  }
  return null;
}

async function createMcpClient(url: string, authToken?: string): Promise<McpClient> {
  const transport = new StreamableHTTPClientTransport(
    new URL(url),
    authToken ? { requestInit: { headers: { Authorization: `Bearer ${authToken}` } } } : undefined,
  );
  const rawClient = new Client({ name: "paseo-test", version: "1" });
  await rawClient.connect(transport);
  return {
    callTool: ({ name, args }) => rawClient.callTool({ name, arguments: args }),
    close: () => rawClient.close(),
  };
}

interface OfflineMcpDaemon {
  client: McpClient;
  stop: () => Promise<void>;
}

async function startOfflineMcpDaemon(): Promise<OfflineMcpDaemon> {
  const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-"));
  const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
  const removeDirectories = async () => {
    await rm(paseoHome, { recursive: true, force: true });
    await rm(staticDir, { recursive: true, force: true });
  };
  const port = await getAvailablePort();
  const daemon = await createPaseoDaemon(
    {
      listen: `127.0.0.1:${port}`,
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: true,
      staticDir,
      mcpDebug: false,
      agentClients: createTestAgentClients(),
      agentStoragePath: path.join(paseoHome, "agents"),
    },
    pino({ level: "silent" }),
  ).catch(async (error: unknown) => {
    await removeDirectories();
    throw error;
  });
  try {
    await daemon.start();
    const client = await createMcpClient(`http://127.0.0.1:${port}/mcp/agents`);
    return {
      client,
      stop: async () => {
        await client.close();
        await daemon.stop();
        await removeDirectories();
      },
    };
  } catch (error) {
    await daemon.stop();
    await removeDirectories();
    throw error;
  }
}

type WorkspaceCreation = { workspaceId: unknown } | { error: unknown };

async function createLocalWorkspace(client: McpClient, cwd: string): Promise<WorkspaceCreation> {
  const result = await client.callTool({
    name: "create_workspace",
    args: { isolation: "local", path: cwd },
  });
  if (result.isError) {
    const content = result.content?.[0];
    return { error: content && "text" in content ? content.text : undefined };
  }
  return { workspaceId: getStructuredContent(result)?.workspaceId };
}

async function listWorkspaces(client: McpClient): Promise<WorkspaceCreation[]> {
  const result = await client.callTool({ name: "list_workspaces", args: {} });
  const workspaces = getStructuredContent(result)?.workspaces;
  if (!Array.isArray(workspaces)) return [];
  return workspaces.map((workspace: StructuredContent) => ({ workspaceId: workspace.workspaceId }));
}

interface LaunchRecorder {
  recordedLaunches: Map<string, AgentSessionConfig>;
}

class RecordingAgentClient implements AgentClient {
  readonly provider: AgentClient["provider"];
  readonly capabilities: AgentClient["capabilities"];

  constructor(
    private readonly inner: AgentClient,
    private readonly recorder: LaunchRecorder,
  ) {
    this.provider = inner.provider;
    this.capabilities = {
      ...inner.capabilities,
      supportsMcpServers: true,
      supportsNativePaseoTools: false,
    };
  }

  async createSession(
    ...args: Parameters<AgentClient["createSession"]>
  ): ReturnType<AgentClient["createSession"]> {
    if (args[1]?.agentId) this.recorder.recordedLaunches.set(args[1].agentId, args[0]);
    return this.inner.createSession(...args);
  }

  async resumeSession(
    ...args: Parameters<AgentClient["resumeSession"]>
  ): ReturnType<AgentClient["resumeSession"]> {
    return this.inner.resumeSession(...args);
  }

  async fetchCatalog(
    ...args: Parameters<AgentClient["fetchCatalog"]>
  ): ReturnType<AgentClient["fetchCatalog"]> {
    return this.inner.fetchCatalog(...args);
  }

  async isAvailable(): Promise<boolean> {
    return this.inner.isAvailable();
  }
}

function createMcpRecordingAgentClients(recorder: LaunchRecorder) {
  const clients = createTestAgentClients();
  const claude = clients.claude;
  if (!claude) {
    throw new Error("Fake Claude client is not configured");
  }

  return {
    ...clients,
    claude: new RecordingAgentClient(claude, recorder),
  };
}

async function assertAgentNotRunning(options: {
  client: McpClient;
  agentId: string;
}): Promise<void> {
  const statusResult = await options.client.callTool({
    name: "get_agent_status",
    args: { agentId: options.agentId },
  });
  const payload = getStructuredContent(statusResult);
  if (!payload) {
    throw new Error("get_agent_status returned no structured payload");
  }
  const status = payload.status;
  if (status === "running" || status === "initializing") {
    throw new Error(`Agent still running after blocking create_agent (status=${status})`);
  }
}

describe("agent MCP end-to-end (offline)", () => {
  test("native launch connects before registration and refuses a replaced launch at tool call", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-native-startup-"));
    const staticDir = path.join(paseoHome, "static");
    const clients = createTestAgentClients({ supportsMcpServers: true });
    const provider = clients.claude!;
    const createSession = provider.createSession.bind(provider);
    const nativeClient = new Client({ name: "native-startup-test", version: "1" });
    let callerAgentId = "";
    let callBatch: (() => Promise<Response>) | undefined;
    vi.spyOn(provider, "createSession").mockImplementation(async (config, context) => {
      callerAgentId = context!.agentId!;
      const server = config.mcpServers!.paseo;
      if (!("url" in server)) throw new Error("HTTP MCP launch required");
      await nativeClient.connect(
        new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: { headers: server.headers },
        }),
      );
      expect((await nativeClient.listTools()).tools).toContainEqual(
        expect.objectContaining({ name: "list_agents" }),
      );
      await expect(nativeClient.callTool({ name: "list_agents", arguments: {} })).rejects.toThrow();
      callBatch = () =>
        fetch(server.url, {
          method: "POST",
          headers: {
            ...server.headers,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify([
            { jsonrpc: "2.0", id: "catalog", method: "tools/list", params: {} },
            {
              jsonrpc: "2.0",
              id: "call",
              method: "tools/call",
              params: { name: "list_agents", arguments: {} },
            },
          ]),
        });
      const initializingBatch = await callBatch();
      expect(initializingBatch.status).toBe(500);
      await initializingBatch.body?.cancel();
      return createSession(config, context);
    });
    const daemon = await createPaseoDaemon(
      {
        listen: "127.0.0.1:0",
        paseoHome,
        staticDir,
        corsAllowedOrigins: [],
        hostnames: true,
        mcpEnabled: true,
        mcpDebug: false,
        agentClients: clients,
        agentStoragePath: path.join(paseoHome, "agents"),
        relayEnabled: false,
      },
      pino({ level: "silent" }),
    );
    try {
      await daemon.start();
      const agent = await daemon.agentManager.createAgent(
        { provider: "claude", cwd: paseoHome },
        undefined,
        {},
      );
      expect(agent.id).toBe(callerAgentId);
      expect(
        (await nativeClient.callTool({ name: "list_agents", arguments: {} })).isError,
      ).not.toBe(true);
      if (!callBatch) throw new Error("Native batch caller required");
      const registeredBatch = await callBatch();
      expect(registeredBatch.status).toBe(200);
      expect(await registeredBatch.text()).not.toContain('"isError":true');
      const state = await daemon.agentManager.getAgentMcpRefreshState(agent.id);
      expect(state?.supported).toBe(true);
      if (!state?.sessionId) throw new Error("Registered native session required");
      expect(
        await daemon.agentManager.refreshAgentMcp({
          agentId: agent.id,
          expected: {
            provider: state.provider,
            sessionId: state.sessionId,
            configRevision: state.configRevision,
          },
          changes: {},
          reconnect: true,
        }),
      ).toMatchObject({ outcome: "refreshed" });
      await expect(nativeClient.callTool({ name: "list_agents", arguments: {} })).rejects.toThrow();
      await expect(
        nativeClient.callTool({
          name: "create_agent",
          arguments: {
            provider: "claude/claude-test-model",
            initialPrompt: "Reply DONE",
            notifyOnFinish: false,
          },
        }),
      ).rejects.toThrow();
      expect(daemon.agentManager.listAgents().map((entry) => entry.id)).toEqual([agent.id]);
    } finally {
      await nativeClient.close();
      await daemon.stop();
      await rm(paseoHome, { recursive: true, force: true });
    }
  }, 30_000);

  test("native launch accepts tools after the provider supplies its first native identity", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-native-lazy-"));
    let nativeIdentityReady = false;
    const clients = createTestAgentClients({
      supportsMcpServers: true,
      onStartTurn: () => {
        nativeIdentityReady = true;
      },
    });
    const provider = clients.claude!;
    const createSession = provider.createSession.bind(provider);
    const nativeClient = new Client({ name: "native-lazy-test", version: "1" });
    let persistence: (() => AgentPersistenceHandle | null) | undefined;
    const readPersistence = () => {
      if (!nativeIdentityReady) return null;
      if (!persistence) throw new Error("Native persistence reader required");
      return persistence();
    };
    vi.spyOn(provider, "createSession").mockImplementation(async (config, context) => {
      const server = config.mcpServers!.paseo;
      if (!("url" in server)) throw new Error("HTTP MCP launch required");
      await nativeClient.connect(
        new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: { headers: server.headers },
        }),
      );
      const session = await createSession(config, context);
      const nativeId = session.id;
      Object.defineProperty(session, "id", { get: () => (nativeIdentityReady ? nativeId : "") });
      persistence = session.describePersistence.bind(session);
      vi.spyOn(session, "describePersistence").mockImplementation(readPersistence);
      return session;
    });
    const daemon = await createPaseoDaemon(
      {
        listen: "127.0.0.1:0",
        paseoHome,
        staticDir: path.join(paseoHome, "static"),
        corsAllowedOrigins: [],
        hostnames: true,
        mcpEnabled: true,
        mcpDebug: false,
        agentClients: clients,
        agentStoragePath: path.join(paseoHome, "agents"),
        relayEnabled: false,
      },
      pino({ level: "silent" }),
    );
    try {
      await daemon.start();
      const agent = await daemon.agentManager.createAgent(
        { provider: "claude", cwd: paseoHome },
        undefined,
        {},
      );
      expect(agent.persistence).toBeNull();
      await expect(nativeClient.callTool({ name: "list_agents", arguments: {} })).rejects.toThrow();
      await daemon.agentManager.runAgent(agent.id, "initialize native session");
      expect(
        (await nativeClient.callTool({ name: "list_agents", arguments: {} })).isError,
      ).not.toBe(true);
    } finally {
      await nativeClient.close();
      await daemon.stop();
      await rm(paseoHome, { recursive: true, force: true });
    }
  }, 30_000);

  test("create_agent runs initial prompt and affects filesystem", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-"));
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    const agentCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-agent-cwd-"));
    const port = await getAvailablePort();

    const daemonConfig: PaseoDaemonConfig = {
      listen: `127.0.0.1:${port}`,
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: true,
      staticDir,
      mcpDebug: false,
      agentClients: createTestAgentClients(),
      agentStoragePath: path.join(paseoHome, "agents"),
    };

    const daemon = await createPaseoDaemon(daemonConfig, pino({ level: "silent" }));
    await daemon.start();

    const client = await createMcpClient(`http://127.0.0.1:${port}/mcp/agents`);

    let agentId: string | null = null;
    try {
      const filePath = path.join(agentCwd, "mcp-smoke.txt");
      await writeFile(filePath, "ok", "utf8");

      const initialPrompt = [
        "You must call the Bash command tool with the exact command `rm -f mcp-smoke.txt`.",
        "Run it and reply with done and stop.",
        "Do not respond before the command finishes.",
      ].join("\n");

      const result = await client.callTool({
        name: "create_agent",
        args: {
          cwd: agentCwd,
          title: "MCP e2e smoke",
          provider: "claude/claude-test-model",
          mode: "bypassPermissions",
          initialPrompt,
          background: false,
        },
      });

      const payload = getStructuredContent(result);
      agentId = typeof payload?.agentId === "string" ? payload.agentId : null;
      expect(agentId).toBeTruthy();

      await assertAgentNotRunning({ client, agentId: agentId! });

      if (existsSync(filePath)) {
        const contents = await readFile(filePath, "utf8");
        throw new Error(
          `Expected mcp-smoke.txt to be removed, but it still exists with contents: ${contents}`,
        );
      }
    } finally {
      if (agentId) {
        await client.callTool({ name: "kill_agent", args: { agentId } });
      }
      await client.close();
      await daemon.stop();
      await rm(paseoHome, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
      await rm(agentCwd, { recursive: true, force: true });
    }
  }, 30_000);

  test("create_workspace with local isolation adopts only an existing directory", async () => {
    const daemon = await startOfflineMcpDaemon();
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-local-workspace-"));
    const missingPath = path.join(root, "does-not-exist");
    const filePath = path.join(root, "regular-file");
    await writeFile(filePath, "not a directory\n", "utf8");
    try {
      expect(await createLocalWorkspace(daemon.client, missingPath)).toEqual({
        error: expect.stringContaining(`Directory not found: ${missingPath}`),
      });
      expect(await createLocalWorkspace(daemon.client, filePath)).toEqual({
        error: expect.stringContaining(`Directory not found: ${filePath}`),
      });
      const created = await createLocalWorkspace(daemon.client, root);
      expect(await listWorkspaces(daemon.client)).toEqual([created]);
    } finally {
      await daemon.stop();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("password-protected daemon authorizes the agent MCP via the capability token", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-"));
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    const agentCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-agent-cwd-"));
    const port = await getAvailablePort();

    const daemonConfig: PaseoDaemonConfig = {
      listen: `127.0.0.1:${port}`,
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: true,
      staticDir,
      mcpDebug: false,
      agentClients: createTestAgentClients(),
      agentStoragePath: path.join(paseoHome, "agents"),
      auth: { password: hashDaemonPassword("daemon-secret") },
    };

    const daemon = await createPaseoDaemon(daemonConfig, pino({ level: "silent" }));
    await daemon.start();

    const mcpUrl = `http://127.0.0.1:${port}/mcp/agents`;
    const capabilityToken = daemon.agentManager.getMcpAuthToken();
    expect(typeof capabilityToken).toBe("string");

    let agentId: string | null = null;
    let client: McpClient | null = null;
    try {
      // Remote auth is not weakened: a request without credentials is rejected
      // before any MCP processing.
      const unauthorized = await fetch(mcpUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(unauthorized.status).toBe(401);

      // The injected capability token authenticates the full MCP handshake:
      // creating (and connecting) the client and driving a tool call both go
      // through the password-gated /mcp/agents route. (The exact bearer header
      // injected into a child agent's config is covered by the
      // runtime-mcp-config unit test.)
      client = await createMcpClient(mcpUrl, capabilityToken!);
      const result = await client.callTool({
        name: "create_agent",
        args: {
          cwd: agentCwd,
          title: "Password MCP",
          provider: "claude/claude-test-model",
          mode: "bypassPermissions",
          initialPrompt: "reply with done and stop",
          background: true,
        },
      });
      const payload = getStructuredContent(result);
      agentId = typeof payload?.agentId === "string" ? payload.agentId : null;
      expect(agentId).toBeTruthy();
    } finally {
      if (agentId) {
        await client?.callTool({ name: "kill_agent", args: { agentId } });
      }
      await client?.close();
      await daemon.stop();
      await rm(paseoHome, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
      await rm(agentCwd, { recursive: true, force: true });
    }
  }, 30_000);

  test("a CLI-started Claude parent uses injected HTTP MCP and receives one durable child finish notice", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-finish-mcp-"));
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-finish-static-"));
    const recorder: LaunchRecorder = { recordedLaunches: new Map() };
    const prompts: AgentPromptInput[] = [];
    const daemon = await createPaseoDaemon(
      {
        listen: "127.0.0.1:0",
        paseoHome,
        staticDir,
        corsAllowedOrigins: [],
        hostnames: true,
        mcpEnabled: true,
        mcpInjectIntoAgents: true,
        nativeFinishNotices: false,
        reportUpOnTurnEnd: true,
        relayEnabled: false,
        agentStoragePath: path.join(paseoHome, "agents"),
        agentClients: {
          claude: new RecordingAgentClient(
            createTestAgentClient("claude", {
              supportsMcpServers: true,
              onStartTurn: (prompt) => prompts.push(prompt),
            }),
            recorder,
          ),
        },
      },
      pino({ level: "silent" }),
      { credentialBackend: createMemoryCredentialBackend() },
    );
    const client = new Client({ name: "fixture-parent", version: "1" });
    try {
      await daemon.start();
      const target = daemon.getListenTarget();
      if (target?.type !== "tcp") throw new Error("Isolated TCP daemon required");
      const cliEntry = fileURLToPath(new URL("../../../../cli/dist/index.js", import.meta.url));
      const result = await promisify(execFile)(
        process.execPath,
        [
          cliEntry,
          "run",
          "fixture parent work",
          "--provider",
          "claude/claude-test-model",
          "--cwd",
          paseoHome,
          "--title",
          "Fixture lead",
          "--mode",
          "bypassPermissions",
          "--host",
          `127.0.0.1:${target.port}`,
          "--json",
        ],
        {
          timeout: 15_000,
          env: { ...process.env, PASEO_AGENT_ID: "", PASEO_WORKSPACE_ID: "", PASEO_PASSWORD: "" },
        },
      );
      const parentId = (JSON.parse(result.stdout) as { agentId: string }).agentId;
      const parent = daemon.agentManager.getAgent(parentId)!;
      expect(parent.lifecycle).toBe("idle");
      const server = recorder.recordedLaunches.get(parent.id)!.mcpServers!.paseo;
      if (server.type !== "http") throw new Error("Injected HTTP MCP server required");
      expect(server.headers).toHaveProperty("X-Paseo-Report-Origin");
      await client.connect(
        new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: { headers: server.headers },
        }),
      );
      const catalog = await client.listTools();
      expect(catalog.tools.map((tool) => tool.name)).toContain("create_agent");
      const created = await client.callTool({
        name: "create_agent",
        arguments: {
          provider: "claude/claude-test-model",
          title: "Fixture child",
          initialPrompt: "fixture child work",
          notifyOnFinish: true,
        },
      });
      expect(created.isError, JSON.stringify(created)).not.toBe(true);
      const childId = (created.structuredContent as { agentId: string }).agentId;
      await vi.waitFor(async () =>
        expect((await daemon.agentStorage.getFinishNotice(childId))?.status).toBe("delivered"),
      );
      expect(prompts).toHaveLength(3);
      expect(JSON.stringify(prompts[2])).toContain(childId);
      expect(daemon.agentManager.nativeReportOwnsFinish(childId, parent.id)).toBe(false);
      expect(daemon.agentManager.getAgent(childId)?.workspaceId).toBe(parent.workspaceId);
      await vi.waitFor(() => expect(daemon.agentManager.hasInFlightRun(parent.id)).toBe(false));
      await daemon.agentManager.runAgent(parent.id, "fixture follow-up");
      await vi.waitFor(() => expect(daemon.agentManager.hasInFlightRun(parent.id)).toBe(false));
      expect(prompts).toHaveLength(4);
      expect(prompts.filter((prompt) => JSON.stringify(prompt).includes(childId))).toHaveLength(1);
    } finally {
      await client.close();
      await daemon.stop();
      await rm(paseoHome, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("create_agent auto-injects paseo MCP by default and can be disabled", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-"));
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    const agentCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-agent-cwd-"));
    const port = await getAvailablePort();
    const recorder: LaunchRecorder = { recordedLaunches: new Map() };

    const daemonConfig: PaseoDaemonConfig = {
      listen: `127.0.0.1:${port}`,
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: true,
      staticDir,
      mcpDebug: false,
      agentClients: createMcpRecordingAgentClients(recorder),
      agentStoragePath: path.join(paseoHome, "agents"),
    };

    const daemon = await createPaseoDaemon(daemonConfig, pino({ level: "silent" }));
    await daemon.start();

    const client = await createMcpClient(`http://127.0.0.1:${port}/mcp/agents`);

    const disabledPaseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-disabled-"));
    const disabledStaticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-disabled-"));
    const disabledAgentCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-agent-cwd-disabled-"));
    const disabledPort = await getAvailablePort();
    const disabledRecorder: LaunchRecorder = { recordedLaunches: new Map() };
    const disabledDaemonConfig: PaseoDaemonConfig = {
      listen: `127.0.0.1:${disabledPort}`,
      paseoHome: disabledPaseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: true,
      mcpInjectIntoAgents: false,
      staticDir: disabledStaticDir,
      mcpDebug: false,
      agentClients: createMcpRecordingAgentClients(disabledRecorder),
      agentStoragePath: path.join(disabledPaseoHome, "agents"),
    };
    const disabledDaemon = await createPaseoDaemon(disabledDaemonConfig, pino({ level: "silent" }));
    await disabledDaemon.start();

    const disabledClient = await createMcpClient(`http://127.0.0.1:${disabledPort}/mcp/agents`);

    let agentId: string | null = null;
    let disabledAgentId: string | null = null;
    try {
      const result = await client.callTool({
        name: "create_agent",
        args: {
          cwd: agentCwd,
          title: "Injected MCP",
          provider: "claude/claude-test-model",
          mode: "bypassPermissions",
          initialPrompt: "reply with done and stop",
          background: true,
        },
      });
      const payload = getStructuredContent(result);
      agentId = typeof payload?.agentId === "string" ? payload.agentId : null;
      expect(agentId).toBeTruthy();

      expect(recorder.recordedLaunches.get(agentId!)?.mcpServers).toMatchObject({
        paseo: {
          type: "http",
          url: `http://127.0.0.1:${port}/mcp/agents?callerAgentId=${agentId!}`,
        },
      });
      const injectedAgent = daemon.agentManager.getAgent(agentId!);
      expect(injectedAgent?.config.mcpServers?.paseo).toBeUndefined();

      const disabledResult = await disabledClient.callTool({
        name: "create_agent",
        args: {
          cwd: disabledAgentCwd,
          title: "No injected MCP",
          provider: "claude/claude-test-model",
          mode: "bypassPermissions",
          initialPrompt: "reply with done and stop",
          background: true,
        },
      });
      const disabledPayload = getStructuredContent(disabledResult);
      disabledAgentId =
        typeof disabledPayload?.agentId === "string" ? disabledPayload.agentId : null;
      expect(disabledAgentId).toBeTruthy();

      expect(disabledRecorder.recordedLaunches.has(disabledAgentId!)).toBe(true);
      expect(
        disabledRecorder.recordedLaunches.get(disabledAgentId!)?.mcpServers?.paseo,
      ).toBeUndefined();
      const disabledAgent = disabledDaemon.agentManager.getAgent(disabledAgentId!);
      expect(disabledAgent?.config.mcpServers?.paseo).toBeUndefined();
    } finally {
      if (agentId) {
        await client.callTool({ name: "kill_agent", args: { agentId } });
      }
      if (disabledAgentId) {
        await disabledClient.callTool({ name: "kill_agent", args: { agentId: disabledAgentId } });
      }
      await disabledClient.close();
      await disabledDaemon.stop();
      await rm(disabledPaseoHome, { recursive: true, force: true });
      await rm(disabledStaticDir, { recursive: true, force: true });
      await rm(disabledAgentCwd, { recursive: true, force: true });
      await client.close();
      await daemon.stop();
      await rm(paseoHome, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
      await rm(agentCwd, { recursive: true, force: true });
    }
  }, 30_000);

  test("create_agent injects a loopback MCP URL when the daemon listens on all interfaces", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-"));
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    const agentCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-agent-cwd-"));
    const port = await getAvailablePort();
    const recorder: LaunchRecorder = { recordedLaunches: new Map() };

    const daemonConfig: PaseoDaemonConfig = {
      listen: `0.0.0.0:${port}`,
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: true,
      staticDir,
      mcpDebug: false,
      agentClients: createMcpRecordingAgentClients(recorder),
      agentStoragePath: path.join(paseoHome, "agents"),
    };

    const daemon = await createPaseoDaemon(daemonConfig, pino({ level: "silent" }));
    await daemon.start();

    const client = await createMcpClient(`http://127.0.0.1:${port}/mcp/agents`);

    let agentId: string | null = null;
    try {
      const result = await client.callTool({
        name: "create_agent",
        args: {
          cwd: agentCwd,
          title: "Wildcard MCP",
          provider: "claude/claude-test-model",
          mode: "bypassPermissions",
          initialPrompt: "reply with done and stop",
          background: true,
        },
      });
      const payload = getStructuredContent(result);
      agentId = typeof payload?.agentId === "string" ? payload.agentId : null;
      expect(agentId).toBeTruthy();

      expect(recorder.recordedLaunches.get(agentId!)?.mcpServers).toMatchObject({
        paseo: {
          type: "http",
          url: `http://127.0.0.1:${port}/mcp/agents?callerAgentId=${agentId!}`,
        },
      });
      const injectedAgent = daemon.agentManager.getAgent(agentId!);
      expect(injectedAgent?.config.mcpServers?.paseo).toBeUndefined();
    } finally {
      if (agentId) {
        await client.callTool({ name: "kill_agent", args: { agentId } });
      }
      await client.close();
      await daemon.stop();
      await rm(paseoHome, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
      await rm(agentCwd, { recursive: true, force: true });
    }
  }, 30_000);

  test("create_agent with background initialPrompt reflects running state once the first turn starts", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-"));
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    const agentCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-agent-cwd-"));
    const port = await getAvailablePort();

    const daemonConfig: PaseoDaemonConfig = {
      listen: `127.0.0.1:${port}`,
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: true,
      staticDir,
      mcpDebug: false,
      agentClients: createTestAgentClients(),
      agentStoragePath: path.join(paseoHome, "agents"),
    };

    const daemon = await createPaseoDaemon(daemonConfig, pino({ level: "silent" }));
    await daemon.start();

    const client = await createMcpClient(`http://127.0.0.1:${port}/mcp/agents`);

    let agentId: string | null = null;
    try {
      const result = await client.callTool({
        name: "create_agent",
        args: {
          cwd: agentCwd,
          title: "MCP background create",
          provider: "codex/gpt-5.4-mini",
          mode: "full-access",
          initialPrompt: "Run exactly: sleep 30",
          background: true,
        },
      });

      const payload = getStructuredContent(result);
      agentId = typeof payload?.agentId === "string" ? payload.agentId : null;
      expect(agentId).toBeTruthy();
      expect(payload?.status).toBe("running");

      const statusResult = await client.callTool({
        name: "get_agent_status",
        args: { agentId },
      });
      const statusPayload = getStructuredContent(statusResult);
      expect(statusPayload?.status).toBe("running");
    } finally {
      if (agentId) {
        await client.callTool({ name: "kill_agent", args: { agentId } });
      }
      await client.close();
      await daemon.stop();
      await rm(paseoHome, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
      await rm(agentCwd, { recursive: true, force: true });
    }
  }, 30_000);

  test("create_agent propagates initial-turn start failure instead of returning success", async () => {
    class StartTurnFailureSession implements AgentSession {
      readonly provider = "codex" as const;
      readonly id = "mcp-start-turn-failure-session";
      readonly capabilities = {
        supportsStreaming: false,
        supportsSessionPersistence: true,
        supportsDynamicModes: false,
        supportsMcpServers: false,
        supportsReasoningStream: false,
        supportsToolInvocations: false,
        supportsRewindConversation: false,
        supportsRewindFiles: false,
        supportsRewindBoth: false,
      } as const;

      async run(): Promise<AgentRunResult> {
        return {
          sessionId: this.id,
          finalText: "",
          timeline: [],
        };
      }

      async startTurn(): Promise<{ turnId: string }> {
        throw new Error("Initial turn failed to start");
      }

      subscribe(_callback: (event: AgentStreamEvent) => void): () => void {
        return () => undefined;
      }

      async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
        yield* [];
      }

      async getRuntimeInfo() {
        return {
          provider: "codex" as const,
          sessionId: this.id,
          model: "gpt-5.4-mini",
          modeId: "full-access",
        };
      }

      async getAvailableModes(): Promise<
        Array<{ id: string; label: string; description: string }>
      > {
        return [{ id: "full-access", label: "Full access", description: "No prompts" }];
      }

      async getCurrentMode(): Promise<string | null> {
        return "full-access";
      }

      async setMode(): Promise<void> {}

      getPendingPermissions() {
        return [];
      }

      async respondToPermission(): Promise<void> {}

      describePersistence(): AgentPersistenceHandle | null {
        return { provider: "codex", sessionId: this.id };
      }

      async interrupt(): Promise<void> {}

      async close(): Promise<void> {}
    }

    class StartTurnFailureClient implements AgentClient {
      readonly provider = "codex" as const;
      readonly capabilities = {
        supportsStreaming: false,
        supportsSessionPersistence: true,
        supportsDynamicModes: false,
        supportsMcpServers: false,
        supportsReasoningStream: false,
        supportsToolInvocations: false,
        supportsRewindConversation: false,
        supportsRewindFiles: false,
        supportsRewindBoth: false,
      } as const;

      async isAvailable(): Promise<boolean> {
        return true;
      }

      async fetchCatalog(): Promise<{
        models: Array<{ provider: "codex"; id: string; label: string; isDefault: boolean }>;
        modes: Array<{ id: string; label: string; description: string }>;
      }> {
        return {
          models: [
            {
              provider: "codex",
              id: "gpt-5.4-mini",
              label: "gpt-5.4-mini",
              isDefault: true,
            },
          ],
          modes: [{ id: "full-access", label: "Full access", description: "No prompts" }],
        };
      }

      async createSession(_config: AgentSessionConfig): Promise<AgentSession> {
        return new StartTurnFailureSession();
      }

      async resumeSession(
        _handle: AgentPersistenceHandle,
        _config?: Partial<AgentSessionConfig>,
      ): Promise<AgentSession> {
        return new StartTurnFailureSession();
      }
    }

    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-"));
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    const agentCwd = await mkdtemp(path.join(os.tmpdir(), "paseo-agent-cwd-"));
    const port = await getAvailablePort();

    const daemonConfig: PaseoDaemonConfig = {
      listen: `127.0.0.1:${port}`,
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: true,
      staticDir,
      mcpDebug: false,
      agentClients: {
        ...createTestAgentClients(),
        codex: new StartTurnFailureClient(),
      },
      agentStoragePath: path.join(paseoHome, "agents"),
    };

    const daemon = await createPaseoDaemon(daemonConfig, pino({ level: "silent" }));
    await daemon.start();

    const client = await createMcpClient(`http://127.0.0.1:${port}/mcp/agents`);

    let agentId: string | null = null;
    try {
      const result = await client.callTool({
        name: "create_agent",
        args: {
          cwd: agentCwd,
          title: "MCP start failure",
          provider: "codex/gpt-5.4-mini",
          mode: "full-access",
          initialPrompt: "Run exactly: sleep 30",
          background: true,
        },
      });

      const payload = getStructuredContent(result);
      agentId = typeof payload?.agentId === "string" ? payload.agentId : null;
      expect(agentId).toBeTruthy();

      await assertAgentNotRunning({ client, agentId: agentId! });
      const statusResult = await client.callTool({
        name: "get_agent_status",
        args: { agentId },
      });
      const statusPayload = getStructuredContent(statusResult);
      expect(statusPayload?.status).toBe("error");
      const snapshot = statusPayload?.snapshot;
      const lastError =
        snapshot && typeof snapshot === "object" ? Reflect.get(snapshot, "lastError") : undefined;
      expect(lastError).toContain("Initial turn failed to start");
    } finally {
      if (agentId) {
        await client.callTool({ name: "kill_agent", args: { agentId } });
      }
      await client.close();
      await daemon.stop();
      await rm(paseoHome, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
      await rm(agentCwd, { recursive: true, force: true });
    }
  }, 30_000);

  test("create_agent with worktree is async and boots terminals only after setup success", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-"));
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-worktree-repo-"));
    const port = await getAvailablePort();

    const daemonConfig: PaseoDaemonConfig = {
      listen: `127.0.0.1:${port}`,
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: true,
      staticDir,
      mcpDebug: false,
      agentClients: createTestAgentClients(),
      agentStoragePath: path.join(paseoHome, "agents"),
    };

    const daemon = await createPaseoDaemon(daemonConfig, pino({ level: "silent" }));
    await daemon.start();

    const client = await createMcpClient(`http://127.0.0.1:${port}/mcp/agents`);

    let agentId: string | null = null;
    try {
      const { execSync } = await import("node:child_process");
      execSync("git init -b main", { cwd: repoRoot, stdio: "pipe" });
      execSync("git config user.email 'fulcra@users.noreply.github.com'", {
        cwd: repoRoot,
        stdio: "pipe",
      });
      execSync("git config user.name 'Fulcra'", { cwd: repoRoot, stdio: "pipe" });
      await writeFile(path.join(repoRoot, "file.txt"), "hello\n", "utf8");
      execSync("git add .", { cwd: repoRoot, stdio: "pipe" });
      execSync("git -c commit.gpgsign=false commit -m 'initial'", { cwd: repoRoot, stdio: "pipe" });

      const setupCommand =
        'while [ ! -f "$PASEO_WORKTREE_PATH/allow-setup" ]; do sleep 0.05; done; echo "done" > "$PASEO_WORKTREE_PATH/setup-done.txt"';
      await writeFile(
        path.join(repoRoot, "paseo.json"),
        JSON.stringify({
          worktree: {
            setup: [setupCommand],
            terminals: [
              {
                name: "Dev Server",
                command: 'echo "dev-server" > dev-terminal.txt; tail -f /dev/null',
              },
            ],
          },
        }),
        "utf8",
      );
      execSync("git add paseo.json", { cwd: repoRoot, stdio: "pipe" });
      execSync("git -c commit.gpgsign=false commit -m 'add worktree config'", {
        cwd: repoRoot,
        stdio: "pipe",
      });

      const result = await withTimeout({
        promise: client.callTool({
          name: "create_agent",
          args: {
            cwd: repoRoot,
            title: "MCP worktree setup terminals",
            provider: "claude/claude-test-model",
            mode: "bypassPermissions",
            initialPrompt: "say done and stop",
            worktreeName: "mcp-worktree-setup-test",
            baseBranch: "main",
            background: true,
          },
        }),
        timeoutMs: 2500,
        label: "create_agent should not block on setup",
      });

      const payload = getStructuredContent(result);
      agentId = typeof payload?.agentId === "string" ? payload.agentId : null;
      expect(agentId).toBeTruthy();
      const worktreePath = typeof payload?.cwd === "string" ? payload.cwd : "";
      expect(worktreePath).toContain(`${path.sep}worktrees${path.sep}`);
      expect(existsSync(path.join(worktreePath, "setup-done.txt"))).toBe(false);
      expect(existsSync(path.join(worktreePath, "dev-terminal.txt"))).toBe(false);

      await writeFile(path.join(worktreePath, "allow-setup"), "ok\n", "utf8");

      await waitForPathExists({
        targetPath: path.join(worktreePath, "setup-done.txt"),
        timeoutMs: 15000,
      });
      await waitForPathExists({
        targetPath: path.join(worktreePath, "dev-terminal.txt"),
        timeoutMs: 30000,
      });
    } finally {
      if (agentId) {
        await client.callTool({ name: "kill_agent", args: { agentId } });
      }
      await client.close();
      await daemon.stop();
      await rm(paseoHome, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
      await rm(repoRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
