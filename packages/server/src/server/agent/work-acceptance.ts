import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { writeJsonQueueFile } from "../atomic-file.js";

// FULCRA(orchestration): FU-349 approve-before-close. Work acceptance is separate from runtime shutdown.
// A worker closes only when: goal met, verification passed for the candidate, and an authorised approval
// bound to that candidate and evidence. The store is host-private, durable and written before any effect.

export type WorkState =
  | "RUNNING"
  | "AWAITING_APPROVAL"
  | "APPROVED"
  | "WAITING"
  | "CLOSING"
  | "CLOSED"
  | "CANCELLED";
export type ApprovalClass = "routine" | "milestone" | "creative";
export type ApproverKind = "check" | "lead" | "owner";
export interface Approver {
  kind: ApproverKind;
  /** Session id of a lead. Absent for the check record and for the owner. */
  id?: string;
}
export interface Candidate {
  kind: "commit" | "artifact";
  /** Commit SHA, or the sha256 of the artifact file. */
  id: string;
  /** Artifact file path, used to recompute the hash before close. */
  path?: string;
}
export interface VerificationInput {
  passed: boolean;
  checks: Array<{ command: string; exitCode: number }>;
  /** Log text or any stable evidence bytes. Only its digest is stored. */
  evidence: string;
}
export interface VerificationRecord {
  passed: boolean;
  candidateId: string;
  checks: VerificationInput["checks"];
  evidenceDigest: string;
  at: string;
}
export interface ApprovalRecord {
  approver: Approver;
  candidateId: string;
  evidenceDigest: string;
  milestone: string;
  at: string;
  /** Stop-hook or goal loops the host stopped before this approval. */
  loopsStopped: number;
}
export interface Assignment {
  item: string;
  project: string;
  generation: number;
  requestId: string;
  workerId: string;
  leadId?: string;
  /** Worker working directory, used to read the live commit. */
  cwd?: string;
  goal: string;
  acceptance: string[];
  approvalClass: ApprovalClass;
  state: WorkState;
  /** Model turns allowed in the current round. Enforced by the host, not by the model. */
  turnLimit: number;
  roundTurns: number;
  /** Job the worker declared it waits for (a CI run, a PC job). Used when a loop trips. */
  pendingJob?: string;
  /** Set while WAITING. The worker starts no turns until this job completes. */
  waitingFor?: { jobId: string; since: string };
  /** Consecutive Stop-hook or goal turns with no tool action. */
  noToolRepeats: number;
  /** Loops the host stopped. Copied into the approval record. */
  loopTrips: number;
  candidate?: Candidate;
  verification?: VerificationRecord;
  approval?: ApprovalRecord;
  rejections: Array<{ findings: string; by: Approver; at: string; candidateId: string }>;
  reviewNoticeKey?: string;
  nextStartClaimed?: boolean;
  cancelled?: { reason: string; by: Approver; at: string };
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export class WorkAcceptanceError extends Error {
  constructor(
    readonly code:
      | "no-assignment"
      | "not-approved"
      | "unverified"
      | "wrong-state"
      | "wrong-candidate"
      | "unauthorised"
      | "self-approval"
      | "turn-limit"
      | "waiting"
      | "awaiting-approval"
      | "duplicate-assignment",
    message: string,
  ) {
    super(message);
    this.name = "WorkAcceptanceError";
  }
}

export function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const OPEN: ReadonlySet<WorkState> = new Set([
  "RUNNING",
  "WAITING",
  "AWAITING_APPROVAL",
  "APPROVED",
  "CLOSING",
]);
export const DEFAULT_TURN_LIMIT = 25;
/** Consecutive Stop-hook or goal turns with no tool action that trip the guard. */
export const STOP_REPEAT_LIMIT = 3;

/** The Stop-hook or goal prompts the provider sends back to a worker. */
export function isStopHookPrompt(text: string): boolean {
  return /^\s*(stop hook feedback|<stop-hook|goal (check|not met))/i.test(text);
}

export interface WorkAcceptanceOptions {
  file: string;
  now?: () => Date;
  /** Reads the live result identity (commit SHA or artifact hash) for a worker. */
  resolveCandidate?: (assignment: Assignment) => Promise<string | null>;
}

interface Snapshot {
  version: 1;
  assignments: Assignment[];
}

export class WorkAcceptanceStore {
  private assignments: Assignment[] = [];
  private chain: Promise<unknown> = Promise.resolve();
  private readonly now: () => Date;
  private readonly resolveCandidate?: WorkAcceptanceOptions["resolveCandidate"];

