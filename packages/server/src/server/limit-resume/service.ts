import { readFileSync } from "node:fs";
import path from "node:path";
import {
  LIMIT_RESUME_AT_LABEL,
  LIMIT_RESUME_OPT_OUT_LABEL,
  LIMIT_RESUME_PROMPT,
  NETWORK_RESUME_PROMPT,
} from "@getpaseo/protocol/limit-resume";
import { ensurePrivateDirectory, writePrivateFileAtomicSync } from "../private-files.js";
import { classifyEndingAssistantMessage, classifyFailedTurn, type LimitStop } from "./detect.js";
import { backoffMs } from "./parse-reset.js";

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
// - One resume per limit event, keyed by the stopped turn. The entry is removed (and the file rewritten) in the final send gate before the
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
export { LIMIT_RESUME_AT_LABEL, LIMIT_RESUME_OPT_OUT_LABEL };

export const STAGGER_MS = 3_000;
export const MAX_JITTER_MS = 60_000;
/** Leaves the controller's own 30..120 s resume window to go first. */
export const HANDOFF_MS = 150_000;
export const MAX_CHAIN = 4;
export const NETWORK_BACKOFF_MS = [30_000, 120_000, 600_000];
export { NETWORK_RESUME_PROMPT };
const CHAIN_WINDOW_MS = 6 * 60 * 60 * 1000;
const STALE_AFTER_MS = 12 * 60 * 60 * 1000;

interface QueueEntry {
  agentId: string;
  /** Stable identity of the stop: the stopped turn's id when the provider gave one. */
  limitId: string;
  detectedAt: number;
  resumeAt: number;
  attempt: number;
  /** The session's turn epoch when the stop was seen; a newer turn invalidates the entry. */
  epoch: number;
  /** "reset" when the provider named a reset time, "backoff" when the wait is our own estimate. */
  source: "reset" | "backoff" | "network";
  /** Captured at the stop: a later removal of the ownership observer never grants fallback. */
  unscoped?: boolean;
  /** Original stop fingerprint only; never replaced with a later observation. */
  binding?: string;
}

interface RecentResume {
  resumedAt: number;
  attempt: number;
  limitId: string;
  source?: "reset" | "backoff" | "network";
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
  unscopedResumeAllowed: boolean;
  binding: string | null;
}

export interface LimitResumeDeps {
  paseoHome: string;
  isEnabled: () => boolean;
  getAgent: (agentId: string, forResume?: boolean) => Promise<LimitResumeAgent | null>;
  captureBinding: (agentId: string) => string | null;
  /** The final assistant message of the session's last turn (the Claude CLI reports its limit this way). */
  getLastAssistantMessage: (agentId: string) => Promise<string | null>;
  /** Writes (or, with null, clears) the label the app shows as "Paused: usage limit, resumes at HH:MM". */
  setMarker: (
    agentId: string,
    resumeAtIso: string | null,
    reason?: "network" | "usage",
  ) => Promise<void>;
  /**
   * Starts the resume turn with repeatable refusal-only `stillWanted` checks after all preparation awaits.
   * `consume` is called once at the actual synchronous provider handoff, never an earlier manager gate.
   * Neither callback grants input authority. A stopped service must retain an unconsumed entry.
   */
  sendResume: (
    agentId: string,
    prompt: string,
    stillWanted: () => boolean,
    consume: () => void,
    originalBinding: string,
  ) => Promise<void>;
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
    return { v: 1, entries, recent };
  } catch {
    return emptyQueue();
  }
}

function validBinding(value: unknown): value is string {
  return typeof value === "string" && /^v1:[a-f0-9]{64}$/.test(value);
}

