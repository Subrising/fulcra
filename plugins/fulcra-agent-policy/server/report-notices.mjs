export const REPORT_UP_SNIPPET_CHARS = 600;
export const PERMISSION_COMMAND_CHARS = 200;
export const COALESCE_WINDOW_MS = 5 * 60 * 1000;
export const COMBINED_LIST_LIMIT = 20;
export const COMBINED_SNIPPET_CHARS = 300;
export const NUDGE_LIST_LIMIT = 8;
export const UNKNOWN_RESET_MS = 15 * 60 * 1000;
export const MAX_HELD_REPORTS = 20;
export function formatLimitNotice(title, limit) {
  const when = new Date(limit.until).toLocaleString("en-AU", {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
  return `${title} is at its ${limit.kind} limit until ${when}.`;
}
export function permissionCommandOf(request) {
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
export function formatNudge(workers, items) {
  const more = (count) =>
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
    ...(workers.length
      ? [
          `${workers.length} of your worker${workers.length === 1 ? " is" : "s are"} idle: ${workerList}${more(workers.length)}.`,
          "Send each idle worker its next task, or close the item it finished.",
        ]
      : ["Start the next READY item. Create a worker if needed."]),
  ].join("\n");
}
export function formatPermissionNotice(input) {
  const command = permissionCommandOf(input.request);
  return [
    `Worker ${titleOf(input.worker)} (${input.worker.id}) is waiting for permission.`,
    `Tool: ${input.request.name ?? "unknown"}`,
    `Command: ${command || "(none)"}`,
    `Folder: ${input.cwd ?? "unknown"}`,
    `Request: ${input.request.id}`,
  ].join("\n");
}
export function formatCombinedNotice(items) {
  const only = items.length === 1 ? items[0] : undefined;
  if (only)
    return formatReportUpNotice({
      worker: only.worker,
      failed: false,
      lastMessage: only.lastMessage,
    });
  const line = (item) => {
    const text = (item.lastMessage ?? "").trim();
    const snippet =
      text.length > COMBINED_SNIPPET_CHARS ? `${text.slice(0, COMBINED_SNIPPET_CHARS)}…` : text;
    return `- Worker ${titleOf(item.worker)} (${item.worker.id}): ${snippet || "(no message)"}\n${formatSessionSpend(item.worker.sessionCost)}`;
  };
  const shown = items.slice(0, COMBINED_LIST_LIMIT).map(line);
  const rest = items.length - shown.length;
  return [
    `${items.length} workers finished a turn since your last update:`,
    ...shown,
    ...(rest > 0 ? [`…and ${rest} more.`] : []),
  ].join("\n");
}
export function titleOf(agent) {
  const config = agent.config;
  const live = typeof config?.title === "string" ? config.title.trim() : "";
  return agent.title?.trim() || live || agent.id.slice(0, 8);
}
export function formatSessionSpend(cost) {
  return cost
    ? `Session total spend: US$${cost.totalUsd.toFixed(6)}.${cost.warning ? ` ${cost.warning}` : ""}`
    : "Session total spend: unavailable.";
}
export function formatWorkerFinish(text, cost) {
  return `${formatSessionSpend(cost)}\n${text}`;
}
export function formatReportUpNotice(input) {
  const text = (input.lastMessage ?? "").trim();
  const snippet =
    text.length > REPORT_UP_SNIPPET_CHARS ? `${text.slice(0, REPORT_UP_SNIPPET_CHARS)}…` : text;
  const verb = input.failed ? "ended a turn with an error" : "finished a turn";
  return `Worker ${titleOf(input.worker)} (${input.worker.id}) ${verb}: ${snippet || "(no message)"}\n${formatSessionSpend(input.worker.sessionCost)}`;
}
export function reportUpSwitches(setting, idleLeadNudge) {
  return {
    finishedTurns: setting === true,
    otherNotices: setting !== false,
    idleNudges: idleLeadNudge !== false,
  };
}

export function quietReportReason(input) {
  if (input.failed) return null;
  if (input.leadToMain) return "a lead's finished turn is not sent to the main assistant";
  if (input.startedAt !== undefined && input.sentAt !== null && input.sentAt >= input.startedAt)
    return "the worker already messaged its lead this turn";
  return null;
}
