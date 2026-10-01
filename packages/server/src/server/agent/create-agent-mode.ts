import { resolveAutomaticApprovalMode } from "@getpaseo/protocol/provider-manifest";
import type {
  AgentCreateConfigParent,
  AgentCreateConfigUnattendedInput,
  AgentMode,
  AgentProvider,
  ResolveAgentCreateConfigInput,
  ResolveAgentCreateConfigResult,
} from "./agent-sdk-types.js";

export interface ResolveCreateAgentModeInput {
  requestedMode: string | undefined;
  targetProvider: AgentProvider;
  parent: AgentCreateConfigParent | null;
  unattended: boolean;
  // `undefined` = target provider's modes unknown: explicit modes pass through
  // unvalidated, but cross-provider inheritance is still refused.
  // `[]` = target provider explicitly has no modes: use its default behavior.
  availableModes: string[] | undefined;
  // Target provider's own unattended mode id, if it has one. Used to bridge
  // unattended parents into unattended children across providers.
  targetUnattendedMode: string | undefined;
}

/**
 * The adapter's own automatic-approval mode, or `undefined` when it declares none — in
 * which case the caller keeps the provider default and the limitation is reported rather
 * than papered over. `availableModes === undefined` means the live mode list is unknown,
 * so the manifest answer is used unchecked; a known list must actually contain it.
 */
function resolveDeclaredAutomaticApprovalMode(
  targetProvider: AgentProvider,
  availableModes: string[] | undefined,
): string | undefined {
  const resolution = resolveAutomaticApprovalMode(targetProvider, availableModes);
  return resolution.supported && resolution.modeId ? resolution.modeId : undefined;
}

function listModes(modes: string[] | undefined): string {
  if (modes === undefined) {
    return "unknown";
  }
  return modes.length > 0 ? modes.join(", ") : "(none)";
}

function isUnattendedCreateConfigParent(parent: AgentCreateConfigParent): boolean {
  return parent.isUnattended;
}

function formatCreateConfigParentMode(parent: AgentCreateConfigParent): string {
  return parent.modeId ?? "<none>";
}

function formatCreateConfigParentSource(parent: AgentCreateConfigParent): string {
  return `caller (provider '${parent.provider}')`;
}

export function resolveAndValidateCreateAgentMode(
  input: ResolveCreateAgentModeInput,
): string | undefined {
  const { requestedMode, targetProvider, parent, availableModes } = input;

  if (requestedMode !== undefined) {
    if (availableModes !== undefined && !availableModes.includes(requestedMode)) {
      throw new Error(
        `Invalid mode '${requestedMode}' for provider '${targetProvider}'. Available modes: ${listModes(availableModes)}`,
      );
    }
    return requestedMode;
  }

  if (!parent) {
    if (input.unattended && input.targetUnattendedMode !== undefined) {
      return input.targetUnattendedMode;
    }
    // Nobody asked for a mode and nothing is being inherited. Rather than leaving the
    // session to the provider's runtime default — which is how every session was born
    // asking for permission — select the adapter's declared automatic-approval mode.
    // Declared, never a literal: `auto` is the classifier on Claude and plain default
    // permissions on Codex. Unattended modes are never used as a substitute here.
    return resolveDeclaredAutomaticApprovalMode(targetProvider, availableModes);
  }

  if (parent.provider === targetProvider) {
    return parent.modeId ?? undefined;
  }

  if (
    (input.unattended || isUnattendedCreateConfigParent(parent)) &&
    input.targetUnattendedMode !== undefined
  ) {
    return input.targetUnattendedMode;
  }

  if (availableModes?.length === 0) {
    return undefined;
  }

  throw new Error(
    `cannot inherit mode '${formatCreateConfigParentMode(parent)}' from ${formatCreateConfigParentSource(parent)} for new agent (provider '${targetProvider}'). Pass an explicit mode. Available modes for '${targetProvider}': ${listModes(availableModes)}`,
  );
}

