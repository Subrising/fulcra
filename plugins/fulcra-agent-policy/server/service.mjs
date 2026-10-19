import { readFileSync } from "node:fs";
import path from "node:path";
import {
  INTERRUPTED_RESUME_PROMPT,
  LIMIT_RESUME_AT_LABEL,
  LIMIT_RESUME_OPT_OUT_LABEL,
  LIMIT_RESUME_PROMPT,
  NETWORK_RESUME_PROMPT,
} from "@getpaseo/protocol/limit-resume";
import { classifyEndingAssistantMessage, classifyFailedTurn } from "./detect.mjs";
import { backoffMs } from "./parse-reset.mjs";
// Auto-resume after a usage limit. A turn that ends on a usage or rate limit (a failed turn, or the Claude CLI's
// own limit line as the final assistant message) was cut off mid-task; this queues one resume at the reset time and
// sends a short "continue" prompt then. Sessions that finish normally never produce such a stop.
//
// The controller owns enrolled sessions. This fallback acts only when every trusted ownership observer disowns
// the session. It checks that decision again before provider handoff. The two services do not race for one stop.
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
//
// Interrupted turns use the same queue and the same binding rule. While a turn runs, its binding is kept in the
// queue file (refreshed on each non-text timeline item, written only when it changes). A daemon that stops mid-turn (restart or crash)
// leaves that record; at the next boot each such session is queued once with that recorded binding, and it is
// resumed only if the reloaded session still has the same binding. A session without a record is never resumed.
export const RESUME_PROMPT = LIMIT_RESUME_PROMPT;
export { LIMIT_RESUME_AT_LABEL, LIMIT_RESUME_OPT_OUT_LABEL };
export const STAGGER_MS = 3_000;
export const MAX_JITTER_MS = 60_000;
/** Ownership is checked directly; no competing-owner handoff delay is needed. */
export const HANDOFF_MS = 0;
export const MAX_CHAIN = 4;
export const NETWORK_BACKOFF_MS = [30_000, 120_000, 600_000];
export { NETWORK_RESUME_PROMPT, INTERRUPTED_RESUME_PROMPT };
/** After a daemon restart: lets providers, relay and the account pool come back before sessions are woken. */
export const INTERRUPTED_SETTLE_MS = 45_000;
const CHAIN_WINDOW_MS = 6 * 60 * 60 * 1000;
const RESUME_PROMPTS = {
  network: NETWORK_RESUME_PROMPT,
  interrupted: INTERRUPTED_RESUME_PROMPT,
};
const STALE_AFTER_MS = 12 * 60 * 60 * 1000;
export function limitResumeFilePath(paseoHome) {
  return path.join(paseoHome, "limit-resume", "queue.json");
}
function emptyQueue() {
  return { v: 1, entries: [], recent: {}, running: {} };
}
function loadQueue(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed?.v !== 1 || !Array.isArray(parsed.entries)) return emptyQueue();
    const entries = parsed.entries.filter(
      (e) =>
        typeof e?.agentId === "string" &&
        typeof e.limitId === "string" &&
        Number.isFinite(e.resumeAt) &&
        Number.isFinite(e.detectedAt) &&
        Number.isFinite(e.attempt) &&
        Number.isFinite(e.epoch),
    );
    const recent = parsed.recent && typeof parsed.recent === "object" ? parsed.recent : {};
    const running = {};
    if (parsed.running && typeof parsed.running === "object") {
      for (const [agentId, turn] of Object.entries(parsed.running)) {
        if (validBinding(turn?.binding) && Number.isFinite(turn.at)) running[agentId] = turn;
      }
    }
    return { v: 1, entries, recent, running };
  } catch {
    return emptyQueue();
  }
}
function validBinding(value) {
  return typeof value === "string" && /^v1:[a-f0-9]{64}$/.test(value);
}
function eligibleBinding(agent, binding) {
  return agent.unscopedResumeAllowed && validBinding(binding) && agent.binding === binding;
}
/** Why a loaded session may not take its queued resume, or null when it may. */
function refusalOf(agent, binding) {
  if (!agent) return "session not found";
  if (agent.archived) return "archived";
  if (agent.busy) return "busy";
  if (!agent.unscopedResumeAllowed) return "owned by a trusted plugin";
  if (agent.binding === null) return "no binding after load";
  if (agent.binding !== binding) return "binding changed";
  if (agent.labels[LIMIT_RESUME_OPT_OUT_LABEL] === "off") return "opted out";
  return null;
}
/** Delays before the next resume-time lookup after an unexplained lookup error (three retries at most). */
export const LOOKUP_RETRY_MS = [30_000, 120_000, 600_000];
/** Lookup errors that never clear: the session is archived or no longer exists. */
function permanentLookupRefusal(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/^Agent is archived\b/.test(message)) return "archived";
  if (/^Agent not found\b/.test(message)) return "session not found";
  return null;
}
export class LimitResumeService {
  deps;
  file;
  now;
  random;
  queue = emptyQueue();
  epochs = new Map();
  chain = Promise.resolve();
  timer = null;
  nextSlotAt = 0;
  ticking = false;
  stopped = false;
  startedAt = 0;
  unsubscribe = null;
  constructor(deps) {
    this.deps = deps;
    this.file = limitResumeFilePath(deps.paseoHome);
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
  }
  start() {
    this.startedAt = this.now();
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
  stop() {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
  /** Release the daemon event listener together with the timer on shutdown. */
  onStop(unsubscribe) {
    if (this.stopped) unsubscribe();
    else this.unsubscribe = unsubscribe;
  }
  /** What the app reads: the pending resume time for a session, or null. */
  pendingResumeAt(agentId) {
    return this.queue.entries.find((e) => e.agentId === agentId)?.resumeAt ?? null;
  }
  epochOf(agentId) {
    return this.epochs.get(agentId) ?? 0;
  }
  /** Runs `fn` after everything queued before it, whatever happens to earlier work. */
  locked(fn) {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }
  async onAgentEvent(input) {
    if (this.stopped) return;
    if (input.type !== "agent_stream" || !input.agentId || !input.event) return;
    const agentId = input.agentId;
    const kind = input.event.type;
    if (kind === "turn_started") {
      // Synchronous: the epoch moves before any pending handler can resume from an older stop.
      const epoch = this.epochOf(agentId) + 1;
      this.epochs.set(agentId, epoch);
      await this.cancel(agentId);
      await this.recordRunning(agentId, epoch);
      return;
    }
    const item = input.event.item?.type;
    if (kind === "timeline" && item !== "assistant_message" && item !== "reasoning") {
      // A new session's binding becomes readable only once it is set up, and the turn's user message moves its
      // message time just after this event. So each non-text timeline item (user message, tool call, ...)
      // refreshes the record; streamed text is skipped, and the file is written only on change.
      const epoch = this.epochOf(agentId);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await this.recordRunning(agentId, epoch);
      return;
    }
    if (kind === "turn_canceled") await this.clearRunning(agentId);
    if (kind !== "turn_failed" && kind !== "turn_completed") return;
    // Captured synchronously at the stop, before any await.
    const binding = this.deps.captureBinding(agentId);
    const epoch = this.epochOf(agentId);
    const turnId = typeof input.event.turnId === "string" ? input.event.turnId : null;
    const now = this.now();
    await this.clearRunning(agentId);
    let stop;
    if (kind === "turn_failed") {
      const text = [input.event.error, input.event.code, input.event.diagnostic]
        .filter((part) => part !== undefined && part !== null)
        .map(String)
        .join(" ");
      stop = classifyFailedTurn(text, now);
    } else {
      stop = classifyEndingAssistantMessage(
        input.event.lastAssistant === undefined
          ? await this.deps.getLastAssistantMessage(agentId).catch(() => null)
          : input.event.lastAssistant,
        now,
      );
    }
    if (!stop) return;
    await this.locked(() => this.admit(agentId, stop, epoch, turnId ?? `epoch-${epoch}`, binding));
  }
  async admit(agentId, stop, epoch, stopKey, binding) {
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
    const entry = {
      agentId,
      limitId,
      detectedAt: now,
      resumeAt: schedule.resumeAt,
      attempt,
      epoch,
      source: schedule.source,
      unscoped: true,
      binding: binding,
    };
    this.queue.entries.push(entry);
    this.save();
    await this.deps
      .setMarker(agentId, new Date(entry.resumeAt).toISOString(), network ? "network" : "usage")
      .catch(this.deps.onError);
    this.arm();
  }
  async admissionAgent(agentId, limitId, epoch) {
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
  nextAttempt(recent, network, now) {
    if (!recent || now - recent.resumedAt >= CHAIN_WINDOW_MS) return 0;
    if (network && recent.source !== "network") return 0;
    return recent.attempt + 1;
  }
  schedule(stop, attempt, now) {
    if (stop.kind === "network")
      return { source: "network", resumeAt: now + NETWORK_BACKOFF_MS[attempt] };
    const base = stop.resetAt ?? now + backoffMs(attempt);
    return {
      source: stop.resetAt === null ? "backoff" : "reset",
      resumeAt: base + HANDOFF_MS + Math.floor(this.random() * MAX_JITTER_MS),
    };
  }
  /** Keeps the running turn's binding on disk, so a restart in the middle of it can be resumed safely. */
  recordRunning(agentId, epoch) {
    return this.locked(async () => {
      if (this.stopped || this.epochOf(agentId) !== epoch) return;
      const binding = this.deps.captureBinding(agentId);
      const current = this.queue.running[agentId];
      if (!validBinding(binding)) {
        if (!current) return;
        delete this.queue.running[agentId];
      } else {
        if (current?.binding === binding) return;
        this.queue.running[agentId] = { binding, at: this.now() };
      }
      this.save();
    });
  }
  clearRunning(agentId) {
    return this.locked(async () => {
      if (!this.queue.running[agentId]) return;
      delete this.queue.running[agentId];
      this.save();
    });
  }
  /**
   * Queues, once each, the sessions whose turn was still running when the previous daemon stopped: a record from
   * before this boot means the service stopped (or the process died) before that turn ended. This covers a graceful
   * restart, which saves the cut-off turn as stopped, as well as a crash. `bootId` names this boot.
   */
  enqueueInterrupted(bootId) {
    return this.locked(async () => {
      const recorded = this.queue.running;
      this.queue.running = {};
      for (const [agentId, turn] of Object.entries(recorded)) {
        if (turn.at >= this.startedAt) this.queue.running[agentId] = turn;
        else await this.admitInterrupted(agentId, `${agentId}:interrupted:${bootId}`, turn.binding);
      }
      this.save();
    });
  }
  async admitInterrupted(agentId, limitId, binding) {
    const epoch = this.epochOf(agentId);
    const agent = await this.admissionAgent(agentId, limitId, epoch);
    if (!agent) return;
    // At boot no session is loaded yet. A stored record cannot say who owns the session or what its binding is,
    // so those checks wait for the due time, when fire() loads the session and refuses (fail closed).
    const refusal = agent.stored ? null : refusalOf(agent, binding);
    if (refusal) {
      this.deps.onSkip?.(agentId, refusal);
      await this.clearStaleMarker(agentId, agent);
      return;
    }
    const now = this.now();
    const recent = this.queue.recent[agentId];
    const attempt =
      recent && recent.source === "interrupted" && now - recent.resumedAt < CHAIN_WINDOW_MS
        ? recent.attempt + 1
        : 0;
    if (attempt >= MAX_CHAIN) return;
    const entry = {
      agentId,
      limitId,
      detectedAt: now,
      resumeAt: now + INTERRUPTED_SETTLE_MS + Math.floor(this.random() * MAX_JITTER_MS),
      attempt,
      epoch,
      source: "interrupted",
      unscoped: true,
      binding,
    };
    this.queue.entries.push(entry);
    await this.deps
      .setMarker(agentId, new Date(entry.resumeAt).toISOString(), "interrupted")
      .catch(this.deps.onError);
    this.arm();
  }
  async clearStaleMarker(agentId, agent) {
    if (agent.labels[LIMIT_RESUME_AT_LABEL])
      await this.deps.setMarker(agentId, null).catch(this.deps.onError);
  }
  /** Drops a pending resume (the person resumed, opted out, or something else started a turn). */
  cancel(agentId) {
    return this.locked(async () => {
      const before = this.queue.entries.length;
      this.queue.entries = this.queue.entries.filter((e) => e.agentId !== agentId);
      if (this.queue.entries.length === before) return;
      this.save();
      await this.deps.setMarker(agentId, null).catch(this.deps.onError);
      this.arm();
    });
  }
  save() {
    // Recent resumes only matter inside the chain window.
    const cutoff = this.now() - CHAIN_WINDOW_MS;
    for (const [id, r] of Object.entries(this.queue.recent)) {
      if (r.resumedAt < cutoff) delete this.queue.recent[id];
    }
    this.deps.writeQueue(this.file, `${JSON.stringify(this.queue)}\n`);
  }
  arm() {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.queue.entries.length === 0) return;
    const earliest = Math.min(...this.queue.entries.map((e) => e.resumeAt));
    const at = Math.max(earliest, this.nextSlotAt);
    this.timer = setTimeout(() => void this.tick(), Math.max(0, at - this.now()));
    this.timer.unref?.();
  }
  async tick() {
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
  /**
   * The resume-time lookup threw. A session that is archived or gone never comes back, so it leaves the queue at once.
   * Any other error may be transient: retry with a bounded backoff, then give up. Never leave a due entry in place,
   * or the timer re-fires it every STAGGER_MS.
   */
  async onLookupFailure(entry, error) {
    const permanent = permanentLookupRefusal(error);
    if (permanent) {
      this.deps.onSkip?.(entry.agentId, permanent);
      await this.cancel(entry.agentId);
      return;
    }
    this.deps.onError(error);
    const failures = (entry.lookupFailures ?? 0) + 1;
    if (failures > LOOKUP_RETRY_MS.length) {
      this.deps.onSkip?.(entry.agentId, "lookup failed repeatedly");
      await this.cancel(entry.agentId);
      return;
    }
    const mine = this.queue.entries.find(
      (e) => e.agentId === entry.agentId && e.limitId === entry.limitId,
    );
    if (!mine) return;
    mine.lookupFailures = failures;
    mine.resumeAt = this.now() + LOOKUP_RETRY_MS[failures - 1];
    this.save();
  }
  async fire(entry) {
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
      this.deps.onSkip?.(entry.agentId, "entry no longer valid");
      await this.cancel(entry.agentId);
      return;
    }
    let agent;
    try {
      agent = await this.deps.getAgent(entry.agentId, true);
    } catch (error) {
      if (this.stopped) return;
      await this.onLookupFailure(entry, error);
      return;
    }
    if (this.stopped) return;
    const refusal = refusalOf(agent, entry.binding);
    if (refusal) {
      this.deps.onSkip?.(entry.agentId, refusal);
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
        RESUME_PROMPTS[entry.source] ?? RESUME_PROMPT,
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
        entry.binding,
      )
      .catch(this.deps.onError);
    if (consumed) {
      await this.deps.setMarker(entry.agentId, null).catch(this.deps.onError);
    } else if (!this.stopped) {
      // A final loading/admission guard refused. Do not spin an already-due timer.
      this.deps.onSkip?.(entry.agentId, "refused at the final send check");
      await this.cancel(entry.agentId);
    }
  }
}
