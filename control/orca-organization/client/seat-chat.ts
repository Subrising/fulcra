import type { PluginObservedAgent } from "@getpaseo/plugin/client";
import type { Fleet } from "../shared/fleet";
import { lastKnownStatusLine } from "@getpaseo/protocol/chat-status";

/**
 * FU-47. A main assistant or leader seat can name a session that is not an enrolled fleet node (the human-facing
 * seat is not delegated to the controller). The page then reads the chat from the app's own chat list, which
 * every connected host fills, instead of saying the chat is missing. Enrolment is not changed.
 */
export type SeatChat = Pick<
  PluginObservedAgent,
  "agentId" | "title" | "hostName" | "activity" | "status" | "connection"
>;

export function chatFromList(
  entries: readonly SeatChat[] | undefined,
  sessionId: string,
): SeatChat | null {
  const found = (entries ?? []).filter((entry) => entry.agentId === sessionId);
  // The same id on two hosts is ambiguous. Never choose the first one.
  return found.length === 1 ? found[0] : null;
}

export function chatStatusLine(chat: SeatChat): string {
  if (chat.connection !== "online") return "Status unavailable · host not connected";
  switch (chat.activity) {
    case "working":
      return "Working now";
    case "idle":
      return "Idle";
    case "permission":
      return "Needs you · permission pending";
    case "error":
      return "Needs attention";
    default:
      // No live turn state for a chat the app has not opened: the host's own status from the chat list, in the
      // words that the sidebar uses too.
      return lastKnownStatusLine(chat.status);
  }
}

/** One plain line for a seat shown from the chat list. */
export const CHAT_LIST_NOTE =
  "Shown from the chat list. The controller does not track this chat, so its work is not counted here.";

/**
 * Names why a fleet read is partial when the fleet data says so. Falls back to the general sentence when it
 * cannot name a reason. Never claims a reason the data does not show.
 */
export function partialSentence(
  fleet: Pick<Fleet, "nodes" | "supervisionAvailable" | "supervisionIssues">,
): string {
  const reasons: string[] = [];
  const byHost = new Map<string, number>();
  for (const node of fleet.nodes)
    if (node.status === "unavailable") byHost.set(node.host, (byHost.get(node.host) ?? 0) + 1);
  for (const [host, count] of byHost)
    reasons.push(`${count} ${count === 1 ? "chat" : "chats"} on ${host} could not be read`);
  const unreadable = fleet.supervisionIssues?.unreadable ?? 0;
  if (unreadable > 0)
    reasons.push(
      `${unreadable} ${unreadable === 1 ? "chat's" : "chats'"} leadership record could not be read`,
    );
  if (fleet.supervisionAvailable === false) reasons.push("who leads whom could not be read");
  if (!reasons.length)
    return "Some work or team members could not be observed. This view is incomplete.";
  return `${reasons.join("; ")}. This view is incomplete.`.replace(/^./, (c) => c.toUpperCase());
}
