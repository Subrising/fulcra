import type { AgentFeature, AgentFeatureToggle } from "../../agent-sdk-types.js";
import { claudeManifestModelSupportsFastMode } from "./model-manifest.js";
import { claudeRuntimeFastModeSupport } from "./model-discovery.js";

export const CLAUDE_FAST_MODE_FEATURE: Omit<AgentFeatureToggle, "value"> = {
  type: "toggle",
  id: "fast_mode",
  label: "Fast",
  description: "Lower latency Opus responses at higher token cost",
  tooltip: "Toggle fast mode",
  icon: "zap",
};

export function claudeModelSupportsFastMode(modelId: string | null | undefined): boolean {
  // What Claude Code reported wins; the manifest answers for models the last probe did not list.
  return claudeRuntimeFastModeSupport(modelId) ?? claudeManifestModelSupportsFastMode(modelId);
}

export function buildClaudeFeatures(input: {
  modelId: string | null | undefined;
  fastModeEnabled: boolean;
}): AgentFeature[] {
  if (!claudeModelSupportsFastMode(input.modelId)) {
    return [];
  }

  return [
    {
      ...CLAUDE_FAST_MODE_FEATURE,
      value: input.fastModeEnabled,
    },
  ];
}
