import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import {
  INTERRUPTED_RESUME_PROMPT,
  LIMIT_RESUME_AT_LABEL,
  LIMIT_RESUME_OPT_OUT_LABEL,
} from "@getpaseo/protocol/limit-resume";
import { ensureUnarchivedAgentLoaded } from "./agent/agent-loading.js";
import type { AgentManager } from "./agent/agent-manager.js";
import {
  FINISH_NOTIFICATION_MESSAGE_PREFIX,
  formatSystemNotificationPrompt,
  sendPromptToAgent,
} from "./agent/agent-prompt.js";
import { FINAL_INPUT_CHECK } from "./agent/agent-sdk-types.js";
import type { AgentStorage, StoredAgentRecord } from "./agent/agent-storage.js";
import { createFinalInputCheck, waitForFinalInputHandoff } from "./agent/final-input-check.js";
import { writeJsonFileAtomic } from "./atomic-file.js";
import { heldSendsFor } from "./held-sends.js";
import { classifyEndingAssistantMessage, classifyFailedTurn } from "./limit-resume/detect.js";
import { INTERRUPTED_SETTLE_MS, STAGGER_MS } from "./limit-resume/service.js";
import { leadChatOf, titleOf } from "./report-up.js";
import { lineStoreOf } from "./reporting-lines.js";

// FULCRA(orchestration): revive on restart. After a daemon restart (clean stop or crash) work continues, at low cost:
//
// - Open sessions read "idle" again, NOT loaded: clients and leads see them open, and their next prompt or held send
//   loads them as before. No provider process starts for them at boot.
// - A turn the restart cut off is loaded and continued with the same prompt as limit-resume, 2 at a time with a gap,
//   after limit-resume's settle time. Pool-account sessions stay with limit-resume, which continues them by binding.
// - Not continued: a session whose account is at a limit, or that does not load (folder or provider missing). Its
//   lead chat gets one notice per restart that lists them: "daemon restarted at <time>; N sessions closed: <names>".
// - A session closed by hand, archived or internal is left alone, also when that happens during the settle time.
//   Subagents follow the same rules. A lead closed by hand is not woken by the notice; the log says why.
// - The notice has fixed reasons ("folder missing", "provider missing", "could not load"), never an error text: load
//   errors can name a path or a chat ID. The full error goes to the log.
// - A stop record is used only for sessions not written after the stop (`updatedAt <= stoppedAt`). The stop seals
//   `stoppedAt` after every session is closed, so a stop record left by a rolled-back build reopens nothing that
//   the older build used since.
//
// - Background work: a session that was idle but waiting for background work (shells, Monitor watches, CI watches,
//   subagents, timers) lost that work in the restart and would sit idle with nobody to notice. The stop records these
//   sessions as `backgroundIds`, and boot sends each one a single prompt that says so (FU-362). The signals are the
//   ones idle sleep uses to refuse sleep (AgentManager.hasLiveBackgroundWork).
//
// A clean stop saves every open session as "closed", so the stop first records them in $PASEO_HOME/revive-at-boot.json.
// After a crash the records still say "idle"/"running". daemon.reviveOnRestart = false turns it off.
//
// A crash (a watchdog SIGKILL) writes no stop record. While the daemon runs, startLiveRecorder() therefore keeps a
// crash-safe copy of the same record in $PASEO_HOME/revive-live.json. Boot uses it only when revive-at-boot.json is
// missing, and deletes it either way. A clean stop deletes it too, so it exists only after an unclean stop.

export const REVIVE_FILE = "revive-at-boot.json";
export const REVIVE_LIVE_FILE = "revive-live.json";
const LIVE_CHECK_MS = 30_000;
const LIVE_REFRESH_MS = 5 * 60_000;
// A live record is written at most LIVE_REFRESH_MS before the crash, so a session of that run can have `updatedAt`
// later than its `stoppedAt`. Allow that gap plus one check interval and some slack. A longer gap means an older
// build used the session after the record was written, and the record no longer describes it.
const LIVE_TOLERANCE_MS = LIVE_REFRESH_MS + LIVE_CHECK_MS + 30_000;
const REVIVE_CONCURRENCY = 2;

