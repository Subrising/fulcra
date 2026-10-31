import { withLeadEvent } from "./lead-events.js";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { AgentManager } from "./agent/agent-manager.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import {
  FINISH_NOTIFICATION_MESSAGE_PREFIX,
  formatSystemNotificationPrompt,
  sendPromptToAgent,
} from "./agent/agent-prompt.js";
import { heldSendsFor } from "./held-sends.js";
import { MAIN_ASSISTANT_ROLE } from "@getpaseo/protocol/agent-labels";
import { findRoleHolder, reportsTo, type LineAgent } from "./reporting-lines.js";

// FULCRA(orchestration): a held message from a chat (CLI send or MCP prompt) was not delivered. The sending chat
// gets one daemon notice with the reason, through its own held-send queue, so it never cuts the sender's turn.

export interface UndeliveredNoticeInput {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
  localServerId: string | null | undefined;
  /** Absent for an owner send with no chat identity (a script). */
  sender?: { agentId: string; serverId?: string };
  targetId: string;
  reason: string;
  count?: number;
}

/**
 * FU-622: who is told about an undelivered message. The sender, when it is another live chat on this computer. A
 * script (bgjob, pcq, a heartbeat) sends as the receiver itself or as no chat, so nobody would learn: then the
 * receiver's lead (fulcra.reports-to or parent) on this computer is told, else the main assistant. Null: no chat here.
 */
export function undeliveredNoticeRecipient(
  input: Pick<
    UndeliveredNoticeInput,
    "agentManager" | "agentStorage" | "localServerId" | "sender" | "targetId"
  >,
): string | null {
  const { agentManager, agentStorage, sender, targetId } = input;
  const localServerId = input.localServerId ?? null;
  const usable = (id: string | null | undefined): id is string => {
    if (!id || id === targetId) return false;
    const agent = agentManager.getAgent(id) ?? agentStorage.getCached(id);
    return Boolean(agent && !agent.archivedAt && !agent.internal);
  };
  const local = !sender?.serverId || sender.serverId === localServerId;
  if (sender && local && usable(sender.agentId)) return sender.agentId;
  const target: LineAgent | null =
    agentManager.getAgent(targetId) ?? agentStorage.getCached(targetId) ?? null;
  const [leadId, leadServer] = reportsTo(target)?.split("@", 2) ?? [];
  if ((leadServer === undefined || leadServer === localServerId) && usable(leadId)) return leadId;
  const agents = new Map<string, LineAgent>(
    agentStorage
      .listCached()
      .filter((agent) => !agent.internal)
      .map((agent) => [agent.id, agent]),
  );
  for (const live of agentManager.listAgents()) agents.set(live.id, live);
  const main = findRoleHolder([...agents.values()], MAIN_ASSISTANT_ROLE);
  return main && "id" in main && usable(main.id) ? main.id : null;
}

export function tellSenderUndelivered(input: UndeliveredNoticeInput): void {
  const { agentManager, agentStorage, logger, sender, targetId, reason } = input;
  const recipient = undeliveredNoticeRecipient(input);
  logger.warn(
    {
      sender: sender?.agentId ?? null,
      senderServer: sender?.serverId ?? null,
      target: targetId,
      told: recipient,
      reason,
    },
    "Held message not delivered",
  );
  if (!recipient) {
    logger.error(
      { sender: sender?.agentId ?? null, target: targetId, reason },
      "Undelivered notice has no chat to tell",
    );
    return;
  }
  const title = agentManager.getAgent(targetId)?.config.title?.trim() || targetId.slice(0, 8);
  const subject =
    input.count === undefined
      ? "Your message"
      : `Your ${input.count} message${input.count === 1 ? "" : "s"}`;
  const verb = input.count === undefined || input.count === 1 ? "was" : "were";
  const from =
    sender && sender.agentId !== targetId ? `chat ${sender.agentId}` : "a script or the owner";
  const text =
    recipient === sender?.agentId
      ? `${subject} to ${title} (${targetId}) ${verb} not delivered: ${reason}`
      : `A message from ${from} to ${title} (${targetId}) was not delivered: ${reason}. ` +
        "Check the receiver and tell the job owner.";
  const prompt = formatSystemNotificationPrompt(text);
  try {
    heldSendsFor(agentManager, logger).hold(recipient, () =>
      withLeadEvent("failed_delivery", () =>
        agentManager.trustedPlugins.daemon(async () => {
          await sendPromptToAgent({
            agentManager,
            agentStorage,
            agentId: recipient,
            prompt,
            messageId: `${FINISH_NOTIFICATION_MESSAGE_PREFIX}undelivered:${randomUUID()}`,
            activeTurnBehavior: "steer",
            steerOnly: true,
            unarchive: false,
            logger,
          });
        }),
      ),
    );
  } catch (error) {
    // The recipient's own queue is full: the warning above is the only record.
    logger.warn({ err: error, recipient }, "Undelivered notice not queued");
  }
}
