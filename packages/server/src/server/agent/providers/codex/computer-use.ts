import { z } from "zod";

export const COMPUTER_USE_ALLOW_APPS_LABEL = "computerUse.allowApps";
const AppNameSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\p{Cc}\p{Cf}]+$/u)
  .refine((value) => value.trim().length > 0);
const BundleIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const DecisionKeySchema = z.tuple([AppNameSchema, BundleIdSchema]);
const AllowAppsSchema = z.array(AppNameSchema).max(100);

export function computerUseFromLabels(labels: Record<string, string> | undefined) {
  const value = labels?.[COMPUTER_USE_ALLOW_APPS_LABEL];
  if (value === undefined) return undefined;
  try {
    return { allowApps: [...new Set(AllowAppsSchema.parse(JSON.parse(value)))] };
  } catch {
    throw new Error("computerUse.allowApps must be a JSON array of app names (maximum 100).");
  }
}

/** Only the computer-use app consent form can reuse an app grant. */
export function computerUseApp(params: {
  serverName: string;
  message: string;
  requestedSchema?: unknown;
  _meta?: unknown;
}): string | null {
  if (
    !["cua_repl", "computer-use"].includes(params.serverName) ||
    !computerUseBundleId(params._meta)
  )
    return null;
  const schema = z
    .object({
      type: z.literal("object"),
      properties: z.object({}).strict(),
      required: z.array(z.never()).optional(),
      additionalProperties: z.boolean().optional(),
    })
    .strict()
    .safeParse(params.requestedSchema);
  if (!schema.success) return null;
  const match = /^Allow Computer Use to use (?:"(.+)"|([^"\r\n]+))\?$/.exec(params.message);
  const app = AppNameSchema.safeParse(match?.[1] ?? match?.[2]);
  return app.success ? app.data : null;
}

export interface ComputerUseDecision {
  action: "accept" | "decline";
  content: Record<string, never> | null;
  _meta: null;
}

export function restoreComputerUseDecisions(value: unknown): Map<string, ComputerUseDecision> {
  const decisions = new Map<string, ComputerUseDecision>();
  const parsed = z.record(z.string(), z.enum(["accept", "decline"])).safeParse(value);
  if (!parsed.success) return decisions;
  for (const [key, action] of Object.entries(parsed.data)) {
    try {
      const identity = DecisionKeySchema.safeParse(JSON.parse(key));
      if (identity.success)
        decisions.set(JSON.stringify(identity.data), {
          action,
          content: action === "accept" ? {} : null,
          _meta: null,
        });
    } catch {
      /* An invalid persisted entry grants no app. */
    }
  }
  return decisions;
}

export function assertComputerUseLabels(input: {
  stored: { provider: string; labels: Record<string, string> } | null | undefined;
  updates: { labels?: Record<string, string | null> } | undefined;
  replace?: boolean;
}): void {
  if (input.stored?.provider !== "codex" || !input.updates?.labels) return;
  const labels = input.updates.labels;
  const key = COMPUTER_USE_ALLOW_APPS_LABEL;
  if ((input.replace || Object.hasOwn(labels, key)) && labels[key] !== input.stored.labels[key]) {
    throw new Error(
      "computerUse.allowApps is fixed at job creation. Start a new job to change it.",
    );
  }
}

/** Codex forwards this MCP metadata; its generated request schema includes `_meta`. */
export function computerUseBundleId(meta: unknown): string | null {
  const parsed = z
    .object({
      connector_id: z.literal("computer-use"),
      tool_params: z.object({ app: BundleIdSchema }),
    })
    .safeParse(meta);
  return parsed.success ? parsed.data.tool_params.app : null;
}

export function computerUseDecisionKey(app: string, bundleId: string): string {
  return JSON.stringify([app, bundleId]);
}

export function hasComputerUseNameBinding(
  decisions: Map<string, ComputerUseDecision>,
  app: string,
): boolean {
  const prefix = `${JSON.stringify([app]).slice(0, -1)},`;
  return [...decisions.keys()].some((key) => key.startsWith(prefix));
}
