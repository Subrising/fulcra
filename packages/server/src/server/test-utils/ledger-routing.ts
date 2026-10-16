import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { vi } from "vitest";
import type { ProjectDispatch } from "@getpaseo/protocol/project-dispatch";
import { ProjectDispatchSchema } from "@getpaseo/protocol/project-dispatch";
import { AgentManager } from "../agent/agent-manager.js";
import { AgentStorage } from "../agent/agent-storage.js";
import type { BoundCreateAgentCommand } from "../agent/create-agent/create.js";
import { createAgentCommand } from "../agent/create-agent/create.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { createProviderSnapshotManagerStub } from "../test-utils/session-stubs.js";
import {
  LedgerRoutingService,
  parseDispatchRows,
  dispatchRowDigest,
} from "../ledger-routing/service.js";
import type { LineAgent } from "../reporting-lines.js";

export function row(
  id = "JOB-1",
  status = "READY",
  brief = "Respond with exactly: DONE checked",
  kind = "BUILD",
  owner = "builders",
): string {
  return `| ${id} | ${brief} | ${kind} | ${owner} | ${status} | — | fixture |`;
}
export function response(prompt: string): string {
  const block = /<untrusted-ledger-data encoding="base64">([^<]+)<\/untrusted-ledger-data>/.exec(
    prompt,
  );
  if (!block) return "Observed report";
  const data = JSON.parse(Buffer.from(block[1], "base64").toString());
  return String(data.description).replace(/^Respond with exactly: /, "");
}
export async function fixture(options: { cap?: number; enabled?: boolean; account?: string } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "ledger-routing-"));
  const ledgerDir = path.join(root, "ledgers");
  await mkdir(path.join(ledgerDir, "sample"), { recursive: true });
  const file = path.join(ledgerDir, "sample", "OPEN-ITEMS.md");
  await writeFile(file, "");
  const logger = createTestLogger();
  const starts: string[] = [];
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const manager = new AgentManager({
    registry: storage,
    logger,
    clients: createTestAgentClients({
      accountLabel: options.account ?? "personal-workspace-api",
      response,
      onStartTurn: (prompt) => {
        if (typeof prompt === "string") starts.push(prompt);
      },
    }),
  });
  const lead = await manager.createAgent(
    { provider: "codex", cwd: root, model: "test-model", modeId: "full-access" },
    undefined,
    { workspaceId: "sample", labels: { "fulcra.project": "sample" }, initialTitle: "Lead" },
  );
  const config = ProjectDispatchSchema.parse({
    enabled: options.enabled ?? true,
    enableId: randomUUID(),
    hostId: "srv_test",
    daemonHome: root,
    ledgerRoot: ledgerDir,
    leadId: lead.id,
    maxParallel: options.cap ?? 1,
    minStartIntervalSeconds: 1,
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
  const providers = createProviderSnapshotManagerStub();
  providers.resolveCreateConfig.mockImplementation(async ({ requestedMode }) => ({
    modeId: requestedMode,
  }));
  const createAgent = vi.fn<BoundCreateAgentCommand>((input) =>
    createAgentCommand(
      {
        agentManager: manager,
        agentStorage: storage,
        logger,
        providerSnapshotManager: providers.manager,
      },
      input,
    ),
  );
  const clock = { now: 1_000_000 };
  const switches = { enabled: true };
  const notify = vi.fn(async (_lead: string, _line: string, _id: string) => {});
  const deps = {
    statePath: path.join(root, "routing.json"),
    ledgerDir,
    hostId: "srv_test",
    daemonHome: root,
    enabled: () => switches.enabled,
    config: (): Record<string, ProjectDispatch> => ({ sample: config }),
    agentManager: manager,
    agentStorage: storage,
    createAgent,
    ensureWorkspace: async () => "sample",
    logger,
    notify,
    now: () => clock.now,
  };
  const services = [new LedgerRoutingService(deps)];
  const routing = services[0];
  const ledger = async (lines: string[]) => writeFile(file, lines.join("\n"));
  const approve = async (line: string, addedBy = "owner") => {
    const data = parseDispatchRows(line)[0];
    const cwd = path.join(root, data.id);
    await mkdir(cwd, { recursive: true });
    config.approvals[data.id] = {
      generation: randomUUID(),
      digest: dispatchRowDigest(data),
      addedBy,
      cwd,
    };
    return data;
  };
  const worker = (id = "JOB-1") =>
    manager.listAgents().find((a) => a.labels["fulcra.item"] === id)!;
  const end = async (agent: LineAgent, text = "DONE checked", fromNotice = false) => {
    await manager.waitForAgentEvent(agent.id);
    clock.now += 2000;
    return routing.observeEnd({
      worker: agent,
      eventId: randomUUID(),
      text,
      failed: false,
      fromNotice,
    });
  };
  const close = async (id = "JOB-1") => {
    const lines = (await readFile(file, "utf8")).split("\n").map((line) => {
      const data = parseDispatchRows(line)[0];
      if (!data || data.id !== id) return line;
      return `| ${data.id} | ${data.brief} | ${data.kind} | ${data.owner} | DONE | test passed | ${data.source} |`;
    });
    await ledger(lines);
  };
  const state = async () => JSON.parse(await readFile(deps.statePath, "utf8"));
  const extra = (patch: Partial<typeof deps> = {}) => {
    const service = new LedgerRoutingService({ ...deps, ...patch });
    services.push(service);
    return service;
  };
  const cleanup = async () => {
    for (const service of services) await service.stop();
    manager.prepareForShutdown();
    await Promise.all(manager.listAgents().map((a) => manager.closeAgent(a.id)));
    await manager.flushForShutdown();
    await storage.flush();
    await rm(root, { recursive: true, force: true });
  };
  return {
    root,
    ledgerDir,
    file,
    manager,
    storage,
    lead,
    config,
    clock,
    switches,
    routing,
    deps,
    createAgent,
    starts,
    notify,
    ledger,
    approve,
    worker,
    end,
    close,
    state,
    extra,
    cleanup,
  };
}
