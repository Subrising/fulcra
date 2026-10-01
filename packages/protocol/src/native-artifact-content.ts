import { z } from "zod";
import { NativeReportIdentitySchema, NativeReportScopeSchema } from "./native-intercom.js";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const NativeArtifactContentGrantSchema = z
  .object({
    grantId: z.string().uuid(),
    revision: z.string().uuid(),
    identity: NativeReportIdentitySchema,
    expectedEpoch: z.string().uuid(),
    scope: NativeReportScopeSchema,
    artifactIds: z.array(z.string().uuid()).min(1).max(24),
    byteBudget: z
      .number()
      .int()
      .min(1)
      .max(128 * 1024),
    expiresAt: z.number().int().nonnegative(),
  })
  .strict();
export const SetNativeArtifactContentGrantSchema = NativeArtifactContentGrantSchema.omit({
  revision: true,
})
  .extend({
    messageId: z.string().uuid(),
    expectedGrantRevision: z.string().uuid().nullable(),
    enabled: z.boolean(),
  })
  .strict();
export const NativeArtifactContentSelectionSchema = z
  .object({
    identity: NativeReportIdentitySchema,
    expectedEpoch: z.string().uuid(),
    scope: NativeReportScopeSchema,
  })
  .strict();
export const NativeArtifactContentReadInputSchema = NativeArtifactContentSelectionSchema.extend({
  requestId: z.string().uuid(),
  grantId: z.string().uuid(),
  grantRevision: z.string().uuid(),
  artifactId: z.string().uuid(),
  offset: z.number().int().nonnegative(),
  length: z.number().int().min(1).max(8192),
}).strict();
export const NativeArtifactContentReadOutputSchema = z
  .object({
    requestId: z.string().uuid(),
    grantId: z.string().uuid(),
    grantRevision: z.string().uuid(),
    artifactId: z.string().uuid(),
    scope: NativeReportScopeSchema,
    offset: z.number().int().nonnegative(),
    length: z.number().int().min(1).max(8192),
    expiresAt: z.number().int().nonnegative(),
    encoding: z.literal("base64"),
    contentType: z.literal("text/plain"),
    data: z
      .string()
      .max(10924)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
    eof: z.boolean(),
  })
  .strict();
/** Private permanent debit: never a credential or replayable read capability. */
export const NativeArtifactContentDebitSchema = z
  .object({
    version: z.literal(5),
    recordType: z.literal("native_artifact_content_debit"),
    request: NativeArtifactContentReadInputSchema,
    byteBudget: z
      .number()
      .int()
      .min(1)
      .max(128 * 1024),
    artifactDigest: digest,
    at: z.number().int().nonnegative(),
    fingerprint: digest,
    bytes: z.number().int().min(1).max(16384),
  })
  .strict();
export type NativeArtifactContentGrant = z.infer<typeof NativeArtifactContentGrantSchema>;
export type NativeArtifactContentReadInput = z.infer<typeof NativeArtifactContentReadInputSchema>;
export type NativeArtifactContentDebit = z.infer<typeof NativeArtifactContentDebitSchema>;
