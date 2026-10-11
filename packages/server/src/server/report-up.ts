import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { REPORTS_TO_OWNER, ROLE_REF_PREFIX } from "@getpaseo/protocol/agent-labels";
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
// - daemon.reportUpOnTurnEnd = false turns it off.
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
}

export interface ReportUpDeps {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  isEnabled: () => boolean;
  localServerId: string | null;
  logger: Logger;
  /** The delivery step; tests replace it. */
  deliver?: (leadId: string, prompt: string) => Promise<void>;
  /** The clock and the timer; tests replace them. */
  now?: () => number;
  setTimer?: (run: () => void, ms: number) => void;
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

function isNoticeMessage(item: { text?: unknown; clientMessageId?: unknown }): boolean {
  const id = typeof item.clientMessageId === "string" ? item.clientMessageId : "";
  const text = typeof item.text === "string" ? item.text : "";
  return id.startsWith(FINISH_NOTIFICATION_MESSAGE_PREFIX) || isSystemInjectedEnvelope(text);
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

  constructor(private readonly deps: ReportUpDeps) {
    this.store = lineStoreOf({ agentManager: deps.agentManager, agentStorage: deps.agentStorage });
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
      return;
    }
    // A canceled turn (interrupt, stop, archive) sends nothing, and its first message must not decide for the next.
    if (kind === "turn_canceled") {
      turn.open = false;
      turn.fromNotice = null;
      return;
    }
    if (kind === "timeline") {
      const item = event.event.item;
      if (item.type !== "user_message" || turn.fromNotice !== null) return;
      turn.open = true;
      turn.fromNotice = isNoticeMessage(item);
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
    // Read synchronously at the stop: a caller's armed finish notification removes itself after it delivers.
    const fromNotice = turn.fromNotice === true;
    turn.fromNotice = null;
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
    void this.report(agentId, kind === "turn_failed", failureText(streamEvent)).catch(
      (err: unknown) => this.deps.logger.warn({ err, agentId }, "Report-up failed"),
    );
  }

  /** The lead chat on this computer, or null with the reason. */
  private leadOf(worker: LineAgent): Promise<{ id: string } | { skip: string }> {
    return leadChatOf(this.store, worker, this.deps.localServerId);
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
    if (!this.deps.isEnabled()) return;
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
      if (this.limited.delete(workerId)) this.releaseHeld(workerId);
      return false;
    }
    const previous = this.limited.get(workerId);
    const limit: LimitedChat = {
      kind: stop.limitKind ?? "usage",
      until: stop.resetAt ?? now + UNKNOWN_RESET_MS,
      notified: previous?.notified === true && previous.until > now,
    };
    this.limited.set(workerId, limit);
    if (limit.notified) return true;
    limit.notified = true;
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
  private async toLead(workerId: string, leadId: string, prompt: string): Promise<void> {
    const leadLimit = this.limitOf(leadId);
    if (leadLimit) {
      const held = this.held.get(leadId) ?? [];
      held.push(prompt);
      if (held.length > MAX_HELD_REPORTS) held.shift();
      this.held.set(leadId, held);
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
      await this.send(leadId, prompt);
      this.deps.logger.info({ agentId: workerId, lead: leadId }, "Report-up delivered");
    });
  }

  /** The held reports for a lead go out as one notice, once the lead is no longer at a limit. */
  private releaseHeld(leadId: string): void {
    if (this.limitOf(leadId)) return;
    const held = this.held.get(leadId);
    if (!held?.length) return;
    this.held.delete(leadId);
    const body = held.map((prompt) => prompt.trim()).join("\n\n");
    const notice = `${held.length} report${held.length === 1 ? "" : "s"} held while you were at your usage limit:\n\n${body}`;
    void this.toLead(leadId, leadId, notice).catch((err: unknown) =>
      this.deps.logger.warn({ err, leadId }, "Held reports failed"),
    );
  }

  private async report(workerId: string, failed: boolean, failure = ""): Promise<void> {
    const skip = (reason: string) => {
      this.deps.logger.info({ agentId: workerId, reason }, "Report-up skipped");
    };
    if (!this.deps.isEnabled()) return skip("turned off");
    // Idle: a follow-up turn that starts at once reports when it ends.
    await new Promise((resolve) => setImmediate(resolve));
    if (this.turns.get(workerId)?.open) return skip("a new turn started");
    const live = this.deps.agentManager.getAgent(workerId);
    const worker = await this.store.get(workerId);
    if (!worker || worker.archivedAt || live?.internal) return skip("not a visible chat");
    // A usage limit is limit state, never "finished a turn" (FU-63).
    if (await this.noteLimit(workerId, failed, failure)) return skip("ended on a usage limit");
    const lead = await this.leadOf(worker);
    if ("skip" in lead) return skip(lead.skip);
    const leadAgent = await this.store.get(lead.id);
    if (!leadAgent || leadAgent.archivedAt) return skip("lead not here or archived");
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
    const prompt = formatSystemNotificationPrompt(
      formatReportUpNotice({ worker, failed, lastMessage }),
    );
    await this.toLead(workerId, lead.id, prompt);
  }

  private send(leadId: string, prompt: string): Promise<void> {
    const { agentManager, agentStorage, logger } = this.deps;
    const checkCurrent = () => {
      if (!this.deps.isEnabled()) throw new Error("Report-up was turned off");
    };
    return agentManager.trustedPlugins.daemon(async () => {
      const finalCheck = createFinalInputCheck(checkCurrent);
      await sendPromptToAgent({
        agentManager,
        agentStorage,
        agentId: leadId,
        prompt,
        messageId: `${FINISH_NOTIFICATION_MESSAGE_PREFIX}report-up:${randomUUID()}`,
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

export function startReportUp(input: {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  daemonConfigStore: DaemonConfigStore;
  localServerId: string | null;
  logger: Logger;
}): () => void {
  const service = new ReportUpService({
    agentManager: input.agentManager,
    agentStorage: input.agentStorage,
    isEnabled: () => input.daemonConfigStore.get().reportUpOnTurnEnd !== false,
    localServerId: input.localServerId,
    logger: input.logger,
  });
  return input.agentManager.subscribe((event) => service.onEvent(event), { replayState: false });
}
