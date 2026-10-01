import { z } from "zod";

const name = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
const image = z
  .string()
  .max(225)
  .regex(/^[a-z0-9][a-z0-9./_-]{0,180}(?::[A-Za-z0-9_.-]{1,40}|@sha256:[a-f0-9]{64})$/)
  .refine((value) => !value.includes("..") && !value.endsWith(":latest"));
const port = z.number().int().min(1).max(65535);
const resource = z.object({ id: name, image, port }).strict();
const requirement = z.object({ id: name, resourceId: name, port }).strict();
const definition = z
  .object({
    application: name,
    requirements: z.array(requirement).min(1).max(16),
    current: z.array(resource).max(16),
    proposed: z.array(resource).min(1).max(16),
  })
  .strict();
const change = z
  .object({
    id: name,
    kind: z.enum(["add", "update", "remove"]),
    before: resource.nullable(),
    after: resource.nullable(),
  })
  .strict();
const plan = z
  .object({
    target: z.literal("0.61.x"),
    definition,
    revision: z.string().min(1).max(16384),
    changes: z.array(change).max(32),
  })
  .strict();
export const RadiusScratchInputSchema = z
  .object({
    attemptId: z
      .string()
      .uuid()
      .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
    plan,
    expectedRevision: z.string().min(1).max(16384),
  })
  .strict()
  .refine((input) => input.expectedRevision === input.plan.revision);
/** Separate explicitly selected destructive purpose; never supplied on an ordinary simulation. */
export const RadiusScratchPruneInputSchema = z
  .object({ ...RadiusScratchInputSchema.shape, confirmDestructive: z.literal(true) })
  .strict()
  .refine((input) => input.expectedRevision === input.plan.revision);
const outputFile = (file: string) =>
  z
    .object({
      file: z.literal(file),
      bytes: z.number().int().min(0).max(65536),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict();
export const RadiusScratchOutputSchema = z
  .object({
    attemptId: z.string().uuid(),
    kind: z.literal("local-scratch-simulation"),
    target: z.literal("0.61.x"),
    outputs: z.tuple([
      outputFile("app.bicep"),
      outputFile("requirements.json"),
      outputFile("infra-change.json"),
      outputFile("deployment-simulation.json"),
    ]),
    nativeCompilation: z.literal("not_run"),
    environmentDeployment: z.literal("held"),
    externalEffects: z.literal(false),
  })
  .strict();
export type RadiusScratchInput = z.infer<typeof RadiusScratchInputSchema>;
export type RadiusScratchOutput = z.infer<typeof RadiusScratchOutputSchema>;
