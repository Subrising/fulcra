import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { registerArchiveReportCount } from "../archive-observation.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import { archiveAgentCommand, closeAgentCommand } from "./lifecycle-command.js";
import {
  WorkAcceptanceError,
  WorkAcceptanceStore,
  digest,
  liveCandidateId,
  type Approver,
} from "./work-acceptance.js";

// FU-349 approve-before-close. The describe-level names below mirror the test list under "Proposed design" in
// capabilities-20261018.md. Every test uses an isolated home and a fake provider. No live daemon is touched.

const logger = createTestLogger();
const LEAD: Approver = { kind: "lead", id: "lead-1" };
const GOOD = { passed: true, checks: [{ command: "npm test", exitCode: 0 }], evidence: "ok 12/12" };
const BAD = { passed: false, checks: [{ command: "npm test", exitCode: 1 }], evidence: "fail 3" };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
  vi.useRealTimers();
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "work-acceptance-"));
  // A store write that is still in flight recreates files while the directory is removed (ENOTEMPTY).
  cleanups.push(() =>
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  );
  return dir;
}

const storeDirs = new WeakMap<WorkAcceptanceStore, string>();
const dirOf = (store: WorkAcceptanceStore) => storeDirs.get(store)!;

function newStore(dir: string, resolveCandidate?: (a: never) => Promise<string | null>) {
  const store = new WorkAcceptanceStore({
    file: join(dir, "work-acceptance", "assignments.json"),
    resolveCandidate: resolveCandidate as never,
  });
  storeDirs.set(store, dir);
  return store;
}

async function openFor(
  store: WorkAcceptanceStore,
  workerId: string,
  extra: Partial<Parameters<WorkAcceptanceStore["open"]>[0]> = {},
) {
  return store.open({
    item: "FU-1",
    project: "fulcra",
    workerId,
    leadId: LEAD.id,
    goal: "Fix the bug",
    acceptance: ["npm test exits 0"],
    approvalClass: "milestone",
    requestId: "req-1",
    ...extra,
  });
}

async function fixture(options: { turns?: string[] } = {}) {
  const dir = home();
  const storage = new AgentStorage(join(dir, "agents"), logger);
  await storage.initialize();
  const store = newStore(dir);
  const turns = options.turns ?? [];
  const manager = new AgentManager({
    registry: storage,
    logger,
    archiveLedgerDirectory: join(dir, "ledgers"),
    workAcceptance: store,
    clients: {
      codex: createTestAgentClient("codex", {
        onStartTurn: (prompt) => turns.push(String(prompt)),
      }),
    },
  });
  cleanups.push(async () => {
    for (const agent of manager.listAgents()) await manager.closeAgent(agent.id).catch(() => {});
    await manager.flush();
  });
  const spawn = (labels: Record<string, string> = {}) =>
    manager.createAgent({ provider: "codex", model: "fixture-model", cwd: dir }, undefined, {
      workspaceId: undefined,
      labels,
    });
  const archive = (id: string) =>
    archiveAgentCommand({ agentManager: manager, agentStorage: storage, logger }, id);
  return { dir, storage, store, manager, spawn, archive, turns };
}

/** Takes an assignment through a passing check and a lead approval. */
async function approved(store: WorkAcceptanceStore, workerId: string) {
  await openFor(store, workerId);
  const { assignment } = await store.submit(workerId, { kind: "commit", id: "sha-1" }, GOOD);
  await store.approve("FU-1", LEAD, {
    candidateId: "sha-1",
    evidenceDigest: assignment.verification!.evidenceDigest,
    milestone: "M1",
  });
}

// --- design test 1 -------------------------------------------------------------------------------------

