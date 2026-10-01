import { z } from "zod";

/**
 * Background jobs a session has left running: backgrounded shells, workflows, or (for providers
 * without a task protocol) shell-rooted child processes. Display only: it may colour a workspace as
 * working, and nothing may gate an action on it. `status` of the agent never changes because of it.
 * See MULTIHOST-DESIGN §6.
 */
export const AGENT_BACKGROUND_WORK_KINDS = ["shell", "workflow", "process"] as const;

export const AgentBackgroundWorkSchema = z
  .object({
    count: z.number().int().min(0).max(999),
    kinds: z.array(z.enum(AGENT_BACKGROUND_WORK_KINDS)).max(3),
    source: z.enum(["provider", "process-tree"]),
    /** When the oldest open job started, if known. */
    since: z.string().nullable(),
    observedAt: z.string(),
  })
  .strict();

export type AgentBackgroundWork = z.infer<typeof AgentBackgroundWorkSchema>;