const ReviveFileSchema = z.object({
  v: z.literal(1),
  stoppedAt: z.string(),
  openIds: z.array(z.string()),
  interruptedIds: z.array(z.string()),
  // FU-362: absent in files from older builds, which means none. Older readers ignore the key.
  backgroundIds: z.array(z.string()).default([]),
});

interface LiveAgent {
  id: string;
  lifecycle: string;
  internal?: boolean;
  /** An idle session with live background work (AgentManager.hasLiveBackgroundWork). Read at the moment of the record. */
  hasBackgroundWork?: boolean;
}

/** Clean stop: records the open sessions and the turns still running, before closeAllAgents closes them. */
export async function recordOpenSessions(input: {
  paseoHome: string;
  agents: readonly LiveAgent[];
  now?: Date;
}): Promise<void> {
  await writeJsonFileAtomic(
    path.join(input.paseoHome, REVIVE_FILE),
    openSessionsRecord(input.agents, input.now ?? new Date()),
  );
}

function isCutOff(agent: LiveAgent): boolean {
  return agent.lifecycle === "running" || agent.lifecycle === "initializing";
}

function openSessionsRecord(agents: readonly LiveAgent[], now: Date) {
  const open = agents.filter((agent) => !agent.internal && agent.lifecycle !== "closed");
  return {
    v: 1 as const,
    stoppedAt: now.toISOString(),
    openIds: open.map((agent) => agent.id),
    interruptedIds: open.filter(isCutOff).map((agent) => agent.id),
    backgroundIds: open
      .filter((agent) => !isCutOff(agent) && agent.hasBackgroundWork === true)
      .map((agent) => agent.id),
  };
}

/**
 * While the daemon runs: keeps the crash-safe copy of the open-session record. Checks every 30 s and writes only when
 * the open sessions or the running turns changed, so a burst of changes costs one write, and also every 5 min when
 * nothing changed, so `stoppedAt` stays near the crash. The first check runs at once.
 */
export function startLiveRecorder(input: {
  paseoHome: string;
  listAgents: () => readonly LiveAgent[] | Promise<readonly LiveAgent[]>;
  logger: Logger;
  now?: () => Date;
  checkMs?: number;
  refreshMs?: number;
}): { stop(): Promise<void> } {
  const file = path.join(input.paseoHome, REVIVE_LIVE_FILE);
  const now = input.now ?? (() => new Date());
  const refreshMs = input.refreshMs ?? LIVE_REFRESH_MS;
  let lastSignature: string | null = null;
  let lastWriteAt = 0;
  let writing: Promise<void> = Promise.resolve();
  let stopped = false;
  const check = () => checkOnce();
  const checkOnce = async () => {
    const at = now();
    let record: ReturnType<typeof openSessionsRecord>;
    try {
      record = openSessionsRecord(await input.listAgents(), at);
    } catch (error) {
      input.logger.warn({ err: error }, "Revive on restart: the live record could not be built");
      return;
    }
    const signature = JSON.stringify([
      [...record.openIds].sort(),
      [...record.interruptedIds].sort(),
      [...record.backgroundIds].sort(),
    ]);
    if (stopped) return;
    if (signature === lastSignature && at.getTime() - lastWriteAt < refreshMs) return;
    lastSignature = signature;
    lastWriteAt = at.getTime();
    writing = writing
      .then(() => (stopped ? undefined : writeJsonFileAtomic(file, record)))
      .catch((error: unknown) =>
        input.logger.warn(
          { err: error },
          "Revive on restart: the live record could not be written",
        ),
      );
  };
  void check();
  const timer = setInterval(() => void check(), input.checkMs ?? LIVE_CHECK_MS);
  timer.unref();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await writing;
      await fs.rm(file, { force: true });
    },
  };
}

