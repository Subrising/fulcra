import { defineContract } from "./rpc-contract";
import { z } from "zod";
const id = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
const generation = z.number().int().nonnegative();
// U5-D04: the controller caps a grant's maxWorkers at 1..6 and LIVE workers at maxWorkers (manager.mjs grant/admit), but its
// summary lists EVERY manager_workers row of a supervisor, including orphaned, archived and taken-over workers, which do
// not count toward the cap. So the row list has no controller cap; this is only a defensive display bound.
export const SUPERVISOR_WORKER_ROWS_MAX = 256;
export const supervisorSchema = z
  .object({
    id,
    task: id,
    active: z.boolean(),
    maxWorkers: z.number().int().min(1).max(6),
    reserved: z.number().int().nonnegative(),
    workers: z
      .array(
        z
          .object({
            requestId: id,
            workerId: id.nullable(),
            phase: z.string(),
            ownership: z.enum(["linked", "orphaned", "unresolved"]),
            fault: z.string().nullable(),
            creation: z
              .object({
                startedAt: z.number().int().nonnegative().nullable(),
                nativeState: z.string().max(64).nullable(),
                generation: generation.nullable(),
              })
              .strict()
              .nullable()
              .optional(),
            lastEvent: z
              .object({
                kind: z.string(),
                state: z.string(),
                consumed: z.boolean(),
                at: z.string(),
              })
              .nullable(),
          })
          .strict(),
      )
      .max(SUPERVISOR_WORKER_ROWS_MAX),
  })
  .strict();
export type Supervisor = z.infer<typeof supervisorSchema>;
export const handoffSchema = z
  .object({
    id,
    source: id,
    destination: id,
    generation,
    wakeId: id,
    context: z.string(),
    workers: z.array(id).max(6),
    predecessors: z.array(z.object({ id, state: z.string() })),
    state: z.string(),
    consumed: z.string().nullable(),
    note: z.string().nullable(),
    at: z.string(),
    deliveryState: z.string(),
  })
  .strict();
export const managementInput = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("allow-routine"),
      sessionId: id,
      generation,
      reason: z.string().trim().min(12).max(2000),
    })
    .strict(),
  z
    .object({
      action: z.literal("revoke-routine"),
      sessionId: id,
      generation,
      reason: z.string().trim().min(12).max(2000),
    })
    .strict(),
  z
    .object({
      action: z.literal("leadership"),
      sessionId: id,
      generation,
      destinationId: id,
      destinationGeneration: generation,
      messageId: id,
      context: z.string().trim().min(12).max(8000),
      maxWorkers: z.number().int().min(1).max(6),
      workers: z.array(z.object({ sessionId: id, expectedGeneration: generation }).strict()).max(6),
    })
    .strict(),
  z.object({ action: z.literal("list") }).strict(),
  z.object({ action: z.literal("health") }).strict(),
  z.object({ action: z.literal("retry-controller") }).strict(),
  z.object({ action: z.literal("acknowledge"), messageId: id }).strict(),
  z.object({ action: z.literal("recover"), messageId: id }).strict(),
  z
    .object({
      action: z.literal("disposition"),
      messageId: id,
      reason: z.string().trim().min(12).max(2000),
    })
    .strict(),
  z.object({ action: z.literal("inspect"), sessionId: id }).strict(),
  z
    .object({
      action: z.literal("create"),
      projectId: id.optional(),
      messageId: id,
      provider: z.enum(["claude", "codex"]),
      title: z.string().trim().min(3).max(120),
      role: z
        .enum(["planning", "orchestration", "implementation", "review", "research", "light"])
        .optional(),
      model: z
        .string()
        .trim()
        .min(1)
        .max(96)
        .regex(/^[A-Za-z0-9][A-Za-z0-9._\-/[\]]*$/)
        .optional(),
      effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
    })
    .strict(), // update-7: five roles; W3: an explicit model / effort
  z
    .object({
      action: z.literal("handback"),
      sessionId: id,
      generation,
      reason: z.string().trim().min(12).max(2000),
    })
    .strict(),
  z
    .object({
      action: z.literal("supervise"),
      sessionId: id,
      generation,
      maxWorkers: z.number().int().min(1).max(6),
      reason: z.string().trim().min(12).max(2000),
    })
    .strict(),
  z
    .object({
      action: z.literal("resume"),
      sessionId: id,
      generation,
      messageId: id,
      reason: z.string().trim().min(12).max(2000),
      workers: z.array(z.object({ sessionId: id, expectedGeneration: generation }).strict()).max(6),
    })
    .strict(),
  z
    .object({
      action: z.literal("takeover"),
      sessionId: id,
      reason: z.string().trim().min(12).max(2000),
    })
    .strict(),
  z
    .object({
      action: z.literal("assign"),
      sessionId: id,
      generation,
      messageId: id,
      text: z.string().trim().min(1).max(16384),
    })
    .strict(),
]);
export const managementRpc = defineContract({
  name: "organization.manage",
  input: managementInput,
  output: z
    .object({
      status: z.string(),
      message: z.string(),
      messageId: id.optional(),
      sessionId: id.optional(),
      observedAt: z.string(),
      permissions: z
        .array(
          z.object({
            sessionId: id,
            active: z.boolean(),
            remaining: z.number().int().min(0).max(100),
            pool: id.nullable(),
            reason: z.string(),
            pending: z.number().int().nonnegative(),
            recent: z.array(z.object({ id, state: z.string(), note: z.string() })),
          }),
        )
        .max(32)
        .optional(),
      permissionError: z.string().nullable().optional(),
      leadershipCapacity: z
        .object({
          handoffs: z.number().int().nonnegative(),
          deliveries: z.number().int().nonnegative(),
          transferAllowed: z.boolean(),
        })
        .optional(),
      leadershipCandidates: z.array(id).max(32).optional(),
      handoffs: z.array(handoffSchema).max(20).optional(),
      leadershipError: z.string().nullable().optional(),
      supervisors: z.array(supervisorSchema).max(32).optional(),
      // U5-D04: supervisor records set aside (unreadable or a repeated id), never returned; the rest are shown.
      supervisionIssues: z
        .object({
          unreadable: z.number().int().nonnegative(),
          ids: z.array(z.string().max(64)).max(8),
          truncated: z.number().int().nonnegative(),
        })
        .strict()
        .optional(),
      deliveries: z
        .array(z.object({ id, session: id.nullable(), kind: z.string(), state: z.string() }))
        .optional(),
      sessions: z
        .array(z.object({ id, mode: z.enum(["human", "delegated"]), generation, task: id }))
        .optional(),
      partial: z.boolean().optional(),
    })
    .strict(),
});
export type ManagementInput = z.infer<typeof managementInput>;
export const taskManagementRpc = defineContract({
  name: "organization.task-manage",
  input: z.object({ taskId: id, command: managementInput }).strict(),
  output: managementRpc.output
    .extend({
      taskAuthority: z
        .object({ allowed: z.boolean(), error: z.string().nullable() })
        .strict()
        .optional(),
    })
    .strict(),
});
