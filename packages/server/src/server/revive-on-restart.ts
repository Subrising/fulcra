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
// A clean stop saves every open session as "closed", so the stop first records them in $PASEO_HOME/revive-at-boot.json.
// After a crash the records still say "idle"/"running". daemon.reviveOnRestart = false turns it off.

export const REVIVE_FILE = "revive-at-boot.json";
const REVIVE_CONCURRENCY = 2;

const ReviveFileSchema = z.object({
  v: z.literal(1),
  stoppedAt: z.string(),
  openIds: z.array(z.string()),
  interruptedIds: z.array(z.string()),
});

interface LiveAgent {
  id: string;
  lifecycle: string;
  internal?: boolean;
}

/** Clean stop: records the open sessions and the turns still running, before closeAllAgents closes them. */
export async function recordOpenSessions(input: {
  paseoHome: string;
  agents: readonly LiveAgent[];
  now?: Date;
}): Promise<void> {
  const open = input.agents.filter((agent) => !agent.internal && agent.lifecycle !== "closed");
  await writeJsonFileAtomic(path.join(input.paseoHome, REVIVE_FILE), {
    v: 1,
    stoppedAt: (input.now ?? new Date()).toISOString(),
    openIds: open.map((agent) => agent.id),
    interruptedIds: open
      .filter((agent) => agent.lifecycle === "running" || agent.lifecycle === "initializing")
      .map((agent) => agent.id),
  });
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
  /** Why the loaded session must not get the continue prompt, or null. */
  refusal(agentId: string): string | null;
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
}

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
  closed: ClosedSession[];
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
  const stopRecord = await readReviveFile(file, logger);
  const result: ReviveResult = { reopened: [], continued: [], closed: [] };
  if (!deps.isEnabled()) {
    await fs.rm(file, { force: true });
    deps.onSessionsReady?.();
    return result;
  }
  const restartedAt = stopRecord ? new Date(stopRecord.stoppedAt) : now();
  const byId = new Map(input.records.map((record) => [record.id, record]));
  const eligible = (id: string) => {
    const record = byId.get(id);
    return Boolean(record && !record.archivedAt && !record.internal);
  };
  // A session written after the stop was used by a later run (a rollback): the stop record no longer describes it.
  const stoppedAtMs = stopRecord ? Date.parse(stopRecord.stoppedAt) : NaN;
  const notLaterThanStop = (id: string) => {
    const updatedMs = Date.parse(byId.get(id)?.updatedAt ?? "");
    const later = updatedMs > stoppedAtMs;
    if (later) logger.info({ agentId: id }, "Revive on restart: used after the stop, not revived");
    return !later;
  };
  const isLoaded = (id: string) => agentManager.getAgent(id) !== null;

  result.reopened = await agentStorage.reopenAfterRestart(
    (stopRecord?.openIds ?? []).filter(eligible).filter(notLaterThanStop),
    isLoaded,
  );
  await fs.rm(file, { force: true });
  deps.onSessionsReady?.();
  const interrupted = [
    ...new Set([
      ...(stopRecord?.interruptedIds ?? []).filter(notLaterThanStop),
      ...input.crashInterrupted,
    ]),
  ].filter(eligible);
  logger.info(
    { reopened: result.reopened, interrupted },
    `Revive on restart: ${result.reopened.length} reopened, ${interrupted.length} cut-off turn(s) to continue`,
  );
  if (interrupted.length === 0) return result;

  await wait(deps.settleMs ?? INTERRUPTED_SETTLE_MS);
  const sessions = deps.sessions ?? defaultSessions(deps);
  const gapMs = deps.gapMs ?? STAGGER_MS;
  const queue = [...interrupted];
  const worker = async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      await continueOne(id, byId.get(id)!, sessions, result, logger);
      await wait(gapMs);
    }
  };
  await Promise.all(Array.from({ length: REVIVE_CONCURRENCY }, worker));
  logger.info(
    { continued: result.continued, closed: result.closed.map((entry) => entry.id) },
    `Revive on restart: ${result.continued.length} continued, ${result.closed.length} not continued`,
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
): Promise<void> {
  const name = titleOf(record);
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
    result.closed.push({ id, name, reason: problem });
    return;
  }
  try {
    await sessions.load(id);
  } catch (error) {
    logger.warn({ err: error, agentId: id }, "Revive on restart: the session did not load");
    result.closed.push({ id, name, reason: reasonOf(error, "could not load") });
    return;
  }
  const skip = async () => sessions.refusal(id) ?? (await sessions.changedSince(id, cutAt));
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
    result.closed.push({ id, name, reason: "could not check its account limit" });
    return;
  }
  if (limited !== undefined) {
    result.closed.push({ id, name, reason: limitReason(limited) });
    return;
  }
  const last = await skip();
  if (last) {
    logger.info({ agentId: id, reason: last }, "Revive on restart: no continue prompt");
    return;
  }
  try {
    await sessions.sendContinue(id, cutAt);
    result.continued.push(id);
  } catch (error) {
    logger.warn({ err: error, agentId: id }, "Revive on restart: the continue prompt failed");
    result.closed.push({ id, name, reason: reasonOf(error, "could not continue") });
  }
}

/** The real session reads and the continue prompt. Exported for tests. */
export function defaultSessions(deps: ReviveDeps): ReviveSessions {
  const { agentManager, agentStorage, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const refusal = (id: string): string | null => {
    const live = agentManager.getAgent(id);
    if (!live || live.archivedAt) return "not loaded";
    if (agentManager.hasInFlightRun(id)) return "a turn is already running";
    // A pool-account session has a binding: limit-resume continues it.
    if (agentManager.getLimitResumeBinding(id) !== null)
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
    sendContinue: async (id, cutAt) => {
      const live = agentManager.getAgent(id);
      if (!live) throw new Error("session not loaded");
      const checkCurrent = () => {
        const current = agentManager.getAgent(id);
        if (
          !current ||
          current.instanceId !== live.instanceId ||
          refusal(id) ||
          liveMessageAt(id) !== cutAt
        )
          throw new Error("Continue after restart refused");
      };
      checkCurrent();
      const finalCheck = createFinalInputCheck(checkCurrent);
      void agentManager
        .runAgent(id, INTERRUPTED_RESUME_PROMPT, { [FINAL_INPUT_CHECK]: finalCheck })
        .catch((error: unknown) =>
          logger.warn({ err: error, agentId: id }, "Continue after restart failed"),
        );
      await waitForFinalInputHandoff(finalCheck);
    },
  };
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