test("design: missing, failed, stale or wrong-target verification refuses closure", async () => {
  const { store, spawn, archive, storage } = await fixture();
  const worker = await spawn();
  await openFor(store, worker.id);

  // missing: nothing submitted
  await expect(archive(worker.id)).rejects.toThrow(/no passing check|Archive refused/);

  // failed: stays RUNNING and cannot close
  const failed = await store.submit(worker.id, { kind: "commit", id: "sha-1" }, BAD);
  expect(failed.assignment.state).toBe("RUNNING");
  expect(failed.notify).toBe(false);
  await expect(archive(worker.id)).rejects.toThrow(/Archive refused/);

  // passing check but then the result changes: the check no longer matches the live result
  await store.submit(worker.id, { kind: "commit", id: "sha-2" }, GOOD);
  await store.observeCandidate("FU-1", "sha-3");
  expect(store.get("FU-1")?.state).toBe("RUNNING");
  await expect(archive(worker.id)).rejects.toThrow(/Archive refused/);

  // wrong target: a check for one candidate cannot approve another
  const second = await store.submit(worker.id, { kind: "commit", id: "sha-4" }, GOOD);
  await expect(
    store.approve("FU-1", LEAD, {
      candidateId: "sha-OTHER",
      evidenceDigest: second.assignment.verification!.evidenceDigest,
      milestone: "M1",
    }),
  ).rejects.toMatchObject({ code: "wrong-candidate" });
  expect((await storage.get(worker.id))?.archivedAt).toBeFalsy();
});

// --- design test 2 -------------------------------------------------------------------------------------

test("design: missing, rejected, forged or wrong-candidate approval refuses closure", async () => {
  const { store, spawn, archive, storage } = await fixture();
  const worker = await spawn();
  await openFor(store, worker.id);
  const { assignment } = await store.submit(worker.id, { kind: "commit", id: "sha-1" }, GOOD);
  const evidenceDigest = assignment.verification!.evidenceDigest;
  const bound = { candidateId: "sha-1", evidenceDigest, milestone: "M1" };

  // missing approval
  await expect(archive(worker.id)).rejects.toThrow(/Archive refused/);
  // forged approvers: the worker, a lead who did not assign it, a check record, wrong digest
  await expect(store.approve("FU-1", { kind: "lead", id: worker.id }, bound)).rejects.toMatchObject(
    {
      code: "self-approval",
    },
  );
  await expect(store.approve("FU-1", { kind: "lead", id: "other" }, bound)).rejects.toMatchObject({
    code: "unauthorised",
  });
  await expect(store.approve("FU-1", { kind: "check" }, bound)).rejects.toMatchObject({
    code: "unauthorised",
  });
  await expect(
    store.approve("FU-1", LEAD, { ...bound, evidenceDigest: digest("forged") }),
  ).rejects.toMatchObject({ code: "wrong-candidate" });
  // a creative look needs the owner, not the lead
  const creative = newStore(home());
  await creative.open({
    item: "MU-1",
    project: "song",
    workerId: "w",
    leadId: LEAD.id,
    goal: "Make the preview",
    acceptance: [],
    approvalClass: "creative",
    requestId: "r",
  });
  const c = await creative.submit("w", { kind: "artifact", id: "h1" }, GOOD);
  const cb = {
    candidateId: "h1",
    evidenceDigest: c.assignment.verification!.evidenceDigest,
    milestone: "look",
  };
  await expect(creative.approve("MU-1", LEAD, cb)).rejects.toMatchObject({ code: "unauthorised" });
  await expect(creative.approve("MU-1", OWNER, cb)).resolves.toMatchObject({ state: "APPROVED" });

  // rejected approval does not close
  await store.reject("FU-1", LEAD, "Missing a failure-path test");
  await expect(archive(worker.id)).rejects.toThrow(/Archive refused/);
  expect((await storage.get(worker.id))?.archivedAt).toBeFalsy();
});

// --- design test 3 -------------------------------------------------------------------------------------

test("design: a valid lead milestone approval and owner approval each permit closure", async () => {
  for (const approver of [LEAD, OWNER]) {
    const { store, spawn, archive, storage } = await fixture();
    const worker = await spawn();
    await openFor(store, worker.id);
    const { assignment } = await store.submit(worker.id, { kind: "commit", id: "sha-1" }, GOOD);
    await store.approve("FU-1", approver, {
      candidateId: "sha-1",
      evidenceDigest: assignment.verification!.evidenceDigest,
      milestone: "M1",
    });
    await archive(worker.id);
    expect((await storage.get(worker.id))?.archivedAt).toBeTruthy();
    expect(store.get("FU-1")).toMatchObject({ state: "CLOSED" });
    expect(store.get("FU-1")?.approval?.approver.kind).toBe(approver.kind);
  }
});

