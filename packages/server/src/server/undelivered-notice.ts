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

// FULCRA(orchestration): a held message from a chat (CLI send or MCP prompt) was not delivered. The sending chat
// gets one daemon notice with the reason, through its own held-send queue, so it never cuts the sender's turn.

export interface UndeliveredNoticeInput {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
  localServerId: string | null | undefined;
  sender: { agentId: string; serverId?: string };
  targetId: string;
  reason: string;
}

export function tellSenderUndelivered(input: UndeliveredNoticeInput): void {
  const { agentManager, agentStorage, logger, sender, targetId, reason } = input;
  const local = !sender.serverId || sender.serverId === input.localServerId;
  logger.warn(
    { sender: sender.agentId, senderServer: sender.serverId ?? null, target: targetId, reason },
    "Held message not delivered",
  );
  if (!local || !agentManager.getAgent(sender.agentId)) return;
  const title = agentManager.getAgent(targetId)?.config.title?.trim() || targetId.slice(0, 8);
  const prompt = formatSystemNotificationPrompt(
    `Your message to ${title} (${targetId}) was not delivered: ${reason}`,
  );
  try {
    heldSendsFor(agentManager, logger).hold(sender.agentId, () =>
      agentManager.trustedPlugins.daemon(async () => {
        await sendPromptToAgent({
          agentManager,
          agentStorage,
          agentId: sender.agentId,
          prompt,
          messageId: `${FINISH_NOTIFICATION_MESSAGE_PREFIX}undelivered:${randomUUID()}`,
          activeTurnBehavior: "steer",
          steerOnly: true,
          unarchive: false,
          logger,
        });
      }),
    );
  } catch (error) {
    // The sender's own queue is full: the warning above is the only record.
    logger.warn({ err: error, sender: sender.agentId }, "Undelivered notice not queued");
  }
}
