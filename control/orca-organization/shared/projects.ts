import { defineContract } from "./rpc-contract";
import { z } from "zod";

export const projectSummary = z.object({ id: z.string().uuid(), name: z.string().min(1).max(160), description: z.string().max(2000).nullable(), status: z.string().min(1).max(64) });
export const projectDirectory = z.object({
  observedAt: z.string().datetime(), available: z.boolean(), partial: z.boolean(),
  projects: z.array(projectSummary).max(64),
  membership: z.array(z.object({ taskId: z.string().uuid(), projectId: z.string().uuid().nullable() }).strict()).max(1000),
  note: z.string().max(512),
}).strict();
export const projectsRpc = defineContract({ name: "organization.projects", input: z.object({}).strict(), output: projectDirectory });
export type ProjectDirectory = z.infer<typeof projectDirectory>;