test("design: routine work is approved by its passing check record, and a changed result cancels it", async () => {
  const { store, spawn, archive } = await fixture();
  const worker = await spawn();
  await openFor(store, worker.id, { approvalClass: "routine" });
  const { assignment } = await store.submit(worker.id, { kind: "commit", id: "sha-1" }, GOOD);
  expect(assignment.state).toBe("APPROVED");
  expect(assignment.approval?.approver.kind).toBe("check");

  // The result changes after approval: approval is cancelled and closure refuses.
  await store.observeCandidate("FU-1", "sha-2");
  expect(store.get("FU-1")).toMatchObject({ state: "RUNNING", approval: undefined });
  await expect(archive(worker.id)).rejects.toThrow(/Archive refused/);
});

test("design: a live result that differs from the approved result cancels approval at close time", async () => {
  const dir = home();
  let live = "sha-1";
  const store = newStore(dir, async () => live);
  const worker = "w-live";
  await approved(store, worker);
  live = "sha-9";
  await expect(store.assertCanClose(worker)).rejects.toMatchObject({ code: "wrong-candidate" });
  expect(store.get("FU-1")).toMatchObject({ state: "RUNNING" });
  // The default reader returns null when it cannot read the result; unreadable never approves or cancels.
  await expect(
    liveCandidateId({ candidate: { kind: "commit", id: "x" } } as never),
  ).resolves.toBeNull();
});

// --- design test 4 -------------------------------------------------------------------------------------

test("design: rejection keeps the same session and requires the checks again", async () => {
  const { store, spawn, archive, storage } = await fixture();
  const worker = await spawn();
  await openFor(store, worker.id);
  const first = await store.submit(worker.id, { kind: "commit", id: "sha-1" }, GOOD);
  const rejected = await store.reject("FU-1", LEAD, "Add the failure-path test");
  expect(rejected.workerId).toBe(worker.id);
  expect(rejected.state).toBe("RUNNING");
  expect(rejected.verification).toBeUndefined();
  expect(rejected.rejections).toHaveLength(1);
  expect(rejected.rejections[0]?.findings).toBe("Add the failure-path test");

  // The old approval path is gone: approving the old evidence fails because state is RUNNING.
  await expect(
    store.approve("FU-1", LEAD, {
      candidateId: "sha-1",
      evidenceDigest: first.assignment.verification!.evidenceDigest,
      milestone: "M1",
    }),
  ).rejects.toMatchObject({ code: "wrong-state" });
  await expect(archive(worker.id)).rejects.toThrow(/Archive refused/);
  expect((await storage.get(worker.id))?.archivedAt).toBeFalsy();

  // Second fix, checks again, approval, close.
  const second = await store.submit(worker.id, { kind: "commit", id: "sha-2" }, GOOD);
  expect(second.notify).toBe(true);
  await store.approve("FU-1", LEAD, {
    candidateId: "sha-2",
    evidenceDigest: second.assignment.verification!.evidenceDigest,
    milestone: "M1",
  });
  await archive(worker.id);
  expect(store.get("FU-1")?.state).toBe("CLOSED");
});

// --- design test 5 -------------------------------------------------------------------------------------

test("design: duplicate completion events cause one review notice and one next-item start", async () => {
  const dir = home();
  const store = newStore(dir);
  await openFor(store, "w1");
  const first = await store.submit("w1", { kind: "commit", id: "sha-1" }, GOOD);
  const again = await store.submit("w1", { kind: "commit", id: "sha-1" }, GOOD);
  const third = await store.submit("w1", { kind: "commit", id: "sha-1" }, GOOD);
  expect([first.notify, again.notify, third.notify]).toEqual([true, false, false]);
  expect(first.noticeKey).toBe(again.noticeKey);

  await store.approve("FU-1", LEAD, {
    candidateId: "sha-1",
    evidenceDigest: first.assignment.verification!.evidenceDigest,
    milestone: "M1",
  });
  await store.beginClose("FU-1");
  await store.finishClose("FU-1");
  const starts = await Promise.all([1, 2, 3].map(() => store.claimNextStart("FU-1")));
  expect(starts.filter(Boolean)).toHaveLength(1);
});

// --- design test 6 -------------------------------------------------------------------------------------

