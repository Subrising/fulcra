import { readFileSync } from "node:fs";
import path from "node:path";
import {
  INTERRUPTED_RESUME_PROMPT,
  LIMIT_RESUME_AT_LABEL,
  LIMIT_RESUME_OPT_OUT_LABEL,
  LIMIT_RESUME_PROMPT,
  RESUME_REASON_LABEL,
} from "@getpaseo/protocol/limit-resume";
import { ensurePrivateDirectory, writePrivateFileAtomicSync } from "../private-files.js";
import { classifyEndingAssistantMessage, classifyFailedTurn, type LimitStop } from "./detect.js";
import { backoffMs } from "./parse-reset.js";

// Interrupted sessions use the same queue. At boot the daemon marks every stored mid-task session (running or
// initializing, never idle, finished, archived or internal) idle with an interruption marker; the boot's id is the
// stop identity, so a session is queued once per interruption. They resume after a short settle delay, staggered
// like limit resumes, under their own toggle and the same per-session opt-out.
//
// Auto-resume after a usage limit. A turn that ends on a usage or rate limit (a failed turn, or the Claude CLI's
// own limit line as the final assistant message) was cut off mid-task; this queues one resume at the reset time and
// sends a short "continue" prompt then. Sessions that finish normally never produce such a stop.
//
// The Command Centre controller already resumes the sessions it supervises (control/src/control/usage-limits.mjs,
// at reset + 30..120 s, after trying an account rotation). This queue is the fallback for everything else, so it
// waits until reset + HANDOFF_MS: if the controller (or the person) got there first, a new turn has started and
// this entry is gone. Both sides check "no newer turn" before sending, so a session is resumed once.
//
// Guards:
// - One resume per limit event, keyed by the stopped turn. The entry is removed (and the file rewritten) before the
//   prompt is sent, so a crash or a failed send can never repeat it, and a duplicate delivery of the same stop is
//   ignored. A resumed session that hits the limit again is a new event with a longer backoff, and a session gives
//   up after MAX_CHAIN consecutive limit events.
// - Admission and cancellation run one at a time, and every await is followed by a re-check against the session's
//   turn epoch (bumped by every turn_started), so a stale handler cannot queue after a newer turn began.
// - Resumes are staggered: at least STAGGER_MS apart across all sessions, and each gets a random jitter.
// - The queue is a file under $PASEO_HOME/limit-resume, so a daemon restart keeps it.
// - The global toggle, the per-session opt-out label, busy state and the turn epoch are checked again immediately
//   before the prompt is admitted.

export const RESUME_PROMPT = LIMIT_RESUME_PROMPT;
export { LIMIT_RESUME_AT_LABEL, LIMIT_RESUME_OPT_OUT_LABEL, RESUME_REASON_LABEL };

export type ResumeKind = "limit" | "interrupted";

export const STAGGER_MS = 3_000;
export const MAX_JITTER_MS = 60_000;
/** After a daemon restart: lets providers, relay and the account pool come back before sessions are woken. */
export const INTERRUPTED_SETTLE_MS = 45_000;
/** Leaves the controller's own 30..120 s resume window to go first. */
export const HANDOFF_MS = 150_000;
export const MAX_CHAIN = 4;
const CHAIN_WINDOW_MS = 6 * 60 * 60 * 1000;
const STALE_AFTER_MS = 12 * 60 * 60 * 1000;

interface QueueEntry {
  agentId: string;
  /** Stable identity of the stop: the stopped turn's id when the provider gave one. */
  limitId: string;
  kind: ResumeKind;
  detectedAt: number;
  resumeAt: number;
  attempt: number;
  /** The session's turn epoch when the stop was seen; a newer turn invalidates the entry. */
  epoch: number;
  /** "reset" when the provider named a reset time, "backoff" when the wait is our own estimate. */
  source: "reset" | "backoff";
}

interface RecentResume {
  resumedAt: number;
  attempt: number;
  limitId: string;
}