/**
 * Clean stop, after every session is closed and flushed: moves `stoppedAt` to now, so that the stop's own writes are
 * not later than it. A session written after this belongs to a later run (a rollback to a build without revive).
 */
export async function sealStopRecord(input: { paseoHome: string; now?: Date }): Promise<void> {
  const file = path.join(input.paseoHome, REVIVE_FILE);
  let record: z.infer<typeof ReviveFileSchema>;
  try {
    record = ReviveFileSchema.parse(JSON.parse(await fs.readFile(file, "utf8")));
  } catch {
    return;
  }
  await writeJsonFileAtomic(file, {
    ...record,
    stoppedAt: (input.now ?? new Date()).toISOString(),
  });
}

/** What revive needs from a loaded session; the default reads the agent manager, tests replace it. */
export interface ReviveSessions {
  load(agentId: string): Promise<void>;
  /**
   * Why the loaded session must not get the continue prompt, or null. The background wake does not hand a pool-account
   * session to limit-resume: limit-resume continues only turns a limit cut off.
   */
  refusal(agentId: string, mode?: ReviveMode): string | null;
  /**
   * Read again before the load and just before each resume: why the session is no longer the turn the restart cut
   * off (archived, closed by hand, or a user, limit-resume or a held send gave it a new message since `cutAt`), or
   * null when it still is.
   */
  changedSince(agentId: string, cutAt: string | null): Promise<string | null>;
  /** The session's account is at a limit: the reset time when known, null when not. Undefined when it is ready. */
  limitedUntil(agentId: string): Promise<Date | null | undefined>;
  /** Sends the continue prompt; refuses at the provider handoff if the session got a message after `cutAt`. */
  sendContinue(agentId: string, cutAt: string | null): Promise<void>;
  /** Sends the background-wake prompt (FU-362) under the same refusal rules as sendContinue. */
  sendBackgroundWake(agentId: string, prompt: string, cutAt: string | null): Promise<void>;
}

/** "continue": the restart cut a turn off. "wake": the session was idle, waiting for background work that is gone. */
export type ReviveMode = "continue" | "wake";

export interface ReviveDeps {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  paseoHome: string;
  localServerId: string | null;
  logger: Logger;
  isEnabled: () => boolean;
  now?: () => Date;
  settleMs?: number;
  gapMs?: number;
  sessions?: ReviveSessions;
  /** Saved open states are restored. Start delivery without waiting for provider recovery. */
  onSessionsReady?: () => void;
  /** The notice step; tests replace it. */
  deliver?: (leadId: string, prompt: string) => Promise<void>;
}

export interface ClosedSession {
  id: string;
  name: string;
  reason: string;
}

export interface ReviveResult {
  reopened: string[];
  continued: string[];
  /** Idle sessions that got the background-wake prompt. */
  woken: string[];
  closed: ClosedSession[];
}

export function formatBackgroundWakePrompt(restartedAt: Date): string {
  const time = restartedAt.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `The Fulcra daemon restarted at ${time}. Background work you started before the restart (background shells, Monitor watches, CI watches, subagents, timers) was stopped. Check what finished and what did not, then restart only what you still need. Do not repeat finished steps.`;
}

export function formatRestartNotice(input: {
  restartedAt: Date;
  closed: ReadonlyArray<{ name: string; reason: string }>;
}): string {
  const time = input.restartedAt.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  const names = input.closed.map((entry) => `${entry.name} (${entry.reason})`).join(", ");
  const count = input.closed.length;
  return `Daemon restarted at ${time}; ${count} session${count === 1 ? "" : "s"} closed: ${names}`;
}

