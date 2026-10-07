// DESIGN-NEXT-BUILD A3.3/A3.4 (C12). Two things the desktop path needs and the controller already knows:
// - the Role picker's table (a projection of the controller's session-defaults read), and
// - the agent.create before-hook: a creation labelled with a role and no model / effort of its own gets the role's
//   configured values, checked against the installed provider's model list exactly as the controller checks them.
// The hook never refuses and never throws: anything it cannot establish leaves the request exactly as it came, so the
// daemon's own defaults apply, as they would have without roles. Explicit form values are never replaced.
import { localCall } from "./management";
import { loadConfig } from "./config.mjs";
import { readRoleDefaults, hookRoles } from "./role-defaults-store.mjs";
import type { ProviderModes } from "./role-defaults-store.mjs";
import {
  SESSION_ROLE_LABEL,
  SESSION_ROLE_NAMES,
  sessionDefaultsRpc,
  type SessionRoleName,
  type SessionRoleDefaults,
} from "../shared/session-defaults";

type Call = (method: string, input?: unknown) => Promise<any>;
const PROVIDERS = ["claude", "codex"] as const;
const own = (o: any, k: string) =>
  o && typeof o === "object" && Object.hasOwn(o, k) ? o[k] : undefined;
const bare = (model: unknown) =>
  typeof model === "string" && model
    ? model.includes("/")
      ? model.slice(model.indexOf("/") + 1)
      : model
    : null;
const pick = (s: any) => ({
  model: bare(own(s, "model")),
  thinkingOptionId: typeof own(s, "thinkingOptionId") === "string" ? s.thinkingOptionId : null,
});

type Modes = Partial<ProviderModes>;
export function projectRoleDefaults(roles: unknown, modes?: Modes): SessionRoleDefaults {
  const out: Record<string, unknown> = {};
  for (const role of SESSION_ROLE_NAMES) {
    const row = own(roles, role);
    if (!row) continue;
    const providers: Record<string, unknown> = {};
    for (const p of PROVIDERS) {
      const x = own(own(row, "providers"), p);
      if (!x) continue;
      const status =
        ["offered", "falls-back"].includes(x.status) && x.effective ? x.status : "unknown";
      providers[p] = {
        status,
        configured: pick(x.configured),
        effective: status === "unknown" ? null : pick(x.effective),
      };
    }
    out[role] = {
      provider: PROVIDERS.includes(own(row, "provider")) ? row.provider : null,
      providers,
    };
  }
  return sessionDefaultsRpc.output.parse({ roles: out, ...(modes ? { modes } : {}) });
}
// Update-7 W3: the default permission modes ride along, so the app form pre-fills them; unreadable means none sent.
export function createSessionDefaultsReader(
  call: Call = localCall,
  readModes: () => Modes = mergedModes,
) {
  return async () => {
    let modes: Modes | undefined;
    try {
      modes = readModes();
    } catch {
      modes = undefined;
    }
    return projectRoleDefaults((await call("session-defaults", null))?.roles, modes);
  };
}

interface ModelList {
  provider?: string;
  error?: string | null;
  models?: Array<{
    id?: string;
    provider?: string;
    isSelectable?: boolean;
    isDefault?: boolean;
    thinkingOptions?: Array<{ id?: string }> | null;
  }>;
}
type CreateRequest = {
  config: {
    provider: string;
    model?: string | null;
    thinkingOptionId?: string | null;
    modeId?: string | null;
    cwd?: string;
  } & Record<string, unknown>;
  labels?: Record<string, string>;
  caller?: unknown;
} & Record<string, unknown>;

// Pure: the request after role defaults, given the configured roles and the provider's model list (null = unavailable).
export async function applyRoleDefaults<R extends CreateRequest>(
  request: R,
  roles: unknown,
  listModels: (provider: string) => Promise<ModelList | null>,
): Promise<R> {
  const role = own(request.labels, SESSION_ROLE_LABEL) as SessionRoleName | undefined;
  if (!role || !SESSION_ROLE_NAMES.includes(role)) return request;
  const provider = request.config.provider;
  if (!PROVIDERS.includes(provider as any)) return request;
  const entry = own(own(roles, role), provider);
  if (!entry) return request;
  const configuredModel = own(entry, "model"),
    configuredEffort = own(entry, "thinkingOptionId");
  // A configured model must name this provider's family; anything else is left to the controller's validator to report.
  const model =
    !request.config.model &&
    typeof configuredModel === "string" &&
    configuredModel.startsWith(`${provider}/`)
      ? bare(configuredModel)
      : null;
  const effort =
    !request.config.thinkingOptionId && typeof configuredEffort === "string" && configuredEffort
      ? configuredEffort
      : null;
  if (!model && !effort) return request;
  let list: ModelList | null = null;
  try {
    list = await listModels(provider);
  } catch {
    list = null;
  }
  const models =
    list && !list.error && Array.isArray(list.models)
      ? list.models.filter(
          (m) => m?.provider === provider && m.isSelectable !== false && typeof m.id === "string",
        )
      : null;
  if (!models) return request; // catalog unavailable: role values fall back (to the daemon's own defaults)
  const useModel = model && models.some((m) => m.id === model) ? model : null; // model-not-offered: fall back
  const target = useModel ?? request.config.model ?? models.find((m) => m.isDefault === true)?.id;
  const offered = (models.find((m) => m.id === target)?.thinkingOptions ?? [])
    .map((o) => o?.id)
    .filter(Boolean);
  const useEffort = effort && offered.includes(effort) ? effort : null; // effort-not-offered: fall back
  if (!useModel && !useEffort) return request;
  return {
    ...request,
    config: {
      ...request.config,
      ...(useModel ? { model: useModel } : {}),
      ...(useEffort ? { thinkingOptionId: useEffort } : {}),
    },
  };
}