test("design: restart during dispatch, approval or archive does not duplicate work", async () => {
  const dir = home();
  const first = newStore(dir);
  const opened = await openFor(first, "w1");

  // Restart during dispatch: the same request returns the same assignment; a different request is refused.
  const reloaded = newStore(dir);
  const same = await openFor(reloaded, "w1");
  expect(same.generation).toBe(opened.generation);
  await expect(openFor(reloaded, "w2", { requestId: "req-2" })).rejects.toMatchObject({
    code: "duplicate-assignment",
  });

  // Restart during approval: the pending state survives and approval still needs its exact digests.
  const submitted = await reloaded.submit("w1", { kind: "commit", id: "sha-1" }, GOOD);
  const afterRestart = newStore(dir);
  expect(afterRestart.get("FU-1")?.state).toBe("AWAITING_APPROVAL");
  await afterRestart.approve("FU-1", LEAD, {
    candidateId: "sha-1",
    evidenceDigest: submitted.assignment.verification!.evidenceDigest,
    milestone: "M1",
  });

  // Restart during archive: CLOSING was written first. The restart finishes it once the worker is archived.
  await afterRestart.beginClose("FU-1");
  const restarted = newStore(dir);
  expect(restarted.get("FU-1")?.state).toBe("CLOSING");
  expect(await restarted.recover(() => false)).toEqual([]);
  expect(restarted.get("FU-1")?.state).toBe("CLOSING");
  expect(await restarted.recover(() => true)).toEqual(["FU-1"]);
  expect(restarted.get("FU-1")?.state).toBe("CLOSED");
  // A closed item may get a fresh worker as generation 2, never a duplicate of generation 1.
  const next = await openFor(restarted, "w3", { requestId: "req-3" });
  expect(next.generation).toBe(2);
});

test("design: a daemon restart or crash is not acceptance", async () => {
  const f = await fixture();
  const worker = await f.spawn();
  await openFor(f.store, worker.id);
  // Closing the runtime (restart, crash, provider retirement) goes through closeAgent, not the guarded routes.
  await f.manager.closeAgent(worker.id);
  const restarted = newStore(f.dir);
  expect(restarted.get("FU-1")).toMatchObject({ state: "RUNNING", workerId: worker.id });
  expect(restarted.get("FU-1")?.approval).toBeUndefined();
  expect(restarted.get("FU-1")?.cancelled).toBeUndefined();
});

// --- design test 7 -------------------------------------------------------------------------------------

test("design: pending review produces no periodic model turns", async () => {
  vi.useFakeTimers();
  const turns: string[] = [];
  const { store, spawn, manager } = await fixture({ turns });
  const worker = await spawn();
  await openFor(store, worker.id);
  await store.submit(worker.id, { kind: "commit", id: "sha-1" }, GOOD);
  expect(store.get("FU-1")?.state).toBe("AWAITING_APPROVAL");

  await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
  expect(turns).toHaveLength(0);
  // Any attempt to start a turn is refused by the host, with no provider call.
  await expect(manager.runAgent(worker.id, "status?")).rejects.toThrow(/no model turn starts/);
  expect(turns).toHaveLength(0);
  expect(store.get("FU-1")?.roundTurns).toBe(0);
});

// --- design test 8 -------------------------------------------------------------------------------------

test("design: protected and cancelled sessions retain their existing archive guards", async () => {
  const { store, spawn, archive, storage, manager } = await fixture();

  // Protected leads still need the app, even with an approved result.
  registerArchiveReportCount(manager, () => 0);
  const lead = await spawn({ "fulcra.role": "orchestration" });
  await approved(store, lead.id);
  await expect(archive(lead.id)).rejects.toThrow(/Confirm in the app/);
  expect((await storage.get(lead.id))?.archivedAt).toBeFalsy();

  // A cancelled assignment records CANCELLED, never DONE, and the ordinary archive then runs.
  const worker = await spawn();
  await store.open({
    item: "FU-2",
    project: "fulcra",
    workerId: worker.id,
    leadId: LEAD.id,
    goal: "g",
    acceptance: [],
    approvalClass: "milestone",
    requestId: "r2",
  });
  await expect(store.cancel("FU-2", { kind: "lead", id: worker.id }, "self")).rejects.toMatchObject(
    {
      code: "unauthorised",
    },
  );
  await store.cancel("FU-2", LEAD, "Superseded by FU-9");
  expect(store.get("FU-2")).toMatchObject({ state: "CANCELLED" });
  expect(store.get("FU-2")?.approval).toBeUndefined();
  await archive(worker.id);
  expect((await storage.get(worker.id))?.archivedAt).toBeTruthy();
  expect(store.get("FU-2")?.state).toBe("CANCELLED");

  // A session without an assignment keeps today's behaviour.
  const plain = await spawn();
  await archive(plain.id);
  expect((await storage.get(plain.id))?.archivedAt).toBeTruthy();
});