  constructor(private readonly options: WorkAcceptanceOptions) {
    this.now = options.now ?? (() => new Date());
    this.resolveCandidate = options.resolveCandidate;
    this.load();
  }

  private load(): void {
    let text: string;
    try {
      text = readFileSync(this.options.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    // A corrupt store must stop closing, not silently forget open work.
    const parsed = JSON.parse(text) as Snapshot;
    if (parsed.version !== 1 || !Array.isArray(parsed.assignments))
      throw new Error("Work acceptance store is unreadable");
    this.assignments = parsed.assignments;
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.chain.then(operation, operation);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async persist(): Promise<void> {
    await writeJsonQueueFile(this.options.file, {
      version: 1,
      assignments: this.assignments,
    } satisfies Snapshot);
  }

  /** Mutate a copy, persist, then publish. A failed write leaves memory and disk unchanged. */
  private async commit(item: string, change: (a: Assignment) => void): Promise<Assignment> {
    const index = this.assignments.findIndex((a) => a.item === item && OPEN.has(a.state));
    if (index < 0) throw new WorkAcceptanceError("no-assignment", `No open assignment for ${item}`);
    const draft = structuredClone(this.assignments[index]);
    change(draft);
    draft.revision += 1;
    draft.updatedAt = this.now().toISOString();
    const next = [...this.assignments];
    next[index] = draft;
    const previous = this.assignments;
    this.assignments = next;
    try {
      await this.persist();
    } catch (error) {
      this.assignments = previous;
      throw error;
    }
    return structuredClone(draft);
  }

  get(item: string): Assignment | undefined {
    const found = this.assignments.findLast((a) => a.item === item);
    return found && structuredClone(found);
  }

  /** The open assignment owned by a worker session, if any. */
  forWorker(workerId: string): Assignment | undefined {
    const found = this.assignments.find((a) => a.workerId === workerId && OPEN.has(a.state));
    return found && structuredClone(found);
  }

  // --- assignment -------------------------------------------------------------------------------------

  /** Idempotent by requestId. A second worker for an open item is refused. */
  open(input: {
    item: string;
    project: string;
    workerId: string;
    leadId?: string;
    cwd?: string;
    goal: string;
    acceptance: string[];
    approvalClass: ApprovalClass;
    requestId: string;
    turnLimit?: number;
  }): Promise<Assignment> {
    return this.serial(async () => {
      const same = this.assignments.find(
        (a) => a.item === input.item && a.requestId === input.requestId,
      );
      if (same) return structuredClone(same);
      if (this.assignments.some((a) => a.item === input.item && OPEN.has(a.state)))
        throw new WorkAcceptanceError(
          "duplicate-assignment",
          `${input.item} already has an open assignment`,
        );
      const at = this.now().toISOString();
      const assignment: Assignment = {
        item: input.item,
        project: input.project,
        generation: this.assignments.filter((a) => a.item === input.item).length + 1,
        requestId: input.requestId,
        workerId: input.workerId,
        leadId: input.leadId,
        cwd: input.cwd,
        goal: input.goal,
        acceptance: input.acceptance,
        approvalClass: input.approvalClass,
        state: "RUNNING",
        turnLimit: input.turnLimit ?? DEFAULT_TURN_LIMIT,
        roundTurns: 0,
        noToolRepeats: 0,
        loopTrips: 0,
        rejections: [],
        revision: 1,
        createdAt: at,
        updatedAt: at,
      };
      const previous = this.assignments;
      this.assignments = [...previous, assignment];
      try {
        await this.persist();
      } catch (error) {
        this.assignments = previous;
        throw error;
      }
      return structuredClone(assignment);
    });
  }

  // --- turns ------------------------------------------------------------------------------------------

  private turnRefusal(a: Assignment): WorkAcceptanceError | undefined {
    if (a.state === "WAITING")
      return new WorkAcceptanceError(
        "waiting",
        `${a.item} is WAITING for job ${a.waitingFor?.jobId ?? "unknown"}; no model turn starts until it completes.`,
      );
    if (a.state === "AWAITING_APPROVAL" || a.state === "APPROVED" || a.state === "CLOSING")
      return new WorkAcceptanceError(
        "awaiting-approval",
        `${a.item} is ${a.state}; no model turn starts until the review result arrives.`,
      );
    if (a.roundTurns >= a.turnLimit)
      return new WorkAcceptanceError(
        "turn-limit",
        `${a.item} used its ${a.turnLimit}-turn limit for this round. The lead must reject with findings or raise the limit.`,
      );
    return undefined;
  }

  /** Called before a model turn starts. Pending review starts no turns; a worker past its round limit starts none. */
  assertTurnAllowed(workerId: string): void {
    const a = this.assignments.find((x) => x.workerId === workerId && OPEN.has(x.state));
    const refusal = a && this.turnRefusal(a);
    if (refusal) throw refusal;
  }

  /**
   * Called when a turn starts, including turns the provider starts itself (stop-hook continuation, wake).
   * Counts the turn. Returns the refusal when the host must cancel the turn.
   */
  recordTurn(workerId: string): WorkAcceptanceError | undefined {
    const index = this.assignments.findIndex((x) => x.workerId === workerId && OPEN.has(x.state));
    if (index < 0) return undefined;
    const a = this.assignments[index];
    const refusal = this.turnRefusal(a);
    if (refusal) return refusal;
    // The count changes in memory at once. The write is queued; losing one count in a crash is harmless.
    const next = [...this.assignments];
    next[index] = { ...a, roundTurns: a.roundTurns + 1, revision: a.revision + 1 };
    this.assignments = next;
    void this.serial(() => this.persist()).catch(() => undefined);
    return undefined;
  }

  // --- waiting loops ----------------------------------------------------------------------------------

  private mutateNow(index: number, change: (a: Assignment) => Assignment): Assignment {
    const next = [...this.assignments];
    next[index] = change(this.assignments[index]);
    this.assignments = next;
    void this.serial(() => this.persist()).catch(() => undefined);
    return next[index];
  }

  /** The worker says what it waits for. The host uses it when a loop trips. */
  declareJob(workerId: string, jobId: string): void {
    const index = this.assignments.findIndex((x) => x.workerId === workerId && OPEN.has(x.state));
    if (index < 0)
      throw new WorkAcceptanceError("no-assignment", `No open assignment for ${workerId}`);
    this.mutateNow(index, (a) => ({ ...a, pendingJob: jobId, revision: a.revision + 1 }));
  }

  /**
   * One finished turn that answered a Stop hook or goal prompt. A repeat with no tool action counts. A repeat
   * with a tool action, or an ordinary turn, resets the count. At the limit the worker goes to WAITING with its
   * job id: no model turn starts until the job completes. Returns true when this call tripped the guard.
   */
  recordStopRepeat(workerId: string, turn: { stopHook: boolean; toolAction: boolean }): boolean {
    const index = this.assignments.findIndex((x) => x.workerId === workerId && OPEN.has(x.state));
    if (index < 0) return false;
    const a = this.assignments[index];
    if (a.state !== "RUNNING") return false;
    if (!turn.stopHook || turn.toolAction) {
      if (a.noToolRepeats > 0)
        this.mutateNow(index, (x) => ({ ...x, noToolRepeats: 0, revision: x.revision + 1 }));
      return false;
    }
    const repeats = a.noToolRepeats + 1;
    if (repeats < STOP_REPEAT_LIMIT) {
      this.mutateNow(index, (x) => ({ ...x, noToolRepeats: repeats, revision: x.revision + 1 }));
      return false;
    }
    this.mutateNow(index, (x) => ({
      ...x,
      state: "WAITING",
      noToolRepeats: 0,
      loopTrips: x.loopTrips + 1,
      waitingFor: { jobId: x.pendingJob ?? "unknown", since: this.now().toISOString() },
      revision: x.revision + 1,
      updatedAt: this.now().toISOString(),
    }));
    return true;
  }

  /** The job's completion event. Returns the resumed items. Repeating the event changes nothing. */
  resumeFromJob(jobId: string): string[] {
    const resumed: string[] = [];
    this.assignments.forEach((a, index) => {
      if (a.state !== "WAITING" || a.waitingFor?.jobId !== jobId) return;
      this.mutateNow(index, (x) => ({
        ...x,
        state: "RUNNING",
        waitingFor: undefined,
        pendingJob: undefined,
        noToolRepeats: 0,
        revision: x.revision + 1,
        updatedAt: this.now().toISOString(),
      }));
      resumed.push(a.item);
    });
    return resumed;
  }

  raiseTurnLimit(item: string, by: Approver, turnLimit: number): Promise<Assignment> {
    return this.serial(async () => {
      this.requireReviewer(this.open_(item), by);
      return this.commit(item, (d) => {
        if (turnLimit > d.turnLimit) d.turnLimit = turnLimit;
      });
    });
  }

  // --- evidence ---------------------------------------------------------------------------------------

  /**
   * The worker submits a result and its verification. Failed checks keep the worker RUNNING. A repeat of the
   * same candidate and evidence returns notify:false, so one completion causes one review notice.
   */
  submit(
    workerId: string,
    candidate: Candidate,
    verification: VerificationInput,
  ): Promise<{ assignment: Assignment; notify: boolean; noticeKey?: string }> {
    return this.serial(async () => {
      const current = this.assignments.find((x) => x.workerId === workerId && OPEN.has(x.state));
      if (!current)
        throw new WorkAcceptanceError("no-assignment", `No open assignment for worker ${workerId}`);
      if (current.state !== "RUNNING")
        return {
          assignment: structuredClone(current),
          notify: false,
          noticeKey: current.reviewNoticeKey,
        };
      const evidenceDigest = digest(verification.evidence);
      const passed = verification.passed && verification.checks.every((c) => c.exitCode === 0);
      const record: VerificationRecord = {
        passed,
        candidateId: candidate.id,
        checks: verification.checks,
        evidenceDigest,
        at: this.now().toISOString(),
      };
      const noticeKey = `${current.item}:${current.generation}:${candidate.id}:${evidenceDigest}`;
      const notify = passed && current.reviewNoticeKey !== noticeKey;
      const assignment = await this.commit(current.item, (d) => {
        d.candidate = candidate;
        d.verification = record;
        if (!passed) return;
        d.reviewNoticeKey = noticeKey;
        if (d.approvalClass === "routine") {
          // Routine work is approved by the passing check record itself.
          d.approval = {
            approver: { kind: "check" },
            candidateId: candidate.id,
            evidenceDigest,
            milestone: "routine",
            at: record.at,
            loopsStopped: d.loopTrips,
          };
          d.state = "APPROVED";
        } else d.state = "AWAITING_APPROVAL";
      });
      return { assignment, notify: notify && assignment.state === "AWAITING_APPROVAL", noticeKey };
    });
  }

  /** Any change to the result after approval cancels the approval and returns the worker to RUNNING. */
  observeCandidate(item: string, liveId: string): Promise<Assignment | undefined> {
    return this.serial(async () => {
      const a = this.assignments.find((x) => x.item === item && OPEN.has(x.state));
      if (!a || !a.candidate || a.candidate.id === liveId) return a && structuredClone(a);
      if (a.state !== "APPROVED" && a.state !== "AWAITING_APPROVAL" && a.state !== "CLOSING")
        return structuredClone(a);
      return this.commit(item, (d) => {
        d.approval = undefined;
        d.verification = undefined;
        d.reviewNoticeKey = undefined;
        d.candidate = { ...d.candidate!, id: liveId };
        d.state = "RUNNING";
      });
    });
  }

  // --- review -----------------------------------------------------------------------------------------

  private open_(item: string): Assignment {
    const a = this.assignments.find((x) => x.item === item && OPEN.has(x.state));
    if (!a) throw new WorkAcceptanceError("no-assignment", `No open assignment for ${item}`);
    return a;
  }

  private requireReviewer(a: Assignment, by: Approver): void {
    if (by.kind === "check")
      throw new WorkAcceptanceError("unauthorised", "A check record cannot review this action.");
    if (by.kind === "lead" && by.id === a.workerId)
      throw new WorkAcceptanceError("self-approval", "A worker cannot review its own work.");
    if (by.kind === "lead" && (!by.id || !a.leadId || by.id !== a.leadId))
      throw new WorkAcceptanceError(
        "unauthorised",
        "Only the assigning lead or the owner may review.",
      );
    if (a.approvalClass === "creative" && by.kind !== "owner")
      throw new WorkAcceptanceError("unauthorised", "A creative look needs the owner.");
  }

  approve(
    item: string,
    by: Approver,
    bound: { candidateId: string; evidenceDigest: string; milestone: string },
  ): Promise<Assignment> {
    return this.serial(async () => {
      const a = this.open_(item);
      this.requireReviewer(a, by);
      if (a.state !== "AWAITING_APPROVAL")
        throw new WorkAcceptanceError(
          "wrong-state",
          `${item} is ${a.state}, not awaiting approval.`,
        );
      if (!a.verification?.passed)
        throw new WorkAcceptanceError("unverified", "Verification did not pass.");
      if (
        bound.candidateId !== a.candidate?.id ||
        bound.evidenceDigest !== a.verification.evidenceDigest ||
        bound.candidateId !== a.verification.candidateId
      )
        throw new WorkAcceptanceError(
          "wrong-candidate",
          "Approval names a different result or evidence than the submitted one.",
        );
      return this.commit(item, (d) => {
        d.approval = {
          approver: by,
          ...bound,
          at: this.now().toISOString(),
          loopsStopped: d.loopTrips,
        };
        d.state = "APPROVED";
      });
    });
  }

  /** Rejection returns the SAME worker to RUNNING with a fresh turn round. The caller then sends the findings. */
  reject(item: string, by: Approver, findings: string): Promise<Assignment> {
    return this.serial(async () => {
      const a = this.open_(item);
      this.requireReviewer(a, by);
      if (a.state !== "AWAITING_APPROVAL" && a.state !== "APPROVED")
        throw new WorkAcceptanceError("wrong-state", `${item} is ${a.state}, nothing to reject.`);
      return this.commit(item, (d) => {
        d.rejections.push({
          findings,
          by,
          at: this.now().toISOString(),
          candidateId: d.candidate?.id ?? "",
        });
        d.approval = undefined;
        d.verification = undefined;
        d.reviewNoticeKey = undefined;
        d.roundTurns = 0;
        d.state = "RUNNING";
      });
    });
  }

  /** Explicit cancel records CANCELLED, never DONE. Lead or The owner only. */
  cancel(item: string, by: Approver, reason: string): Promise<Assignment> {
    return this.serial(async () => {
      const a = this.open_(item);
      if (by.kind === "check")
        throw new WorkAcceptanceError("unauthorised", "A check record cannot cancel work.");
      if (by.kind === "lead" && (by.id === a.workerId || !a.leadId || by.id !== a.leadId))
        throw new WorkAcceptanceError(
          "unauthorised",
          "Only the assigning lead or the owner may cancel.",
        );
      return this.commit(item, (d) => {
        d.cancelled = { reason, by, at: this.now().toISOString() };
        d.state = "CANCELLED";
      });
    });
  }

  // --- closing ----------------------------------------------------------------------------------------

  /**
   * The close predicate: goal met, verification passed for the candidate, and an authorised approval for the
   * same candidate and evidence. Rechecks the live candidate. Throws with the reason when closing is unsafe.
   */
  async assertCanClose(workerId: string): Promise<Assignment | undefined> {
    let a = this.forWorker(workerId);
    if (!a) return undefined;
    if (a.state === "CLOSING") a = await this.reverify(a);
    if (!a.verification?.passed || a.verification.candidateId !== a.candidate?.id)
      throw new WorkAcceptanceError(
        "unverified",
        `${a.item} has no passing check for its current result. Archive refused.`,
      );
    if (a.state !== "APPROVED" && a.state !== "CLOSING")
      throw new WorkAcceptanceError(
        "not-approved",
        `${a.item} is ${a.state}. Archive refused until the result is approved. Cancel the assignment to stop the work.`,
      );
    const approval = a.approval;
    if (
      !approval ||
      approval.candidateId !== a.candidate?.id ||
      approval.evidenceDigest !== a.verification.evidenceDigest
    )
      throw new WorkAcceptanceError(
        "not-approved",
        `${a.item} approval does not match its result.`,
      );
    if (this.resolveCandidate) {
      a = await this.reverify(a);
      if (a.state !== "APPROVED" && a.state !== "CLOSING")
        throw new WorkAcceptanceError(
          "wrong-candidate",
          `${a.item} changed after approval. The approval is cancelled.`,
        );
    }
    return a;
  }

  private async reverify(a: Assignment): Promise<Assignment> {
    if (!this.resolveCandidate) return a;
    const live = await this.resolveCandidate(a);
    if (live === null) return a;
    return (await this.observeCandidate(a.item, live)) ?? a;
  }

  /** Persist CLOSING before any archive effect. Safe to repeat after a restart. */
  beginClose(item: string): Promise<Assignment> {
    return this.serial(async () => {
      const a = this.open_(item);
      if (a.state === "CLOSING") return structuredClone(a);
      if (a.state !== "APPROVED")
        throw new WorkAcceptanceError("not-approved", `${item} is ${a.state}, not approved.`);
      return this.commit(item, (d) => {
        d.state = "CLOSING";
      });
    });
  }

  finishClose(item: string): Promise<Assignment> {
    return this.serial(async () => {
      const a = this.open_(item);
      if (a.state !== "CLOSING")
        throw new WorkAcceptanceError("wrong-state", `${item} is ${a.state}, not closing.`);
      const closed = await this.commit(item, (d) => {
        d.state = "CLOSED";
      });
      return closed;
    });
  }

  /** After a restart: a CLOSING assignment whose worker is already archived becomes CLOSED. */
  async recover(isArchived: (workerId: string) => boolean | Promise<boolean>): Promise<string[]> {
    const closed: string[] = [];
    for (const a of this.assignments.filter((x) => x.state === "CLOSING")) {
      if (await isArchived(a.workerId)) {
        await this.finishClose(a.item);
        closed.push(a.item);
      }
    }
    return closed;
  }

  /** True once per assignment: the one start of the next item after a close. */
  claimNextStart(item: string): Promise<boolean> {
    return this.serial(async () => {
      const a = this.assignments.findLast((x) => x.item === item);
      if (!a || a.state !== "CLOSED" || a.nextStartClaimed) return false;
      const index = this.assignments.indexOf(a);
      const draft = { ...structuredClone(a), nextStartClaimed: true, revision: a.revision + 1 };
      const next = [...this.assignments];
      next[index] = draft;
      const previous = this.assignments;
      this.assignments = next;
      try {
        await this.persist();
      } catch (error) {
        this.assignments = previous;
        throw error;
      }
      return true;
    });
  }
}

/** Reads the live result identity: the commit at the worker's cwd, or the artifact file hash. Null when unreadable. */
export async function liveCandidateId(a: Assignment): Promise<string | null> {
  const candidate = a.candidate;
  if (!candidate) return null;
  if (candidate.kind === "artifact")
    return candidate.path
      ? createHash("sha256")
          .update(await readFile(candidate.path))
          .digest("hex")
      : null;
  const cwd = a.cwd;
  if (!cwd) return null;
  return new Promise((resolve) => {
    execFile("git", ["-C", cwd, "rev-parse", "HEAD"], { timeout: 10_000 }, (error, stdout) =>
      resolve(error ? null : stdout.trim()),
    );
  });
}
