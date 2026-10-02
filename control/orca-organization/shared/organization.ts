import { defineContract } from "./rpc-contract";
import { z } from "zod";
export const snapshotRpc = defineContract({
  name: "organization.snapshot",
  input: z.object({ taskId: z.string().uuid().optional() }).strict(),
  output: z.object({
    observedAt: z.string(),
    host: z.string(),
    board: z.object({
      available: z.boolean(),
      identifier: z.string(),
      title: z.string().nullable(),
      status: z.string().nullable(),
      owner: z.string().nullable(),
      error: z.string().nullable(),
    }),
    sessionsAvailable: z.boolean(),
    coverage: z.string(),
    sessions: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        provider: z.string(),
        model: z.string().nullable(),
        nativeId: z.string().nullable(),
        status: z.string(),
        updatedAt: z.string(),
        pending: z.number().nullable(),
        error: z.string().nullable(),
        artifacts: z.array(
          z.object({ name: z.string(), sha256: z.string().nullable(), state: z.string() }),
        ),
      }),
    ),
    remote: z.string(),
  }),
});