// Update-7 W3 (owner, 01:29Z): a create that names no permission mode gets the stored per-provider default (Claude
// auto, Codex full-access unless changed in Settings). An explicit mode always wins; other providers are left alone.
// R1 P-3 seam: the caller of a child create, as the daemon reports it (context only).
export interface CreateCaller {
  provider: string;
  modeId: string | null;
  modeClass: "automatic" | "restricted" | "unknown";
}
type ChildPolicy = (
  modes: Modes | null | undefined,
  provider: keyof ProviderModes,
  caller: CreateCaller | undefined,
) => string | undefined;
// THE child-mode policy point (R1 P-3; the owner decides later). The daemon passes the caller as `parent` on every
// create path (MCP create_agent and the session path used by `paseo run`), so a restricted caller's child normally
// arrives here with a restricted mode already set. As a backstop, a restricted or unknown caller's child gets no owner
// default here (R1 P-8 b): the daemon's conservative default applies. Interim rule for an AUTOMATIC caller
// (orchestrator, COORD 04:0xZ): the MORE RESTRICTIVE of the child's own provider's stored default and the caller's
// class -- ask/plan < reviewed < unattended -- so a Claude-auto lead's Codex child is auto-review, not full-access,
// while a Codex full-access lead's Claude child keeps Claude's own `auto`. A caller-less (top-level) create keeps the
// owner's default; an explicit mode never reaches here.
const MODE_LEVEL: Record<string, Record<string, number>> = {
  claude: { plan: 0, default: 0, acceptEdits: 0, auto: 1, bypassPermissions: 2 },
  codex: { "read-only": 0, auto: 0, "auto-review": 1, "full-access": 2 },
};
const MODE_AT_LEVEL: Record<string, readonly string[]> = {
  claude: ["default", "auto"],
  codex: ["auto", "auto-review"],
};
export const childModeDefault: ChildPolicy = (modes, provider, caller) => {
  const own = modes?.[provider];
  if (!caller) return own;
  if (caller.modeClass !== "automatic") return undefined;
  if (!own) return own;
  const callerLevel = MODE_LEVEL[caller.provider]?.[caller.modeId ?? ""] ?? 0;
  const ownLevel = MODE_LEVEL[provider]?.[own] ?? 2;
  return ownLevel <= callerLevel ? own : (MODE_AT_LEVEL[provider]?.[callerLevel] ?? own);
};
export function applyModeDefault<R extends CreateRequest>(
  request: R,
  modes: Modes | null | undefined,
  policy: ChildPolicy = childModeDefault,
): R {
  const provider = request.config.provider as keyof ProviderModes;
  if (request.config.modeId || !PROVIDERS.includes(provider as any)) return request;
  const modeId = policy(modes, provider, own(request, "caller") as CreateCaller | undefined);
  return typeof modeId === "string" && modeId
    ? { ...request, config: { ...request.config, modeId } }
    : request;
}
export function mergedModes(): Modes {
  const c = loadConfig() as { home: string; defaults?: { roles?: unknown; modes?: unknown } };
  return readRoleDefaults(
    c.home,
    (c.defaults?.roles ?? null) as any,
    (c.defaults?.modes ?? null) as any,
  ).modes;
}
// Update-7: the persisted table (Settings -> Accounts & models, its own file) over the shared config's roles.
export function mergedRoles(): unknown {
  const c = loadConfig() as { home: string; defaults?: { roles?: unknown } };
  return hookRoles(readRoleDefaults(c.home, (c.defaults?.roles ?? null) as any));
}
export function roleDefaultsHook(
  readRoles: () => unknown = mergedRoles,
  readModes: () => Modes = mergedModes,
  policy: ChildPolicy = childModeDefault,
) {
  return async ({ request }: { request: CreateRequest }, context: { paseo: any }) => {
    let modes: Modes | null = null;
    try {
      modes = readModes();
    } catch {
      modes = null;
    }
    const withMode = applyModeDefault(request, modes, policy);
    let roles: unknown;
    try {
      roles = readRoles();
    } catch {
      return withMode;
    }
    if (!roles) return withMode;
    try {
      return await applyRoleDefaults(withMode, roles, (provider) =>
        context.paseo.providers.listModels(
          provider,
          withMode.config.cwd ? { cwd: withMode.config.cwd } : undefined,
        ),
      );
    } catch {
      return withMode;
    }
  };
}
