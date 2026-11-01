// FU-483: a worker's finished turn wakes its lead only when the final message has a result line at the start of a line.
// Any other turn end is held and stays visible in the notice list. Errors, permission requests and limits never reach this check.

const RESULT_LINE = /^[ \t]*(?:\*\*|__|`)?(?:DONE|BLOCKED|DECISION|QUESTION|RISK)\b/m;

/** Whether a finished turn with this final message wakes the lead. An unreadable message (null) is sent. */
export function finishNoticeWanted(lastMessage: string | null | undefined): boolean {
  if (lastMessage === null || lastMessage === undefined) return true;
  return RESULT_LINE.test(lastMessage);
}

/**
 * FU-633: a worker that reports to a lead on another computer often ends with a message addressed to that lead, such as
 * "To Main (88b1e035): the link is fixed", with no result line. The fallback treats such a message as a result.
 * It must start a line with "To", name the lead by the first 8 characters of its chat ID, and say it before the first colon.
 */
export function addressesLead(lastMessage: string, leadRef: string | undefined): boolean {
  const leadId = leadRef?.split("@", 1)[0]?.slice(0, 8);
  if (!leadId || !/^[0-9a-f]{8}$/i.test(leadId)) return false;
  return new RegExp(
    `^[ \\t]*(?:\\*\\*|__|\`)?To[ \\t][^:\\n]{0,60}${leadId}[^:\\n]{0,10}:`,
    "im",
  ).test(lastMessage);
}

/** FU-492: the notifyOnFinish path uses the same rule. A plain finished turn without a result line (for example
 * "WAITING q123") does not wake the caller; errors, permission requests and closed chats always do. */
export function finishNotificationWanted(
  reason: string,
  lastMessage: string | null | undefined,
): boolean {
  return reason !== "finished" || finishNoticeWanted(lastMessage);
}
