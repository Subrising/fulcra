import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import {
  LIMIT_RESUME_AT_LABEL,
  RESUME_PROMPT,
  limitResumeFilePath,
} from "../limit-resume/service.js";

test("bootstrap recovers a persisted limit stop once, and a second restart cannot replay it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "limit-restart-"));
  const prompts: unknown[] = [];
  let resumeAccepted = () => {};
  const accepted = new Promise<void>((resolve) => (resumeAccepted = resolve));
  let daemon: TestPaseoDaemon | undefined;
  const clients = () => ({
    codex: createTestAgentClient("codex", {
      onStartTurn: (prompt) => {
        prompts.push(prompt);
        if (prompt === "trigger-limit") throw new Error("usage limit reached");
        if (prompt === RESUME_PROMPT) resumeAccepted();
      },
    }),
  });
  const boot = () =>
    createTestPaseoDaemon({ paseoHomeRoot: root, cleanup: false, agentClients: clients() });
  try {
    daemon = await boot();
    const manager = daemon.daemon.agentManager;
    const agent = await manager.createAgent(
      {
        provider: "codex",
        cwd: root,
        modeId: "full-access",
        model: "gpt-6.1-sol",
        thinkingOptionId: "high",
      },
      undefined,
      {},
    );
    // The real failed-turn event must reach the bootstrap listener and write the durable queue.
    const queued = new Promise<void>((resolve) => {
      const off = manager.subscribe(
        (event) => {
          if (
            event.type === "agent_state" &&
            event.agent.id === agent.id &&
            event.agent.labels[LIMIT_RESUME_AT_LABEL]
          ) {
            off();
            resolve();
          }
        },
        { replayState: false },
      );
    });
    await expect(manager.runAgent(agent.id, "trigger-limit")).rejects.toThrow(
      "usage limit reached",
    );
    await queued;
    await daemon.close();
    const file = limitResumeFilePath(daemon.paseoHome);
    const captured = JSON.parse(await readFile(file, "utf8"));
    expect(captured.entries).toHaveLength(1);
    expect(captured.entries[0].agentId).toBe(agent.id);
    // Advance this captured queue's due time without waiting for the real 15 minute reset.
    captured.entries[0].resumeAt = Date.now() + 300;
    await writeFile(file, JSON.stringify(captured));
    daemon = await boot();
    await accepted;
    await daemon.daemon.agentManager.waitForAgentEvent(agent.id);
    expect(prompts).toEqual(["trigger-limit", RESUME_PROMPT]);
    const consumed = JSON.parse(await readFile(file, "utf8"));
    expect(consumed.entries).toEqual([]);
    expect(consumed.recent[agent.id].limitId).toBe(captured.entries[0].limitId);
    expect(daemon.daemon.agentManager.getAgent(agent.id)?.labels[LIMIT_RESUME_AT_LABEL]).toBe("");
    await daemon.close();
    daemon = await boot();
    // One bounded observation period; no provider calls or status polling.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(prompts).toEqual(["trigger-limit", RESUME_PROMPT]);
    expect(JSON.parse(await readFile(file, "utf8")).entries).toEqual([]);
  } finally {
    await daemon?.close();
    if (daemon) await rm(daemon.staticDir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