interface QueueFile {
  v: 1;
  entries: QueueEntry[];
  recent: Record<string, RecentResume>;
}

export interface LimitResumeAgent {
  labels: Record<string, string>;
  archived: boolean;
  /** A turn is already running or starting. */
  busy: boolean;
}

export interface LimitResumeDeps {
  paseoHome: string;
  /** The host toggle for this kind of resume. */
  isEnabled: (kind: ResumeKind) => boolean;
  getAgent: (agentId: string) => Promise<LimitResumeAgent | null>;
  /** The final assistant message of the session's last turn (the Claude CLI reports its limit this way). */
  getLastAssistantMessage: (agentId: string) => Promise<string | null>;
  /** Writes (or, with null, clears) the label the app shows as "Paused: usage limit, resumes at HH:MM". */
  setMarker: (agentId: string, resumeAtIso: string | null, kind?: ResumeKind) => Promise<void>;
  /**
   * Starts the resume turn. `stillWanted` must be called immediately before the turn is admitted, after any
   * awaiting the implementation needs (loading the session), and the turn must not start when it returns false.
   */
  sendResume: (agentId: string, prompt: string, stillWanted: () => boolean) => Promise<void>;
  onError: (error: unknown) => void;
  now?: () => number;
  random?: () => number;
}

export interface LimitResumeEvent {
  type: string;
  agentId?: string;
  event?: {
    type?: string;
    error?: unknown;
    code?: unknown;
    diagnostic?: unknown;
    turnId?: unknown;
  };
}

export function limitResumeFilePath(paseoHome: string): string {
  return path.join(paseoHome, "limit-resume", "queue.json");
}

function emptyQueue(): QueueFile {
  return { v: 1, entries: [], recent: {} };
}

function loadQueue(file: string): QueueFile {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<QueueFile>;
    if (parsed?.v !== 1 || !Array.isArray(parsed.entries)) return emptyQueue();
    const entries = parsed.entries.filter(
      (e): e is QueueEntry =>
        typeof e?.agentId === "string" &&
        typeof e.limitId === "string" &&
        Number.isFinite(e.resumeAt) &&
        Number.isFinite(e.detectedAt) &&
        Number.isFinite(e.attempt) &&
        Number.isFinite(e.epoch),
    );
    const recent = parsed.recent && typeof parsed.recent === "object" ? parsed.recent : {};
    // Files from before interrupted resumes existed hold only limit entries.
    for (const entry of entries) entry.kind ??= "limit";
    return { v: 1, entries, recent };
  } catch {
    return emptyQueue();
  }
}

export class LimitResumeService {
  private readonly file: string;
  private readonly now: () => number;
  private readonly random: () => number;
  private queue: QueueFile = emptyQueue();
  private readonly epochs = new Map<string, number>();
  private chain: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextSlotAt = 0;
  private ticking = false;
  private stopped = false;

  constructor(private readonly deps: LimitResumeDeps) {
    this.file = limitResumeFilePath(deps.paseoHome);
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
  }

