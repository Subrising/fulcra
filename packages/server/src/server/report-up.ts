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

export const REPORT_UP_SNIPPET_CHARS = 600;

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
}

function isNoticeMessage(item: { text?: unknown; clientMessageId?: unknown }): boolean {
  const id = typeof item.clientMessageId === "string" ? item.clientMessageId : "";
  const text = typeof item.text === "string" ? item.text : "";
  return id.startsWith(FINISH_NOTIFICATION_MESSAGE_PREFIX) || isSystemInjectedEnvelope(text);
}

function titleOf(agent: LineAgent): string {
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

export class ReportUpService {
  private readonly turns = new Map<string, TurnState>();
  private readonly store: LineStore;

  constructor(private readonly deps: ReportUpDeps) {
    this.store = lineStoreOf({ agentManager: deps.agentManager, agentStorage: deps.agentStorage });
  }

  onEvent(event: AgentManagerEvent): void {
    if (event.type !== "agent_stream") return;
    const { agentId } = event;
    const kind = event.event.type;
    const turn = this.turns.get(agentId) ?? { open: false, fromNotice: null };
    this.turns.set(agentId, turn);
    if (kind === "turn_started") {
      turn.open = true;
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
      this.deps.logger.info(
        { agentId, reason: fromNotice ? "turn started by a notice" : "caller already notified" },
        "Report-up skipped",
      );
      return;
    }
    void this.report(agentId, kind === "turn_failed").catch((err: unknown) =>
      this.deps.logger.warn({ err, agentId }, "Report-up failed"),
    );
  }

  /** The lead chat on this computer, or null with the reason. */
  private async leadOf(worker: LineAgent): Promise<{ id: string } | { skip: string }> {
    const ref = reportsTo(worker);
    if (!ref || ref === REPORTS_TO_OWNER) return { skip: "no lead chat" };
    let leadId = ref;
    if (ref.startsWith(ROLE_REF_PREFIX)) {
      const role = await resolveRoleTarget(this.store, ref);
      if (!role?.ok) return { skip: "role has no chat" };
      leadId = role.agentId;
    }
    const [id, server] = leadId.split("@", 2);
    if (server !== undefined && server !== this.deps.localServerId)
      return { skip: "lead on another computer" };
    if (!id || id === worker.id) return { skip: "no lead chat" };
    return { id };
  }

  private async report(workerId: string, failed: boolean): Promise<void> {
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
    if (this.deps.deliver) {
      await this.deps.deliver(lead.id, prompt);
      return;
    }
    // Held until the lead's turn ends, one queue per lead, in order (held-sends.ts).
    heldSendsFor(this.deps.agentManager, this.deps.logger).hold(lead.id, async () => {
      await this.send(lead.id, prompt);
      this.deps.logger.info({ agentId: workerId, lead: lead.id }, "Report-up delivered");
    });
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
