import { z } from "zod";
import { defineContract, type ContractReceive } from "./rpc-contract";

const item = z.object({
  id: z.string(),
  item: z.string(),
  kind: z.string(),
  owner: z.string(),
  status: z.string(),
  evidence: z.string(),
  source: z.string(),
  createdAt: z.string().optional(),
  completedAt: z.string().optional(),
  needsHuman: z.boolean().optional(),
});
const job = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  machine: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  permissions: z.number(),
  result: z.string().nullable(),
});
const branch = z.object({
  workspace: z.string(),
  branch: z.string().nullable(),
  head: z.string().nullable(),
  state: z.string(),
  ci: z.string(),
  observedAt: z.string().nullable(),
});
export const progressBoardRpc = defineContract({
  name: "progress.board.snapshot",
  input: z.object({}).strict(),
  output: z.object({
    observedAt: z.string(),
    machine: z.string(),
    warnings: z.array(z.string()),
    projects: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        ledgerState: z.string(),
        items: z.array(item),
        jobs: z.array(job),
        branches: z.array(branch),
      }),
    ),
  }),
});
export type ProgressBoard = ContractReceive<typeof progressBoardRpc>;
export type BoardItem = ProgressBoard["projects"][number]["items"][number];

export type BoardJob = ProgressBoard["projects"][number]["jobs"][number];
export const BOARD_GROUPS = ["Next / Open", "In progress", "Needs you", "Blocked", "Done"] as const;
export type BoardGroup = (typeof BOARD_GROUPS)[number];
export type BoardCard = { type: "item"; item: BoardItem } | { type: "job"; job: BoardJob };

export function matchesHumanOwner(owner: string, humanOwners: readonly string[] = []): boolean {
  const name = owner.trim().toLowerCase();
  return (
    name.length > 0 && humanOwners.some((candidate) => candidate.trim().toLowerCase() === name)
  );
}

export function itemGroup(row: BoardItem): BoardGroup {
  const status = row.status.trim().toUpperCase();
  if (status === "DONE" || status.startsWith("MOVED")) return "Done";
  if (status.startsWith("BLOCKED")) return "Blocked";
  if (row.kind.trim().toUpperCase() === "DECIDE" || row.needsHuman) return "Needs you";
  if (status.startsWith("IN PROGRESS")) return "In progress";
  return "Next / Open";
}

// Ledgers do not require dates. Undated completions use ledger order, bounded to the last ten rows.
export function boardColumns(project: ProgressBoard["projects"][number], now: number) {
  const recent = new Set(
    project.items
      .filter((row) => {
        if (itemGroup(row) !== "Done") return false;
        if (!row.completedAt) return true;
        const at = Date.parse(row.completedAt);
        return Number.isFinite(at) && at <= now && now - at <= 14 * 86400000;
      })
      .slice(-10),
  );
  return BOARD_GROUPS.map((group) => ({
    group,
    cards: [
      ...project.jobs
        .filter((job) => (job.status === "done" ? group === "Done" : group === "In progress"))
        .map((job): BoardCard => ({ type: "job", job })),
      ...project.items
        .filter((row) => itemGroup(row) === group && (group !== "Done" || recent.has(row)))
        .map((item): BoardCard => ({ type: "item", item })),
    ],
  }));
}

export function ageLabel(createdAt: string, now: number): string {
  const age = now - Date.parse(createdAt);
  if (!Number.isFinite(age) || age < 0) return "Age unavailable";
  const minutes = Math.floor(age / 60000);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.floor(minutes / 60);
  if (minutes < 1440) return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  const days = Math.floor(minutes / 1440);
  return `${days} ${days === 1 ? "day" : "days"}`;
}
