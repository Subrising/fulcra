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

test("daemon restart loads the saved lead without a prompt and dispatches the next closed-item slot once", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ledger-routing-restart-"));
  const ledgerDir = path.join(root, "ledgers");
  const file = path.join(ledgerDir, "sample", "OPEN-ITEMS.md");
  await mkdir(path.dirname(file), { recursive: true });
  vi.stubEnv("FULCRA_LEDGER_DIR", ledgerDir);
  const leadId = randomUUID();
  const first =
    "| JOB-1 | Respond with exactly: DONE checked | BUILD | builders | OPEN | — | fixture |";
  const nextBrief = "Respond with exactly: BLOCKED input needed";
  await writeFile(file, first);
  const options = {
    paseoHomeRoot: path.join(root, "daemon"),
    staticDir: path.join(root, "static"),
    cleanup: false,
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
  };
  await mkdir(options.staticDir);
  let daemon = await createTestPaseoDaemon({ ...options, agentClients: createTestAgentClients() });
  try {
    const manager = daemon.daemon.agentManager;
    const reported = nextTurn(
      manager,
      (event) =>
        event.type === "agent_stream" &&
        event.event.type === "turn_completed" &&
        event.agentId === leadId,
    );
    await manager.createAgent({ provider: "codex", cwd: root, modeId: "full-access" }, leadId, {
      workspaceId: "sample",
      initialTitle: "Lead",
      labels: { "fulcra.project": "sample", "fulcra.role": "project-lead" },
    });
    await reported;
    const previous = manager.listAgents().find((agent) => agent.labels["fulcra.item"] === "JOB-1")!;
    expect(previous).toBeTruthy();
    await daemon.close();
    await writeFile(
      file,
      [
        first.replace("OPEN | —", "DONE | test passed"),
        `| JOB-2 | ${nextBrief} | FIX | builders | OPEN | — | fixture |`,
      ].join("\n"),
    );
    const starts: string[] = [];
    let started = () => {};
    const nextStarted = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Restart did not dispatch the next item")),
        15_000,
      );
      started = () => {
        clearTimeout(timeout);
        resolve();
      };
    });
    void nextStarted.catch(() => {});
    daemon = await createTestPaseoDaemon({
      ...options,
      agentClients: createTestAgentClients({
        onStartTurn: (prompt) => {
          if (typeof prompt !== "string") return;
          starts.push(prompt);
          if (prompt === nextBrief) started();
        },
      }),
    });
    await nextStarted;
    const next = daemon.daemon.agentManager
      .listAgents()
      .find((agent) => agent.labels["fulcra.item"] === "JOB-2")!;
    expect(next.id).not.toBe(previous.id);
    expect(next.labels["paseo.parent-agent-id"]).toBe(leadId);
    await daemon.daemon.agentManager.waitForAgentEvent(next.id);
    expect(starts.filter((prompt) => !prompt.startsWith("<paseo-system>"))).toEqual([nextBrief]);
    expect(
      (await daemon.daemon.agentStorage.list()).filter((agent) => agent.labels["fulcra.item"]),
    ).toHaveLength(2);
  } finally {
    await daemon.close();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
