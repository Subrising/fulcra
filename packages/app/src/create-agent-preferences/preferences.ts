import { z } from "zod";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";

const featureValuesSchema = z.record(z.string(), z.union([z.boolean(), z.string(), z.null()]));

export interface ProviderPreferences {
  model?: string;
  /**
   * Whether `model` is a model the user picked, as opposed to one a form merely
   * resolved and wrote back. Only a chosen model outranks the model the host
   * advertises as its default.
   *
   * COMPAT(modelChosenByUser): added in v0.9.2, remove after 2027-03-23 — delete
   * the field and treat every saved `model` as chosen.
   *
   * This IS the migration for profiles written before the distinction existed,
   * and it is deliberate rather than incidental. Those profiles carry a `model`
   * with no marker, because every submit used to write the resolved model back
   * as if it had been chosen: one session that came up on an older model pinned
   * that model into the profile, after which it outranked the host's default on
   * every future session and the host could never move the fleet forward. An
   * unmarked model is therefore not treated as intent, so such a profile follows
   * the host again. The cost is stated rather than hidden: a user who really did
   * choose that model loses the choice once and re-picks it, which marks it.
   */
  modelChosenByUser?: true;
  mode?: string;
  /**
   * The same question for the mode, and the same answer. Only a mode the user
   * picked outranks the provider's own `defaultModeId`.
   *
   * COMPAT(modeChosenByUser): added in v0.9.2, remove after 2027-03-23 — delete
   * the field and treat every saved `mode` as chosen.
   *
   * The mode had a guard on the WRITE side before the model did, so a resolved
   * mode has not been written as intent for some time. What it never had is a
   * mark on the values already stored: a profile written before that guard holds
   * `mode: "default"` — Always Ask — and nothing can tell it apart from someone
   * deliberately choosing to be asked. It therefore outranked the adapter's own
   * `auto` default on every new chat, forever, which is one third of the symptom
   * this whole change exists to remove. An unmarked mode is not treated as
   * intent, with the same one-time cost as the model.
   */
  modeChosenByUser?: true;
  thinkingByModel?: Record<string, string>;
  /**
   * Which entries of `thinkingByModel` the user actually picked, keyed by the
   * same model id. An effort that a form resolved — from the model's own
   * default, or from a previously stored value — is not a preference.
   *
   * COMPAT(thinkingChosenByModel): added in v0.9.2, remove after 2027-03-23 —
   * delete the field and treat every `thinkingByModel` entry as chosen.
   *
   * Separate from `thinkingByModel` rather than changing its value shape,
   * because that map is read by name in several places and widening a string to
   * an object would be a far larger change than the question deserves. A missing
   * key means "not chosen", which is exactly the state every profile written
   * before this field is in.
   */
  thinkingChosenByModel?: Record<string, true>;
  featureValues?: Record<string, unknown>;
}

export type LaunchTarget = { kind: "chat" } | { kind: "terminal"; profileId: string };

export interface FormPreferences {
  provider?: string;
  providerPreferences?: Record<string, ProviderPreferences>;
  favoriteModels?: Array<{ provider: string; modelId: string }>;
  isolation?: "local" | "worktree";
  launchTarget?: LaunchTarget;
}

const providerPreferencesSchema: z.ZodType<ProviderPreferences> = z.strictObject({
  model: z.string().optional(),
  modelChosenByUser: z.literal(true).optional(),
  mode: z.string().optional(),
  modeChosenByUser: z.literal(true).optional(),
  thinkingByModel: z.record(z.string(), z.string()).optional(),
  thinkingChosenByModel: z.record(z.string(), z.literal(true)).optional(),
  featureValues: featureValuesSchema.optional(),
});

const launchTargetSchema: z.ZodType<LaunchTarget> = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("chat") }),
  z.strictObject({ kind: z.literal("terminal"), profileId: z.string() }),
]);

