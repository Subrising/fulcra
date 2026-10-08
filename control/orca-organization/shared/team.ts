import { z } from "zod";
import { defineContract } from "./rpc-contract";

// Fulcra 0.2.8: set up the team from chats that already exist, in one step each. The server runs the controller's
// owner-only team methods (src/control/team.mjs), then the seat and remit writes, and reports each step in plain words.
// A refusal carries the controller's own reason.

const id = z.string().uuid();
const projectName = z.string().trim().min(1).max(160);

export const MAIN_SEAT = "main";

/**
 * The one main assistant every view shows: the "main" seat when it is held, else the first held main assistant seat.
 * Leads, the Team map, the organisation view, Home and the sidebar all use this, so they never disagree.
 */
export function mainAssistant<S extends { seat: string; state: string; sessionId: string | null }>(
  primes: readonly S[] | undefined,
): S | null {
  const held = (primes ?? []).filter((s) => s.state === "assigned" && s.sessionId);
  return held.find((s) => s.seat === MAIN_SEAT) ?? held[0] ?? null;
}

export const teamSetupRpc = defineContract({
  name: "organization.team-setup",
  input: z.discriminatedUnion("action", [
    z.object({ action: z.literal("main-assistant"), sessionId: id }).strict(),
    z
      .object({
        action: z.literal("project-lead"),
        sessionId: id,
        projectId: id.optional(),
        projectName: projectName.optional(),
      })
      .strict()
      .refine((a) => (a.projectId === undefined) !== (a.projectName === undefined), {
        message: "Choose a project or type a new project name",
      }),
    z
      .object({
        action: z.literal("add-workers"),
        projectId: id,
        sessionIds: z.array(id).min(1).max(16),
      })
      .strict(),
    z.object({ action: z.literal("archive-project"), projectId: id }).strict(),
    // The one chat a chat may also message directly, outside its reporting line. null removes it.
    z
      .object({ action: z.literal("direct-link"), sessionId: id, linkedSessionId: id.nullable() })
      .strict(),
    z
      .object({ action: z.literal("retire-main-assistant"), seat: z.string().min(1).max(64) })
      .strict(),
  ]),
  output: z
    .object({
      status: z.enum(["done", "partly", "refused"]),
      message: z.string().max(2000),
      steps: z.array(z.string().max(500)).max(40),
      projectId: id.nullable(),
      observedAt: z.string().datetime(),
    })
    .strict(),
});
export type TeamSetupResult = z.infer<typeof teamSetupRpc.output>;

const teamChat = z
  .object({
    id,
    title: z.string().max(200),
    provider: z.string().max(40),
    running: z.boolean(),
    updatedAt: z.string().max(40).nullable(),
    /** Plain words: "Main assistant", "Lead of Fulcra", "Worker in Fulcra", or null when not on the team. */
    role: z.string().max(200).nullable(),
  })
  .strict();
export type TeamChat = z.infer<typeof teamChat>;

/** The chats on this computer that can join the team, newest first, with the place each holds now. */
export const teamChatsRpc = defineContract({
  name: "organization.team-chats",
  input: z.object({}).strict(),
  output: z
    .object({
      observedAt: z.string().datetime(),
      available: z.boolean(),
      complete: z.boolean(),
      chats: z.array(teamChat).max(500),
      note: z.string().max(500).nullable(),
    })
    .strict(),
});
export type TeamChats = z.infer<typeof teamChatsRpc.output>;
