import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { canonicalTrustedPayload, type Sha256 } from "@getpaseo/protocol/trusted-input";
import type { TrustedPluginServerV11 } from "@getpaseo/plugin/server";
import { TrustedPlugins } from "./trusted.js";
import { AgentManager } from "../agent/agent-manager.js";
import { AgentStorage } from "../agent/agent-storage.js";
import { startAgentRun, sendPromptToAgent } from "../agent/agent-prompt.js";
import { promptPayload } from "../agent/trusted-operation.js";
import { TRUSTED_OPERATION } from "../agent/agent-sdk-types.js";
import { StaleProviderSessionError } from "../agent/stale-provider-session-error.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { createTestLogger } from "../../test-utils/test-logger.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "trusted-pipeline-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(join(directory, "agents"), logger);
  await storage.initialize();
  const host = new TrustedPlugins();
  host.initializeKnownAgents([]);
  let api!: TrustedPluginServerV11;
  const seen: { source: string; kind: string }[] = [];
  host.registerV11("controller", true, (server) => {
    api = server;
    server.admission.onInput((_agent, input) => {
      seen.push({ source: input.source, kind: input.kind });
      return "allow";
    });
  });
  const provider = vi.fn();
  const providerOperations: ReturnType<TrustedPlugins["captureOperation"]>[] = [];
  const manager = new AgentManager({
    logger,
    registry: storage,
    trustedPlugins: host,
    clients: {
      codex: createTestAgentClient("codex", {
        onStartTurn: (prompt) => {
          providerOperations.push(host.captureOperation());
          provider(prompt);
        },
      }),
    },
  });
  const agent = await manager.createAgent(
    {
      provider: "codex",
      cwd: directory,
      modeId: "full-access",
    },
    undefined,
    { workspaceId: undefined },
  );
  cleanups.push(async () => {
    await host.daemon(() => manager.closeAgent(agent.id));
    await manager.flush();
    host.close();
    await rm(directory, { recursive: true, force: true });
  });
  const token = (payload: ReturnType<typeof promptPayload>) =>
    api.issueProvenance({
      agentId: agent.id,
      kind: "prompt",
      messageId: "bound",
      attemptId: randomUUID(),
      payloadDigest: createHash("sha256")
        .update(
          canonicalTrustedPayload({
            agentId: agent.id,
            kind: "prompt",
            messageId: "bound",
            payload,
          }),
        )
        .digest("hex") as Sha256,
    });
  const send = (text: string, capability: string, activeTurnBehavior?: "steer") =>
    host.rpc(capability, () =>
      sendPromptToAgent({
        agentManager: manager,
        agentStorage: storage,
        agentId: agent.id,
        logger,
        prompt: text,
        messageId: "bound",
        activeTurnBehavior,
      }),
    );
  return { manager, host, agent, provider, providerOperations, logger, token, send, seen };
}

test.each([undefined, "steer"] as const)(
  "R1 M3: real send/start/replace/stream/provider pipeline (%s)",
  async (behavior) => {
    const f = await fixture();
    await startAgentRun(f.manager, f.agent.id, "sleep 30", f.logger);
    await vi.waitFor(() => expect(f.provider).toHaveBeenCalledOnce());
    const replace = vi.spyOn(f.manager, behavior ? "steerOrReplaceActiveTurn" : "replaceAgentRun");
    const stream = vi.spyOn(f.manager, "streamAgent");
    const payload = promptPayload(
      "approved",
      { clientMessageId: "bound" },
      {
        unarchive: true,
        replaceRunning: true,
        activeTurnBehavior: behavior,
        clearPendingPermissions: false,
      },
    );
    await expect(f.send("altered", f.token(payload), behavior)).rejects.toThrow(
      /provenance|payload/i,
    );
    expect(f.provider).toHaveBeenCalledTimes(1);
    await f.send("approved", f.token(payload), behavior);
    await vi.waitFor(() => expect(f.provider).toHaveBeenCalledWith("approved"));
    expect(f.providerOperations.at(-1)?.operation).toMatchObject({
      pluginId: "controller",
      agentId: f.agent.id,
      messageId: "bound",
    });
    expect(replace).toHaveBeenCalled();
    expect(stream).toHaveBeenCalled();
  },
);