export const FormPreferencesSchema = z.strictObject({
  provider: z.string().optional(),
  providerPreferences: z.record(z.string(), providerPreferencesSchema).optional(),
  // COMPAT(agentProfileFavoriteMigration): favourites were removed in v0.3.2.
  // Keep the legacy payload alive until every capable host has had a chance to
  // import it; ordinary preference writes must not erase it first.
  favoriteModels: z
    .array(
      z.strictObject({
        provider: z.string(),
        modelId: z.string(),
      }),
    )
    .optional(),
  isolation: z.enum(["local", "worktree"]).optional(),
  // What the New workspace composer submits to: the chat agent (default) or a
  // terminal profile. See `@/new-workspace-launch` for resolution/fallback.
  launchTarget: launchTargetSchema.optional(),
}) satisfies z.ZodType<FormPreferences>;

const LegacyProviderPreferencesSchema = z.strictObject({
  model: z.string().optional(),
  mode: z.string().optional(),
  thinkingOptionId: z.string().optional(),
});

const LegacyFormPreferencesSchema = z
  .strictObject({
    workingDir: z.string().optional(),
    provider: z.string().optional(),
    serverId: z.string().optional(),
    providerPreferences: z.record(z.string(), LegacyProviderPreferencesSchema).optional(),
  })
  .transform(({ provider, providerPreferences }): FormPreferences => {
    const migratedProviderPreferences: Record<string, ProviderPreferences> = {};
    for (const [providerId, legacy] of Object.entries(providerPreferences ?? {})) {
      const model = legacy.model;
      migratedProviderPreferences[providerId] = {
        ...(model !== undefined ? { model } : {}),
        ...(legacy.mode !== undefined ? { mode: legacy.mode } : {}),
        ...(model !== undefined && legacy.thinkingOptionId !== undefined
          ? { thinkingByModel: { [model]: legacy.thinkingOptionId } }
          : {}),
      };
    }
    return {
      ...(provider !== undefined ? { provider } : {}),
      ...(providerPreferences !== undefined
        ? { providerPreferences: migratedProviderPreferences }
        : {}),
    };
  });

export const StoredFormPreferencesSchema: z.ZodType<FormPreferences> = z.union([
  FormPreferencesSchema,
  LegacyFormPreferencesSchema,
]);

export const DEFAULT_FORM_PREFERENCES: FormPreferences = {};

export function parseFormPreferences(value: unknown): FormPreferences {
  const result = StoredFormPreferencesSchema.safeParse(value);
  return result.success ? result.data : DEFAULT_FORM_PREFERENCES;
}

function mergeDefinedRecord<T>(
  existing: Record<string, T> | undefined,
  updates: Record<string, T> | undefined,
): Record<string, T> | undefined {
  if (updates === undefined) {
    return existing;
  }
  return {
    ...existing,
    ...updates,
  };
}

function applyProviderPreferenceUpdates(
  existing: ProviderPreferences,
  updates: Omit<Partial<ProviderPreferences>, "mode"> & { mode?: string | null },
): ProviderPreferences {
  const next: ProviderPreferences = { ...existing };
  const nextThinkingByModel = mergeDefinedRecord(existing.thinkingByModel, updates.thinkingByModel);
  const nextFeatureValues = mergeDefinedRecord(existing.featureValues, updates.featureValues);

  if (updates.model !== undefined) {
    next.model = updates.model;
  }
  // A write that does not say the model was chosen CLEARS the marker rather than leaving it, because the
  // marker describes the value now stored. Leaving it would let a resolved model inherit an earlier pick's
  // authority -- the same ratchet, one step removed.
  if (updates.model !== undefined || updates.modelChosenByUser !== undefined) {
    if (updates.modelChosenByUser === true) next.modelChosenByUser = true;
    else delete next.modelChosenByUser;
  }
  if (updates.mode === null) {
    delete next.mode;
    delete next.modeChosenByUser;
  } else if (updates.mode !== undefined) {
    next.mode = updates.mode;
  }
  // Same rule as the model: the marker describes the value now stored, so a write that supplies a mode
  // without claiming a choice clears it. An erasing write (mode: null) drops both above.
  if (updates.mode !== undefined && updates.mode !== null) {
    if (updates.modeChosenByUser === true) next.modeChosenByUser = true;
    else delete next.modeChosenByUser;
  } else if (updates.modeChosenByUser === true) {
    next.modeChosenByUser = true;
  }
  if (nextThinkingByModel !== undefined) {
    next.thinkingByModel = nextThinkingByModel;
  }
  // Per model id, because that is how the efforts themselves are stored: marking one model's effort as
  // chosen says nothing about another's. An entry written without a claim clears just that key, so
  // resolving an effort for one model cannot quietly unmark the effort the user picked for a different one.
  if (updates.thinkingByModel !== undefined || updates.thinkingChosenByModel !== undefined) {
    const chosen = { ...existing.thinkingChosenByModel };
    for (const modelId of Object.keys(updates.thinkingByModel ?? {})) delete chosen[modelId];
    for (const modelId of Object.keys(updates.thinkingChosenByModel ?? {})) chosen[modelId] = true;
    if (Object.keys(chosen).length > 0) next.thinkingChosenByModel = chosen;
    else delete next.thinkingChosenByModel;
  }
  if (nextFeatureValues !== undefined) {
    next.featureValues = nextFeatureValues;
  }

  return next;
}

