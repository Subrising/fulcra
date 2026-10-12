import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { writePrivateFileAtomicSync } from "./private-files.js";
import type { Logger } from "pino";
import {
  MAIN_ASSISTANT_ROLE,
  REPORTS_TO_OWNER,
  ROLE_REF_PREFIX,
  SEAT_LABEL,
} from "@getpaseo/protocol/agent-labels";
import { FINAL_INPUT_CHECK } from "./agent/agent-sdk-types.js";
import type { AgentManager, AgentManagerEvent } from "./agent/agent-manager.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import {
  FINISH_NOTIFICATION_MESSAGE_PREFIX,
  formatSystemNotificationPrompt,
  hasArmedFinishNotification,
  isSystemInjectedEnvelope,
  sendPromptToAgent,
} from "./agent/agent-prompt.js";
import { createFinalInputCheck, waitForFinalInputHandoff } from "./agent/final-input-check.js";
import type { DaemonConfigStore } from "./daemon-config-store.js";
import { heldSendsFor } from "./held-sends.js";
import {
  defaultLedgerDir,
  readOpenLedgerRows,
  rowsOwnedBy,
  type LedgerRow,
} from "./ledger-items.js";
import { lastAgentMessageAt } from "./agent-message-log.js";
import { classifyEndingAssistantMessage, classifyFailedTurn } from "./limit-resume/detect.js";
import {
  decideSend,
  lineStoreOf,
  reportsTo,
  resolveRoleTarget,
  type LineAgent,
  type LineStore,
} from "./reporting-lines.js";

// FULCRA(orchestration): report-up. When a chat that has a lead (fulcra.reports-to, else its parent) ends a turn and
// goes idle, its lead gets ONE short notice with the start of the chat's last message. Workers' reports and
// questions then reach the lead without anyone asking.
//
// Rules:
// - Once per turn. A turn that a notice started (any daemon notice: the message id prefix, or the system envelope)
//   sends nothing, so a lead that answers a notice never notifies its own lead, and two chats cannot ping-pong.
// - No lead, the owner as lead, a lead on another computer, or a send the reporting line refuses: nothing.
// - A caller that already waits on this chat's finish (an armed finish notification, or a native report) gets that
//   notice instead; report-up stays quiet for it.
// - The notice uses the daemon source, like the finish notification, and waits in the lead's held-send queue: it
//   never enters or cancels the lead's running turn (held-sends.ts).
// - A lead (a chat that other chats report to) sends no "finished a turn" notice to the main assistant (FU-113): leads
//   report up on purpose. A failed lead turn is still sent, and worker-to-lead notices are unchanged.
// - "Finished a turn" notices for one lead are combined (FU-115): the first goes at once when the lead is idle and was
//   not told in the last 5 minutes; others wait and go out as ONE message listing each worker with a short snippet,
//   after the window and after the lead's running turn ends. A worker that already messaged its lead during its turn
//   sends none. A failed turn is still sent at once. Waiting notices are in memory: a daemon restart drops them.
// - OFF BY DEFAULT (0.2.17): native notifyOnFinish is the standard way a lead hears a worker finish. daemon.reportUpOnTurnEnd
//   = true turns these "finished a turn" notices and idle-lead nudges on. Permission and limit notices stay on unless
//   daemon.reportUpOnTurnEnd = false turns every report-up notice off.
// - A lead that turns idle while it owns open ledger items and has idle workers gets ONE short message that lists them
//   (FU-101). It is driven by the end of the lead's turn, not by a timer. It is sent at most once per idle period, and
//   never after a turn that a nudge started, so a lead that does nothing is not nudged again and again.
// - A new pending permission prompt in a chat sends its lead ONE notice (chat, tool, the start of the command, folder)
//   (FU-68), so the lead can allow or deny it. It is driven by the daemon's own permission event, not by polling, and
//   it changes no guard or ask rule.
// - A turn that ends on a usage limit ("You've hit your session limit ...") is not "a turn finished" (FU-63). The chat
//   is marked limited (kind and reset time), its lead hears ONCE ("<chat> is at its <kind> limit until <time>"), and
//   a chat that is limited is not woken by worker reports: they are held and sent as one notice after the reset.

export const REPORT_UP_SNIPPET_CHARS = 600;
/** How much of a command a permission notice carries. */
export const PERMISSION_COMMAND_CHARS = 200;

interface TurnState {
  /** A turn began (turn_started, or its first user message) and has not ended yet; one notice per turn. */
  open: boolean;
  /** The first user message of this turn was a daemon notice. */
  fromNotice: boolean | null;
  /** The first user message of this turn was an idle-lead nudge. */
  fromNudge?: boolean;
  /** Epoch ms when the turn began; kept after it ends, so a notice can ask "did this worker message its lead?". */
  startedAt?: number;
}