// --- design test 9 -------------------------------------------------------------------------------------

test("design: direct and cascading lifecycle actions cannot mark unapproved work DONE", async () => {
  const f = await fixture();
  const parent = await f.spawn();
  const child = await f.spawn({ [PARENT_AGENT_ID_LABEL]: parent.id });
  await openFor(f.store, child.id);

  // Parent archive cascades to the child: refused before any effect on either session.
  await expect(f.archive(parent.id)).rejects.toThrow(/Archive refused/);
  // Workspace teardown preflight, direct manager archive, stored-snapshot archive, kill and delete routes.
  await expect(f.manager.preflightArchiveDescendants(parent.id)).rejects.toThrow(/Archive refused/);
  await expect(f.manager.archiveAgent(child.id)).rejects.toThrow(/Archive refused/);
  await expect(f.manager.archiveSnapshot(child.id, new Date().toISOString())).rejects.toThrow(
    /Archive refused/,
  );
  await expect(closeAgentCommand({ agentManager: f.manager }, child.id)).rejects.toThrow(
    /Archive refused/,
  );
  await expect(f.manager.assertWorkCloseAllowed(child.id)).rejects.toBeInstanceOf(
    WorkAcceptanceError,
  );
  // Bulk archive is the same command per session.
  const results = await Promise.allSettled([parent.id, child.id].map((id) => f.archive(id)));
  expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);

  expect((await f.storage.get(parent.id))?.archivedAt).toBeFalsy();
  expect((await f.storage.get(child.id))?.archivedAt).toBeFalsy();
  expect(f.store.get("FU-1")).toMatchObject({ state: "RUNNING" });
  expect(f.store.get("FU-1")?.cancelled).toBeUndefined();

  // After approval, the parent archive cascades and the child closes through the same acceptance path.
  const { assignment } = await f.store.submit(child.id, { kind: "commit", id: "sha-1" }, GOOD);
  await f.store.approve("FU-1", LEAD, {
    candidateId: "sha-1",
    evidenceDigest: assignment.verification!.evidenceDigest,
    milestone: "M1",
  });
  await f.archive(parent.id);
  expect((await f.storage.get(child.id))?.archivedAt).toBeTruthy();
  expect(f.store.get("FU-1")?.state).toBe("CLOSED");
});

// --- requirement tests outside the design list ---------------------------------------------------------

test("turn limits are enforced by the host: turns past the limit are refused and the lead can raise it", async () => {
  const turns: string[] = [];
  const { store, spawn, manager } = await fixture({ turns });
  const worker = await spawn();
  await openFor(store, worker.id, { turnLimit: 2 });

  // The host counts each started turn, including ones the provider starts itself.
  expect(store.recordTurn(worker.id)).toBeUndefined();
  expect(store.recordTurn(worker.id)).toBeUndefined();
  const refused = store.recordTurn(worker.id);
  expect(refused).toMatchObject({ code: "turn-limit" });
  await expect(manager.runAgent(worker.id, "goal not met?")).rejects.toThrow(/turn limit/i);
  expect(turns).toHaveLength(0);

  // A worker cannot raise its own limit. The lead can.
  await expect(
    store.raiseTurnLimit("FU-1", { kind: "lead", id: worker.id }, 99),
  ).rejects.toMatchObject({ code: "self-approval" });
  await store.raiseTurnLimit("FU-1", LEAD, 3);
  expect(store.recordTurn(worker.id)).toBeUndefined();

  // A rejection opens a fresh round for the same worker.
  await store.submit(worker.id, { kind: "commit", id: "sha-1" }, GOOD);
  await store.reject("FU-1", LEAD, "Fix it");
  expect(store.get("FU-1")?.roundTurns).toBe(0);
  const run = await manager.runAgent(worker.id, "Fix it");
  expect(run).toBeDefined();
  expect(turns).toHaveLength(1);
  expect(store.get("FU-1")?.roundTurns).toBe(1);
});