export function resolveDefaultAgentCreateConfig(
  input: ResolveAgentCreateConfigInput,
): ResolveAgentCreateConfigResult {
  const availableModeIds = input.availableModes?.map((mode) => mode.id);
  return {
    modeId: resolveAndValidateCreateAgentMode({
      requestedMode: input.requestedMode,
      targetProvider: input.provider,
      parent: input.parent,
      unattended: input.unattended,
      availableModes: availableModeIds,
      targetUnattendedMode: input.availableModes?.find(isUnattendedMode)?.id,
    }),
    featureValues: input.featureValues,
  };
}

// Update-7 W3 (R1 P-8): a caller's mode class, for its children. "automatic" runs without routine prompts (Claude's
// classifier `auto`, and the unattended modes); "restricted" is a mode the owner uses to keep a session in check;
// anything not known here is "unknown" and is treated as restricted. Only Claude and Codex are classified.
const RESTRICTED_MODES: Record<string, readonly string[]> = {
  claude: ["default", "plan", "acceptEdits"],
  codex: ["auto-review", "auto", "read-only"],
};
const AUTOMATIC_MODES: Record<string, readonly string[]> = {
  claude: ["auto", "bypassPermissions"],
  codex: ["full-access"],
};
export type ChildModeClass = "automatic" | "restricted" | "unknown";
export function childModeClass(
  provider: string,
  modeId: string | null | undefined,
): ChildModeClass {
  if (!modeId) return "unknown";
  if (AUTOMATIC_MODES[provider]?.includes(modeId)) return "automatic";
  if (RESTRICTED_MODES[provider]?.includes(modeId)) return "restricted";
  return "unknown";
}
const RESTRICTED_EQUIVALENTS: Record<string, readonly string[]> = {
  claude: ["default"],
  codex: ["auto-review", "auto"],
};
// A target provider's restricted equivalent for a restricted caller's cross-provider child. Never an unattended mode.
function restrictedEquivalent(
  provider: string,
  availableModes: string[] | undefined,
): string | undefined {
  const preference = RESTRICTED_EQUIVALENTS[provider] ?? [];
  return preference.find((m) => availableModes === undefined || availableModes.includes(m));
}

/**
 * Update-7 W3 (owner, 01:29Z; e69ed191's gate dry run; R1 P-8): the create config for a provider that persists its own
 * default mode on create (Claude, Codex). The caller's RESTRICTION CLASS is inherited, never its exact permissions:
 * - no caller, or an automatic caller: the mode is left unset and decided downstream -- a host plugin's
 *   agent.create hook (Fulcra's owner default), else the provider's conservative resolveDefaultModeId. So a Codex
 *   full-access lead's Claude worker is neither refused nor handed bypassPermissions;
 * - a restricted (or unknown) caller: the child stays restricted -- the caller's own mode on the same provider, the
 *   target's restricted equivalent across providers.
 * An explicit mode wins (validated), and a create that itself asks for unattended keeps the target's unattended mode;
 * an unattended flag that only reflects the parent does not.
 */
export function resolveOwnDefaultCreateConfig(
  input: ResolveAgentCreateConfigInput,
): ResolveAgentCreateConfigResult {
  if (input.requestedMode !== undefined) return resolveDefaultAgentCreateConfig(input);
  const availableModeIds = input.availableModes?.map((mode) => mode.id);
  const parent = input.parent;
  if (parent && childModeClass(parent.provider, parent.modeId) !== "automatic") {
    const sameProvider = parent.provider === input.provider && parent.modeId;
    const modeId = sameProvider
      ? (parent.modeId ?? undefined)
      : restrictedEquivalent(input.provider, availableModeIds);
    return { modeId, featureValues: input.featureValues };
  }
  const askedUnattended = input.unattended && parent?.isUnattended !== true;
  const modeId = askedUnattended ? input.availableModes?.find(isUnattendedMode)?.id : undefined;
  return { modeId, featureValues: input.featureValues };
}

export function isDefaultAgentCreateConfigUnattended(
  input: AgentCreateConfigUnattendedInput,
): boolean {
  if (input.modeId === null) {
    return false;
  }
  return input.availableModes.some((mode) => mode.id === input.modeId && isUnattendedMode(mode));
}

function isUnattendedMode(mode: AgentMode): boolean {
  return mode.isUnattended === true;
}