/** One worker's "finished a turn" line waiting to go to its lead (FU-115). */
interface PendingFinish {
  workerId: string;
  worker: LineAgent;
  lastMessage: string | null;
}

/** Between two combined "finished a turn" messages to one lead. */
export const COALESCE_WINDOW_MS = 5 * 60 * 1000;
/** Workers one combined message lists; the rest are counted. */
export const COMBINED_LIST_LIMIT = 20;
/** The snippet of each worker in a combined message. */
export const COMBINED_SNIPPET_CHARS = 300;

/** The message id prefix of an idle-lead nudge; it starts with the notice prefix, so it counts as a notice too. */
export const NUDGE_MESSAGE_PREFIX = `${FINISH_NOTIFICATION_MESSAGE_PREFIX}idle-nudge:`;
/** Most workers and items the nudge lists. */
export const NUDGE_LIST_LIMIT = 8;

export interface ReportUpDeps {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  /** "Finished a turn" notices: off unless the owner turned the fallback on. */
  isEnabled: () => boolean;
  /** The permission and limit notices: on unless every report-up notice is turned off. Default: on. */
  isOtherEnabled?: () => boolean;
  /** Idle-lead nudges are off unless the owner enables them. */
  isNudgeEnabled?: () => boolean;
  localServerId: string | null;
  logger: Logger;
  /** The delivery step; tests replace it. */
  deliver?: (leadId: string, prompt: string) => Promise<void>;
  /** The clock and the timer; tests replace them. */
  now?: () => number;
  setTimer?: (run: () => void, ms: number) => void;
  /** Where the limited chats and the held reports are kept, so a daemon restart does not lose them. */
  statePath?: string;
  /** The open ledger rows; tests replace it. Default: the project ledgers under FULCRA_LEDGER_DIR or ~/shared-vault. */
  readLedger?: () => readonly LedgerRow[];
}

interface PersistedState {
  v: 1;
  limited: Record<string, LimitedChat>;
  held: Record<string, string[]>;
}

/** A chat whose last turn ended on a usage limit. */
export interface LimitedChat {
  kind: string;
  /** Epoch ms of the reset; our own estimate when the text named none. */
  until: number;
  /** Its lead was told. */
  notified: boolean;
}

/** Wait when the limit text names no reset. */
export const UNKNOWN_RESET_MS = 15 * 60 * 1000;
/** Reports held for one limited chat; the oldest are dropped past this. */
export const MAX_HELD_REPORTS = 20;

