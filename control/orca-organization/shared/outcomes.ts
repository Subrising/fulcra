import { defineContract } from "./rpc-contract";
import { z } from "zod";
const text = z.string().min(1).max(4000),
  label = z.string().min(1).max(160);
const key = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
const publishedFile = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}\.(md|csv|txt)$/);
export const outcomeRecord = z
  .object({
    version: z.literal(1),
    taskId: z.string().uuid(),
    title: label,
    outcome: text,
    currentState: text,
    nextStep: text.optional(),
    publishedAt: z.string().datetime({ offset: true }).optional(),
    coordination: z
      .object({
        decisionNeeded: text.nullable(),
        affectedProjects: z
          .array(z.object({ projectId: z.string().uuid(), reason: text }).strict())
          .max(8),
        dependsOn: z.array(z.object({ taskId: z.string().uuid(), reason: text }).strict()).max(8),
      })
      .strict()
      .optional(),
    alternatives: z
      .array(
        z
          .object({
            id: key,
            title: label,
            change: text,
            benefits: text,
            risks: text,
            dependencies: z.array(label).max(16),
            example: text,
          })
          .strict(),
      )
      .min(1)
      .max(8),
    decision: z
      .object({
        alternativeId: key,
        by: label,
        at: z.string().datetime({ offset: true }),
        rationale: text,
        authority: text,
      })
      .strict()
      .nullable(),
    artifacts: z
      .array(
        z
          .object({
            id: key,
            title: label,
            file: publishedFile,
            sha256: hash,
            kind: z.enum(["input", "output", "review", "runtime"]),
            producerSessionId: z.string().uuid().nullable(),
          })
          .strict(),
      )
      .max(16),
    reviews: z
      .array(
        z
          .object({
            artifactId: key,
            reviewed: z
              .array(z.object({ artifactId: key, sha256: hash }).strict())
              .min(1)
              .max(16),
            by: label,
            verdict: z.enum(["accepted", "changes-requested", "pending"]),
            scope: text,
          })
          .strict(),
      )
      .max(8),
  })
  .strict()
  .superRefine((r, ctx) => {
    const c = r.coordination;
    if (
      c &&
      ((c.decisionNeeded !== null && r.decision !== null) ||
        new Set(c.affectedProjects.map((p) => p.projectId)).size !== c.affectedProjects.length ||
        new Set(c.dependsOn.map((t) => t.taskId)).size !== c.dependsOn.length ||
        c.dependsOn.some((t) => t.taskId === r.taskId))
    )
      ctx.addIssue({ code: "custom", message: "Ambiguous coordination or self dependency" });
    const choices = new Set(r.alternatives.map((a) => a.id)),
      artifacts = new Map(r.artifacts.map((a) => [a.id, a]));
    if (
      choices.size !== r.alternatives.length ||
      artifacts.size !== r.artifacts.length ||
      new Set(r.artifacts.map((a) => a.file)).size !== r.artifacts.length
    )
      ctx.addIssue({ code: "custom", message: "Duplicate outcome identity" });
    if (r.decision && !choices.has(r.decision.alternativeId))
      ctx.addIssue({ code: "custom", message: "Unknown selected alternative" });
    if (new Set(r.reviews.map((a) => a.artifactId)).size !== r.reviews.length)
      ctx.addIssue({ code: "custom", message: "Duplicate review identity" });
    for (const review of r.reviews)
      if (
        artifacts.get(review.artifactId)?.kind !== "review" ||
        review.reviewed.some(
          (a) => !artifacts.has(a.artifactId) || a.artifactId === review.artifactId,
        ) ||
        new Set(review.reviewed.map((a) => a.artifactId)).size !== review.reviewed.length
      )
        ctx.addIssue({ code: "custom", message: "Invalid review binding" });
  });
export const outcomeSnapshot = z
  .object({
    observedAt: z.string(),
    status: z.enum(["available", "missing", "unavailable"]),
    message: z.string().max(512),
    recordSha256: hash.nullable(),
    record: outcomeRecord.nullable(),
    artifacts: z
      .array(
        z
          .object({
            id: key,
            state: z.enum(["matches", "changed", "unavailable"]),
            actualSha256: hash.nullable(),
            bytes: z.number().int().nonnegative().nullable(),
          })
          .strict(),
      )
      .max(16),
    reviews: z
      .array(
        z.object({ artifactId: key, current: z.boolean(), reason: z.string().max(512) }).strict(),
      )
      .max(8),
  })
  .strict();
export const outcomeRpc = defineContract({
  name: "organization.outcome",
  input: z.object({ taskId: z.string().uuid() }).strict(),
  output: outcomeSnapshot,
});
export const outcomeArtifactRpc = defineContract({
  name: "organization.outcome-artifact",
  input: z.object({ taskId: z.string().uuid(), artifactId: key, recordSha256: hash }).strict(),
  output: z
    .object({
      observedAt: z.string(),
      status: z.enum(["available", "changed", "unavailable"]),
      message: z.string().max(512),
      text: z.string().max(65536).nullable(),
      sha256: hash.nullable(),
    })
    .strict(),
});