test("a corrupt store refuses every close instead of forgetting open work", async () => {
  const dir = home();
  writeFileSync(join(dir, "assignments.json"), "{ not json");
  const store = new WorkAcceptanceStore({ file: join(dir, "assignments.json") });
  expect(store.unavailableReason()).toMatch(/unreadable/);
  await expect(store.assertCanClose("any-worker")).rejects.toMatchObject({
    code: "store-unavailable",
  });
});

test("a failed write leaves memory and disk unchanged", async () => {
  const dir = home();
  const store = newStore(dir);
  await openFor(store, "w1");
  // A directory where the file belongs makes the next durable write fail.
  rmSync(join(dir, "work-acceptance"), { recursive: true, force: true });
  writeFileSync(join(dir, "work-acceptance"), "file in the way");
  await expect(store.submit("w1", { kind: "commit", id: "sha-1" }, GOOD)).rejects.toThrow();
  expect(store.get("FU-1")?.state).toBe("RUNNING");
  expect(store.get("FU-1")?.candidate).toBeUndefined();
});

// --- FU-349 addition: stop the Stop-hook and goal loop outside the model ------------------------------

const STOP = { stopHook: true, toolAction: false };

test("loop guard: 3 no-tool Stop-hook repeats set WAITING with the job id and start no turns", async () => {
  const store = newStore(home());
  await openFor(store, "w1", { turnLimit: 100 });
  store.declareJob("w1", "ci-run-39100229458");
  expect(store.recordStopRepeat("w1", STOP)).toBe(false);
  expect(store.recordStopRepeat("w1", STOP)).toBe(false);
  expect(store.get("FU-1")?.state).toBe("RUNNING");
  expect(store.recordStopRepeat("w1", STOP)).toBe(true);

  const waiting = store.get("FU-1")!;
  expect(waiting.state).toBe("WAITING");
  expect(waiting.waitingFor?.jobId).toBe("ci-run-39100229458");
  expect(waiting.loopTrips).toBe(1);
  // No model turn starts while WAITING, and the provider-started turn is refused so the host cancels it.
  expect(() => store.assertTurnAllowed("w1")).toThrow(/WAITING for job ci-run-39100229458/);
  expect(store.recordTurn("w1")).toMatchObject({ code: "waiting" });
  // WAITING is not acceptance.
  await expect(store.assertCanClose("w1")).rejects.toMatchObject({ code: "unverified" });
});

test("loop guard: without a declared job the id is recorded as unknown", async () => {
  const store = newStore(home());
  await openFor(store, "w1");
  for (let i = 0; i < 3; i += 1) store.recordStopRepeat("w1", STOP);
  expect(store.get("FU-1")?.waitingFor?.jobId).toBe("unknown");
});

test("loop guard: the job completion event resumes the worker once and the count is in the approval record", async () => {
  const store = newStore(home());
  await openFor(store, "w1");
  store.declareJob("w1", "job-7");
  for (let i = 0; i < 3; i += 1) store.recordStopRepeat("w1", STOP);
  expect(store.resumeFromJob("other-job")).toEqual([]);
  expect(store.get("FU-1")?.state).toBe("WAITING");
  expect(store.resumeFromJob("job-7")).toEqual(["FU-1"]);
  expect(store.resumeFromJob("job-7")).toEqual([]); // a repeated event changes nothing
  expect(store.get("FU-1")).toMatchObject({ state: "RUNNING", waitingFor: undefined });
  expect(() => store.assertTurnAllowed("w1")).not.toThrow();

  const { assignment } = await store.submit("w1", { kind: "commit", id: "sha-1" }, GOOD);
  const approvedRecord = await store.approve("FU-1", LEAD, {
    candidateId: "sha-1",
    evidenceDigest: assignment.verification!.evidenceDigest,
    milestone: "M1",
  });
  expect(approvedRecord.approval?.loopsStopped).toBe(1);
  // The state survives a restart.
  expect(newStore(dirOf(store)).get("FU-1")?.approval?.loopsStopped).toBe(1);
});

test("loop guard: a repeat WITH a tool action does not trip, and an ordinary turn resets the count", async () => {
  const store = newStore(home());
  await openFor(store, "w1");
  const toolRepeat = { stopHook: true, toolAction: true };
  const ordinary = { stopHook: false, toolAction: false };
  for (const turn of [STOP, STOP, toolRepeat, STOP, STOP, ordinary, STOP, STOP]) {
    expect(store.recordStopRepeat("w1", turn)).toBe(false);
  }
  expect(store.get("FU-1")).toMatchObject({ state: "RUNNING", loopTrips: 0 });
  expect(store.get("FU-1")?.noToolRepeats).toBe(2);
  // The third in a row after the reset does trip.
  expect(store.recordStopRepeat("w1", STOP)).toBe(true);
});

