import { z } from "zod";

export const IntercomRateSettingsSchema = z
  .object({
    report: z.number().int().min(0).max(12),
    followup: z.number().int().min(0).max(64),
    channel: z.number().int().min(0).max(64),
    seat: z.number().int().min(0).max(32),
  })
  .strict();
export const SetIntercomRatesSchema = z
  .object({
    messageId: z.string().uuid(),
    settings: IntercomRateSettingsSchema,
  })
  .strict();

// Additive native owner commands. No authentication, credential kind or recipient flags on wire.
export const NativeReportIdentitySchema = z
  .object({
    agentId: z.string().uuid(),
    instanceId: z.string().uuid(),
    sessionId: z.string().min(1).max(200),
    boot: z.string().uuid(),
  })
  .strict();
export type NativeReportIdentity = z.infer<typeof NativeReportIdentitySchema>;
export const NativeReportScopeSchema = z
  .object({
    projectId: z.string().uuid(),
    taskId: z.string().uuid(),
  })
  .strict();
export type NativeReportScope = z.infer<typeof NativeReportScopeSchema>;
const scopes = z.array(NativeReportScopeSchema).min(1).max(16);
export const RegisterReportPrimeSchema = z
  .object({
    messageId: z.string().uuid(),
    identity: NativeReportIdentitySchema,
    scopes,
    expectedEpoch: z.string().uuid().nullable(),
  })
  .strict();
export const AdoptReportParentSchema = z
  .object({
    messageId: z.string().uuid(),
    child: NativeReportIdentitySchema,
    parent: NativeReportIdentitySchema,
    scopes,
    expectedEpoch: z.string().uuid().nullable(),
  })
  .strict();
export const RevokeReportRegistrationSchema = z
  .object({
    messageId: z.string().uuid(),
    identity: NativeReportIdentitySchema,
    expectedEpoch: z.string().uuid(),
  })
  .strict();
export const ReportRegistrationReceiptSchema = z
  .object({
    messageId: z.string().uuid(),
    epoch: z.string().uuid(),
    duplicate: z.boolean(),
    current: z.boolean(),
    maintenanceRequired: z.boolean().optional(),
  })
  .strict();

export const IntercomRateSnapshotSchema = z
  .object({
    initialized: z.boolean(),
    settings: IntercomRateSettingsSchema.nullable(),
    windowMs: z.literal(3600000),
  })
  .strict();
export const IntercomStatusInputSchema = z.object({ agentId: z.string().uuid() }).strict();
export const IntercomStatusSchema = z
  .object({
    version: z.literal(1),
    identity: NativeReportIdentitySchema.nullable(),
    registration: z
      .object({
        epoch: z.string().uuid(),
        parent: NativeReportIdentitySchema.nullable(),
        scopes: z.array(NativeReportScopeSchema).min(1).max(16),
        primeRole: z.boolean().optional(),
        owningProjects: z
          .array(z.object({ projectId: z.string().uuid(), epoch: z.string().uuid() }).strict())
          .max(16)
          .optional(),
      })
      .strict()
      .nullable(),
    queueAvailable: z.boolean(),
    reportLinked: z.boolean(),
    settingsInitialized: z.boolean(),
    supportedProviders: z.tuple([z.literal("codex")]),
  })
  .strict();

/** Native admission is distinct from correlated provider acceptance. */
export const NativeQueuedMessageReceiptSchema = z
  .object({
    messageId: z.string().min(1).max(256),
    state: z.enum(["queued", "dispatching", "delivered", "refused", "cancelled", "uncertain"]),
    providerTurnId: z.string().min(1).max(256).optional(),
    pendingCount: z.number().int().min(0).max(32),
  })
  .strict();

/** Explicit owner read, not a report credential or action capability. */
export const NativeOwnerReportReadInputSchema = z
  .object({
    identity: NativeReportIdentitySchema,
    expectedEpoch: z.string().uuid(),
    scope: NativeReportScopeSchema,
  })
  .strict();
const nativeReportKind = z.enum(["ended", "needs-you", "blocked", "usage-limit", "handoff"]);
const reportWakeState = z.enum([
  "collecting",
  "queued",
  "dispatching",
  "delivered",
  "refused",
  "cancelled",
  "uncertain",
]);
export const NativeOwnerReportReadOutputSchema = z
  .object({
    scope: NativeReportScopeSchema,
    events: z
      .array(
        z
          .object({
            eventId: z.string().uuid(),
            kind: nativeReportKind,
            routing: z.literal("owning-prime-rollup").optional(),
            scope: NativeReportScopeSchema,
            at: z.number().int().nonnegative(),
            metadataCommitted: z.literal(true),
            wakeState: reportWakeState,
            providerAccepted: z.boolean(),
            consumed: z.boolean(),
          })
          .strict(),
      )
      .max(24),
    overflow: z
      .array(
        z
          .object({
            scope: NativeReportScopeSchema,
            eventIds: z.array(z.string().uuid()).max(16),
            counts: z
              .object({
                ended: z.number().int().min(1).max(16).optional(),
                "needs-you": z.number().int().min(1).max(16).optional(),
                blocked: z.number().int().min(1).max(16).optional(),
                "usage-limit": z.number().int().min(1).max(16).optional(),
                handoff: z.number().int().min(1).max(16).optional(),
              })
              .strict(),
            count: z.number().int().min(1).max(16),
            metadataCommitted: z.literal(true),
            wakeState: reportWakeState,
            providerAccepted: z.boolean(),
          })
          .strict(),
      )
      .max(24),
    visibleMetadataCount: z.number().int().min(0).max(408),
    bounded: z.literal(true),
  })
  .strict();
