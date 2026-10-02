// DESIGN-NEXT-BUILD A3.4 (C12): what a new session under each role would launch here, for the desktop form's Role
// picker. The controller's session-defaults read is the source; model ids are bare (no family prefix), as the app's
// model catalog names them. The label a creation carries to say what it is for is SESSION_ROLE_LABEL.
import { z } from "zod";
import { defineContract } from "./rpc-contract";

export const SESSION_ROLE_LABEL = "fulcra.role";
export const SESSION_ROLE_NAMES = [
  "planning",
  "orchestration",
  "implementation",
  "review",
  "research",
] as const; // update-7: review, research
export type SessionRoleName = (typeof SESSION_ROLE_NAMES)[number];
const selection = z
  .object({
    model: z.string().max(200).nullable(),
    thinkingOptionId: z.string().max(40).nullable(),
  })
  .strict();
const providerRow = z
  .object({
    status: z.enum(["offered", "falls-back", "unknown"]),
    configured: selection,
    effective: selection.nullable(),
  })
  .strict();
const roleRow = z
  .object({
    provider: z.enum(["claude", "codex"]).nullable(),
    providers: z.object({ claude: providerRow.optional(), codex: providerRow.optional() }).strict(),
  })
  .strict();
export const sessionDefaultsRpc = defineContract({
  name: "organization.session-defaults",
  input: z.object({}).strict(),
  // Update-7 W3: the default permission mode per provider for a new session (optional: an older plugin sends none).
  output: z
    .object({
      roles: z
        .object({
          planning: roleRow.optional(),
          orchestration: roleRow.optional(),
          implementation: roleRow.optional(),
          review: roleRow.optional(),
          research: roleRow.optional(),
        })
        .strict(),
      modes: z
        .object({ claude: z.string().max(40).optional(), codex: z.string().max(40).optional() })
        .strict()
        .optional(),
    })
    .strict(),
});
export type SessionRoleDefaults = z.infer<typeof sessionDefaultsRpc.output>;
