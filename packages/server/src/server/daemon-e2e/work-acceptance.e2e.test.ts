import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createPaseoToolCatalog } from "../agent/tools/paseo-tools.js";
import { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import type { Assignment } from "../agent/work-acceptance.js";

// FU-349 approve-before-close on a real test daemon: isolated home, fake provider, real MCP tools, real app
// websocket routes. No live daemon is touched.

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).toReversed()) await close();
});

const GOOD = { passed: true, checks: [{ command: "npm test", exitCode: 0 }], evidence: "ok 12/12" };

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "work-accept-e2e-"));
  const prompts: string[] = [];
  const provider = createTestAgentClient("codex", {
    onStartTurn: (prompt) =>
      prompts.push(typeof prompt === "string" ? prompt : JSON.stringify(prompt)),
  });
  const daemon = await createTestPaseoDaemon({
    paseoHomeRoot: root,
    agentClients: { codex: provider },
  });
  let client: DaemonClient | undefined;
  cleanups.push(async () => {
    await client?.close();
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  });
  const manager = daemon.daemon.agentManager;
  const storage = daemon.daemon.agentStorage;
  const store = manager.workAcceptance!;
  const lead = await manager.createAgent(
    { provider: "codex", cwd: root, modeId: "full-access", title: "Lead" },
    undefined,
    {},
  );
  const worker = await manager.createAgent(
    { provider: "codex", cwd: root, modeId: "full-access", title: "Worker" },
    undefined,
    { labels: { [PARENT_AGENT_ID_LABEL]: lead.id } },
  );
  await manager.flush();
  client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  await client.connect();
  const catalogFor = (callerAgentId: string) =>
    createPaseoToolCatalog({
      agentManager: manager,
      agentStorage: storage,
      providerSnapshotManager: Object.create(ProviderSnapshotManager.prototype),
      callerAgentId,
      logger: createTestLogger(),
    });
  const asLead = catalogFor(lead.id);
  const asWorker = catalogFor(worker.id);
  const result = <T>(r: { structuredContent?: unknown }) =>
    (r.structuredContent as { result: T }).result;
  const assign = (item = "FU-1", workerId = worker.id, requestId = `req-${item}`) =>
    asLead.executeTool("work_assign", {
      item,
      project: "fulcra",
      workerId,
      goal: "Fix the bug",
      acceptance: ["npm test exits 0"],
      approvalClass: "milestone",
      requestId,
    });
  const submit = async (candidateId: string, evidence = GOOD) =>
    result<{ assignment: Assignment }>(
      await asWorker.executeTool("work_submit", {
        candidateKind: "commit",
        candidateId,
        ...evidence,
      }),
    );
  const approve = async (candidateId: string, digest: string) =>
    asLead.executeTool("work_review", {
      item: "FU-1",
      decision: "approve",
      candidateId,
      evidenceDigest: digest,
      milestone: "M1",
    });
  return {
    root,
    daemon,
    manager,
    storage,
    store,
    lead,
    worker,
    client,
    asLead,
    asWorker,
    assign,
    submit,
    approve,
    prompts,
  };
}

test("daemon: failed check, rejection, second fix, approval, then every close route", async () => {
  const f = await fixture();
  await f.assign();

  // Every close route refuses before approval: app archive, app delete, MCP archive, MCP kill.
  const refuse = async () => {
    await expect(f.client.archiveAgent(f.worker.id)).rejects.toThrow(/Archive refused/);
    await expect(f.client.deleteAgent(f.worker.id)).rejects.toThrow(/Archive refused/);
    await expect(f.asLead.executeTool("archive_agent", { agentId: f.worker.id })).rejects.toThrow(
      /Archive refused/,
    );
    await expect(f.asLead.executeTool("kill_agent", { agentId: f.worker.id })).rejects.toThrow(
      /Archive refused/,
    );
    expect((await f.storage.get(f.worker.id))?.archivedAt).toBeFalsy();
  };
  await refuse();

  // Failed check: still running, still refused.
  const failed = await f.submit("sha-1", {
    passed: false,
    checks: [{ command: "npm test", exitCode: 1 }],
    evidence: "fail 3",
  });
  expect(failed.assignment.state).toBe("RUNNING");
  await refuse();

  // Fix, pass: waits for approval and starts no turn. The worker cannot approve itself.
  const first = await f.submit("sha-2");
  expect(first.assignment.state).toBe("AWAITING_APPROVAL");
  const digest = first.assignment.verification!.evidenceDigest;
  await expect(
    f.asWorker.executeTool("work_review", {
      item: "FU-1",
      decision: "approve",
      candidateId: "sha-2",
      evidenceDigest: digest,
    }),
  ).rejects.toThrow(/cannot review its own work/);
  const before = f.prompts.length;
  await expect(f.manager.runAgent(f.worker.id, "status?")).rejects.toThrow(/no model turn starts/);
  expect(f.prompts).toHaveLength(before);
  await refuse();

  // Rejection sends the findings to the same worker and opens a new round.
  await f.asLead.executeTool("work_review", {
    item: "FU-1",
    decision: "reject",
    findings: "Add the failure-path test",
  });
  await vi.waitFor(() =>
    expect(f.prompts.some((p) => p.includes("Add the failure-path test"))).toBe(true),
  );
  expect(f.store.get("FU-1")).toMatchObject({ state: "RUNNING", workerId: f.worker.id });
  expect(f.store.get("FU-1")?.rejections).toHaveLength(1);
  await refuse();

  // Second fix, approval, close through the app route.
  const second = await f.submit("sha-3");
  await f.approve("sha-3", second.assignment.verification!.evidenceDigest);
  await f.client.archiveAgent(f.worker.id);
  expect((await f.storage.get(f.worker.id))?.archivedAt).toBeTruthy();
  expect(f.store.get("FU-1")).toMatchObject({ state: "CLOSED" });
  expect(f.store.get("FU-1")?.approval?.approver).toEqual({ kind: "lead", id: f.lead.id });
});