// --- FU-349 review round 1: each test below fails on head 394c2222 -----------------------------------------

test("B3: a store file deleted after it was written fails closed, and only the owner reset reopens it", async () => {
  const dir = home();
  const store = newStore(dir);
  await openFor(store, "w1");
  // Deleted file, new process: the marker proves it existed.
  rmSync(join(dir, "work-acceptance", "assignments.json"));
  const restarted = newStore(dir);
  expect(restarted.unavailableReason()).toMatch(/missing after it was written/);
  await expect(restarted.assertCanClose("w1")).rejects.toMatchObject({ code: "store-unavailable" });
  await expect(restarted.assertCanClose("a-worker-with-no-assignment")).rejects.toMatchObject({
    code: "store-unavailable",
  });
  await expect(openFor(restarted, "w2", { item: "FU-9", requestId: "r9" })).rejects.toMatchObject({
    code: "store-unavailable",
  });
  await restarted.resetStore("File deleted by mistake");
  expect(restarted.unavailableReason()).toBeNull();
  await expect(restarted.assertCanClose("w1")).resolves.toEqual([]);
  expect(restarted.overrideLog()).toMatchObject([
    { action: "reset_store", reason: "File deleted by mistake" },
  ]);
  // The override survives a restart. A never-written store is still a fresh start, not an error.
  expect(newStore(dir).overrideLog()).toHaveLength(1);
  expect(newStore(home()).unavailableReason()).toBeNull();
});

test("M1: a worker with two open assignments closes only when every one is approved", async () => {
  const dir = home();
  const store = newStore(dir);
  await openFor(store, "w1");
  // A second open assignment for the same worker is refused at open time.
  await expect(openFor(store, "w1", { item: "FU-2", requestId: "r2" })).rejects.toMatchObject({
    code: "duplicate-assignment",
  });
  // A stored file can still hold two (written by hand or by an older build). Close checks all of them.
  const file = join(dir, "work-acceptance", "assignments.json");
  const snapshot = JSON.parse(readFileSync(file, "utf8"));
  const first = snapshot.assignments[0];
  snapshot.assignments.push({ ...first, item: "FU-2", requestId: "r2", state: "RUNNING" });
  snapshot.assignments[0] = {
    ...first,
    state: "APPROVED",
    candidate: { kind: "commit", id: "sha-1" },
    verification: { passed: true, candidateId: "sha-1", checks: [], evidenceDigest: "d", at: "t" },
    approval: {
      approver: { kind: "lead", id: "lead-1" },
      candidateId: "sha-1",
      evidenceDigest: "d",
      milestone: "M1",
      at: "t",
      loopsStopped: 0,
    },
  };
  writeFileSync(file, JSON.stringify(snapshot));
  const reloaded = newStore(dir);
  expect(reloaded.forWorkerAll("w1")).toHaveLength(2);
  await expect(reloaded.assertCanClose("w1")).rejects.toThrow(/FU-2/);
});

test("M2: a worker at its turn limit can be rejected by the lead and gets a fresh round; the lead can raise the limit", async () => {
  const store = newStore(home());
  await openFor(store, "w1", { turnLimit: 1 });
  expect(store.recordTurn("w1")).toBeUndefined();
  expect(store.recordTurn("w1")).toMatchObject({ code: "turn-limit" });
  // Before the fix this threw "nothing to reject" because the worker was RUNNING.
  const rejected = await store.reject("FU-1", LEAD, "Stop looping and report what blocks you");
  expect(rejected).toMatchObject({ state: "RUNNING", roundTurns: 0 });
  expect(store.recordTurn("w1")).toBeUndefined();
  expect(store.recordTurn("w1")).toMatchObject({ code: "turn-limit" });
  await store.raiseTurnLimit("FU-1", LEAD, 5);
  expect(store.recordTurn("w1")).toBeUndefined();
  // A WAITING worker can be rejected too: it returns to RUNNING and the wait is cleared.
  const waiting = newStore(home());
  await openFor(waiting, "w1");
  waiting.declareJob("w1", "job-1");
  for (let i = 0; i < 3; i += 1)
    waiting.recordStopRepeat("w1", { stopHook: true, toolAction: false });
  expect(waiting.get("FU-1")?.state).toBe("WAITING");
  await waiting.reject("FU-1", LEAD, "Report instead");
  expect(waiting.get("FU-1")).toMatchObject({ state: "RUNNING", waitingFor: undefined });
});