async function readReviveFile(file: string, logger: Logger) {
  try {
    return ReviveFileSchema.parse(JSON.parse(await fs.readFile(file, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      logger.warn({ err: error }, "Revive on restart: the stop record could not be read");
    return null;
  }
}

async function folderProblem(cwd: string): Promise<string | null> {
  try {
    return (await fs.stat(cwd)).isDirectory() ? null : "folder is not a directory";
  } catch {
    return "folder missing";
  }
}

/** A fixed reason for the lead notice. The error text can name a path or a chat ID, so it goes to the log only. */
function reasonOf(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/\bENOENT\b|\bspawn\b|not available|not installed|command not found/i.test(message))
    return "provider missing";
  return fallback;
}

function limitReason(until: Date | null): string {
  if (!until) return "account at a limit";
  const time = until.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `account at a limit until ${time}`;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * An idle session that waited for background work. The live record is up to a few minutes old, so a session whose
 * work ended since may get a prompt it did not need; the prompt says to check first. A null or missing timestamp
 * never drops a session (notLaterThanStop reads it as not later).
 */
function backgroundToWake(
  stopRecord: { backgroundIds: readonly string[] } | null,
  interrupted: readonly string[],
  keep: (id: string) => boolean,
  logger: Logger,
): string[] {
  const ids = [...new Set(stopRecord?.backgroundIds)]
    .filter((id) => !interrupted.includes(id))
    .filter(keep);
  if (ids.length > 0) logger.info({ agentIds: ids }, "Revive on restart: background wake");
  return ids;
}

/** Cut-off turns first, then background wakes: REVIVE_CONCURRENCY at a time, each followed by a gap. */
async function runQueue(input: {
  interrupted: readonly string[];
  background: readonly string[];
  wakePrompt: string;
  gapMs: number;
  run: (item: { id: string; mode: ReviveMode }, wakePrompt: string) => Promise<void>;
}): Promise<void> {
  const queue = [
    ...input.interrupted.map((id) => ({ id, mode: "continue" as const })),
    ...input.background.map((id) => ({ id, mode: "wake" as const })),
  ];
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      await input.run(item, input.wakePrompt);
      await wait(input.gapMs);
    }
  };
  await Promise.all(Array.from({ length: REVIVE_CONCURRENCY }, worker));
}

/**
 * Boot. `records` is the registry as read before the boot normalised interrupted turns; `crashInterrupted` lists the
 * turns that normalisation found still running (a crash). Resolves when every cut-off turn was handled.
 */
export async function reviveAfterRestart(
  deps: ReviveDeps,
  input: { records: readonly StoredAgentRecord[]; crashInterrupted: readonly string[] },
): Promise<ReviveResult> {
  const { agentManager, agentStorage, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const file = path.join(deps.paseoHome, REVIVE_FILE);
  const liveFile = path.join(deps.paseoHome, REVIVE_LIVE_FILE);
  const cleanRecord = await readReviveFile(file, logger);
  // No clean-stop record means an unclean stop: use the crash-safe copy of the running daemon.
  const liveRecord = cleanRecord ? null : await readReviveFile(liveFile, logger);
  const stopRecord = cleanRecord ?? liveRecord;
  if (liveRecord) logger.info("Revive on restart: unclean stop, using the live record");
  const result: ReviveResult = { reopened: [], continued: [], woken: [], closed: [] };
  if (!deps.isEnabled()) {
    await fs.rm(file, { force: true });
    await fs.rm(liveFile, { force: true });
    deps.onSessionsReady?.();
    return result;
  }
  const restartedAt = cleanRecord ? new Date(cleanRecord.stoppedAt) : now();
  const byId = new Map(input.records.map((record) => [record.id, record]));
  const eligible = (id: string) => {
    const record = byId.get(id);
    return Boolean(record && !record.archivedAt && !record.internal);
  };
  // A session written after the stop was used by a later run (a rollback): the stop record no longer describes it.
  const stoppedAtMs = stopRecord ? Date.parse(stopRecord.stoppedAt) : NaN;
  const notLaterThanStop = (id: string) => {
    const updatedMs = Date.parse(byId.get(id)?.updatedAt ?? "");
    // The live record is up to LIVE_TOLERANCE_MS older than the crash, and the sessions it lists kept running until
    // then, so their `updatedAt` is later. Without the gap the sessions that most need to reopen would be dropped.
    const later = updatedMs > stoppedAtMs + (liveRecord ? LIVE_TOLERANCE_MS : 0);
    if (later) logger.info({ agentId: id }, "Revive on restart: used after the stop, not revived");
    return !later;
  };
  const isLoaded = (id: string) => agentManager.getAgent(id) !== null;

  result.reopened = await agentStorage.reopenAfterRestart(
    (stopRecord?.openIds ?? []).filter(eligible).filter(notLaterThanStop),
    isLoaded,
  );
  await fs.rm(file, { force: true });
  await fs.rm(liveFile, { force: true });
  deps.onSessionsReady?.();
  const interrupted = [
    ...new Set([
      // The live record can be older than the crash: a turn it lists may have ended since. Only the boot's own
      // reading of turns still running (crashInterrupted) is current.
      ...(liveRecord ? [] : (stopRecord?.interruptedIds ?? [])).filter(notLaterThanStop),
      ...input.crashInterrupted,
    ]),
  ].filter(eligible);
  const background = backgroundToWake(
    stopRecord,
    interrupted,
    (id) => eligible(id) && notLaterThanStop(id),
    logger,
  );
  logger.info(
    { reopened: result.reopened, interrupted },
    `Revive on restart: ${result.reopened.length} reopened, ${interrupted.length} cut-off turn(s) to continue`,
  );
  if (interrupted.length === 0 && background.length === 0) return result;

  await wait(deps.settleMs ?? INTERRUPTED_SETTLE_MS);
  const sessions = deps.sessions ?? defaultSessions(deps);
  await runQueue({
    interrupted,
    background,
    wakePrompt: formatBackgroundWakePrompt(restartedAt),
    gapMs: deps.gapMs ?? STAGGER_MS,
    run: (item, wakePrompt) =>
      continueOne(item.id, byId.get(item.id)!, sessions, result, logger, item.mode, wakePrompt),
  });
  logger.info(
    {
      continued: result.continued,
      woken: result.woken,
      closed: result.closed.map((entry) => entry.id),
    },
    `Revive on restart: ${result.continued.length} continued, ${result.woken.length} woken, ${result.closed.length} not continued`,
  );
  await tellLeads(deps, restartedAt, result.closed, byId);
  return result;
}

async function continueOne(
  id: string,
  record: StoredAgentRecord,
  sessions: ReviveSessions,
  result: ReviveResult,
  logger: Logger,
  mode: ReviveMode,
  wakePrompt: string,
): Promise<void> {
  const name = titleOf(record);
  // A woken session is open and idle, as the user left it: a failure here is logged, not named as closed to its lead.
  const fail = (reason: string) => {
    if (mode === "continue") result.closed.push({ id, name, reason });
    else logger.info({ agentId: id, reason }, "Revive on restart: background wake not sent");
  };
  // The boot snapshot is at least the settle time old: read the session again so it is never resumed twice, and so
  // a session archived or closed by hand in the meantime is neither loaded nor named in a notice.
  const cutAt = record.lastUserMessageAt ?? null;
  const changed = await sessions.changedSince(id, cutAt);
  if (changed) {
    logger.info({ agentId: id, reason: changed }, "Revive on restart: not loaded");
    return;
  }
  const problem = await folderProblem(record.cwd);
  if (problem) {
    fail(problem);
    return;
  }
  try {
    await sessions.load(id);
  } catch (error) {
    logger.warn({ err: error, agentId: id }, "Revive on restart: the session did not load");
    fail(reasonOf(error, "could not load"));
    return;
  }
  const skip = async () => sessions.refusal(id, mode) ?? (await sessions.changedSince(id, cutAt));
  const before = await skip();
  if (before) {
    logger.info({ agentId: id, reason: before }, "Revive on restart: no continue prompt");
    return;
  }
  // FU-25: a session with no pool account has no account record to ask, so its limit is read from its own last
  // messages. When that read fails, the session is not continued (fail closed): a stop at a limit looks the same.
  let limited: Date | null | undefined;
  try {
    limited = await sessions.limitedUntil(id);
  } catch (error) {
    logger.warn(
      { err: error, agentId: id },
      "Revive on restart: the account limit could not be checked",
    );
    fail("could not check its account limit");
    return;
  }
  if (limited !== undefined) {
    fail(limitReason(limited));
    return;
  }
  const last = await skip();
  if (last) {
    logger.info({ agentId: id, reason: last }, "Revive on restart: no continue prompt");
    return;
  }
  try {
    if (mode === "wake") {
      await sessions.sendBackgroundWake(id, wakePrompt, cutAt);
      result.woken.push(id);
    } else {
      await sessions.sendContinue(id, cutAt);
      result.continued.push(id);
    }
  } catch (error) {
    logger.warn({ err: error, agentId: id }, "Revive on restart: the continue prompt failed");
    fail(reasonOf(error, "could not continue"));
  }
}

/** The real session reads and the continue prompt. Exported for tests. */
export function defaultSessions(deps: ReviveDeps): ReviveSessions {
  const { agentManager, agentStorage, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const refusal = (id: string, mode: ReviveMode = "continue"): string | null => {
    const live = agentManager.getAgent(id);
    if (!live || live.archivedAt) return "not loaded";
    if (agentManager.hasInFlightRun(id)) return "a turn is already running";
    // A pool-account session has a binding: limit-resume continues it.
    if (mode === "continue" && agentManager.getLimitResumeBinding(id) !== null)
      return "pool account: limit-resume continues it";
    // The owner continues its sessions through the controller restart queue and its journal checks.
    if (!agentManager.canRunUnscopedLimitResume(id)) return "owned by a trusted plugin";
    if (live.labels[LIMIT_RESUME_OPT_OUT_LABEL] === "off") return "opted out";
    return null;
  };
  const liveMessageAt = (id: string) =>
    agentManager.getAgent(id)?.lastUserMessageAt?.toISOString() ?? null;
  return {
    load: async (id) => {
      await ensureUnarchivedAgentLoaded(id, { agentManager, agentStorage, logger });
    },
    refusal,
    changedSince: async (id, cutAt) => {
      const stored = await agentStorage.get(id);
      if (!stored || stored.archivedAt) return "archived or removed since the restart";
      // Boot set every open session back to idle: "closed" now means a user closed it during the settle time.
      if (stored.lastStatus === "closed") return "closed by hand since the restart";
      if ((stored.lastUserMessageAt ?? null) !== cutAt || liveMessageAt(id) !== cutAt)
        return "a new message arrived since the restart";
      return null;
    },
    limitedUntil: async (id) => {
      const marker = agentManager.getAgent(id)?.labels[LIMIT_RESUME_AT_LABEL];
      const markerAt = marker ? Date.parse(marker) : NaN;
      if (Number.isFinite(markerAt) && markerAt > now().getTime()) return new Date(markerAt);
      // Reads that fail throw: the caller treats an unreadable limit state as a refusal, never as "ready".
      const last = await agentManager.getLastAssistantMessage(id);
      const stored = await agentStorage.get(id);
      // A failed turn carries its limit text as the error (Codex on a ChatGPT login ends a limited turn this way).
      const failure = stored?.lastError
        ? classifyFailedTurn(stored.lastError, now().getTime())
        : null;
      const stop = classifyEndingAssistantMessage(last, now().getTime()) ?? failure;
      if (!stop || stop.kind === "network") return undefined;
      return stop.resetAt && stop.resetAt > now().getTime() ? new Date(stop.resetAt) : null;
    },
    sendContinue: (id, cutAt) => sendPrompt(id, cutAt, INTERRUPTED_RESUME_PROMPT, "continue"),
    sendBackgroundWake: (id, prompt, cutAt) => sendPrompt(id, cutAt, prompt, "wake"),
  };
  async function sendPrompt(id: string, cutAt: string | null, prompt: string, mode: ReviveMode) {
    const live = agentManager.getAgent(id);
    if (!live) throw new Error("session not loaded");
    const checkCurrent = () => {
      const current = agentManager.getAgent(id);
      if (
        !current ||
        current.instanceId !== live.instanceId ||
        refusal(id, mode) ||
        liveMessageAt(id) !== cutAt
      )
        throw new Error("Continue after restart refused");
    };
    checkCurrent();
    const finalCheck = createFinalInputCheck(checkCurrent);
    void agentManager
      .runAgent(id, prompt, { [FINAL_INPUT_CHECK]: finalCheck })
      .catch((error: unknown) =>
        logger.warn({ err: error, agentId: id }, "Continue after restart failed"),
      );
    await waitForFinalInputHandoff(finalCheck);
  }
}

async function tellLeads(
  deps: ReviveDeps,
  restartedAt: Date,
  closed: readonly ClosedSession[],
  byId: ReadonlyMap<string, StoredAgentRecord>,
): Promise<void> {
  const store = lineStoreOf({ agentManager: deps.agentManager, agentStorage: deps.agentStorage });
  const perLead = new Map<string, ClosedSession[]>();
  for (const entry of closed) {
    const record = byId.get(entry.id);
    if (!record) continue;
    const lead = await leadChatOf(store, record, deps.localServerId);
    if ("skip" in lead) {
      deps.logger.info({ agentId: entry.id, reason: lead.skip }, "Revive on restart: no lead told");
      continue;
    }
    const leadRecord = await store.get(lead.id);
    if (!leadRecord || leadRecord.archivedAt) continue;
    // Agent decision (FU-67, the owner can change it): a lead closed by hand stays closed. The notice would load it and
    // start a turn, so only the log names the closed sessions.
    if ((await deps.agentStorage.get(lead.id))?.lastStatus === "closed") {
      deps.logger.info(
        { agentId: entry.id, leadId: lead.id, reason: entry.reason },
        "Revive on restart: the lead is closed, not woken",
      );
      continue;
    }
    perLead.set(lead.id, [...(perLead.get(lead.id) ?? []), entry]);
  }
  const deliver = deps.deliver ?? ((leadId, prompt) => holdNotice(deps, leadId, prompt));
  for (const [leadId, entries] of perLead) {
    const prompt = formatSystemNotificationPrompt(
      formatRestartNotice({ restartedAt, closed: entries }),
    );
    await deliver(leadId, prompt).catch((error: unknown) =>
      deps.logger.warn({ err: error, leadId }, "Revive on restart: the lead notice failed"),
    );
  }
}

/** Held until the lead's turn ends (held-sends.ts), as a daemon notice; a notice never starts a report-up. */
async function holdNotice(deps: ReviveDeps, leadId: string, prompt: string): Promise<void> {
  const { agentManager, agentStorage, logger } = deps;
  heldSendsFor(agentManager, logger).hold(leadId, () =>
    agentManager.trustedPlugins.daemon(async () => {
      await sendPromptToAgent({
        agentManager,
        agentStorage,
        agentId: leadId,
        prompt,
        messageId: `${FINISH_NOTIFICATION_MESSAGE_PREFIX}restart:${randomUUID()}`,
        activeTurnBehavior: "steer",
        steerOnly: true,
        unarchive: false,
        logger,
      });
    }),
  );
}