function eligibleBinding(agent: LimitResumeAgent, binding: string | null): boolean {
  return agent.unscopedResumeAllowed && validBinding(binding) && agent.binding === binding;
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
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly deps: LimitResumeDeps) {
    this.file = limitResumeFilePath(deps.paseoHome);
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
  }

  start(): void {
    this.queue = loadQueue(this.file);
    const refused = this.queue.entries.filter(
      (entry) => entry.unscoped !== true || !validBinding(entry.binding),
    );
    this.queue.entries = this.queue.entries.filter(
      (entry) => entry.unscoped === true && validBinding(entry.binding),
    );
    if (refused.length) {
      this.save();
      for (const entry of refused)
        void this.deps.setMarker(entry.agentId, null).catch(this.deps.onError);
    }
    for (const entry of this.queue.entries) this.epochs.set(entry.agentId, entry.epoch);
    this.arm();
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Release the daemon event listener together with the timer on shutdown. */
  onStop(unsubscribe: () => void): void {
    if (this.stopped) unsubscribe();
    else this.unsubscribe = unsubscribe;
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
    if (this.stopped) return;
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

    const binding = this.deps.captureBinding(agentId);
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
    await this.locked(() => this.admit(agentId, stop, epoch, turnId ?? `epoch-${epoch}`, binding));
  }

  private async admit(
    agentId: string,
    stop: LimitStop,
    epoch: number,
    stopKey: string,
    binding: string | null,
  ): Promise<void> {
    const limitId = `${agentId}:${stopKey}`;
    const agent = await this.admissionAgent(agentId, limitId, epoch);
    if (!agent) return;

    if (!eligibleBinding(agent, binding)) {
      await this.clearStaleMarker(agentId, agent);
      return;
    }
    const now = this.now();
    const recent = this.queue.recent[agentId];
    const network = stop.kind === "network";
    const attempt = this.nextAttempt(recent, network, now);
    if (attempt >= (network ? NETWORK_BACKOFF_MS.length : MAX_CHAIN)) return;

    const schedule = this.schedule(stop, attempt, now);
    const entry: QueueEntry = {
      agentId,
      limitId,
      detectedAt: now,
      resumeAt: schedule.resumeAt,
      attempt,
      epoch,
      source: schedule.source,
      unscoped: true,
      binding: binding!,
    };
    this.queue.entries.push(entry);
    this.save();
    await this.deps
      .setMarker(agentId, new Date(entry.resumeAt).toISOString(), network ? "network" : "usage")
      .catch(this.deps.onError);
    this.arm();
  }

  private async admissionAgent(
    agentId: string,
    limitId: string,
    epoch: number,
  ): Promise<LimitResumeAgent | null> {
    const stillCurrent = () =>
      !this.stopped &&
      this.deps.isEnabled() &&
      this.epochOf(agentId) === epoch &&
      !this.queue.entries.some((entry) => entry.agentId === agentId) &&
      this.queue.recent[agentId]?.limitId !== limitId;
    if (!stillCurrent()) return null;
    const agent = await this.deps.getAgent(agentId);
    if (
      !stillCurrent() ||
      !agent ||
      agent.archived ||
      agent.busy ||
      agent.labels[LIMIT_RESUME_OPT_OUT_LABEL] === "off"
    )
      return null;
    return agent;
  }
  private nextAttempt(recent: RecentResume | undefined, network: boolean, now: number): number {
    if (!recent || now - recent.resumedAt >= CHAIN_WINDOW_MS) return 0;
    if (network && recent.source !== "network") return 0;
    return recent.attempt + 1;
  }
  private schedule(
    stop: LimitStop,
    attempt: number,
    now: number,
  ): Pick<QueueEntry, "source" | "resumeAt"> {
    if (stop.kind === "network")
      return { source: "network", resumeAt: now + NETWORK_BACKOFF_MS[attempt]! };
    const base = stop.resetAt ?? now + backoffMs(attempt);
    return {
      source: stop.resetAt === null ? "backoff" : "reset",
      resumeAt: base + HANDOFF_MS + Math.floor(this.random() * MAX_JITTER_MS),
    };
  }

  private async clearStaleMarker(agentId: string, agent: LimitResumeAgent): Promise<void> {
    if (agent.labels[LIMIT_RESUME_AT_LABEL])
      await this.deps.setMarker(agentId, null).catch(this.deps.onError);
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
    const unchanged = () =>
      !this.stopped && this.epochOf(entry.agentId) === entry.epoch && this.deps.isEnabled();
    if (this.stopped) return;
    // Legacy/unknown entries and a previously observed scoped owner never gain unscoped authority.
    if (
      entry.unscoped !== true ||
      !validBinding(entry.binding) ||
      !unchanged() ||
      this.now() - entry.resumeAt > STALE_AFTER_MS
    ) {
      await this.cancel(entry.agentId);
      return;
    }
    const agent = await this.deps.getAgent(entry.agentId, true);
    if (this.stopped) return;
    if (
      !agent ||
      agent.archived ||
      agent.busy ||
      agent.binding !== entry.binding ||
      agent.labels[LIMIT_RESUME_OPT_OUT_LABEL] === "off"
    ) {
      await this.cancel(entry.agentId);
      return;
    }

    // Keep the durable entry while session loading awaits. Shutdown during that wait must leave
    // it for the next boot. Consume synchronously in the final send gate, immediately before admission.
    let consumed = false;
    const stillWanted = () =>
      unchanged() &&
      (consumed ||
        this.queue.entries.some((e) => e.agentId === entry.agentId && e.limitId === entry.limitId));
    await this.deps
      .sendResume(
        entry.agentId,
        entry.source === "network" ? NETWORK_RESUME_PROMPT : RESUME_PROMPT,
        stillWanted,
        () => {
          if (!stillWanted()) throw new Error("Limit resume no longer wanted");
          if (consumed) return;
          const mine = this.queue.entries.find(
            (e) => e.agentId === entry.agentId && e.limitId === entry.limitId,
          );
          if (!mine) throw new Error("Limit resume entry unavailable");
          this.queue.entries = this.queue.entries.filter((e) => e !== mine);
          this.queue.recent[entry.agentId] = {
            resumedAt: this.now(),
            attempt: entry.attempt,
            limitId: entry.limitId,
            source: entry.source,
          };
          this.save();
          consumed = true;
        },
        entry.binding!,
      )
      .catch(this.deps.onError);
    if (consumed) {
      await this.deps.setMarker(entry.agentId, null).catch(this.deps.onError);
    } else if (!this.stopped) {
      // A final loading/admission guard refused. Do not spin an already-due timer.
      await this.cancel(entry.agentId);
    }
  }
}
