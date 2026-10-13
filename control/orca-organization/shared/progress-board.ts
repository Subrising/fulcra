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

export function itemGroup(row: BoardItem): "Done" | "Decide" | "In progress" | "Next" | "Open" {
  if (row.status === "DONE" || row.status.startsWith("MOVED")) return "Done";
  if (row.kind === "DECIDE") return "Decide";
  if (row.status.startsWith("IN PROGRESS")) return "In progress";
  if (row.status.startsWith("NEXT")) return "Next";
  return "Open";
}

export function ageLabel(createdAt: string, now: number): string {
  const age = now - Date.parse(createdAt);
  if (!Number.isFinite(age) || age < 0) return "Age unavailable";
  const minutes = Math.floor(age / 60000);
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} h`;
  return `${Math.floor(minutes / 1440)} days`;
}
