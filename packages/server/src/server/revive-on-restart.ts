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
import { classifyEndingAssistantMessage } from "./limit-resume/detect.js";
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
// - A session closed by hand, archived or internal is left alone. Subagents follow the same rules.
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

/** What revive needs from a loaded session; the default reads the agent manager, tests replace it. */
export interface ReviveSessions {
  load(agentId: string): Promise<void>;
  /** Why the loaded session must not get the continue prompt, or null. */
  refusal(agentId: string): string | null;
  /** The session's account is at a limit: the reset time when known, null when not. Undefined when it is ready. */
  limitedUntil(agentId: string): Promise<Date | null | undefined>;
  sendContinue(agentId: string): Promise<void>;
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

function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n", 1)[0]!.slice(0, 160) || "could not load";
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
    return result;
  }
  const restartedAt = stopRecord ? new Date(stopRecord.stoppedAt) : now();
  const byId = new Map(input.records.map((record) => [record.id, record]));
  const eligible = (id: string) => {
    const record = byId.get(id);
    return Boolean(record && !record.archivedAt && !record.internal);
  };
  const isLoaded = (id: string) => agentManager.getAgent(id) !== null;

  result.reopened = await agentStorage.reopenAfterRestart(
    (stopRecord?.openIds ?? []).filter(eligible),
    isLoaded,
  );
  await fs.rm(file, { force: true });
  const interrupted = [
    ...new Set([...(stopRecord?.interruptedIds ?? []), ...input.crashInterrupted]),
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
  const problem = await folderProblem(record.cwd);
  if (problem) {
    result.closed.push({ id, name, reason: problem });
    return;
  }
  try {
    await sessions.load(id);
  } catch (error) {
    result.closed.push({ id, name, reason: reasonOf(error) });
    return;
  }
  const refusal = sessions.refusal(id);
  if (refusal) {
    logger.info({ agentId: id, reason: refusal }, "Revive on restart: no continue prompt");
    return;
  }
  const limited = await sessions.limitedUntil(id);
  if (limited !== undefined) {
    result.closed.push({ id, name, reason: limitReason(limited) });
    return;
  }
  try {
    await sessions.sendContinue(id);
    result.continued.push(id);
  } catch (error) {
    result.closed.push({ id, name, reason: reasonOf(error) });
  }
}

function defaultSessions(deps: ReviveDeps): ReviveSessions {
  const { agentManager, agentStorage, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const refusal = (id: string): string | null => {
    const live = agentManager.getAgent(id);
    if (!live || live.archivedAt) return "not loaded";
    if (agentManager.hasInFlightRun(id)) return "a turn is already running";
    // A pool-account session has a binding: limit-resume continues it.
    if (agentManager.getLimitResumeBinding(id) !== null)
      return "pool account: limit-resume continues it";
    if (!agentManager.canRunUnscopedLimitResume(id)) return "owned by a trusted plugin";
    if (live.labels[LIMIT_RESUME_OPT_OUT_LABEL] === "off") return "opted out";
    return null;
  };
  return {
    load: async (id) => {
      await ensureUnarchivedAgentLoaded(id, { agentManager, agentStorage, logger });
    },
    refusal,
    limitedUntil: async (id) => {
      const marker = agentManager.getAgent(id)?.labels[LIMIT_RESUME_AT_LABEL];
      const markerAt = marker ? Date.parse(marker) : NaN;
      if (Number.isFinite(markerAt) && markerAt > now().getTime()) return new Date(markerAt);
      const last = await agentManager.getLastAssistantMessage(id).catch(() => null);
      const stop = classifyEndingAssistantMessage(last, now().getTime());
      if (!stop || stop.kind === "network") return undefined;
      return stop.resetAt && stop.resetAt > now().getTime() ? new Date(stop.resetAt) : null;
    },
    sendContinue: async (id) => {
      const live = agentManager.getAgent(id);
      if (!live) throw new Error("session not loaded");
      const checkCurrent = () => {
        const current = agentManager.getAgent(id);
        if (!current || current.instanceId !== live.instanceId || refusal(id))
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