  start(): void {
    this.queue = loadQueue(this.file);
    for (const entry of this.queue.entries) this.epochs.set(entry.agentId, entry.epoch);
    this.arm();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** What the app reads: the pending resume time for a session, or null. */
  pendingResumeAt(agentId: string): number | null {
    return this.queue.entries.find((e) => e.agentId === agentId)?.resumeAt ?? null;
  }

  private epochOf(agentId: string): number {
    return this.epochs.get(agentId) ?? 0;
  }

  /** Runs `fn` after everything queued before it, whatever happens to earlier work. */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  async onAgentEvent(input: LimitResumeEvent): Promise<void> {
    if (input.type !== "agent_stream" || !input.agentId || !input.event) return;
    const agentId = input.agentId;
    const kind = input.event.type;
    if (kind === "turn_started") {
      // Synchronous: the epoch moves before any pending handler can resume from an older stop.
      this.epochs.set(agentId, this.epochOf(agentId) + 1);
      await this.cancel(agentId);
      return;
    }
    if (kind !== "turn_failed" && kind !== "turn_completed") return;

    const epoch = this.epochOf(agentId);
    const turnId = typeof input.event.turnId === "string" ? input.event.turnId : null;
    const now = this.now();
    let stop: LimitStop | null;
    if (kind === "turn_failed") {
      const text = [input.event.error, input.event.code, input.event.diagnostic]
        .filter((part) => part !== undefined && part !== null)
        .map(String)
        .join(" ");
      stop = classifyFailedTurn(text, now);
    } else {
      stop = classifyEndingAssistantMessage(
        await this.deps.getLastAssistantMessage(agentId).catch(() => null),
        now,
      );
    }
    if (!stop) return;
    await this.locked(() => this.admit(agentId, stop, epoch, turnId ?? `epoch-${epoch}`));
  }

  private async admit(
    agentId: string,
    stop: LimitStop,
    epoch: number,
    stopKey: string,
  ): Promise<void> {
    if (!this.deps.isEnabled("limit")) return;
    const limitId = `${agentId}:${stopKey}`;
    if (this.queue.entries.some((e) => e.agentId === agentId)) return;
    if (this.queue.recent[agentId]?.limitId === limitId) return;
    const agent = await this.deps.getAgent(agentId);
    // Re-validate after the await: a newer turn, a second delivery or a toggle flip may have overtaken us.
    if (this.epochOf(agentId) !== epoch || !this.deps.isEnabled("limit")) return;
    if (this.queue.entries.some((e) => e.agentId === agentId)) return;
    if (!agent || agent.archived || agent.busy) return;
    if (agent.labels[LIMIT_RESUME_OPT_OUT_LABEL] === "off") return;

    const now = this.now();
    const recent = this.queue.recent[agentId];
    const attempt = recent && now - recent.resumedAt < CHAIN_WINDOW_MS ? recent.attempt + 1 : 0;
    if (attempt >= MAX_CHAIN) return;

    const base = stop.resetAt ?? now + backoffMs(attempt);
    const entry: QueueEntry = {
      agentId,
      limitId,
      kind: "limit",
      detectedAt: now,
      resumeAt: base + HANDOFF_MS + Math.floor(this.random() * MAX_JITTER_MS),
      attempt,
      epoch,
      source: stop.resetAt === null ? "backoff" : "reset",
    };
    this.queue.entries.push(entry);
    this.save();
    await this.deps
      .setMarker(agentId, new Date(entry.resumeAt).toISOString(), "limit")
      .catch(this.deps.onError);
    this.arm();
  }

  /**
   * Queues the sessions the daemon found mid-task when it started. `bootId` is the boot that marked them, so a
   * session is queued once per interruption; a session that keeps getting interrupted stops after MAX_CHAIN.
   */
  enqueueInterrupted(agentIds: readonly string[], bootId: string): Promise<void> {
    return this.locked(async () => {
      for (const agentId of agentIds) {
        await this.admitInterrupted(agentId, `interrupted:${bootId}`);
      }
    });
  }

  private async admitInterrupted(agentId: string, limitId: string): Promise<void> {
    if (!this.deps.isEnabled("interrupted")) return;
    if (this.queue.entries.some((e) => e.agentId === agentId)) return;
    if (this.queue.recent[agentId]?.limitId === limitId) return;
    const epoch = this.epochOf(agentId);
    const agent = await this.deps.getAgent(agentId);
    if (this.epochOf(agentId) !== epoch || !this.deps.isEnabled("interrupted")) return;
    if (!agent || agent.archived || agent.busy) return;
    if (agent.labels[LIMIT_RESUME_OPT_OUT_LABEL] === "off") return;

    const now = this.now();
    const recent = this.queue.recent[agentId];
    const attempt = recent && now - recent.resumedAt < CHAIN_WINDOW_MS ? recent.attempt + 1 : 0;
    if (attempt >= MAX_CHAIN) return;

    const entry: QueueEntry = {
      agentId,
      limitId,
      kind: "interrupted",
      detectedAt: now,
      resumeAt: now + INTERRUPTED_SETTLE_MS + Math.floor(this.random() * MAX_JITTER_MS),
      attempt,
      epoch,
      source: "backoff",
    };
    this.queue.entries.push(entry);
    this.save();
    await this.deps
      .setMarker(agentId, new Date(entry.resumeAt).toISOString(), "interrupted")
      .catch(this.deps.onError);
    this.arm();
  }

  /** Drops a pending resume (the person resumed, opted out, or something else started a turn). */
  cancel(agentId: string): Promise<void> {
    return this.locked(async () => {
      const before = this.queue.entries.length;
      this.queue.entries = this.queue.entries.filter((e) => e.agentId !== agentId);
      if (this.queue.entries.length === before) return;
      this.save();
      await this.deps.setMarker(agentId, null).catch(this.deps.onError);
      this.arm();
    });
  }

  private save(): void {
    ensurePrivateDirectory(path.dirname(this.file));
    // Recent resumes only matter inside the chain window.
    const cutoff = this.now() - CHAIN_WINDOW_MS;
    for (const [id, r] of Object.entries(this.queue.recent)) {
      if (r.resumedAt < cutoff) delete this.queue.recent[id];
    }
    writePrivateFileAtomicSync(this.file, `${JSON.stringify(this.queue)}\n`);
  }

  private arm(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.queue.entries.length === 0) return;
    const earliest = Math.min(...this.queue.entries.map((e) => e.resumeAt));
    const at = Math.max(earliest, this.nextSlotAt);
    this.timer = setTimeout(() => void this.tick(), Math.max(0, at - this.now()));
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      const now = this.now();
      const due = this.queue.entries
        .filter((e) => e.resumeAt <= now)
        .sort((a, b) => a.resumeAt - b.resumeAt)[0];
      if (due && now >= this.nextSlotAt) {
        this.nextSlotAt = now + STAGGER_MS;
        await this.fire(due);
      }
    } catch (error) {
      this.deps.onError(error);
    } finally {
      this.ticking = false;
      this.arm();
    }
  }

  private async fire(entry: QueueEntry): Promise<void> {
    // Consume by stop identity, first and durably: at most one resume per limit event, whatever happens next.
    const consumed = await this.locked(async () => {
      const mine = this.queue.entries.find(
        (e) => e.agentId === entry.agentId && e.limitId === entry.limitId,
      );
      if (!mine) return false;
      this.queue.entries = this.queue.entries.filter((e) => e !== mine);
      this.queue.recent[entry.agentId] = {
        resumedAt: this.now(),
        attempt: entry.attempt,
        limitId: entry.limitId,
      };
      this.save();
      return true;
    });
    if (!consumed) return;

    const clear = () => this.deps.setMarker(entry.agentId, null).catch(this.deps.onError);
    const unchanged = () =>
      this.epochOf(entry.agentId) === entry.epoch && this.deps.isEnabled(entry.kind);
    if (!unchanged() || this.now() - entry.resumeAt > STALE_AFTER_MS) return void (await clear());
    const agent = await this.deps.getAgent(entry.agentId);
    await clear();
    if (
      !agent ||
      agent.archived ||
      agent.busy ||
      agent.labels[LIMIT_RESUME_OPT_OUT_LABEL] === "off"
    ) {
      return;
    }
    // The last gate sits inside sendResume, after it has loaded the session and right before the turn starts.
    await this.deps
      .sendResume(
        entry.agentId,
        entry.kind === "interrupted" ? INTERRUPTED_RESUME_PROMPT : RESUME_PROMPT,
        () => unchanged(),
      )
      .catch(this.deps.onError);
  }
}
