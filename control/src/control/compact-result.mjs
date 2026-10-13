const ROW_LIMIT = 5;
const TEXT_LIMIT = 300;
const FIELD_LIMIT = 12;
const ERROR_KEYS = /^(error|errors|lastError|failure|failures|refusal|blockedReason|reason)$/i;
const KEY_FIELDS = new Set([
  "id",
  "agentId",
  "sessionId",
  "workerId",
  "task",
  "taskId",
  "title",
  "name",
  "status",
  "state",
  "provider",
  "model",
  "cwd",
  "parentAgentId",
  "archivedAt",
  "pending",
  "pendingPermissions",
  "permission",
  "ok",
  "success",
  "partial",
  "available",
  "count",
  "total",
  "observedAt",
  "lastMessage",
  "content",
  "latestReply",
  "native",
  "snapshot",
]);

export function compactToolResult(result, fullResult = false) {
  if (fullResult || result.structuredContent === undefined) return result;
  let omitted = 0;
  const errors = [];
  function collectErrors(value, path) {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      if (
        ERROR_KEYS.test(key) &&
        child !== null &&
        child !== "" &&
        child !== false &&
        !(Array.isArray(child) && child.length === 0)
      )
        errors.push({ path: childPath, value: child });
      else collectErrors(child, childPath);
    }
  }
  function shorten(value, depth = 0) {
    if (typeof value === "string" && value.length > TEXT_LIMIT) {
      const removed = value.length - TEXT_LIMIT;
      omitted += removed;
      return `${value.slice(0, TEXT_LIMIT)} [${removed} characters omitted]`;
    }
    if (Array.isArray(value)) {
      const shownRows = depth >= 4 ? [] : value.slice(0, ROW_LIMIT);
      const omittedRows = value.length - shownRows.length;
      omitted += omittedRows;
      return {
        count: value.length,
        shown: shownRows.map((row) => shorten(row, depth + 1)),
        omitted: omittedRows,
      };
    }
    if (!value || typeof value !== "object") return value;
    const output = {};
    for (const [key, child] of Object.entries(value)) {
      if (ERROR_KEYS.test(key)) continue;
      if (depth > 0 && !KEY_FIELDS.has(key) && !Array.isArray(child)) {
        omitted++;
        continue;
      }
      if (depth >= 4 && child && typeof child === "object") {
        omitted++;
        continue;
      }
      if (Object.keys(output).length >= FIELD_LIMIT) {
        omitted++;
        continue;
      }
      output[key] = shorten(child, depth + 1);
    }
    return output;
  }
  collectErrors(result.structuredContent, "result");
  const summary = shorten(result.structuredContent);
  const structuredContent = {
    errors,
    summary,
    omitted,
    fullResult: "Set fullResult: true for the full result.",
    notice: `${omitted} more omitted; full result with fullResult: true. Counts include rows, fields, and characters.`,
  };
  return {
    ...result,
    structuredContent,
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
  };
}