test.each(["synchronous", "provider"] as const)(
  "R1 M1: %s stale reload and retry retain the admitted plugin binding",
  async (boundary) => {
    const f = await fixture();
    const actualStream = f.manager.streamAgent.bind(f.manager);
    if (boundary === "synchronous")
      vi.spyOn(f.manager, "streamAgent")
        .mockImplementationOnce(() => {
          throw new StaleProviderSessionError("fixture");
        })
        .mockImplementation(actualStream);
    else
      f.provider.mockImplementationOnce(() => {
        throw new StaleProviderSessionError("fixture");
      });
    const reload = vi.spyOn(f.manager, "reloadAgentSession");
    const before = f.host.requireSequence(f.agent.id).humanAt;
    const payload = promptPayload(
      "retry",
      { clientMessageId: "bound" },
      { unarchive: true, replaceRunning: true, clearPendingPermissions: false },
    );
    await f.send("retry", f.token(payload));
    await vi.waitFor(() =>
      expect(f.provider).toHaveBeenCalledTimes(boundary === "provider" ? 2 : 1),
    );
    expect(f.provider).toHaveBeenLastCalledWith("retry");
    expect(reload).toHaveBeenCalledOnce();
    expect(reload.mock.calls[0]?.[3]).toBeDefined();
    expect(f.seen).toContainEqual({ kind: "configure", source: "plugin" });
    expect(f.seen).not.toContainEqual({ kind: "configure", source: "daemon" });
    expect(f.host.requireSequence(f.agent.id).humanAt).toBe(before);
  },
);

test.each(["set-mode", "unarchive", "replaceRunning", "clearPendingPermissions"] as const)(
  "R1 nested rule %s refuses changed consequence before real provider",
  async (rule) => {
    const f = await fixture();
    const outer = {
      sessionMode: rule === "set-mode" ? "impossible-mode" : undefined,
      unarchive: rule === "unarchive",
      replaceRunning: rule === "replaceRunning",
      clearPendingPermissions: false,
    };
    const payload = promptPayload("work", { clientMessageId: "bound" }, outer);
    const handle = f.host.rpc(f.token(payload), () =>
      f.manager.withInput(f.agent.id, "prompt", "bound", (operation) => operation, payload),
    );
    if (rule === "unarchive") {
      // Fault injection at the real manager projection: simulate an unapplied unarchive.
      const getAgent = f.manager.getAgent.bind(f.manager);
      vi.spyOn(f.manager, "getAgent").mockImplementation((id) => {
        const live = getAgent(id);
        return live ? { ...live, archivedAt: "2030-01-01T00:00:00Z" } : live;
      });
    }
    await expect(
      startAgentRun(f.manager, f.agent.id, "work", f.logger, {
        replaceRunning: false,
        clearPendingPermissions: rule === "clearPendingPermissions",
        runOptions: { clientMessageId: "bound", [TRUSTED_OPERATION]: handle },
      }),
    ).rejects.toThrow(/Bound|changed/);
    expect(f.provider).not.toHaveBeenCalled();
  },
);

test("R1 minor 3: provider receives the normalized attachment whose digest was admitted", async () => {
  const f = await fixture();
  const prompt = [
    {
      type: "forge_change_request",
      mimeType: "application/paseo-forge-change-request",
      number: 1,
      title: "Review",
      url: "https://example.invalid/change/1",
    },
  ] as const;
  const payload = promptPayload(
    prompt as never,
    { clientMessageId: "bound" },
    { replaceRunning: false, clearPendingPermissions: false },
  );
  await f.host.rpc(f.token(payload), () =>
    startAgentRun(f.manager, f.agent.id, prompt as never, f.logger, {
      runOptions: { clientMessageId: "bound" },
    }),
  );
  await vi.waitFor(() => expect(f.provider).toHaveBeenCalled());
  expect(f.provider.mock.calls[0][0]).toEqual([{ ...prompt[0], forge: "github" }]);
  expect(prompt[0]).not.toHaveProperty("forge");
});
