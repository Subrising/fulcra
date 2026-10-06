import { afterEach, expect, test, vi } from "vitest";
import { AgentManager } from "./agent-manager.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import * as baseline from "./host-public-baseline.js";
afterEach(() => vi.restoreAllMocks());
test("actual Manager launch preparation chooses host loader without caller path/env and excludes history/internal/other provider", async () => {
  const read = vi.spyOn(baseline, "readHostPublicCodexBaseline").mockResolvedValue(undefined);
  const codex = createTestAgentClient("codex"),
    claude = createTestAgentClient("claude");
  const manager = new AgentManager({ clients: { codex, claude }, logger: createTestLogger() });
  const build = Reflect.get(manager, "buildLaunchContext").bind(manager);
  const env = {
    CODEX_HOME: "/fixture-account",
    HOME: "/caller-cannot-select-baseline",
    FULCRA_ACCOUNT_ID: "fixture-account",
  };
  const one = await build("one", codex, "/fixture-project", undefined, env, {
    purpose: "interactive",
    internal: false,
  });
  expect(read).toHaveBeenCalledWith();
  expect(one.env).toMatchObject(env);
  expect(one.env).not.toBe(env);
  for (const opening of [{ purpose: "history" }, { purpose: "interactive", internal: true }])
    await build("two", codex, "/fixture-project", undefined, env, opening);
  await build("three", claude, "/fixture-project", undefined, env, { purpose: "interactive" });
  expect(read).toHaveBeenCalledTimes(1);
  expect(env).toEqual({
    CODEX_HOME: "/fixture-account",
    HOME: "/caller-cannot-select-baseline",
    FULCRA_ACCOUNT_ID: "fixture-account",
  });
});

test("private transport event updates only live digest projection without model/run/permission changes or dispatching a public stream event", async () => {
  vi.spyOn(baseline, "readHostPublicCodexBaseline").mockResolvedValue(undefined);
  const client = createTestAgentClient("codex"),
    manager = new AgentManager({ clients: { codex: client }, logger: createTestLogger() });
  const publicAgent = await manager.createAgent(
    {
      provider: "codex",
      cwd: "/tmp",
      model: "gpt-6.1-sol",
      thinkingOptionId: "high",
      modeId: "full-access",
    },
    undefined,
    { workspaceId: undefined },
  );
  const agent = Reflect.get(manager, "agents").get(publicAgent.id),
    before = {
      model: agent.config.model,
      lifecycle: agent.lifecycle,
      permissions: agent.pendingPermissions.size,
      activeTurn: agent.activeTurnId,
    };
  const receipt = {
    version: 1 as const,
    state: "SUBMITTED" as const,
    baselineSha256: "a".repeat(64),
    developerInstructionsSha256: "b".repeat(64),
    files: [],
  };
  const event = {
    type: "host_public_baseline_transport",
    provider: "codex",
    nativeSessionId: agent.session.id,
    receipt,
  };
  const handle = Reflect.get(manager, "handleStreamEvent").bind(manager);
  const dispatched: string[] = [];
  const unsubscribe = manager.subscribe((observed) => dispatched.push(observed.type), {
    replayState: false,
  });
  try {
    await handle(agent, event);
    await manager.flush();
    expect(manager.getAgent(agent.id)?.runtimeInfo?.extra?.hostPublicBaselineTransport).toEqual(
      receipt,
    );
    expect(dispatched).not.toContain("agent_stream");
    expect({
      model: agent.config.model,
      lifecycle: agent.lifecycle,
      permissions: agent.pendingPermissions.size,
      activeTurn: agent.activeTurnId,
    }).toEqual(before);
    await handle(agent, {
      ...event,
      nativeSessionId: "wrong-native",
      receipt: { ...receipt, baselineSha256: "c".repeat(64) },
    });
    await manager.flush();
    expect(manager.getAgent(agent.id)?.runtimeInfo?.extra?.hostPublicBaselineTransport).toEqual(
      receipt,
    );
  } finally {
    unsubscribe();
    await manager.closeAgent(agent.id);
    await manager.flush();
  }
});
