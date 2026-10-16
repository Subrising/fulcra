import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { ProjectDispatchSchema } from "@getpaseo/protocol/messages";
import { AgentManager } from "../agent/agent-manager.js";
import { AgentStorage } from "../agent/agent-storage.js";
import type { BoundCreateAgentCommand } from "../agent/create-agent/create.js";
import { createAgentCommand } from "../agent/create-agent/create.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { createProviderSnapshotManagerStub } from "../test-utils/session-stubs.js";
import { LedgerRoutingService, parseWorkerResult, parseDispatchRows } from "./service.js";
import type { LineAgent } from "../reporting-lines.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function fixture(options: { enabled?: boolean; cap?: number } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "ledger-routing-"));
  const ledgerDir = path.join(root, "ledgers");
  await mkdir(path.join(ledgerDir, "sample"), { recursive: true });
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const starts: string[] = [];
  const manager = new AgentManager({
    registry: storage,
    logger,
    clients: createTestAgentClients({
      onStartTurn: (prompt) => {
        if (typeof prompt === "string") starts.push(prompt);
      },
    }),
  });
  const lead = await manager.createAgent(
    { provider: "codex", cwd: root, model: "test-model", modeId: "full-access" },
    undefined,
    {
      workspaceId: "sample-workspace",
      labels: { "fulcra.project": "sample" },
      initialTitle: "Sample lead",
    },
  );
  const config = ProjectDispatchSchema.parse({
    enabled: options.enabled ?? true,
    leadId: lead.id,
    maxParallel: options.cap ?? 1,
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
  });
  const providers = createProviderSnapshotManagerStub();
  providers.resolveCreateConfig.mockImplementation(async ({ requestedMode }) => ({
    modeId: requestedMode,
  }));
  const createAgent = vi.fn<BoundCreateAgentCommand>();
  createAgent.mockImplementation((input) =>
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
  const deps = {
    statePath: path.join(root, "routing.json"),
    ledgerDir,
    config: () => ({ sample: config }),
    agentManager: manager,
    agentStorage: storage,
    createAgent,
    logger,
    ensureWorkspace: async () => "sample-workspace",
  };
  const routing = new LedgerRoutingService(deps);
  cleanups.push(async () => {
    routing.stop();
    manager.prepareForShutdown();
    await Promise.all(manager.listAgents().map((a) => manager.closeAgent(a.id)));
    await manager.flushForShutdown();
    await storage.flush();
    await rm(root, { recursive: true, force: true });
  });
  const ledger = async (rows: string[]) =>
    writeFile(path.join(ledgerDir, "sample", "OPEN-ITEMS.md"), rows.join("\n"));
  const worker = async (item = "JOB-1") =>
    manager.createAgent({ provider: "codex", cwd: root }, undefined, {
      workspaceId: "sample-workspace",
      labels: {
        "fulcra.project": "sample",
        "fulcra.role": "implementation",
        "fulcra.item": item,
        "fulcra.reports-to": lead.id,
        "paseo.parent-agent-id": lead.id,
      },
    });
  const end = (
    agent: LineAgent,
    text: string,
    eventId = "end-1",
    failed = false,
    fromNotice = false,
  ) => routing.observeEnd({ worker: agent, eventId, text, failed, fromNotice });
  return {
    root,
    manager,
    storage,
    lead,
    config,
    routing,
    deps,
    createAgent,
    starts,
    ledger,
    worker,
    end,
  };
}
const ready = (id = "JOB-2", kind = "BUILD", owner = "builders") =>
  `| ${id} | Respond with exactly: DONE tested | ${kind} | ${owner} | OPEN | — | fixture |`;
const closed = (evidence = "test passed") =>
  `| JOB-1 | Previous task | BUILD | builders | DONE | ${evidence} | fixture |`;

test("only the final literal result line selects a state", () => {
  expect(parseWorkerResult("progress\nDONE tests passed\n")).toEqual({
    state: "DONE",
    line: "DONE tests passed",
  });
  for (const text of [
    "DONE\nstill working",
    "BLOCKED",
    "DECISION",
    "done",
    "`DONE`",
    "prefix DONE",
  ])
    expect(parseWorkerResult(text)).toBeNull();
  expect(parseWorkerResult("BLOCKED missing input")?.state).toBe("BLOCKED");
  expect(parseWorkerResult("DECISION choose one")?.state).toBe("DECISION");
  expect(parseDispatchRows(ready())[0]?.brief).toBe("Respond with exactly: DONE tested");
});

test("DONE and evidence closure start one fresh session with the exact item brief", async () => {
  const f = await fixture();
  const worker = await f.worker();
  await f.ledger([closed(), ready()]);
  await f.end(worker, "DONE tests passed");
  expect(f.createAgent).toHaveBeenCalledTimes(1);
  const next = f.manager.listAgents().find((a) => a.labels["fulcra.item"] === "JOB-2");
  expect(next?.id).toBeTruthy();
  expect(next?.id).not.toBe(worker.id);
  expect(next?.labels["paseo.parent-agent-id"]).toBe(f.lead.id);
  expect(next?.config).toMatchObject({ model: "test-model", modeId: "full-access", cwd: f.root });
  await f.manager.waitForAgentEvent(next!.id, { waitForActive: true });
  expect(f.starts).toEqual(["Respond with exactly: DONE tested"]);
  await f.routing.changed();
  await f.end(worker, "DONE tests passed");
  expect(f.createAgent).toHaveBeenCalledTimes(1);
});

