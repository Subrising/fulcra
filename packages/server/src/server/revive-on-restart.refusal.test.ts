import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";
import { createTestLogger } from "../test-utils/test-logger.js";
import { AgentManager } from "./agent/agent-manager.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import { defaultSessions } from "./revive-on-restart.js";

// FU-422: a revive prompt refused at the final input check leaves the session idle.
async function setup() {
  const manager = new AgentManager({
    clients: createTestAgentClients(),
    logger: createTestLogger(),
  });
  const created = await manager.createAgent(
    { provider: "claude", cwd: mkdtempSync(join(tmpdir(), "revive-refusal-")) },
    undefined,
    { workspaceId: undefined },
  );
  const id = created.id;
  const events: string[] = [];
  manager.subscribe(
    (event) => {
      if (event.type === "agent_stream") events.push(event.event.type);
    },
    { replayState: false },
  );
  const lines: Array<{ fields: Record<string, unknown>; message: string }> = [];
  const logger = {
    ...createTestLogger(),
    info: (fields: Record<string, unknown>, message: string) => lines.push({ fields, message }),
    warn: (fields: Record<string, unknown>, message: string) => lines.push({ fields, message }),
  } as unknown as ReturnType<typeof createTestLogger>;
  const sessions = defaultSessions({
    agentManager: manager,
    agentStorage: {} as AgentStorage,
    paseoHome: "",
    localServerId: null,
    logger,
    isEnabled: () => true,
  });
  /** The first check passes; the final check inside runAgent reads the changed state. */
  const changeAfterFirstCheck = (change: () => void) => {
    const original = manager.canRunUnscopedLimitResume.bind(manager);
    let calls = 0;
    vi.spyOn(manager, "canRunUnscopedLimitResume").mockImplementation((agentId) => {
      if (++calls > 1) change();
      return original(agentId);
    });
  };
  const managed = () =>
    (manager as unknown as { agents: Map<string, Record<string, unknown>> }).agents.get(id)!;
  const withdrawn = () =>
    lines.filter((line) => line.message === "Revive on restart: prompt withdrawn");
  return { manager, id, sessions, events, lines, withdrawn, changeAfterFirstCheck, managed };
}

describe("revive prompt refused at the final input check (FU-422)", () => {
  test("a refusal leaves the session idle: no failed turn, no error, one log line", async () => {
    const f = await setup();
    f.changeAfterFirstCheck(() => {
      f.managed().instanceId = "another-instance";
    });
    const outcome = await f.sessions.sendBackgroundWake(f.id, "wake", null);
    expect(outcome).toBe("withdrawn");
    expect(f.manager.getAgent(f.id)!.lifecycle).toBe("idle");
    expect(f.events).not.toContain("turn_failed");
    expect(f.withdrawn()).toHaveLength(1);
    expect(f.withdrawn()[0]!.fields).toMatchObject({ agentId: f.id, mode: "wake" });
    expect(f.withdrawn()[0]!.fields.reason).toBe("the session instance changed");
  });

  test("the pool-account refusal after load is withdrawn and left to limit-resume", async () => {
    const f = await setup();
    let calls = 0;
    vi.spyOn(f.manager, "getLimitResumeBinding").mockImplementation(() =>
      ++calls > 1 ? "pool" : null,
    );
    const outcome = await f.sessions.sendContinue(f.id, null);
    expect(outcome).toBe("withdrawn");
    expect(f.manager.getAgent(f.id)!.lifecycle).toBe("idle");
    expect(f.events).not.toContain("turn_failed");
    expect(f.withdrawn()).toHaveLength(1);
    expect(f.withdrawn()[0]!.fields).toMatchObject({
      mode: "continue",
      reason: "pool account: limit-resume continues it",
    });
  });

  test("a new message during the window: no prompt and no error", async () => {
    const f = await setup();
    f.changeAfterFirstCheck(() => {
      f.managed().lastUserMessageAt = new Date();
    });
    const outcome = await f.sessions.sendContinue(f.id, null);
    expect(outcome).toBe("withdrawn");
    expect(f.manager.getAgent(f.id)!.lifecycle).toBe("idle");
    expect(f.events).not.toContain("turn_failed");
    expect(f.withdrawn()[0]!.fields.reason).toBe("a new message arrived since the restart");
  });
});

describe("revive prompt on the real manager (FU-422)", () => {
  test("a clean session gets the prompt: its own registered run is not a refusal", async () => {
    const f = await setup();
    await expect(f.sessions.sendBackgroundWake(f.id, "wake", null)).resolves.toBeUndefined();
    expect(f.withdrawn()).toHaveLength(0);
  });
});
