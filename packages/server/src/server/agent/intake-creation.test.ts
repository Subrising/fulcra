import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import {
  createPaseoApi,
  type PaseoWorkspace,
  type PaseoWorkspaceListResult,
} from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { AgentManager } from "./agent-manager.js";
import { toAgentPayload } from "./agent-projections.js";
import { ClaudeAgentClient } from "./providers/claude/agent.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { openIntakeForm } from "../../../../../control/orca-organization/client/organization/intake-form";
import { createIntakeChat } from "../../../../../control/orca-organization/client/organization/native-actions.mjs";

type WorkspaceOptions = NonNullable<Parameters<DaemonClient["fetchWorkspaces"]>[0]>;
type WorkspaceResult = Awaited<ReturnType<DaemonClient["fetchWorkspaces"]>>;
type Subscription = NonNullable<PaseoWorkspaceListResult["subscription"]>;
class ConstructorOnlyClaude extends ClaudeAgentClient {
  override async isAvailable() {
    return true;
  }
}
class IntakeDriver extends DaemonClient {
  readonly creates: Parameters<DaemonClient["createAgent"]>[0][] = [];
  constructor(
    readonly manager: AgentManager,
    readonly workspace: PaseoWorkspace,
  ) {
    super({ url: "ws://127.0.0.1:1", clientId: "intake-port" });
  }
  override fetchWorkspaces(
    options: WorkspaceOptions & { subscribe: {} },
  ): Promise<WorkspaceResult & { subscription: Subscription }>;
  override fetchWorkspaces(options?: WorkspaceOptions): Promise<WorkspaceResult>;
  override async fetchWorkspaces(options?: WorkspaceOptions): Promise<WorkspaceResult> {
    if (options?.subscribe) throw new Error("This creation fixture does not subscribe.");
    return {
      requestId: "workspaces",
      entries: [this.workspace],
      pageInfo: { hasMore: false, nextCursor: null },
    };
  }
  override async getProvidersSnapshot(): Promise<
    Awaited<ReturnType<DaemonClient["getProvidersSnapshot"]>>
  > {
    return {
      requestId: "catalog",
      generatedAt: "2026-01-01T00:00:00.000Z",
      entries: [
        {
          provider: "claude",
          status: "ready",
          enabled: true,
          models: [
            {
              provider: "claude",
              id: "opus",
              label: "Opus",
              thinkingOptions: [{ id: "high", label: "High" }],
            },
          ],
          modes: [
            { id: "default", label: "Ask" },
            { id: "acceptEdits", label: "Accept edits" },
          ],
          defaultModeId: "default",
        },
      ],
    };
  }
  override async createAgent(
    input: Parameters<DaemonClient["createAgent"]>[0],
  ): Promise<Awaited<ReturnType<DaemonClient["createAgent"]>>> {
    this.creates.push(input);
    if (
      !input.config ||
      input.config.provider !== "claude" ||
      input.config.cwd !== this.workspace.workspaceDirectory
    )
      throw new Error("The SDK did not provide the selected provider/context config.");
    const agent = await this.manager.createAgent(
      { ...input.config, provider: "claude", cwd: this.workspace.workspaceDirectory },
      input.agentId,
      { workspaceId: input.workspaceId, labels: input.labels, persistSession: false },
    );
    return toAgentPayload(agent);
  }
}
test("intake cross-provider config reaches the actual SDK, manager and Claude constructor without a provider launch", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "fulcra-intake-constructor-"));
  const logger = createTestLogger();
  let launches = 0;
  const claude = new ConstructorOnlyClaude({
    logger,
    queryFactory: () => {
      launches++;
      throw new Error("No model turn allowed");
    },
    resolveBinary: async () => {
      launches++;
      throw new Error("No CLI launch allowed");
    },
    resolveVersion: async () => {
      launches++;
      throw new Error("No version probe allowed");
    },
    modelProbe: async () => {
      launches++;
      throw new Error("No model probe allowed");
    },
  });
  const manager = new AgentManager({ clients: { claude }, logger });
  const workspace: PaseoWorkspace = {
    id: "existing",
    projectId: "ship",
    projectDisplayName: "Ship It",
    projectRootPath: cwd,
    workspaceDirectory: cwd,
    projectKind: "git",
    workspaceKind: "directory",
    name: "existing",
    archivingAt: null,
    status: "done",
    statusEnteredAt: null,
    activityAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
    gitRuntime: null,
    githubRuntime: null,
  };
  const driver = new IntakeDriver(manager, workspace),
    api = createPaseoApi(driver);
  const model = openIntakeForm({ id: randomUUID(), text: "Plan", setText() {} });
  const id = randomUUID(),
    deliveryId = randomUUID(),
    agentId = randomUUID(),
    effects: Record<string, unknown>[] = [];
  try {
    model.applyDefaults("codex/gpt-6.1-sol", "high", "auto-review");
    model.setModel("claude/opus");
    model.setThinking("high");
    model.applyProviderModes({
      provider: "claude",
      modes: [
        { id: "default", label: "Ask" },
        { id: "acceptEdits", label: "Accept edits" },
      ],
      configuredMode: "acceptEdits",
      defaultMode: "default",
    });
    const form = model.getState();
    const request: Omit<Parameters<typeof createIntakeChat>[0], "config"> = {
      intake: {
        id,
        workspaceId: randomUUID(),
        text: "Plan",
        context: { serverId: "srv_fixture_book", projectId: "ship", workspaceId: "existing" },
        prime: null,
        projectKey: "ship",
        state: "routed",
        basis: null,
        primeRequest: null,
        primeReply: null,
        conversations: [],
        history: [],
        at: "2026-01-01T00:00:00.000Z",
      },
      project: {
        key: "ship",
        name: "Ship It",
        placements: [{ serverId: "srv_fixture_book", projectId: "ship" }],
        controllerProjectId: null,
        preferredContext: null,
      },
      api,
      deliveryId,
      agentId,
      canReuseContext: () => true,
      record: async (effect) => {
        effects.push(effect);
      },
    };
    await expect(
      createIntakeChat({
        ...request,
        config: { provider: "claude/opus", thinkingOptionId: "high", modeId: "auto-review" },
      }),
    ).rejects.toThrow("permission mode");
    expect(driver.creates).toEqual([]);
    expect(effects).toEqual([]);
    const result = await createIntakeChat({
      ...request,
      config: {
        provider: form.model,
        thinkingOptionId: form.thinking,
        modeId: form.modeId || undefined,
      },
    });
    expect(result).toEqual({ serverId: "srv_fixture_book", agentId });
    expect(driver.creates).toHaveLength(1);
    expect(driver.creates[0].config).toMatchObject({
      provider: "claude",
      model: "opus",
      modeId: "acceptEdits",
      cwd,
    });
    expect(manager.getAgent(agentId)?.config.modeId).toBe("acceptEdits");
    expect(effects.map((effect) => [effect.action, effect.state])).toEqual([
      ["reserve-chat", undefined],
      ["chat-result", "created"],
    ]);
    expect(launches).toBe(0);
  } finally {
    model.close();
    if (manager.getAgent(agentId)) await manager.closeAgent(agentId);
    await manager.flushForShutdown();
    await api.dispose();
    await driver.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});
