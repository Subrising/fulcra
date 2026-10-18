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

test("design 8 (daemon): a paused provider holds a send, and a held send does not use a turn of the round", async () => {
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

test("design 8 (daemon): a usage-limited session holds automatic sends and stays assigned", async () => {
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

test("design 8 (daemon): a canceled assignment records CANCELLED, never DONE, and the item gets a fresh worker", async () => {
  const f = await fixture();
  await f.assign();
  await f.asLead.executeTool("work_cancel", { item: "FU-1", reason: "Superseded" });
  expect(f.store.get("FU-1")).toMatchObject({ state: "CANCELLED" });
  expect(f.store.get("FU-1")?.approval).toBeUndefined();
  await f.client.archiveAgent(f.worker.id);
  expect((await f.storage.get(f.worker.id))?.archivedAt).toBeTruthy();
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

test("design 8 (daemon): an archived session stays closed and starts no turn", async () => {
  const f = await fixture();
  await f.assign();
  const submitted = await f.submit("sha-1");
  await f.approve("sha-1", submitted.assignment.verification!.evidenceDigest);
  await f.client.archiveAgent(f.worker.id);
  expect(f.store.get("FU-1")).toMatchObject({ state: "CLOSED" });

  const before = f.prompts.length;
  await expect(
    f.asLead.executeTool("send_agent_prompt", { agentId: f.worker.id, prompt: "wake up" }),
  ).rejects.toThrow();
  expect(f.prompts).toHaveLength(before);
  expect(f.store.get("FU-1")?.state).toBe("CLOSED");
  expect((await f.storage.get(f.worker.id))?.archivedAt).toBeTruthy();
});

test("design 8 (daemon): a lead on another host cannot review, and remote sends keep their guard", async () => {
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

// --- one daemon test per item in the design's verification list ------------------------------------------

const fail = {
  passed: false,
  checks: [{ command: "npm test", exitCode: 1 }],
  evidence: "fail 3",
};

test("design 1 (daemon): missing, failed, stale or wrong-target verification refuses closure", async () => {
  const f = await fixture();
  await f.assign();
  const refused = () =>
    expect(f.client.archiveAgent(f.worker.id)).rejects.toThrow(/Archive refused/);
  await refused(); // missing
  await f.submit("sha-1", fail);
  await refused(); // failed
  const passed = await f.submit("sha-2");
  // stale: the result changes after the check passed
  await f.store.observeCandidate("FU-1", "sha-3");
  expect(f.store.get("FU-1")?.state).toBe("RUNNING");
  await refused();
  // wrong target: approval for a different candidate is refused
  const again = await f.submit("sha-4");
  await expect(
    f.approve("sha-OTHER", again.assignment.verification!.evidenceDigest),
  ).rejects.toThrow(/different result or evidence/);
  expect(passed.assignment.state).toBe("AWAITING_APPROVAL");
  await refused();
});

test("design 2 (daemon): missing, rejected, forged or wrong-candidate approval refuses closure", async () => {
  const f = await fixture();
  await f.assign();
  const refused = () =>
    expect(f.client.archiveAgent(f.worker.id)).rejects.toThrow(/Archive refused/);
  const sub = await f.submit("sha-1");
  const digest = sub.assignment.verification!.evidenceDigest;
  await refused(); // missing approval
  await expect(f.approve("sha-1", "forged-digest")).rejects.toThrow(/different result or evidence/);
  const other = await f.manager.createAgent(
    { provider: "codex", cwd: f.root, modeId: "full-access", title: "Other lead" },
    undefined,
    {},
  );
  const asOther = createPaseoToolCatalog({
    agentManager: f.manager,
    agentStorage: f.storage,
    providerSnapshotManager: Object.create(ProviderSnapshotManager.prototype),
    callerAgentId: other.id,
    logger: createTestLogger(),
  });
  await expect(
    asOther.executeTool("work_review", {
      item: "FU-1",
      decision: "approve",
      candidateId: "sha-1",
      evidenceDigest: digest,
    }),
  ).rejects.toThrow(/Only the assigning lead/); // forged approver
  await f.asLead.executeTool("work_review", { item: "FU-1", decision: "reject", findings: "No" });
  await refused(); // rejected
});

test("design 3 (daemon): a valid lead milestone approval and an owner approval each permit closure", async () => {
  const f = await fixture();
  await f.assign();
  const lead = await f.submit("sha-1");
  await f.approve("sha-1", lead.assignment.verification!.evidenceDigest);
  await f.client.archiveAgent(f.worker.id);
  expect(f.store.get("FU-1")).toMatchObject({ state: "CLOSED" });

  const second = await f.manager.createAgent(
    { provider: "codex", cwd: f.root, modeId: "full-access", title: "Second worker" },
    undefined,
    { labels: { [PARENT_AGENT_ID_LABEL]: f.lead.id } },
  );
  await f.asLead.executeTool("work_assign", {
    item: "FU-2",
    project: "fulcra",
    workerId: second.id,
    goal: "A creative look",
    acceptance: [],
    approvalClass: "creative",
    requestId: "req-FU-2",
  });
  const asSecond = createPaseoToolCatalog({
    agentManager: f.manager,
    agentStorage: f.storage,
    providerSnapshotManager: Object.create(ProviderSnapshotManager.prototype),
    callerAgentId: second.id,
    logger: createTestLogger(),
  });
  const sub = (
    (await asSecond.executeTool("work_submit", {
      candidateKind: "artifact",
      candidateId: "hash-1",
      ...GOOD,
    })) as { structuredContent: { result: { assignment: Assignment } } }
  ).structuredContent.result.assignment;
  const digest = sub.verification!.evidenceDigest;
  // The lead cannot approve a creative look. The owner can, over the app connection.
  await expect(
    f.asLead.executeTool("work_review", {
      item: "FU-2",
      decision: "approve",
      candidateId: "hash-1",
      evidenceDigest: digest,
    }),
  ).rejects.toThrow(/needs the owner/);
  await f.client.reviewWorkAsOwner({
    item: "FU-2",
    decision: "approve",
    candidateId: "hash-1",
    evidenceDigest: digest,
    milestone: "look",
  });
  await f.client.archiveAgent(second.id);
  expect(f.store.get("FU-2")).toMatchObject({ state: "CLOSED" });
  expect(f.store.get("FU-2")?.approval?.approver).toEqual({ kind: "owner" });
});

test("design 4 (daemon): rejection retains the same session and requires the checks again", async () => {
  const f = await fixture();
  await f.assign();
  const first = await f.submit("sha-1");
  await f.client.reviewWorkAsOwner({ item: "FU-1", decision: "reject", findings: "Add a test" });
  await vi.waitFor(() => expect(f.prompts.some((p) => p.includes("Add a test"))).toBe(true));
  const after = f.store.get("FU-1")!;
  expect(after).toMatchObject({ state: "RUNNING", workerId: f.worker.id, verification: undefined });
  await expect(f.client.archiveAgent(f.worker.id)).rejects.toThrow(/Archive refused/);
  await expect(f.approve("sha-1", first.assignment.verification!.evidenceDigest)).rejects.toThrow(
    /not awaiting approval/,
  );
});

test("design 5 (daemon): duplicate completion events cause one review notice and one next-item start", async () => {
  const f = await fixture();
  await f.assign();
  const submits = await Promise.all(
    [1, 2, 3].map(() =>
      f.asWorker.executeTool("work_submit", {
        candidateKind: "commit",
        candidateId: "sha-1",
        ...GOOD,
      }),
    ),
  );
  const notify = submits.map(
    (r) => (r.structuredContent as { result: { notify: boolean } }).result.notify,
  );
  expect(notify.filter(Boolean)).toHaveLength(1);
  const digest = f.store.get("FU-1")!.verification!.evidenceDigest;
  await f.approve("sha-1", digest);
  await f.client.archiveAgent(f.worker.id);
  const starts = await Promise.all([1, 2, 3].map(() => f.store.claimNextStart("FU-1")));
  expect(starts.filter(Boolean)).toHaveLength(1);
});

test("design 6 (daemon): restart during dispatch, approval or archive does not duplicate work", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "work-accept-restart-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const start = () =>
    createTestPaseoDaemon({
      paseoHomeRoot: root,
      cleanup: false,
      agentClients: { codex: createTestAgentClient("codex") },
    });
  const first = await start();
  const manager1 = first.daemon.agentManager;
  const lead = await manager1.createAgent(
    { provider: "codex", cwd: root, modeId: "full-access", title: "Lead" },
    undefined,
    {},
  );
  const worker = await manager1.createAgent(
    { provider: "codex", cwd: root, modeId: "full-access", title: "Worker" },
    undefined,
    { labels: { [PARENT_AGENT_ID_LABEL]: lead.id } },
  );
  await manager1.flush();
  const catalog = (daemon: typeof first, id: string) =>
    createPaseoToolCatalog({
      agentManager: daemon.daemon.agentManager,
      agentStorage: daemon.daemon.agentStorage,
      providerSnapshotManager: Object.create(ProviderSnapshotManager.prototype),
      callerAgentId: id,
      logger: createTestLogger(),
    });
  const assign = (daemon: typeof first, workerId: string, requestId: string) =>
    catalog(daemon, lead.id).executeTool("work_assign", {
      item: "FU-1",
      project: "fulcra",
      workerId,
      goal: "g",
      acceptance: [],
      approvalClass: "milestone",
      requestId,
    });
  await assign(first, worker.id, "req-1");
  const submitted = (await catalog(first, worker.id).executeTool("work_submit", {
    candidateKind: "commit",
    candidateId: "sha-1",
    ...GOOD,
  })) as { structuredContent: { result: { assignment: Assignment } } };
  const digest = submitted.structuredContent.result.assignment.verification!.evidenceDigest;
  // Restart 1, during approval: the pending state survives and still needs the exact digests.
  await first.close();
  const second = await start();
  cleanups.push(second.close);
  const store2 = second.daemon.agentManager.workAcceptance!;
  expect(store2.get("FU-1")).toMatchObject({ state: "AWAITING_APPROVAL", workerId: worker.id });
  // Restart during dispatch: the same request id returns the same assignment; a new worker is refused.
  await assign(second, worker.id, "req-1");
  expect(store2.get("FU-1")?.generation).toBe(1);
  await expect(assign(second, lead.id, "req-2")).rejects.toThrow(/already has an open assignment/);
  await catalog(second, lead.id).executeTool("work_review", {
    item: "FU-1",
    decision: "approve",
    candidateId: "sha-1",
    evidenceDigest: digest,
  });
  // Restart during archive: CLOSING was written. The restarted daemon keeps it open until archived.
  await store2.beginClose("FU-1");
  await second.close();
  const third = await start();
  cleanups.push(third.close);
  const store3 = third.daemon.agentManager.workAcceptance!;
  expect(store3.get("FU-1")).toMatchObject({ state: "CLOSING" });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${third.port}/ws` });
  await client.connect();
  cleanups.push(() => client.close());
  await client.archiveAgent(worker.id);
  expect(store3.get("FU-1")).toMatchObject({ state: "CLOSED", generation: 1 });
});

test("design 7 (daemon): pending review produces no periodic model turns", async () => {
  const f = await fixture();
  await f.assign();
  await f.submit("sha-1");
  const before = f.prompts.length;
  await expect(f.manager.runAgent(f.worker.id, "status?")).rejects.toThrow(/no model turn starts/);
  await f.asLead
    .executeTool("send_agent_prompt", { agentId: f.worker.id, prompt: "are you done?" })
    .catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 3000));
  expect(f.prompts).toHaveLength(before);
  expect(f.store.get("FU-1")).toMatchObject({ state: "AWAITING_APPROVAL", roundTurns: 0 });
});

test("design 9 (daemon): direct and cascading lifecycle actions cannot mark unapproved work DONE", async () => {
  const f = await fixture();
  const child = await f.manager.createAgent(
    { provider: "codex", cwd: f.root, modeId: "full-access", title: "Child" },
    undefined,
    { labels: { [PARENT_AGENT_ID_LABEL]: f.worker.id } },
  );
  await f.manager.flush();
  await f.assign("FU-1", child.id);
  // Parent archive cascades to the unapproved child: refused before any effect.
  await expect(f.client.archiveAgent(f.worker.id)).rejects.toThrow(/Archive refused/);
  await expect(f.client.archiveAgent(child.id)).rejects.toThrow(/Archive refused/);
  expect((await f.storage.get(f.worker.id))?.archivedAt).toBeFalsy();
  expect((await f.storage.get(child.id))?.archivedAt).toBeFalsy();
  expect(f.store.get("FU-1")).toMatchObject({ state: "RUNNING" });
  expect(f.store.get("FU-1")?.cancelled).toBeUndefined();
});

test("loop guard (daemon): 3 no-tool Stop-hook repeats set WAITING with the job id, and the completion event resumes", async () => {
  const f = await fixture();
  await f.assign();
  await f.asWorker.executeTool("work_wait", { jobId: "ci-run-1" });
  for (let i = 0; i < 3; i += 1)
    await f.manager
      .runAgent(f.worker.id, "Stop hook feedback: goal not met")
      .catch(() => undefined);
  await vi.waitFor(() => expect(f.store.get("FU-1")?.state).toBe("WAITING"));
  expect(f.store.get("FU-1")).toMatchObject({ waitingFor: { jobId: "ci-run-1" }, loopTrips: 1 });

  // Waiting starts no model turn.
  const before = f.prompts.length;
  await expect(f.manager.runAgent(f.worker.id, "Stop hook feedback: goal not met")).rejects.toThrow(
    /WAITING for job ci-run-1/,
  );
  expect(f.prompts).toHaveLength(before);

  // The job's completion event resumes the worker with one turn. A repeated event does nothing more.
  await f.asLead.executeTool("work_job_done", { jobId: "ci-run-1", message: "CI passed." });
  await vi.waitFor(() => expect(f.prompts.some((p) => p.includes("CI passed."))).toBe(true));
  expect(f.store.get("FU-1")).toMatchObject({ state: "RUNNING", waitingFor: undefined });
  const after = f.prompts.length;
  await f.asLead.executeTool("work_job_done", { jobId: "ci-run-1", message: "CI passed." });
  expect(f.prompts).toHaveLength(after);
});

test("loop guard (daemon): provider-started Stop-hook turns are counted from the timeline, and a tool action does not trip", async () => {
  const f = await fixture();
  await f.assign();
  await f.asWorker.executeTool("work_wait", { jobId: "ci-run-2" });
  const session = f.worker.session!;
  const notify = Reflect.get(session, "notifySubscribers") as (event: unknown) => void;
  let n = 0;
  // A turn the provider starts itself: the hook feedback arrives as a user message, no prompt from the host.
  const hookTurn = (withTool: boolean) => {
    const turnId = `hook-${(n += 1)}`;
    notify.call(session, { type: "turn_started", provider: "codex", turnId });
    notify.call(session, {
      type: "timeline",
      provider: "codex",
      turnId,
      item: { type: "user_message", text: "Stop hook feedback: goal not met" },
    });
    if (withTool)
      notify.call(session, {
        type: "timeline",
        provider: "codex",
        turnId,
        item: {
          type: "tool_call",
          callId: `call-${n}`,
          name: "shell",
          status: "completed",
          error: null,
          detail: { type: "unknown", input: null, output: null },
        },
      });
    notify.call(session, {
      type: "timeline",
      provider: "codex",
      turnId,
      item: { type: "assistant_message", text: "Goal not met." },
    });
    notify.call(session, { type: "turn_completed", provider: "codex", turnId });
  };
  // Two no-tool repeats, then a repeat WITH a tool action: the count resets and nothing trips.
  hookTurn(false);
  hookTurn(false);
  hookTurn(true);
  await vi.waitFor(() => expect(f.store.get("FU-1")?.noToolRepeats).toBe(0));
  expect(f.store.get("FU-1")).toMatchObject({ state: "RUNNING", loopTrips: 0 });
  // Three in a row with no tool action stop the loop.
  hookTurn(false);
  hookTurn(false);
  hookTurn(false);
  await vi.waitFor(() => expect(f.store.get("FU-1")?.state).toBe("WAITING"));
  expect(f.store.get("FU-1")).toMatchObject({ waitingFor: { jobId: "ci-run-2" }, loopTrips: 1 });
});
