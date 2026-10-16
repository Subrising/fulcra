import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { ProjectDispatchSchema } from "@getpaseo/protocol/project-dispatch";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import type { AgentManager, AgentManagerEvent } from "../agent/agent-manager.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { sendPromptToAgent } from "../agent/agent-prompt.js";

function nextTurn(
  manager: AgentManager,
  match: (event: AgentManagerEvent) => boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      off();
      reject(new Error("Expected daemon turn did not finish"));
    }, 15_000);
    const off = manager.subscribe(
      (event) => {
        if (!match(event)) return;
        clearTimeout(timeout);
        off();
        resolve();
      },
      { replayState: false },
    );
  });
}

test("real daemon routes ledger events, reports one level, and retains follow-up session identity", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ledger-routing-daemon-"));
  const ledger = path.join(root, "ledgers", "sample", "OPEN-ITEMS.md");
  await mkdir(path.dirname(ledger), { recursive: true });
  const first =
    "| JOB-1 | Respond with exactly: DONE first verified | BUILD | builders | OPEN | — | fixture |";
  const second =
    "| JOB-2 | Respond with exactly: BLOCKED missing input | FIX | builders | OPEN | — | fixture |";
  const third =
    "| JOB-3 | Respond with exactly: DONE third verified | BUILD | builders | OPEN | — | fixture |";
  await writeFile(ledger, [first, second, third].join("\n"));
  vi.stubEnv("FULCRA_LEDGER_DIR", path.join(root, "ledgers"));
  const leadId = randomUUID();
  const ownerId = randomUUID();
  const prompts: string[] = [];
  const daemon = await createTestPaseoDaemon({
    agentClients: createTestAgentClients({
      onStartTurn: (prompt) => {
        if (typeof prompt === "string") prompts.push(prompt);
      },
    }),
    projectDispatch: {
      sample: ProjectDispatchSchema.parse({
        enabled: true,
        leadId,
        maxParallel: 1,
        roles: [
          {
            role: "implementation",
            owner: "builders",
            provider: "codex",
            model: "test-model",
            mode: "full-access",
            cwd: root,
          },
        ],
      }),
    },
  });
  const manager = daemon.daemon.agentManager;
  const storage = daemon.daemon.agentStorage;
  try {
    const health = await fetch(`http://127.0.0.1:${daemon.port}/api/health`);
    expect(health.ok).toBe(true);
    await manager.createAgent({ provider: "codex", cwd: root, modeId: "full-access" }, ownerId, {
      workspaceId: "sample",
      initialTitle: "Owner",
    });
    const finished = (item: string) =>
      nextTurn(
        manager,
        (event) =>
          event.type === "agent_stream" &&
          event.event.type === "turn_completed" &&
          manager.getAgent(event.agentId)?.labels["fulcra.item"] === item,
      );
    const notice = (line: string) =>
      nextTurn(
        manager,
        (event) =>
          event.type === "agent_stream" &&
          event.event.type === "turn_completed" &&
          event.agentId === leadId &&
          prompts.includes(`<paseo-system>\n${line}\n</paseo-system>`),
      );
    const firstFinished = finished("JOB-1");
    const firstNotice = notice("DONE first verified");
    await manager.createAgent({ provider: "codex", cwd: root, modeId: "full-access" }, leadId, {
      workspaceId: "sample",
      initialTitle: "Lead",
      labels: {
        "fulcra.project": "sample",
        "fulcra.role": "project-lead",
        "fulcra.reports-to": ownerId,
        "paseo.parent-agent-id": ownerId,
      },
    });
    await firstFinished;
    await firstNotice;
    expect(manager.listAgents().filter((a) => a.labels["fulcra.item"])).toHaveLength(1);
    const firstWorker = manager.listAgents().find((a) => a.labels["fulcra.item"] === "JOB-1")!;
    const secondFinished = finished("JOB-2");
    const secondNotice = notice("BLOCKED missing input");
    await writeFile(
      ledger,
      [first.replace("OPEN | —", "DONE | test passed"), second, third].join("\n"),
    );
    await secondFinished;
    await secondNotice;
    const secondWorker = manager.listAgents().find((a) => a.labels["fulcra.item"] === "JOB-2")!;
    expect(secondWorker.id).not.toBe(firstWorker.id);
    expect(manager.getTimeline(ownerId).filter((row) => row.type === "user_message")).toHaveLength(
      0,
    );
    expect(prompts.filter((p) => p.startsWith("<paseo-system>"))).toEqual([
      "<paseo-system>\nDONE first verified\n</paseo-system>",
      "<paseo-system>\nBLOCKED missing input\n</paseo-system>",
    ]);
    const followupFinished = finished("JOB-2");
    const followupNotice = notice("DECISION choose input");
    await manager.trustedPlugins.daemon(() =>
      sendPromptToAgent({
        agentManager: manager,
        agentStorage: storage,
        agentId: secondWorker.id,
        prompt: "Respond with exactly: DECISION choose input",
        logger: createTestLogger(),
      }),
    );
    await followupFinished;
    await followupNotice;
    expect(manager.getAgent(secondWorker.id)?.labels["fulcra.item"]).toBe("JOB-2");
    expect(manager.listAgents().filter((a) => a.labels["fulcra.item"])).toHaveLength(2);
  } finally {
    await daemon.close();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
