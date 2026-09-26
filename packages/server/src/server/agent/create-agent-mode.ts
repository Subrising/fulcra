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