test.each(["OPEN", "IN PROGRESS", "DONE"])(
  "DONE retains its session without evidence closure: %s",
  async (status) => {
    const f = await fixture();
    const worker = await f.worker();
    await f.ledger([`| JOB-1 | Previous | BUILD | builders | ${status} | — | fixture |`, ready()]);
    expect(await f.end(worker, "DONE checked")).toMatchObject({
      result: { line: "DONE checked" },
      fresh: true,
    });
    expect(f.createAgent).not.toHaveBeenCalled();
    expect(f.manager.getAgent(worker.id)).toBeTruthy();
  },
);

test.each(["BLOCKED missing input", "DECISION choose mode"])(
  "%s keeps the slot even after item closure",
  async (text) => {
    const f = await fixture({ cap: 2 });
    const worker = await f.worker();
    await f.ledger([closed(), ready()]);
    await f.end(worker, text);
    await f.routing.changed();
    expect(f.createAgent).not.toHaveBeenCalled();
  },
);

test("DECIDE, RULE, blocked rows and other owners never auto-start", async () => {
  const f = await fixture({ cap: 4 });
  await f.ledger([
    ready("JOB-1", "DECIDE"),
    ready("JOB-2", "RULE"),
    ready("JOB-3").replace("OPEN", "OPEN: BLOCKED dependency"),
    ready("JOB-4", "BUILD", "other"),
  ]);
  await f.routing.changed();
  expect(f.createAgent).not.toHaveBeenCalled();
});

test("project cap includes pending creations across concurrent ledger events", async () => {
  const f = await fixture({ cap: 2 });
  await f.ledger([ready("JOB-1"), ready("JOB-2"), ready("JOB-3")]);
  await Promise.all([f.routing.changed(), f.routing.changed(), f.routing.changed()]);
  expect(f.createAgent).toHaveBeenCalledTimes(2);
});

test("disabled project starts nothing", async () => {
  const f = await fixture({ enabled: false });
  await f.ledger([ready()]);
  await f.routing.changed();
  expect(f.createAgent).not.toHaveBeenCalled();
  expect(ProjectDispatchSchema.parse({ ...f.config, enabled: undefined }).enabled).toBe(false);
});

test.each(["fulcra.hold", "fulcra.dispatch", "custom-hold"])(
  "project hold %s blocks dispatch",
  async (label) => {
    const f = await fixture();
    f.config.holdLabels = ["custom-hold"];
    f.lead.labels[label] = label === "fulcra.dispatch" ? "off" : "paused";
    await f.storage.applySnapshot(f.lead);
    await f.ledger([ready()]);
    await f.routing.changed();
    expect(f.createAgent).not.toHaveBeenCalled();
  },
);

test("a restart retains claims and does not create or prompt an item twice", async () => {
  const f = await fixture();
  await f.ledger([ready()]);
  await f.routing.changed();
  f.routing.stop();
  const restored = new LedgerRoutingService(f.deps);
  await restored.changed();
  restored.stop();
  expect(f.createAgent).toHaveBeenCalledTimes(1);
});

test("an uncertain creation consumes the item and slot after restart", async () => {
  const f = await fixture();
  f.createAgent.mockRejectedValue(new Error("creation reply lost"));
  await f.ledger([ready()]);
  await f.routing.changed();
  f.routing.stop();
  const restored = new LedgerRoutingService(f.deps);
  await restored.changed();
  restored.stop();
  expect(f.createAgent).toHaveBeenCalledTimes(1);
  expect(JSON.parse(await readFile(f.deps.statePath, "utf8")).claims[0].stage).toBe("uncertain");
});

test("notice turns cannot release a slot or relay a result", async () => {
  const f = await fixture();
  const worker = await f.worker();
  await f.ledger([closed(), ready()]);
  expect(await f.end(worker, "DONE", "notice", false, true)).toBeNull();
  expect(f.createAgent).not.toHaveBeenCalled();
});

test("failed turns cannot reuse stale DONE text", async () => {
  const f = await fixture();
  const worker = await f.worker();
  await f.ledger([closed(), ready()]);
  await f.end(worker, "DONE", "failed", true);
  expect(f.createAgent).not.toHaveBeenCalled();
});

test("corrupt journal refuses recovery", async () => {
  const f = await fixture();
  await writeFile(f.deps.statePath, "broken");
  expect(() => new LedgerRoutingService(f.deps)).toThrow();
});

test("new work in the retained session clears its previous DONE result", async () => {
  const f = await fixture();
  const worker = await f.worker();
  await f.ledger([closed(), ready()]);
  // Save DONE while the next item is not ready yet.
  await f.ledger([closed()]);
  await f.end(worker, "DONE accepted");
  f.routing.begin(worker);
  await f.ledger([closed(), ready()]);
  await f.routing.changed();
  expect(f.createAgent).not.toHaveBeenCalled();
});

test("a hold set during workspace preparation refuses provider creation", async () => {
  const f = await fixture();
  const routing = new LedgerRoutingService({
    ...f.deps,
    ensureWorkspace: async () => {
      f.config.enabled = false;
      return "sample-workspace";
    },
  });
  await f.ledger([ready()]);
  await routing.changed();
  routing.stop();
  expect(f.createAgent).not.toHaveBeenCalled();
});
