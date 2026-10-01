import {
  isSessionRole,
  SESSION_ROLE_LABEL,
  SESSION_ROLES,
  type SessionDefaultsResponse,
  type SessionRole,
  type SessionRoleDefaults,
  type SessionRoleProviderDefaults,
  type SessionRoleSelection,
} from "@getpaseo/protocol/session-roles";
import type { AgentModelDefinition, AgentProvider } from "@getpaseo/protocol/agent-types";
import type { FormInitialValues } from "./resolve-agent-form";

/**
 * The served table, or null when the answer is not one this app understands. Checked by
 * structure rather than trusted: the plugin and the app ship separately, and a shape
 * mismatch must read as "no role defaults here", never as a half-filled form.
 */
export function parseSessionDefaults(value: unknown): SessionDefaultsResponse | null {
  if (!isRecord(value) || !isRecord(value.roles)) return null;
  const roles: SessionDefaultsResponse["roles"] = {};
  for (const role of SESSION_ROLES) {
    const row = value.roles[role];
    if (row === undefined) continue;
    const parsed = parseRoleRow(row);
    if (!parsed) return null;
    roles[role] = parsed;
  }
  const modes = parseModes(value.modes);
  return modes ? { roles, modes } : { roles };
}

/** Update-7 W3: string modes per provider; anything else is dropped rather than failing the whole table. */
function parseModes(value: unknown): Partial<Record<string, string>> | undefined {
  if (!isRecord(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0,
    ),
  );
}

/**
 * R1 W3-1: the draft's role. Until the user picks (roleChosen), a host that serves Implementation gets it, so a new
 * session from the UI starts on the role default like every other create path. An explicit "No role" is kept.
 */
export function selectedDraftRole(
  preferences: { role?: SessionRole; roleChosen?: true },
  choices: SessionRole[],
): SessionRole | null {
  if (preferences.roleChosen) {
    return preferences.role && choices.includes(preferences.role) ? preferences.role : null;
  }
  return choices.includes("implementation") ? "implementation" : null;
}

/** Roles the host has defaults for, in the fixed order the picker shows them. */
export function availableRoles(table: SessionDefaultsResponse | null): SessionRole[] {
  if (!table) return [];
  return SESSION_ROLES.filter((role) => table.roles[role] !== undefined);
}

/**
 * The form values a role contributes: its provider when it names one, and the model / effort
 * a creation would launch with here. A model equal to the provider's own name means "the
 * provider's default" (the role's model was not offered), so it is left for the host to pick.
 * Nothing for no role, or for a role with no entry for the provider in use.
 */
export function roleInitialValues(input: {
  role: SessionRole | null;
  table: SessionDefaultsResponse | null;
  provider: AgentProvider | null;
}): FormInitialValues | undefined {
  const { role, table } = input;
  if (!table) return undefined;
  // Update-7 W3: the host's default permission mode for the provider in use, with or without a role.
  const modeFor = (provider: string | null) => {
    const modeId = provider ? table.modes?.[provider] : undefined;
    return modeId ? { modeId } : {};
  };
  const row = role ? table.roles[role] : undefined;
  if (!row) {
    const mode = modeFor(input.provider);
    return Object.keys(mode).length ? mode : undefined;
  }
  const provider = (row.provider ?? input.provider) as AgentProvider | null;
  if (!provider) return undefined;
  const values = selectionFor(row, provider);
  if (!values) return row.provider ? { provider, ...modeFor(provider) } : undefined;
  const model = values.model && values.model !== provider ? values.model : null;
  return {
    ...(row.provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(values.thinkingOptionId ? { thinkingOptionId: values.thinkingOptionId } : {}),
    ...modeFor(provider),
  };
}

/** Explicit values from the setup win; the role fills only what they leave unset. */
export function mergeRoleInitialValues(
  explicit: FormInitialValues | undefined,
  role: FormInitialValues | undefined,
): FormInitialValues | undefined {
  if (!role) return explicit;
  if (!explicit) return role;
  return {
    ...role,
    ...Object.fromEntries(Object.entries(explicit).filter(([, value]) => value != null)),
  };
}

/** Create-request options for a role: `{ labels }`, or nothing at all for no role. */
export function roleLabelOption(
  role: SessionRole | null | undefined,
): { labels: Record<string, string> } | Record<string, never> {
  const labels = roleLabels(role ?? null);
  return labels ? { labels } : {};
}

/** The label a creation carries; none for no role, so an unlabelled creation is unchanged. */
export function roleLabels(role: SessionRole | null): Record<string, string> | undefined {
  return role ? { [SESSION_ROLE_LABEL]: role } : undefined;
}

/**
 * The human names for what a role would launch: the model's catalog label and the effort's
 * label, lower-cased for a sentence ("Opus 5.5", "high"). Null when the role contributes no
 * model (the host's own default applies, and there is nothing true to say about it).
 */
export function describeRoleDefault(input: {
  values: FormInitialValues | undefined;
  models: AgentModelDefinition[] | undefined;
}): { model: string; effort: string | null } | null {
  const model = input.values?.model;
  if (!model) return null;
  const definition = input.models?.find((entry) => entry.id === model);
  const effortId = input.values?.thinkingOptionId ?? null;
  const effort = effortId
    ? (definition?.thinkingOptions?.find((option) => option.id === effortId)?.label ?? effortId)
    : null;
  return { model: definition?.label ?? model, effort: effort ? effort.toLowerCase() : null };
}

export function selectionFor(
  row: SessionRoleDefaults,
  provider: string,
): SessionRoleSelection | null {
  const entry = row.providers[provider];
  if (!entry) return null;
  return entry.status === "unknown" ? entry.configured : (entry.effective ?? entry.configured);
}

function parseRoleRow(value: unknown): SessionRoleDefaults | null {
  if (!isRecord(value) || !isRecord(value.providers)) return null;
  if (value.provider !== null && typeof value.provider !== "string") return null;
  const providers: SessionRoleDefaults["providers"] = {};
  for (const [provider, entry] of Object.entries(value.providers)) {
    const parsed = parseProviderEntry(entry);
    if (!parsed) return null;
    providers[provider] = parsed;
  }
  return { provider: value.provider, providers };
}

function parseProviderEntry(value: unknown): SessionRoleProviderDefaults | null {
  if (!isRecord(value)) return null;
  const status = value.status;
  if (status !== "offered" && status !== "falls-back" && status !== "unknown") return null;
  const configured = parseSelection(value.configured);
  const effective = value.effective === null ? null : parseSelection(value.effective);
  if (!configured || (value.effective !== null && !effective)) return null;
  return { status, configured, effective };
}

function parseSelection(value: unknown): SessionRoleSelection | null {
  if (!isRecord(value)) return null;
  const model = value.model;
  const thinkingOptionId = value.thinkingOptionId;
  if (model !== null && typeof model !== "string") return null;
  if (thinkingOptionId !== null && typeof thinkingOptionId !== "string") return null;
  return { model, thinkingOptionId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export { isSessionRole };