test("daemon: a paused provider holds a send, and a held send does not use a turn of the round", async () => {
  const f = await fixture();
  await f.assign();
  await writeFile(f.storage.noticePausePath, JSON.stringify({ pausedProviders: ["codex"] }));
  await f.asLead.executeTool("send_agent_prompt", { agentId: f.worker.id, prompt: "held work" });
  expect(f.prompts.some((p) => p.includes("held work"))).toBe(false);
  expect(f.store.get("FU-1")?.roundTurns).toBe(0);
  await expect(f.client.archiveAgent(f.worker.id)).rejects.toThrow(/Archive refused/);
  await writeFile(f.storage.noticePausePath, JSON.stringify({ pausedProviders: [] }));
  await vi.waitFor(() => expect(f.prompts.some((p) => p.includes("held work"))).toBe(true));
  await vi.waitFor(() => expect(f.store.get("FU-1")?.roundTurns).toBe(1));
});

test("daemon: a usage-limited session holds automatic sends and stays assigned", async () => {
  const f = await fixture();
  await f.assign();
  const session = f.worker.session!;
  vi.spyOn(session, "startTurn").mockImplementationOnce(async () => {
    const turnId = "turn-limit";
    setTimeout(() => {
      const notify = Reflect.get(session, "notifySubscribers") as (event: unknown) => void;
      notify.call(session, { type: "turn_started", provider: "codex", turnId });
      notify.call(session, {
        type: "turn_failed",
        provider: "codex",
        turnId,
        error: "You've hit your usage limit.",
      });
    }, 0);
    return { turnId };
  });
  await f.manager.trustedPlugins
    .agentInput(async () => f.manager.runAgent(f.worker.id, "work that hits the limit"))
    .catch(() => undefined);
  await vi.waitFor(() => expect(f.manager.getAgent(f.worker.id)?.lifecycle).toBe("error"));
  const turnsBefore = f.prompts.length;
  await f.asLead.executeTool("send_agent_prompt", { agentId: f.worker.id, prompt: "after limit" });
  expect(f.prompts.slice(turnsBefore).some((p) => p.includes("after limit"))).toBe(false);
  expect(f.store.get("FU-1")).toMatchObject({ state: "RUNNING" });
  await expect(f.client.archiveAgent(f.worker.id)).rejects.toThrow(/Archive refused/);
});

test("daemon: an archived session stays closed, and a cancelled assignment records CANCELLED", async () => {
  const f = await fixture();
  await f.assign();
  await f.asLead.executeTool("work_cancel", { item: "FU-1", reason: "Superseded" });
  expect(f.store.get("FU-1")).toMatchObject({ state: "CANCELLED" });
  expect(f.store.get("FU-1")?.approval).toBeUndefined();
  await f.client.archiveAgent(f.worker.id);
  expect((await f.storage.get(f.worker.id))?.archivedAt).toBeTruthy();
  expect(f.store.get("FU-1")?.state).toBe("CANCELLED");

  // The archived session starts no turn and gets no assignment state back.
  const before = f.prompts.length;
  await expect(
    f.asLead.executeTool("send_agent_prompt", { agentId: f.worker.id, prompt: "wake up" }),
  ).rejects.toThrow();
  expect(f.prompts).toHaveLength(before);
  expect(f.store.get("FU-1")?.state).toBe("CANCELLED");

  // The item can get a fresh worker as generation 2.
  const next = await f.manager.createAgent(
    { provider: "codex", cwd: f.root, modeId: "full-access", title: "Fresh worker" },
    undefined,
    { labels: { [PARENT_AGENT_ID_LABEL]: f.lead.id } },
  );
  await f.assign("FU-1", next.id, "req-fresh");
  expect(f.store.get("FU-1")).toMatchObject({ generation: 2, workerId: next.id });
});

test("daemon: a lead on another host cannot review, and remote sends keep their guard", async () => {
  const f = await fixture();
  await f.assign();
  const submitted = await f.submit("sha-1");
  const bound = {
    candidateId: "sha-1",
    evidenceDigest: submitted.assignment.verification!.evidenceDigest,
    milestone: "M1",
  };
  await expect(
    f.store.approve("FU-1", { kind: "lead", id: `${f.lead.id}@other-host` }, bound),
  ).rejects.toMatchObject({ code: "unauthorised" });
  // The existing remote guard is unchanged: a remote send without a host link is refused.
  await expect(
    f.asLead.executeTool("send_agent_prompt", {
      agentId: `${f.worker.id}@other-host`,
      prompt: "remote work",
    }),
  ).rejects.toThrow(/remote worker grant|host link/i);
  expect(f.store.get("FU-1")?.state).toBe("AWAITING_APPROVAL");
  await expect(f.client.archiveAgent(f.worker.id)).rejects.toThrow(/Archive refused/);
});
