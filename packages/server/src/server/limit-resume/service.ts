import { readFileSync } from "node:fs";
import path from "node:path";
import {
  LIMIT_RESUME_AT_LABEL,
  LIMIT_RESUME_OPT_OUT_LABEL,
  LIMIT_RESUME_PROMPT,
} from "@getpaseo/protocol/limit-resume";
import { USAGE_LIMIT } from "../../utils/insights/agents.js";
import { ensurePrivateDirectory, writePrivateFileAtomicSync } from "../private-files.js";
import { backoffMs, parseLimitReset } from "./parse-reset.js";

// Auto-resume after a usage limit. A turn that fails on a usage or rate limit was, by definition, mid-task; this
// queues one resume for it at the reset time and sends a short "continue" prompt then. Idle and finished sessions
// never produce a failed turn, so they are never queued.
//
// Guards:
// - One resume per limit event. The entry is removed (and the file rewritten) before the prompt is sent, so a crash
//   or a failed send can never repeat it. A resumed session that hits the limit again is a new event with a longer
//   backoff, and a session gives up after MAX_CHAIN consecutive limit events.
// - Resumes are staggered: at least STAGGER_MS apart across all sessions, and each gets a random jitter.
// - The queue is a file under $PASEO_HOME/limit-resume, so a daemon restart keeps it.
// - Anything that starts a turn on the session (the person pressing "Resume now", the account pool moving the
//   session to another account and re-prompting it) cancels the pending entry.
// - The global toggle and the per-session opt-out label are checked again at fire time.

export const RESUME_PROMPT = LIMIT_RESUME_PROMPT;
export { LIMIT_RESUME_AT_LABEL, LIMIT_RESUME_OPT_OUT_LABEL };

export const STAGGER_MS = 3_000;
export const MAX_JITTER_MS = 60_000;
export const MAX_CHAIN = 4;
const CHAIN_WINDOW_MS = 6 * 60 * 60 * 1000;
const STALE_AFTER_MS = 12 * 60 * 60 * 1000;

interface QueueEntry {
  agentId: string;
  detectedAt: number;
  resumeAt: number;
  attempt: number;
  /** "reset" when the provider named a reset time, "backoff" when the wait is our own estimate. */
  source: "reset" | "backoff";
}

interface RecentResume {
  resumedAt: number;
  attempt: number;
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
  isEnabled: () => boolean;
  getAgent: (agentId: string) => Promise<LimitResumeAgent | null>;
  /** Writes (or, with null, clears) the label the app shows as "Paused: usage limit, resumes at HH:MM". */
  setMarker: (agentId: string, resumeAtIso: string | null) => Promise<void>;
  sendResume: (agentId: string, prompt: string) => Promise<void>;
  onError: (error: unknown) => void;
  now?: () => number;
  random?: () => number;
}

export interface LimitResumeEvent {
  type: string;
  agentId?: string;
  event?: { type?: string; error?: unknown; code?: unknown; diagnostic?: unknown };
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
        Number.isFinite(e.resumeAt) &&
        Number.isFinite(e.detectedAt) &&
        Number.isFinite(e.attempt),
    );
    return {
      v: 1,
      entries,
      recent: parsed.recent && typeof parsed.recent === "object" ? parsed.recent : {},
    };
  } catch {
    return emptyQueue();
  }
}

export class LimitResumeService {
  private readonly file: string;
  private readonly now: () => number;
  private readonly random: () => number;
  private queue: QueueFile = emptyQueue();
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

  async onAgentEvent(input: LimitResumeEvent): Promise<void> {
    if (input.type !== "agent_stream" || !input.agentId || !input.event) return;
    const kind = input.event.type;
    if (kind === "turn_started") {
      await this.cancel(input.agentId);
      return;
    }
    if (kind !== "turn_failed") return;
    const text = [input.event.error, input.event.code, input.event.diagnostic]
      .filter((part) => part !== undefined && part !== null)
      .map(String)
      .join(" ");
    if (!USAGE_LIMIT.test(text)) return;
    await this.onLimit(input.agentId, text);
  }

  private async onLimit(agentId: string, text: string): Promise<void> {
    if (!this.deps.isEnabled()) return;
    if (this.queue.entries.some((e) => e.agentId === agentId)) return;
    const agent = await this.deps.getAgent(agentId);
    if (!agent || agent.archived || agent.labels[LIMIT_RESUME_OPT_OUT_LABEL] === "off") return;

    const now = this.now();
    const recent = this.queue.recent[agentId];
    const attempt = recent && now - recent.resumedAt < CHAIN_WINDOW_MS ? recent.attempt + 1 : 0;
    if (attempt >= MAX_CHAIN) return;

    const resetAt = parseLimitReset({ text, now });
    const base = resetAt ?? now + backoffMs(attempt);
    const entry: QueueEntry = {
      agentId,
      detectedAt: now,
      resumeAt: base + Math.floor(this.random() * MAX_JITTER_MS),
      attempt,
      source: resetAt === null ? "backoff" : "reset",
    };
    this.queue.entries.push(entry);
    this.save();
    await this.deps
      .setMarker(agentId, new Date(entry.resumeAt).toISOString())
      .catch(this.deps.onError);
    this.arm();
  }

  /** Drops a pending resume (the person resumed, opted out, or something else started a turn). */
  async cancel(agentId: string): Promise<void> {
    const before = this.queue.entries.length;
    this.queue.entries = this.queue.entries.filter((e) => e.agentId !== agentId);
    if (this.queue.entries.length === before) return;
    this.save();
    await this.deps.setMarker(agentId, null).catch(this.deps.onError);
    this.arm();
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
    // Remove first and persist: at most one resume per limit event, whatever happens next.
    this.queue.entries = this.queue.entries.filter((e) => e !== entry);
    this.queue.recent[entry.agentId] = { resumedAt: this.now(), attempt: entry.attempt };
    this.save();

    const clear = () => this.deps.setMarker(entry.agentId, null).catch(this.deps.onError);
    if (!this.deps.isEnabled() || this.now() - entry.resumeAt > STALE_AFTER_MS)
      return void (await clear());
    const agent = await this.deps.getAgent(entry.agentId);
    if (
      !agent ||
      agent.archived ||
      agent.busy ||
      agent.labels[LIMIT_RESUME_OPT_OUT_LABEL] === "off"
    ) {
      return void (await clear());
    }
    await clear();
    await this.deps.sendResume(entry.agentId, RESUME_PROMPT).catch(this.deps.onError);
  }
}
