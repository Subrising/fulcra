import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { ProjectDispatchSchema } from "@getpaseo/protocol/project-dispatch";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { row, response } from "../test-utils/ledger-routing.js";
import { parseDispatchRows, dispatchRowDigest } from "./ledger.js";
import type { AgentPromptInput } from "../agent/agent-sdk-types.js";
import type { AgentManager, AgentManagerEvent } from "../agent/agent-manager.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { sendPromptToAgent } from "../agent/agent-prompt.js";
function nextTurn(
  manager: AgentManager,
  match: (event: AgentManagerEvent) => boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error("Expected daemon turn did not finish"));
    }, 15000);
    const off = manager.subscribe(
      (event) => {
        if (match(event)) {
          clearTimeout(timer);
          off();
          resolve();
        }
      },
      { replayState: false },
    );
  });
}
async function noticeTurn(manager: AgentManager, lead: string, line: string): Promise<void> {
  const messageId = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`Missing lead receipt: ${line}`));
    }, 15000);
    const off = manager.subscribe(
      (event) => {
        if (
          event.type !== "agent_stream" ||
          event.agentId !== lead ||
          event.event.type !== "timeline"
        )
          return;
        const item = event.event.item;
        if (item.type !== "user_message" || !item.text.includes(line) || !item.clientMessageId)
          return;
        clearTimeout(timer);
        off();
        resolve(item.clientMessageId);
      },
      { replayState: false },
    );
  });
  const result = await manager.waitForMessageTurn(lead, messageId, AbortSignal.timeout(15000));
  expect(result.permission).toBeNull();
  expect(result.status).not.toBe("error");
}
async function environment() {
  const root = await mkdtemp(path.join(tmpdir(), "ledger-routing-daemon-"));
  const ledgerRoot = path.join(root, "ledgers");
  const file = path.join(ledgerRoot, "sample", "OPEN-ITEMS.md");
  const paseoHomeRoot = path.join(root, "daemon");
  const daemonHome = path.join(paseoHomeRoot, ".paseo");
  const hostId = `srv_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await mkdir(path.dirname(file), { recursive: true });
  await mkdir(daemonHome, { recursive: true });
  await writeFile(path.join(daemonHome, "server-id"), hostId);
  const leadId = randomUUID();
  const ownerId = randomUUID();
  const prompts: string[] = [];
  const lines = [
    row("JOB-1", "READY", "Respond with exactly: DONE verified"),
    row("JOB-2", "READY", "Respond with exactly: BLOCKED missing input"),
    row("JOB-3"),
  ];
  const approvals: Record<
    string,
    { generation: string; digest: string; addedBy: string; cwd: string }
  > = {};
  for (const line of lines) {
    const data = parseDispatchRows(line)[0];
    const cwd = path.join(root, data.id);
    await mkdir(cwd);
    approvals[data.id] = {
      generation: randomUUID(),
      digest: dispatchRowDigest(data),
      addedBy: "owner",
      cwd,
    };
  }
  const config = ProjectDispatchSchema.parse({
    enabled: true,
    enableId: randomUUID(),
    hostId,
    daemonHome,
    ledgerRoot,
    leadId,
    maxParallel: 1,
    minStartIntervalSeconds: 1,
    approvals,
    roles: [
      {
        role: "implementation",
        owner: "builders",
        provider: "codex",
        model: "test-model",
        mode: "auto",
      },
    ],
  });
  const staticDir = path.join(root, "static");
  await mkdir(staticDir);
  vi.stubEnv("FULCRA_LEDGER_DIR", ledgerRoot);
  vi.stubEnv("PASEO_SERVER_ID", hostId);
  const options = {
    paseoHomeRoot,
    staticDir,
    cleanup: false,
    ledgerDispatchEnabled: true,
    projectDispatch: { sample: config },
    agentClients: createTestAgentClients({
      accountLabel: "personal-workspace-api",
      response,
      onStartTurn: (prompt: AgentPromptInput) => {
        if (typeof prompt === "string") prompts.push(prompt);
      },
    }),
  };
  await writeFile(file, lines.join("\n"));
  return { root, file, leadId, ownerId, prompts, options };
}
async function closeItem(file: string, id: string): Promise<void> {
  const lines = (await readFile(file, "utf8")).split("\n").map((line) => {
    const r = parseDispatchRows(line)[0];
    if (!r || r.id !== id) return line;
    return `| ${r.id} | ${r.brief} | ${r.kind} | ${r.owner} | DONE | test passed | ${r.source} |`;
  });
  await writeFile(file, lines.join("\n"));
}
test("real daemon claims READY work, reports one level, and keeps a follow-up in the same session", async () => {
  const f = await environment();
  const daemon = await createTestPaseoDaemon(f.options);
  const manager = daemon.daemon.agentManager;
  const notice = (line: string) =>
    noticeTurn(manager, f.leadId, line).catch(async (error: unknown) => {
      const journal = await readFile(
        path.join(f.options.paseoHomeRoot, ".paseo", "ledger-routing.json"),
        "utf8",
      ).catch(() => "missing journal");
      const agents = manager
        .listAgents()
        .map((agent) => ({ item: agent.labels["fulcra.item"], lifecycle: agent.lifecycle }));
      throw new Error(
        `${error instanceof Error ? error.message : error}; agents=${JSON.stringify(agents)}; journal=${journal}`,
      );
    });
  try {
    expect((await fetch(`http://127.0.0.1:${daemon.port}/api/health`)).ok).toBe(true);
    await manager.createAgent(
      { provider: "codex", cwd: f.root, modeId: "full-access" },
      f.ownerId,
      { workspaceId: "sample", initialTitle: "Owner" },
    );
    const first = notice("DONE verified");
    await manager.createAgent({ provider: "codex", cwd: f.root, modeId: "full-access" }, f.leadId, {
      workspaceId: "sample",
      initialTitle: "Lead",
      labels: {
        "fulcra.project": "sample",
        "fulcra.role": "project-lead",
        "fulcra.reports-to": f.ownerId,
        "paseo.parent-agent-id": f.ownerId,
      },
    });
    await first;
    const previous = manager.listAgents().find((a) => a.labels["fulcra.item"] === "JOB-1")!;
    expect(manager.listAgents().filter((a) => a.labels["fulcra.item"])).toHaveLength(1);
    await delay(1100);
    const second = notice("BLOCKED missing input");
    await closeItem(f.file, "JOB-1");
    await second;
    const current = manager.listAgents().find((a) => a.labels["fulcra.item"] === "JOB-2")!;
    expect(current.id).not.toBe(previous.id);
    expect(current.cwd).not.toBe(previous.cwd);
    expect(manager.getTimeline(f.ownerId).filter((r) => r.type === "user_message")).toHaveLength(0);
    const followup = notice("DECISION choose input");
    await manager.trustedPlugins.daemon(() =>
      sendPromptToAgent({
        agentManager: manager,
        agentStorage: daemon.daemon.agentStorage,
        agentId: current.id,
        prompt:
          '<untrusted-ledger-data encoding="base64">' +
          Buffer.from(
            JSON.stringify({ description: "Respond with exactly: DECISION choose input" }),
          ).toString("base64") +
          "</untrusted-ledger-data>",
        logger: createTestLogger(),
      }),
    );
    await followup;
    expect(manager.getAgent(current.id)?.labels["fulcra.item"]).toBe("JOB-2");
    expect(manager.listAgents().filter((a) => a.labels["fulcra.item"])).toHaveLength(2);
  } finally {
    await daemon.close();
    vi.unstubAllEnvs();
    await rm(f.root, { recursive: true, force: true });
  }
});
test("real daemon restart keeps claim receipts and starts the next closed-item slot once", async () => {
  const f = await environment();
  let daemon = await createTestPaseoDaemon(f.options);
  try {
    const manager = daemon.daemon.agentManager;
    const reported = nextTurn(
      manager,
      (e) =>
        e.type === "agent_stream" && e.event.type === "turn_completed" && e.agentId === f.leadId,
    );
    await manager.createAgent({ provider: "codex", cwd: f.root, modeId: "full-access" }, f.leadId, {
      workspaceId: "sample",
      initialTitle: "Lead",
      labels: { "fulcra.project": "sample", "fulcra.role": "project-lead" },
    });
    await reported;
    const previous = manager.listAgents().find((a) => a.labels["fulcra.item"] === "JOB-1")!;
    await daemon.close();
    await delay(1100);
    await closeItem(f.file, "JOB-1");
    let resolveStarted = () => {};
    const started = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Restart did not dispatch next item")),
        15000,
      );
      resolveStarted = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    void started.catch(() => {});
    const resumedPrompts: string[] = [];
    daemon = await createTestPaseoDaemon({
      ...f.options,
      agentClients: createTestAgentClients({
        accountLabel: "personal-workspace-api",
        response,
        onStartTurn: (prompt: AgentPromptInput) => {
          if (typeof prompt !== "string") return;
          resumedPrompts.push(prompt);
          if (prompt.includes("<untrusted-ledger-data")) resolveStarted();
        },
      }),
    });
    await started;
    const next = daemon.daemon.agentManager
      .listAgents()
      .find((a) => a.labels["fulcra.item"] === "JOB-2")!;
    expect(next.id).not.toBe(previous.id);
    await daemon.daemon.agentManager.waitForAgentEvent(next.id);
    expect(resumedPrompts.filter((p) => p.includes("<untrusted-ledger-data"))).toHaveLength(1);
    expect(
      (await daemon.daemon.agentStorage.list()).filter((a) => a.labels["fulcra.item"]),
    ).toHaveLength(2);
  } finally {
    await daemon.close();
    vi.unstubAllEnvs();
    await rm(f.root, { recursive: true, force: true });
  }
});
