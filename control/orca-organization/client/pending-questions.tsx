// A session's pending ask-the-user questions, answerable where the session shows up (Home, the Team map). The host
// draws them with the chat's own question card (plugin UI kit `AgentQuestions`), so an answer here is the same
// answer as in the chat. Hosts before that seam don't provide it, and then this renders nothing.
import type { ComponentType } from "react";
import * as kit from "@getpaseo/plugin/client/ui";

/** Same shape as the UI kit's `AgentQuestionsProps`, kept here so older plugin packages still type-check. */
interface AgentQuestionsProps {
  serverId: string;
  agentId: string;
  testID?: string;
}

const hostQuestions = (kit as { AgentQuestions?: ComponentType<AgentQuestionsProps> })
  .AgentQuestions;

export const questionCardsSupported = typeof hostQuestions === "function";

export function PendingQuestions(props: AgentQuestionsProps) {
  const Questions = hostQuestions;
  return typeof Questions === "function" ? <Questions {...props} /> : null;
}

/**
 * The host a session's question card asks. The fleet names a session's host only when that host is bound in the
 * organisation config, and installs leave "This Mac" unbound, so an unbound session falls back to the host this
 * screen is connected to. The card finds the session by agent id there; a session that lives elsewhere is not found
 * and shows nothing.
 */
export function questionServerId(
  node: { serverId?: string | null },
  hostId: string | null | undefined,
): string | null {
  return node.serverId || hostId || null;
}
