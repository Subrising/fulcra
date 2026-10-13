import { z } from "zod";
import { defineContract } from "./rpc-contract";
export const ledgerItemSchema = z.object({
  id: z.string(),
  item: z.string(),
  kind: z.string(),
  owner: z.string(),
  status: z.string(),
  evidence: z.string(),
  source: z.string(),
  lane: z.enum(["Open", "In progress", "Done", "Next", "DECIDE"]),
});
export const branchSchema = z.object({
  directory: z.string(),
  branch: z.string(),
  head: z.string(),
  state: z.string(),
  ci: z.string(),
  checkedAt: z.string(),
});
export const jobSchema = z.object({
  id: z.string(),
  project: z.string(),
  title: z.string(),
  status: z.string(),
  machine: z.string(),
  createdAt: z.string(),
  waiting: z.boolean(),
  result: z.string(),
  directory: z.string(),
});
export const boardSchema = z.object({
  revision: z.number(),
  observedAt: z.string(),
  partial: z.boolean(),
  notice: z.string(),
  projects: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      notice: z.string(),
      items: z.array(ledgerItemSchema),
      jobs: z.array(jobSchema),
      branches: z.array(branchSchema),
    }),
  ),
});
export type LedgerItem = z.infer<typeof ledgerItemSchema>;
export type BoardJob = z.infer<typeof jobSchema>;
export type Branch = z.infer<typeof branchSchema>;
export type ProgressBoard = z.infer<typeof boardSchema>;
export const progressBoardRpc = defineContract({
  name: "organization.progress-board.read",
  input: z.object({}).strict(),
  output: boardSchema,
});
export const progressBoardWatchRpc = defineContract({
  name: "organization.progress-board.watch",
  input: z.object({ revision: z.number().int().nonnegative() }).strict(),
  output: z.object({ revision: z.number().int().nonnegative() }),
});
