import { z } from "zod";
import type { AgentManager } from "./agent/agent-manager.js";

const reportCounts = new WeakMap<AgentManager, (id: string) => number | null>();
export function registerArchiveReportCount(
  manager: AgentManager,
  count: (id: string) => number | null,
): () => void {
  reportCounts.set(manager, count);
  return () => {
    if (reportCounts.get(manager) === count) reportCounts.delete(manager);
  };
}
export function archiveReportCount(manager: AgentManager, id: string): number | null {
  return reportCounts.get(manager)?.(id) ?? null;
}

export function archiveReportStateKnown(value: unknown, maxHeld: number): boolean {
  const report = z.union([
    z.string(),
    z.object({ prompt: z.string(), kind: z.enum(["report-up", "idle-nudge", "finished-turn"]) }),
  ]);
  return z
    .object({ held: z.record(z.string(), z.array(report).max(maxHeld)).optional() })
    .safeParse(value).success;
}