test("M4: a routine result is approved only from a real check record, not a bare claim", async () => {
  const store = newStore(home());
  await openFor(store, "w1", { approvalClass: "routine" });
  const bare = await store.submit(
    "w1",
    { kind: "commit", id: "sha-1" },
    {
      passed: true,
      checks: [],
      evidence: "",
    },
  );
  expect(bare.assignment.state).toBe("AWAITING_APPROVAL");
  expect(bare.assignment.approval).toBeUndefined();
  await store.reject("FU-1", LEAD, "Run a real check");
  const real = await store.submit("w1", { kind: "commit", id: "sha-2" }, GOOD);
  expect(real.assignment.state).toBe("APPROVED");
  expect(real.assignment.approval?.approver.kind).toBe("check");
});

test("B1: idle cleanup refuses unapproved work and leaves the session live", async () => {
  const dir = home();
  const storage = new AgentStorage(join(dir, "agents"), logger);
  await storage.initialize();
  const store = newStore(dir);
  const manager = new AgentManager({
    registry: storage,
    logger,
    archiveLedgerDirectory: join(dir, "ledgers"),
    workAcceptance: store,
    clients: { codex: createTestAgentClient("codex") },
  });
  cleanups.push(async () => {
    for (const agent of manager.listAgents()) await manager.closeAgent(agent.id).catch(() => {});
    await manager.flush();
  });
  const worker = await manager.createAgent(
    { provider: "codex", model: "fixture-model", cwd: dir },
    undefined,
    { workspaceId: undefined, labels: { owner: "orca-control" } },
  );
  await openFor(store, worker.id);
  const sequence = manager.trustedPlugins.sequence(worker.id);
  const request = (archive: boolean) => ({
    agentId: worker.id,
    runtimeInstanceId: worker.instanceId,
    updatedAt: worker.updatedAt.toISOString(),
    lastUserMessageAt: worker.lastUserMessageAt?.toISOString() ?? null,
    boot: sequence.boot,
    humanAt: sequence.humanAt,
    archive,
  });
  await expect(manager.cleanupIdleAgent(request(true))).rejects.toThrow(/Archive refused/);
  await expect(manager.cleanupIdleAgent(request(false))).rejects.toThrow(/Archive refused/);
  expect(manager.getAgent(worker.id)).toBeTruthy();
  expect((await storage.get(worker.id))?.archivedAt).toBeFalsy();
  expect(store.get("FU-1")?.state).toBe("RUNNING");
});

// --- FU-349 review round 2 -----------------------------------------------------------------------------

const OWNER: Approver = { kind: "owner" };

test("an owner cancel or raise is recorded in the same write as the change, and a failed write keeps neither", async () => {
  const dir = home();
  const file = join(dir, "work-acceptance", "assignments.json");
  const store = newStore(dir);
  await openFor(store, "w1");
  await store.raiseTurnLimit("FU-1", OWNER, 40, "Long job");
  // One snapshot on disk holds both the new limit and its override record.
  const afterRaise = JSON.parse(readFileSync(file, "utf8"));
  expect(afterRaise.assignments[0].turnLimit).toBe(40);
  expect(afterRaise.overrides).toMatchObject([
    { action: "raise_turn_limit", item: "FU-1", reason: "Long job" },
  ]);

  // A write that fails changes neither the state nor the override log.
  rmSync(join(dir, "work-acceptance"), { recursive: true, force: true });
  writeFileSync(join(dir, "work-acceptance"), "file in the way");
  await expect(store.cancel("FU-1", OWNER, "Lead is gone")).rejects.toThrow();
  expect(store.get("FU-1")?.state).toBe("RUNNING");
  expect(store.overrideLog()).toHaveLength(1);

  // A lead's cancel is not an owner override and adds no record.
  const other = newStore(home());
  await openFor(other, "w1");
  await other.cancel("FU-1", LEAD, "Superseded");
  expect(other.overrideLog()).toEqual([]);
});
