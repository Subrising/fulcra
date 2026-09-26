import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import { mergeProviderPreferences, type FormPreferences } from "@/hooks/use-form-preferences";

// The schedule form's writer for providerPreferences.<provider>. It lives here rather than inside the
// sheet so the persist path can be driven directly from the schedule form model in a test, without
// rendering the sheet. The sheet writes the same providerPreferences key the new-session form reads,
// so the two must agree about what counts as a preference.
export function updateSelectionPreferences(input: {
  preferences: FormPreferences;
  provider: AgentProvider;
  model: string;
  mode: string;
  // A mode the form merely resolved is not a mode the user chose. Writing it back ratchets a
  // transient mode into permanent "user intent" in the same providerPreferences key the new-session
  // form reads, which is the defect persistProviderPreferences exists to avoid.
  modeChosenByUser: boolean;
  // And the same for the model: see ProviderPreferences.modelChosenByUser. A schedule that merely
  // resolved a model must not pin it into the key the new-session composer reads.
  modelChosenByUser: boolean;
  // And the effort, for the same reason and keyed by the same model id.
  thinkingChosenByUser: boolean;
  thinkingOptionId: string;
  isolation: "local" | "worktree";
}): FormPreferences {
  const model = input.model.trim();
  const mode = input.mode.trim();
  const thinkingOptionId = input.thinkingOptionId.trim();
  return {
    ...mergeProviderPreferences({
      preferences: input.preferences,
      provider: input.provider,
      updates: {
        // Omitted entirely, not set to undefined, so an earlier explicit choice is left intact.
        ...(input.modelChosenByUser && model ? { model, modelChosenByUser: true as const } : {}),
        ...(input.modeChosenByUser && mode ? { mode, modeChosenByUser: true as const } : {}),
        ...(input.thinkingChosenByUser && model && thinkingOptionId
          ? {
              thinkingByModel: { [model]: thinkingOptionId },
              thinkingChosenByModel: { [model]: true as const },
            }
          : {}),
      },
    }),
    isolation: input.isolation,
  };
}
