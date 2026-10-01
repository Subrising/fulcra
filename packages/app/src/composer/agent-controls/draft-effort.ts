import type { AgentModelDefinition } from "@getpaseo/protocol/agent-types";
import { findModelByReference } from "@/provider-selection/model-catalog";

const EMPTY_OPTIONS: NonNullable<AgentModelDefinition["thinkingOptions"]> = [];

/** Resolve display defaults without turning them into a saved user preference. */
export function resolveDraftEffort(
  models: AgentModelDefinition[],
  modelId: string,
  thinkingId: string,
) {
  const model = modelId.trim()
    ? findModelByReference(models, modelId)
    : (models.find((entry) => entry.isDefault) ?? models[0]);
  const options = model?.thinkingOptions ?? EMPTY_OPTIONS;
  const selectedId =
    thinkingId ||
    model?.defaultThinkingOptionId ||
    options.find((option) => option.isDefault)?.id ||
    options[0]?.id ||
    "";
  return { options, selectedId };
}
