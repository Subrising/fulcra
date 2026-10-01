import { defineContract } from "./rpc-contract";
import { z } from "zod";
const id = z.string().uuid();
const percent = z.number().finite().min(0).max(100).nullable();
export const usageSchema = z.object({
  observedAt: z.string(), fetchedAt: z.string().nullable(), available: z.boolean(), truncated: z.boolean(),
  providers: z.array(z.object({
    id: z.string().max(128), name: z.string().max(128), status: z.enum(["available", "unavailable", "error"]),
    fetchedAt: z.string().max(128).nullable(), source: z.string().max(128).nullable(), error: z.string().max(512).nullable(),
    windows: z.array(z.object({ label: z.string().max(128), used: percent, remaining: percent, resetsAt: z.string().max(128).nullable() }).strict()).max(16),
    balances: z.array(z.object({ label: z.string().max(128), remaining: z.number().finite().nullable(), unit: z.enum(["usd", "credits", "requests", "tokens"]) }).strict()).max(16),
  }).strict()).max(16),
}).strict();
export const taskCatalogRpc = defineContract({ name: "organization.tasks",
  input: z.object({ cursor: z.number().int().min(0).max(4096).default(0) }).strict(),
  output: z.object({ observedAt: z.string(), available: z.boolean(), partial: z.boolean(), total: z.number().int().nonnegative(), nextCursor: z.number().int().nullable(),
    tasks: z.array(z.object({ id, identifier: z.string().max(64).nullable(), title: z.string().max(160), status: z.string().max(64).nullable(), retained: z.boolean(), eligibleHint: z.boolean() }).strict()).max(32),
    note: z.string().max(512),
  }).strict(),
});
export const usageRpc = defineContract({ name: "organization.usage", input: z.object({}).strict(), output: usageSchema });
