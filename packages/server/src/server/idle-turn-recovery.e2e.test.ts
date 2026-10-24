import { expect, test } from "vitest";
import { REPORTS_TO_LABEL } from "@getpaseo/protocol/agent-labels";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import { createTestAgentClient } from "./test-utils/fake-agent-client.js";
import { IDLE_TURN_PROMPT } from "./idle-turn-recovery.js";

test("ReportUpService constructor attaches idle recovery to real daemon turn endings", async () => {
  const started: string[] = [];
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const recovered = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void recovered.catch(() => {});
  const provider = createTestAgentClient("codex", {
    response: (prompt) =>
      prompt === "fixture unfinished work"
        ? "I will wait for the background job notice."
        : "DONE: fixture work finished in the foreground",
    onStartTurn: (prompt) => {
      if (typeof prompt !== "string") return;
      started.push(prompt);
      if (prompt.includes("BLOCKED:")) reject(new Error(prompt));
    },
  });
  const h = await createTestPaseoDaemon({ agentClients: { codex: provider } });
  const manager = h.daemon.agentManager;
  let off = () => {};
  try {
    const parent = await manager.createAgent(
      {
        provider: "codex",
        cwd: h.paseoHome,
        title: "Parent",
      },
      undefined,
      { workspaceId: undefined },
    );
    const worker = await manager.createAgent(
      {
        provider: "codex",
        cwd: h.paseoHome,
        title: "Worker",
      },
      undefined,
      { workspaceId: undefined, labels: { [REPORTS_TO_LABEL]: parent.id } },
    );
    off = manager.subscribe(
      (event) => {
        if (
          event.type === "agent_stream" &&
          event.agentId === worker.id &&
          event.event.type === "turn_completed" &&
          started.includes(IDLE_TURN_PROMPT)
        )
          resolve();
      },
      { replayState: false },
    );
    await manager.runAgent(worker.id, "fixture unfinished work");
    await recovered;
    expect(started.filter((prompt) => prompt === IDLE_TURN_PROMPT)).toHaveLength(1);
    expect(await manager.getLastAssistantMessage(worker.id)).toContain(
      "DONE: fixture work finished in the foreground",
    );
  } finally {
    off();
    await h.close();
  }
}, 20000);
