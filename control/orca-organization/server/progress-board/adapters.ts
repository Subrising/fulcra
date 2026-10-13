import type { PaseoAgentListResult } from "@getpaseo/client";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { BoardJob, LedgerItem } from "../../shared/progress-board";

export function projectKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, "|"));
}
export function parseLedger(text: string): { items: LedgerItem[]; notice: string } {
  if (!text.trim()) return { items: [], notice: "The ledger is empty." };
  const columns = ["id", "item", "kind", "owner", "status", "evidence", "source"];
  const lines = text.split(/\r?\n/);
  const header = lines.findIndex((line) => {
    const row = cells(line).map((cell) => cell.toLowerCase());
    return row.length === columns.length && columns.every((column) => row.includes(column));
  });
  if (
    header < 0 ||
    cells(lines[header + 1] ?? "").length !== 7 ||
    !cells(lines[header + 1] ?? "").every((cell) => /^:?-{3,}:?$/.test(cell))
  ) {
    return { items: [], notice: "The ledger table is malformed." };
  }
  const indices = cells(lines[header]).map((cell) => cell.toLowerCase());
  const items: LedgerItem[] = [];
  const seen = new Set<string>();
  let invalid = 0;
  for (const line of lines.slice(header + 2)) {
    if (!line.trim().startsWith("|")) break;
    const row = cells(line);
    const read = (name: string) => row[indices.indexOf(name)] ?? "";
    if (row.length !== 7 || !read("id") || !read("item") || seen.has(read("id"))) {
      invalid++;
      continue;
    }
    const status = read("status").toUpperCase(),
      kind = read("kind").toUpperCase();
    const lane =
      status === "DONE"
        ? "Done"
        : status === "NEXT" || status === "PLANNED"
          ? "Next"
          : status === "IN PROGRESS"
            ? "In progress"
            : kind === "DECIDE"
              ? "DECIDE"
              : "Open";
    if (status.startsWith("MOVED")) continue;
    if (!["DONE", "NEXT", "PLANNED", "IN PROGRESS", "OPEN"].includes(status)) {
      invalid++;
      continue;
    }
    seen.add(read("id"));
    items.push({
      id: read("id"),
      item: read("item"),
      kind,
      owner: read("owner"),
      status,
      evidence: read("evidence"),
      source: read("source"),
      lane,
    });
  }
  return { items, notice: invalid ? `${invalid} invalid ledger rows were excluded.` : "" };
}
export function lastResult(timeline: readonly AgentTimelineItem[]): string {
  const last = timeline
    .toReversed()
    .find((item) => item.type === "assistant_message" && item.text.trim());
  return last?.type === "assistant_message"
    ? last.text
        .trim()
        .split(/\r?\n/)
        .find((line) => line.trim())!
        .trim()
        .slice(0, 280)
    : "No result was recorded.";
}
export function adaptJobs(
  entries: PaseoAgentListResult["entries"],
  machine: string,
  results: ReadonlyMap<string, string>,
): BoardJob[] {
  return entries
    .filter(({ agent }) => !agent.archivedAt)
    .map(({ agent, project }) => ({
      id: agent.id,
      project: projectKey(agent.labels["fulcra.project"] || project.projectName),
      title: agent.title || "Untitled job",
      status: agent.status,
      machine,
      createdAt: agent.createdAt,
      waiting: agent.pendingPermissions.length > 0,
      result: results.get(agent.id) || agent.lastError || "No result was recorded.",
      directory: agent.cwd,
    }));
}
