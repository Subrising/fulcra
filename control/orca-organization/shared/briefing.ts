import { defineContract } from "./rpc-contract";
import { z } from "zod";
const id = z.string().uuid(), text = z.string().max(4000), label = z.string().max(160);
export const briefingRpc = defineContract({ name: "organization.project-briefing",
  input: z.object({ after: id.nullable().default(null) }).strict(),
  output: z.object({ observedAt: z.string().datetime(), partial: z.boolean(), scanned: z.number().int().min(0).max(64), total: z.number().int().nonnegative(), missing: z.number().int().nonnegative(), unavailable: z.number().int().nonnegative(), nextCursor: id.nullable(),
    entries: z.array(z.object({ taskId: id, title: label, projectId: id.nullable(), projectName: label.nullable(), outcome: text, currentState: text, nextStep: text.nullable(), question: text.nullable(), decision: text.nullable(), publishedAt: z.string().nullable(), recordSha256: z.string().regex(/^[a-f0-9]{64}$/),
      affects: z.array(z.object({ projectId: id, name: label.nullable(), reason: text }).strict()).max(8),
      dependencies: z.array(z.object({ taskId: id.nullable(), title: label.nullable(), reportedStatus: z.string().max(64).nullable(), reason: text }).strict()).max(8),
    }).strict()).max(64),
  }).strict(),
});
export type Briefing = z.infer<typeof briefingRpc.output>;
