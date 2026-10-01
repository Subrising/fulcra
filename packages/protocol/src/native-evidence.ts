import { z } from "zod";
import {
  NativeReportIdentitySchema,
  NativeReportScopeSchema,
  NativeOwnerReportReadInputSchema,
} from "./native-intercom.js";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const NativeEvidenceFactSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("produced_artifact"),
      basis: z.literal("host_materialized_native_generation"),
      sha256: digest,
      size: z
        .number()
        .int()
        .min(1)
        .max(16 * 1024 * 1024),
      contentAvailable: z.literal(false),
    })
    .strict(),
  z
    .object({
      kind: z.literal("file_touch"),
      basis: z.literal("native_provider_ack"),
      fileCount: z.number().int().min(1).max(32),
    })
    .strict(),
  z
    .object({
      kind: z.literal("command_result"),
      basis: z.literal("native_provider_ack"),
      exitCode: z.number().int().min(-2147483648).max(2147483647).nullable(),
    })
    .strict(),
]);
export const NativeEvidenceEntrySchema = z
  .object({
    id: z.string().uuid(),
    operationDigest: digest,
    scope: NativeReportScopeSchema,
    at: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
    fact: NativeEvidenceFactSchema,
    metadataCommitted: z.literal(true),
  })
  .strict();
export type NativeEvidenceEntry = z.infer<typeof NativeEvidenceEntrySchema>;
export const NativeEvidenceJournalSchema = z
  .object({
    version: z.literal(3),
    recordType: z.literal("native_evidence"),
    source: NativeReportIdentitySchema,
    sourceEpoch: z.string().uuid(),
    recipient: NativeReportIdentitySchema,
    recipientEpoch: z.string().uuid(),
    entry: NativeEvidenceEntrySchema,
    completionBodyDigest: digest,
    fingerprint: digest,
    bytes: z.number().int().min(1).max(4096),
  })
  .strict();
export type NativeEvidenceJournal = z.infer<typeof NativeEvidenceJournalSchema>;
export const NativeEvidenceReadInputSchema = NativeOwnerReportReadInputSchema;
export const NativeEvidenceReadOutputSchema = z
  .object({
    scope: NativeReportScopeSchema,
    entries: z.array(NativeEvidenceEntrySchema).max(24),
    bounded: z.literal(true),
    contentReadAvailable: z.literal(false),
  })
  .strict();

export const NativeEvidenceClaimSchema = NativeEvidenceJournalSchema.omit({
  entry: true,
  fingerprint: true,
})
  .extend({
    recordType: z.literal("native_evidence_attempt"),
    entry: NativeEvidenceEntrySchema.omit({ fact: true, metadataCommitted: true }),
    fingerprint: digest,
  })
  .strict();
export type NativeEvidenceClaim = z.infer<typeof NativeEvidenceClaimSchema>;

export type NativeEvidenceFact = z.infer<typeof NativeEvidenceFactSchema>;
export type NativeEvidenceReadInput = z.infer<typeof NativeEvidenceReadInputSchema>;
export type NativeEvidenceReadOutput = z.infer<typeof NativeEvidenceReadOutputSchema>;

/** Separate additive namespace: legacy native evidence facts/read results are unchanged. */
export const ManagedArtifactFactSchema = z
  .object({
    kind: z.literal("managed_artifact"),
    basis: z.literal("host_materialized_declared_output"),
    sha256: digest,
    size: z
      .number()
      .int()
      .min(1)
      .max(128 * 1024),
    contentAvailable: z.literal(false),
  })
  .strict();
export const ManagedArtifactEntrySchema = NativeEvidenceEntrySchema.omit({ fact: true }).extend({
  fact: ManagedArtifactFactSchema,
});
export const ManagedArtifactReservationSchema = z
  .object({
    size: z
      .number()
      .int()
      .min(1)
      .max(128 * 1024),
    sha256: digest,
  })
  .strict();
export const ManagedArtifactReferenceSchema = ManagedArtifactReservationSchema.extend({
  dev: z.number().int().nonnegative(),
  ino: z.number().int().nonnegative(),
  rootDev: z.number().int().nonnegative().optional(),
  rootIno: z.number().int().nonnegative().optional(),
  parentDev: z.number().int().nonnegative().optional(),
  parentIno: z.number().int().nonnegative().optional(),
});
const ManagedArtifactContextSchema = z
  .object({
    version: z.literal(4),
    source: NativeReportIdentitySchema,
    sourceEpoch: z.string().uuid(),
    recipient: NativeReportIdentitySchema,
    recipientEpoch: z.string().uuid(),
    completionBodyDigest: digest,
    fingerprint: digest,
    bytes: z.number().int().min(1).max(4096),
    artifactReservation: ManagedArtifactReservationSchema,
  })
  .strict();
export const ManagedArtifactClaimSchema = ManagedArtifactContextSchema.extend({
  recordType: z.literal("native_managed_artifact_attempt"),
  entry: NativeEvidenceEntrySchema.omit({ fact: true, metadataCommitted: true }),
});
export const ManagedArtifactJournalSchema = ManagedArtifactContextSchema.extend({
  recordType: z.literal("native_managed_artifact"),
  entry: ManagedArtifactEntrySchema,
  artifactReference: ManagedArtifactReferenceSchema,
});
export type ManagedArtifactClaim = z.infer<typeof ManagedArtifactClaimSchema>;
export type ManagedArtifactJournal = z.infer<typeof ManagedArtifactJournalSchema>;
export const ManagedArtifactReadInputSchema = NativeOwnerReportReadInputSchema;
export const ManagedArtifactReadOutputSchema = z
  .object({
    scope: NativeReportScopeSchema,
    entries: z.array(ManagedArtifactEntrySchema).max(24),
    bounded: z.literal(true),
    contentReadAvailable: z.literal(false),
  })
  .strict();
/** Independent owner opt-in, not provider-wide enabled-tools defaults. */
export const SetNativeArtifactToolSchema = z
  .object({
    messageId: z.string().uuid(),
    identity: NativeReportIdentitySchema,
    expectedEpoch: z.string().uuid(),
    scope: NativeReportScopeSchema,
    enabled: z.boolean(),
    expiresAt: z.number().int().nonnegative(),
  })
  .strict();
export const NativeArtifactProduceInputSchema = z
  .object({
    operationId: z.string().uuid(),
    scope: NativeReportScopeSchema,
    text: z
      .string()
      .min(1)
      .max(128 * 1024),
  })
  .strict();
export const NativeArtifactProduceOutputSchema = z
  .object({
    id: z.string().uuid(),
    scope: NativeReportScopeSchema,
    metadataCommitted: z.literal(true),
    basis: z.literal("host_materialized_declared_output"),
    contentReadAvailable: z.literal(false),
  })
  .strict();
