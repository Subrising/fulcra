// Update-7: how leads get work done. The owner found MacBook game work "orphaned": its per-game leads had implementation
// done by Agent-tool subagents, which no view records. Every session created in a lead role (orchestration, planning,
// review) gets Fulcra's orchestration instruction by default: workers are sessions -- started with `paseo run` (or the
// manager tools), which records the lead as parent, the task and project, and the implementation role's model and
// effort -- never Agent-tool subagents for implementation or review; subagents only for read-only digests.
// With the guard on (Settings › Accounts & Defaults), a Claude lead's session also has the subagent tools removed, so
// implementation cannot go to a subagent at all (read-only digests then go to a session too). Codex has no such tool.
// The hook never throws and never replaces a prompt: it appends to the one the creation already has.
import { loadConfig } from "./config.mjs";
import { readRoleDefaults, LEAD_ROLES } from "./role-defaults-store.mjs";

export const ROLE_LABEL = "fulcra.role";
export const SUBAGENT_TOOLS = ["Task", "Agent"] as const;
export const ORCHESTRATION_NOTE = [
  "Fulcra orchestration: you lead; workers do the work.",
  'Start every implementation or review worker as its own session, never as an Agent-tool subagent: run `paseo run --title "<what it does>" "<its brief>"` from this session (or use your manager tools). Fulcra records you as its parent, gives it your task and project, and starts it with the implementation role\'s model and effort, so it shows under you in Sessions and Organisation on every Mac.',
  "Use a subagent only for a read-only digest (reading and summarising), never to change files or to review for acceptance.",
].join("\n");

type Request = {
  config: {
    provider: string;
    systemPrompt?: string;
    providerOptions?: Record<string, unknown>;
  } & Record<string, unknown>;
  labels?: Record<string, string>;
} & Record<string, unknown>;
export function applyOrchestration<R extends Request>(request: R, guard: boolean): R {
  const role = request.labels?.[ROLE_LABEL];
  if (!role || !(LEAD_ROLES as readonly string[]).includes(role)) return request;
  const prompt =
    typeof request.config.systemPrompt === "string" && request.config.systemPrompt
      ? request.config.systemPrompt
      : "";
  const config: R["config"] = {
    ...request.config,
    systemPrompt: prompt.includes("Fulcra orchestration:")
      ? prompt
      : [prompt, ORCHESTRATION_NOTE].filter(Boolean).join("\n\n"),
  };
  if (guard && request.config.provider === "claude") {
    const options = (request.config.providerOptions ?? {}) as { disallowedTools?: unknown };
    const current = Array.isArray(options.disallowedTools)
      ? options.disallowedTools.filter((t): t is string => typeof t === "string")
      : [];
    config.providerOptions = {
      ...options,
      disallowedTools: [...new Set([...current, ...SUBAGENT_TOOLS])],
    };
  }
  return { ...request, config };
}
export function orchestrationHook(
  readGuard: () => boolean = () => {
    const c = loadConfig() as { home: string; defaults?: { roles?: unknown } };
    return readRoleDefaults(c.home, (c.defaults?.roles ?? null) as any).orchestrationGuard;
  },
) {
  return async ({ request }: { request: Request }) => {
    let guard = false;
    try {
      guard = readGuard();
    } catch {
      guard = false;
    }
    try {
      return applyOrchestration(request, guard);
    } catch {
      return request;
    }
  };
}