export function formatLimitNotice(title: string, limit: LimitedChat): string {
  const when = new Date(limit.until).toLocaleString("en-AU", {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
  return `${title} is at its ${limit.kind} limit until ${when}.`;
}

export interface PermissionRequest {
  id: string;
  name?: string;
  title?: string;
  input?: Record<string, unknown>;
  detail?: { type?: string; command?: unknown; filePath?: unknown } | null;
}

/** The start of what the chat wants to run, for a lead that has to allow or deny it. */
export function permissionCommandOf(request: PermissionRequest): string {
  const raw =
    (typeof request.input?.command === "string" && request.input.command) ||
    (typeof request.detail?.command === "string" && request.detail.command) ||
    (typeof request.detail?.filePath === "string" && request.detail.filePath) ||
    request.title ||
    "";
  const text = raw.replace(/\s+/g, " ").trim();
  return text.length > PERMISSION_COMMAND_CHARS
    ? `${text.slice(0, PERMISSION_COMMAND_CHARS)}…`
    : text;
}

/** The idle-lead nudge: a short list of the lead's open items and its idle workers. */
export function formatNudge(workers: readonly LineAgent[], items: readonly LedgerRow[]): string {
  const more = (count: number) =>
    count > NUDGE_LIST_LIMIT ? `, and ${count - NUDGE_LIST_LIMIT} more` : "";
  const itemList = items
    .slice(0, NUDGE_LIST_LIMIT)
    .map((row) => row.id)
    .join(", ");
  const workerList = workers
    .slice(0, NUDGE_LIST_LIMIT)
    .map((worker) => `${titleOf(worker)} (${worker.id})`)
    .join(", ");
  return [
    `You are idle. You own ${items.length} open ledger item${items.length === 1 ? "" : "s"}: ${itemList}${more(items.length)}.`,
    `${workers.length} of your worker${workers.length === 1 ? " is" : "s are"} idle: ${workerList}${more(workers.length)}.`,
    "Send each idle worker its next task, or close the item it finished.",
  ].join("\n");
}

export function formatPermissionNotice(input: {
  worker: LineAgent;
  request: PermissionRequest;
  cwd: string | null;
}): string {
  const command = permissionCommandOf(input.request);
  return [
    `Worker ${titleOf(input.worker)} (${input.worker.id}) is waiting for permission.`,
    `Tool: ${input.request.name ?? "unknown"}`,
    `Command: ${command || "(none)"}`,
    `Folder: ${input.cwd ?? "unknown"}`,
    `Request: ${input.request.id}`,
  ].join("\n");
}

function failureText(event: object): string {
  const failed = event as { error?: unknown; code?: unknown; diagnostic?: unknown };
  return [failed.error, failed.code, failed.diagnostic]
    .filter((part) => part !== undefined && part !== null)
    .map(String)
    .join(" ");
}

function isNudgeMessage(item: { clientMessageId?: unknown }): boolean {
  return (
    typeof item.clientMessageId === "string" &&
    item.clientMessageId.startsWith(NUDGE_MESSAGE_PREFIX)
  );
}

function isNoticeMessage(item: { text?: unknown; clientMessageId?: unknown }): boolean {
  const id = typeof item.clientMessageId === "string" ? item.clientMessageId : "";
  const text = typeof item.text === "string" ? item.text : "";
  return id.startsWith(FINISH_NOTIFICATION_MESSAGE_PREFIX) || isSystemInjectedEnvelope(text);
}

/** One worker's finished turn, or the list of them when several finished since the lead was last told. */
export function formatCombinedNotice(items: readonly PendingFinish[]): string {
  const only = items.length === 1 ? items[0] : undefined;
  if (only)
    return formatReportUpNotice({
      worker: only.worker,
      failed: false,
      lastMessage: only.lastMessage,
    });
  const line = (item: PendingFinish) => {
    const text = (item.lastMessage ?? "").trim();
    const snippet =
      text.length > COMBINED_SNIPPET_CHARS ? `${text.slice(0, COMBINED_SNIPPET_CHARS)}…` : text;
    return `- Worker ${titleOf(item.worker)} (${item.worker.id}): ${snippet || "(no message)"}`;
  };
  const shown = items.slice(0, COMBINED_LIST_LIMIT).map(line);
  const rest = items.length - shown.length;
  return [
    `${items.length} workers finished a turn since your last update:`,
    ...shown,
    ...(rest > 0 ? [`…and ${rest} more.`] : []),
  ].join("\n");
}

export function titleOf(agent: LineAgent): string {
  const config = agent.config as { title?: unknown } | null | undefined;
  const live = typeof config?.title === "string" ? config.title.trim() : "";
  return agent.title?.trim() || live || agent.id.slice(0, 8);
}

export function formatReportUpNotice(input: {
  worker: LineAgent;
  failed: boolean;
  lastMessage: string | null;
}): string {
  const text = (input.lastMessage ?? "").trim();
  const snippet =
    text.length > REPORT_UP_SNIPPET_CHARS ? `${text.slice(0, REPORT_UP_SNIPPET_CHARS)}…` : text;
  const verb = input.failed ? "ended a turn with an error" : "finished a turn";
  return `Worker ${titleOf(input.worker)} (${input.worker.id}) ${verb}: ${snippet || "(no message)"}`;
}

/** A chat's lead chat on this computer (fulcra.reports-to, else its parent), or the reason there is none. */
export async function leadChatOf(
  store: LineStore,
  worker: LineAgent,
  localServerId: string | null,
): Promise<{ id: string } | { skip: string }> {
  const ref = reportsTo(worker);
  if (!ref || ref === REPORTS_TO_OWNER) return { skip: "no lead chat" };
  let leadId = ref;
  if (ref.startsWith(ROLE_REF_PREFIX)) {
    const role = await resolveRoleTarget(store, ref);
    if (!role?.ok) return { skip: "role has no chat" };
    leadId = role.agentId;
  }
  const [id, server] = leadId.split("@", 2);
  if (server !== undefined && server !== localServerId) return { skip: "lead on another computer" };
  if (!id || id === worker.id) return { skip: "no lead chat" };
  return { id };
}

export class ReportUpService {
  private readonly turns = new Map<string, TurnState>();
  private readonly store: LineStore;
  private readonly limited = new Map<string, LimitedChat>();
  private readonly held = new Map<string, string[]>();
  /** Permission prompts already sent to a lead, as "<chat>:<request>"; a request is told once. */
  private readonly askedPermission = new Set<string>();
  /** Leads already nudged in this idle period; cleared when the lead starts a turn. */
  private readonly nudged = new Set<string>();

  constructor(private readonly deps: ReportUpDeps) {
    this.store = lineStoreOf({ agentManager: deps.agentManager, agentStorage: deps.agentStorage });
    this.load();
  }

  /** Reads the kept state: limits that have not passed, and reports still held. Held reports are released after the reset. */
  private load(): void {
    const file = this.deps.statePath;
    if (!file) return;
    let state: Partial<PersistedState> = {};
    try {
      state = JSON.parse(readFileSync(file, "utf8")) as Partial<PersistedState>;
    } catch {
      return;
    }
    const now = this.now();
    for (const [id, limit] of Object.entries(state.limited ?? {})) {
      if (typeof limit?.kind === "string" && Number.isFinite(limit.until) && limit.until > now)
        this.limited.set(id, {
          kind: limit.kind,
          until: limit.until,
          notified: limit.notified === true,
        });
    }
    for (const [lead, held] of Object.entries(state.held ?? {})) {
      const reports = Array.isArray(held)
        ? held.filter((r): r is string => typeof r === "string").slice(-MAX_HELD_REPORTS)
        : [];
      if (!reports.length) continue;
      this.held.set(lead, reports);
      const wait = Math.max(0, (this.limited.get(lead)?.until ?? now) - now) + 5000;
      (this.deps.setTimer ?? ((run, ms) => setTimeout(run, ms).unref()))(
        () => this.releaseHeld(lead),
        wait,
      );
    }
  }

  private save(): void {
    const file = this.deps.statePath;
    if (!file) return;
    const state: PersistedState = {
      v: 1,
      limited: Object.fromEntries(this.limited),
      held: Object.fromEntries(this.held),
    };
    try {
      writePrivateFileAtomicSync(file, JSON.stringify(state));
    } catch (err) {
      this.deps.logger.warn({ err }, "Report-up state not saved");
    }
  }

  onEvent(event: AgentManagerEvent): void {
    // A closed chat keeps no state here, so the map does not grow with old chats.
    if (event.type === "agent_state" && event.agent.lifecycle === "closed") {
      this.turns.delete(event.agent.id);
      for (const key of this.askedPermission)
        if (key.startsWith(`${event.agent.id}:`)) this.askedPermission.delete(key);
      return;
    }
    if (event.type !== "agent_stream") return;
    const { agentId } = event;
    const kind = event.event.type;
    const turn = this.turns.get(agentId) ?? { open: false, fromNotice: null };
    this.turns.set(agentId, turn);
    if (kind === "permission_requested" || kind === "permission_resolved") {
      this.onPermissionEvent(agentId, kind, event.event);
      return;
    }
    if (kind === "turn_started") {
      turn.open = true;
      turn.startedAt = this.now();
      this.nudged.delete(agentId);
      return;
    }
    // A canceled turn (interrupt, stop, archive) sends nothing, and its first message must not decide for the next.
    if (kind === "turn_canceled") {
      turn.open = false;
      turn.fromNotice = null;
      turn.fromNudge = false;
      turn.startedAt = undefined;
      return;
    }
    if (kind === "timeline") {
      const item = event.event.item;
      if (item.type !== "user_message" || turn.fromNotice !== null) return;
      turn.open = true;
      turn.startedAt ??= this.now();
      turn.fromNotice = isNoticeMessage(item);
      turn.fromNudge = isNudgeMessage(item);
      return;
    }
    if (kind !== "turn_completed" && kind !== "turn_failed") return;
    this.onTurnEnd(agentId, turn, kind, event.event);
  }

  private onTurnEnd(
    agentId: string,
    turn: TurnState,
    kind: "turn_completed" | "turn_failed",
    streamEvent: object,
  ): void {
    // A second end event for the same turn sends nothing.
    if (!turn.open) return;
    turn.open = false;
    const startedAt = turn.startedAt;
    turn.startedAt = undefined;
    // Read synchronously at the stop: a caller's armed finish notification removes itself after it delivers.
    const fromNotice = turn.fromNotice === true;
    turn.fromNotice = null;
    const fromNudge = turn.fromNudge === true;
    turn.fromNudge = false;
    const nudgeEnabled = this.deps.isNudgeEnabled?.() === true;
    if (kind === "turn_completed" && !fromNudge && nudgeEnabled)
      void this.nudgeIdleLead(agentId).catch((err: unknown) =>
        this.deps.logger.warn({ err, agentId }, "Idle-lead nudge failed"),
      );
    const leadHint = reportsTo(this.deps.agentManager.getAgent(agentId) ?? null);
    const armed = leadHint
      ? hasArmedFinishNotification(this.deps.agentManager, agentId, leadHint) ||
        this.deps.agentManager.nativeReportOwnsFinish(agentId, leadHint)
      : false;
    if (fromNotice || armed) {
      // A limit is recorded even when this turn sends no report, so the chat is not woken again while it is limited.
      void this.noteLimit(agentId, kind === "turn_failed", failureText(streamEvent)).catch(
        (err: unknown) => this.deps.logger.warn({ err, agentId }, "Limit note failed"),
      );
      this.deps.logger.info(
        { agentId, reason: fromNotice ? "turn started by a notice" : "caller already notified" },
        "Report-up skipped",
      );
      return;
    }
    void this.report(agentId, kind === "turn_failed", failureText(streamEvent), startedAt).catch(
      (err: unknown) => this.deps.logger.warn({ err, agentId }, "Report-up failed"),
    );
  }

  /** The lead chat on this computer, or null with the reason. */
  private leadOf(worker: LineAgent): Promise<{ id: string } | { skip: string }> {
    return leadChatOf(this.store, worker, this.deps.localServerId);
  }

  private async isLeadReportingToMain(reporterId: string, target: LineAgent): Promise<boolean> {
    return (
      target.labels?.[SEAT_LABEL] === MAIN_ASSISTANT_ROLE && (await this.hasWorkers(reporterId))
    );
  }

  /** Why a finished-turn notice is not needed, or null. A failed turn is always sent. */
  private anyEnabled(): boolean {
    return this.deps.isEnabled() || this.otherEnabled();
  }

  private otherEnabled(): boolean {
    return this.deps.isOtherEnabled ? this.deps.isOtherEnabled() : true;
  }

  private async quietReason(input: {
    workerId: string;
    leadId: string;
    leadAgent: LineAgent;
    failed: boolean;
    startedAt?: number;
  }): Promise<string | null> {
    if (input.failed) return null;
    // FU-113: a lead reports to the main assistant on purpose. Its turns ending are not news.
    if (await this.isLeadReportingToMain(input.workerId, input.leadAgent))
      return "a lead's finished turn is not sent to the main assistant";
    // FU-115: a worker that already messaged its lead during this turn needs no second message about the same turn.
    const sentAt = lastAgentMessageAt(input.workerId, input.leadId);
    if (input.startedAt !== undefined && sentAt !== null && sentAt >= input.startedAt)
      return "the worker already messaged its lead this turn";
    return null;
  }

  /** Whether any chat on this computer reports to this chat, which makes it a lead. */
  private async hasWorkers(leadId: string): Promise<boolean> {
    for (const chat of await this.store.list()) {
      if (chat.id === leadId || chat.archivedAt || !reportsTo(chat)) continue;
      const owner = await this.leadOf(chat);
      if ("id" in owner && owner.id === leadId) return true;
    }
    return false;
  }

  /** The chats on this computer that report to the lead and are idle now. */
  private async idleWorkersOf(leadId: string): Promise<LineAgent[]> {
    const workers: LineAgent[] = [];
    for (const chat of await this.store.list()) {
      if (chat.id === leadId || chat.archivedAt || !reportsTo(chat)) continue;
      if (this.deps.agentManager.getAgent(chat.id)?.lifecycle !== "idle") continue;
      const owner = await this.leadOf(chat);
      if ("id" in owner && owner.id === leadId) workers.push(chat);
    }
    return workers;
  }

  /**
   * A lead that is idle while it owns open ledger items and has idle workers gets one message that lists them.
   * Event-driven: it runs when the lead's turn ends. Nothing is sent when there are no idle workers, no open items,
   * when the lead is at a usage limit, or when the nudge was already sent in this idle period.
   */
  private async nudgeIdleLead(leadId: string): Promise<void> {
    if (!this.otherEnabled() || this.nudged.has(leadId)) return;
    await new Promise((resolve) => setImmediate(resolve));
    if (this.turns.get(leadId)?.open || this.nudged.has(leadId) || this.limitOf(leadId)) return;
    const lead = await this.store.get(leadId);
    const live = this.deps.agentManager.getAgent(leadId);
    if (!lead || lead.archivedAt || live?.internal) return;
    const last = await this.deps.agentManager.getLastAssistantMessage(leadId).catch(() => null);
    const stop = classifyEndingAssistantMessage(last, this.now());
    if (stop && stop.kind !== "network") return;
    const workers = await this.idleWorkersOf(leadId);
    if (!workers.length) return;
    const owned = rowsOwnedBy(
      (this.deps.readLedger ?? (() => readOpenLedgerRows(defaultLedgerDir())))(),
      { id: leadId, title: titleOf(lead) },
    );
    if (!owned.length) return;
    // The lead may have started a turn while the lists were read.
    if (this.turns.get(leadId)?.open || this.nudged.has(leadId)) return;
    this.nudged.add(leadId);
    await this.toLead(
      leadId,
      leadId,
      formatSystemNotificationPrompt(formatNudge(workers, owned)),
      "idle-nudge",
    );
  }

  /** A new prompt is told to the lead once; a resolved prompt may be asked again under a new request. */
  private onPermissionEvent(agentId: string, kind: string, event: object): void {
    if (kind === "permission_resolved") {
      const requestId = (event as { requestId?: string }).requestId;
      if (requestId) this.askedPermission.delete(`${agentId}:${requestId}`);
      return;
    }
    const request = (event as { request?: PermissionRequest }).request;
    if (!request?.id || this.askedPermission.has(`${agentId}:${request.id}`)) return;
    this.askedPermission.add(`${agentId}:${request.id}`);
    void this.notifyPermission(agentId, request).catch((err: unknown) =>
      this.deps.logger.warn({ err, agentId }, "Permission notice failed"),
    );
  }

  /** Tells the lead once that a chat is waiting for permission. Nothing is allowed or denied here. */
  private async notifyPermission(workerId: string, request: PermissionRequest): Promise<void> {
    if (!this.otherEnabled()) return;
    const live = this.deps.agentManager.getAgent(workerId);
    const worker = await this.store.get(workerId);
    if (!worker || worker.archivedAt || live?.internal) return;
    const lead = await this.leadOf(worker);
    if ("skip" in lead) return;
    const leadAgent = await this.store.get(lead.id);
    if (!leadAgent || leadAgent.archivedAt) return;
    const decision = await decideSend(
      this.store,
      { agentId: workerId },
      lead.id,
      this.deps.localServerId,
    );
    if (!decision?.allowed) return;
    const prompt = formatSystemNotificationPrompt(
      formatPermissionNotice({
        worker,
        request,
        cwd: (live as { cwd?: string } | null)?.cwd ?? (worker as { cwd?: string }).cwd ?? null,
      }),
    );
    await this.toLead(workerId, lead.id, prompt);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Whether a chat is at a usage limit now. */
  limitOf(agentId: string): LimitedChat | null {
    const limit = this.limited.get(agentId);
    if (!limit) return null;
    if (limit.until > this.now()) return limit;
    this.limited.delete(agentId);
    this.save();
    return null;
  }

  /**
   * Reads how a turn ended. A usage limit marks the chat limited and tells its lead once; any other end clears the
   * mark. Returns true for a limit, which is never reported as a finished turn.
   */
  private async noteLimit(workerId: string, failed: boolean, text: string): Promise<boolean> {
    const now = this.now();
    const last = failed
      ? null
      : await this.deps.agentManager.getLastAssistantMessage(workerId).catch(() => null);
    const stop = failed ? classifyFailedTurn(text, now) : classifyEndingAssistantMessage(last, now);
    if (!stop || stop.kind === "network") {
      if (this.limited.delete(workerId)) {
        this.save();
        this.releaseHeld(workerId);
      }
      return false;
    }
    const previous = this.limited.get(workerId);
    const limit: LimitedChat = {
      kind: stop.limitKind ?? "usage",
      until: stop.resetAt ?? now + UNKNOWN_RESET_MS,
      notified: previous?.notified === true && previous.until > now,
    };
    this.limited.set(workerId, limit);
    if (limit.notified) {
      this.save();
      return true;
    }
    limit.notified = true;
    this.save();
    const worker = await this.store.get(workerId);
    if (!worker || worker.archivedAt) return true;
    const lead = await this.leadOf(worker);
    if ("skip" in lead) return true;
    await this.toLead(
      workerId,
      lead.id,
      formatSystemNotificationPrompt(formatLimitNotice(titleOf(worker), limit)),
    );
    return true;
  }

  /** Sends a notice to a lead, or holds it while the lead is at a limit (sent as one notice after the reset). */
  private async toLead(
    workerId: string,
    leadId: string,
    prompt: string,
    kind: "report-up" | "idle-nudge" = "report-up",
  ): Promise<void> {
    const leadLimit = this.limitOf(leadId);
    if (leadLimit) {
      const held = this.held.get(leadId) ?? [];
      held.push(prompt);
      if (held.length > MAX_HELD_REPORTS) held.shift();
      this.held.set(leadId, held);
      this.save();
      this.deps.logger.info(
        { agentId: workerId, lead: leadId, until: leadLimit.until },
        "Report-up held: the lead is at a usage limit",
      );
      const delay = Math.max(0, leadLimit.until - this.now()) + 1000;
      (this.deps.setTimer ?? ((run, ms) => setTimeout(run, ms).unref()))(
        () => this.releaseHeld(leadId),
        delay,
      );
      return;
    }
    if (this.deps.deliver) {
      await this.deps.deliver(leadId, prompt);
      return;
    }
    // Held until the lead's turn ends, one queue per lead, in order (held-sends.ts).
    heldSendsFor(this.deps.agentManager, this.deps.logger).hold(leadId, async () => {
      await this.send(leadId, prompt, kind);
      this.deps.logger.info({ agentId: workerId, lead: leadId, kind }, "Report-up delivered");
    });
  }

  /** The held reports for a lead go out as one notice, once the lead is no longer at a limit. */
  private releaseHeld(leadId: string): void {
    if (this.limitOf(leadId)) return;
    const held = this.held.get(leadId);
    if (!held?.length) return;
    this.held.delete(leadId);
    this.save();
    const body = held.map((prompt) => prompt.trim()).join("\n\n");
    const notice = `${held.length} report${held.length === 1 ? "" : "s"} held while you were at your usage limit:\n\n${body}`;
    void this.toLead(leadId, leadId, notice).catch((err: unknown) =>
      this.deps.logger.warn({ err, leadId }, "Held reports failed"),
    );
  }

  private async report(
    workerId: string,
    failed: boolean,
    failure = "",
    startedAt?: number,
  ): Promise<void> {
    const skip = (reason: string) => {
      this.deps.logger.info({ agentId: workerId, reason }, "Report-up skipped");
    };
    if (!this.anyEnabled()) return skip("turned off");
    // Idle: a follow-up turn that starts at once reports when it ends.
    await new Promise((resolve) => setImmediate(resolve));
    if (this.turns.get(workerId)?.open) return skip("a new turn started");
    const live = this.deps.agentManager.getAgent(workerId);
    const worker = await this.store.get(workerId);
    if (!worker || worker.archivedAt || live?.internal) return skip("not a visible chat");
    // A usage limit is limit state, never "finished a turn" (FU-63).
    if (await this.noteLimit(workerId, failed, failure)) return skip("ended on a usage limit");
    // OFF BY DEFAULT: the limit notice above stays on; "finished a turn" and "ended with an error" notices need the fallback.
    if (!this.deps.isEnabled()) return skip("turned off");
    const lead = await this.leadOf(worker);
    if ("skip" in lead) return skip(lead.skip);
    const leadAgent = await this.store.get(lead.id);
    if (!leadAgent || leadAgent.archivedAt) return skip("lead not here or archived");
    const quiet = await this.quietReason({
      workerId,
      leadId: lead.id,
      leadAgent,
      failed,
      startedAt,
    });
    if (quiet) return skip(quiet);
    const decision = await decideSend(
      this.store,
      { agentId: workerId },
      lead.id,
      this.deps.localServerId,
    );
    if (!decision?.allowed) {
      this.deps.logger.info(
        {
          agentId: workerId,
          lead: lead.id,
          reason: decision?.allowed === false ? decision.reason : null,
        },
        "Report-up refused by the reporting line",
      );
      return;
    }
    const lastMessage = await this.deps.agentManager
      .getLastAssistantMessage(workerId)
      .catch(() => null);
    // A failed turn is sent at once. A finished turn is combined with the lead's other finished workers (FU-115).
    if (failed) {
      const prompt = formatSystemNotificationPrompt(
        formatReportUpNotice({ worker, failed, lastMessage }),
      );
      await this.toLead(workerId, lead.id, prompt);
      return;
    }
    await this.queueFinished(lead.id, { workerId, worker, lastMessage });
  }

  /**
   * FU-115: "finished a turn" notices for one lead wait here and go out as ONE message: the first at once when the lead
   * is idle and was not told in the last 5 minutes, the rest together after that window, and always after the lead's
   * running turn ends (the held-send queue). A worker that finishes twice before delivery is listed once.
   */
  private readonly pendingFinished = new Map<string, PendingFinish[]>();
  private readonly lastFinishedAt = new Map<string, number>();
  private readonly flushing = new Set<string>();

  private async queueFinished(leadId: string, item: PendingFinish): Promise<void> {
    if (this.limitOf(leadId)) {
      // A limited lead keeps its own held-report path (persisted, one notice after the reset).
      const prompt = formatSystemNotificationPrompt(
        formatReportUpNotice({ worker: item.worker, failed: false, lastMessage: item.lastMessage }),
      );
      await this.toLead(item.workerId, leadId, prompt);
      return;
    }
    const list = (this.pendingFinished.get(leadId) ?? []).filter(
      (entry) => entry.workerId !== item.workerId,
    );
    list.push(item);
    this.pendingFinished.set(leadId, list);
    if (this.flushing.has(leadId)) return;
    this.flushing.add(leadId);
    const wait = Math.max(
      0,
      (this.lastFinishedAt.get(leadId) ?? 0) + COALESCE_WINDOW_MS - this.now(),
    );
    if (wait === 0) {
      await this.flushFinished(leadId);
      return;
    }
    this.deps.logger.info(
      { lead: leadId, waitMs: wait },
      "Report-up held: the lead was told lately",
    );
    (this.deps.setTimer ?? ((run, ms) => setTimeout(run, ms).unref()))(() => {
      void this.flushFinished(leadId).catch((err: unknown) =>
        this.deps.logger.warn({ err, leadId }, "Report-up flush failed"),
      );
    }, wait);
  }

  private takePending(leadId: string): PendingFinish[] {
    const items = this.pendingFinished.get(leadId) ?? [];
    this.pendingFinished.delete(leadId);
    this.flushing.delete(leadId);
    return items;
  }

  private async flushFinished(leadId: string): Promise<void> {
    if (!this.deps.isEnabled()) {
      this.takePending(leadId);
      return;
    }
    if (this.deps.deliver) {
      const items = this.takePending(leadId);
      if (!items.length) return;
      await this.deliverCombined(leadId, items);
      return;
    }
    // Built when the lead's turn has ended: notices that arrive while the lead works join this one message.
    heldSendsFor(this.deps.agentManager, this.deps.logger).hold(leadId, async () => {
      const items = this.takePending(leadId);
      if (!items.length) return;
      await this.deliverCombined(leadId, items);
    });
  }

  /**
   * The combined message goes out now, unless the lead reached a usage limit after the reports were queued: then it
   * takes the limit-aware path (toLead), which keeps it in the persisted held reports until the reset (FU-63).
   */
  private async deliverCombined(leadId: string, items: readonly PendingFinish[]): Promise<void> {
    const prompt = formatSystemNotificationPrompt(formatCombinedNotice(items));
    if (this.limitOf(leadId)) {
      await this.toLead(items[0]!.workerId, leadId, prompt);
      return;
    }
    this.lastFinishedAt.set(leadId, this.now());
    if (this.deps.deliver) await this.deps.deliver(leadId, prompt);
    else {
      await this.send(leadId, prompt, "report-up");
      this.deps.logger.info({ lead: leadId, workers: items.length }, "Report-up delivered");
    }
  }

  private send(leadId: string, prompt: string, kind: "report-up" | "idle-nudge"): Promise<void> {
    const { agentManager, agentStorage, logger } = this.deps;
    const checkCurrent = () => {
      if (!this.deps.isEnabled() && !this.otherEnabled())
        throw new Error("Report-up was turned off");
    };
    return agentManager.trustedPlugins.daemon(async () => {
      const finalCheck = createFinalInputCheck(checkCurrent);
      await sendPromptToAgent({
        agentManager,
        agentStorage,
        agentId: leadId,
        prompt,
        messageId:
          kind === "idle-nudge"
            ? `${NUDGE_MESSAGE_PREFIX}${randomUUID()}`
            : `${FINISH_NOTIFICATION_MESSAGE_PREFIX}report-up:${randomUUID()}`,
        runOptions: { [FINAL_INPUT_CHECK]: finalCheck },
        activeTurnBehavior: "steer",
        steerOnly: true,
        unarchive: false,
        logger,
      });
      await waitForFinalInputHandoff(finalCheck);
    });
  }
}

/**
 * daemon.reportUpOnTurnEnd opts into finished-turn notices and idle-lead nudges.
 * Unset keeps permission and limit notices on. False turns all report-up notices off.
 */
export function reportUpSwitches(setting: boolean | undefined): {
  finishedTurns: boolean;
  otherNotices: boolean;
  idleLeadNudge: boolean;
} {
  return {
    finishedTurns: setting === true,
    otherNotices: setting !== false,
    idleLeadNudge: setting === true,
  };
}

export function startReportUp(input: {
  paseoHome?: string;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  daemonConfigStore: DaemonConfigStore;
  localServerId: string | null;
  logger: Logger;
}): () => void {
  const service = new ReportUpService({
    agentManager: input.agentManager,
    agentStorage: input.agentStorage,
    isEnabled: () =>
      reportUpSwitches(input.daemonConfigStore.get().reportUpOnTurnEnd).finishedTurns,
    isOtherEnabled: () =>
      reportUpSwitches(input.daemonConfigStore.get().reportUpOnTurnEnd).otherNotices,
    isNudgeEnabled: () =>
      reportUpSwitches(input.daemonConfigStore.get().reportUpOnTurnEnd).idleLeadNudge,
    localServerId: input.localServerId,
    logger: input.logger,
    ...(input.paseoHome ? { statePath: path.join(input.paseoHome, "report-up-limits.json") } : {}),
  });
  return input.agentManager.subscribe((event) => service.onEvent(event), { replayState: false });
}