export function mergeProviderPreferences(args: {
  preferences: FormPreferences;
  provider: AgentProvider;
  updates: Omit<Partial<ProviderPreferences>, "mode"> & { mode?: string | null };
}): FormPreferences {
  const { preferences, provider, updates } = args;
  const existingProviderPreferences = preferences.providerPreferences ?? {};
  const existing = existingProviderPreferences[provider] ?? {};

  return {
    ...preferences,
    provider,
    providerPreferences: {
      ...existingProviderPreferences,
      [provider]: applyProviderPreferenceUpdates(existing, updates),
    },
  };
}

export function mergeCreateAgentSelectionPreferences(args: {
  preferences: FormPreferences;
  provider: AgentProvider | null;
  modelId?: string | null;
  modeId?: string | null;
  thinkingOptionId?: string | null;
  featureValues?: Record<string, unknown>;
}): FormPreferences {
  if (!args.provider) {
    return args.preferences;
  }

  const modelId = args.modelId?.trim() ?? "";
  const modeId = args.modeId?.trim() ?? "";
  const thinkingOptionId = args.thinkingOptionId?.trim() ?? "";
  const featureValues = featureValuesSchema.safeParse(args.featureValues);

  return mergeProviderPreferences({
    preferences: args.preferences,
    provider: args.provider,
    updates: {
      model: modelId || undefined,
      // A submitted selection is a form the user filled in and saved, so every value in it is chosen.
      ...(modelId ? { modelChosenByUser: true as const } : {}),
      mode: args.modeId === undefined ? undefined : modeId || null,
      ...(modeId ? { modeChosenByUser: true as const } : {}),
      ...(modelId && thinkingOptionId
        ? {
            thinkingByModel: { [modelId]: thinkingOptionId },
            thinkingChosenByModel: { [modelId]: true as const },
          }
        : {}),
      ...(featureValues.success ? { featureValues: featureValues.data } : {}),
    },
  });
}

export function applyAgentProfilePreferences(args: {
  preferences: FormPreferences;
  previousProvider: AgentProvider | null;
  previousProviderModeIds: readonly string[];
  provider: AgentProvider;
  modelId: string;
  modeId: string;
  thinkingOptionId: string;
  featureValues: Record<string, unknown>;
}): FormPreferences {
  let next = args.preferences;
  if (args.previousProvider) {
    const previousMode = next.providerPreferences?.[args.previousProvider]?.mode;
    if (previousMode && !args.previousProviderModeIds.includes(previousMode)) {
      next = mergeProviderPreferences({
        preferences: next,
        provider: args.previousProvider,
        updates: { mode: null },
      });
    }
  }

  return mergeProviderPreferences({
    preferences: next,
    provider: args.provider,
    updates: {
      model: args.modelId || undefined,
      // Applying a profile is an explicit act and the profile names these values, so they are chosen.
      ...(args.modelId ? { modelChosenByUser: true as const } : {}),
      mode: args.modeId || null,
      ...(args.modeId ? { modeChosenByUser: true as const } : {}),
      ...(args.modelId && args.thinkingOptionId
        ? {
            thinkingByModel: { [args.modelId]: args.thinkingOptionId },
            thinkingChosenByModel: { [args.modelId]: true as const },
          }
        : {}),
      featureValues: args.featureValues,
    },
  });
}
