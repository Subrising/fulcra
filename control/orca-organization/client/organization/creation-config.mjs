export function intakeProvider(model) {
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(0, slash) : model;
}
export function selectIntakeMode({ modes, configuredMode, defaultMode }) {
  const supports = (id) => typeof id === "string" && modes.some((mode) => mode.id === id);
  if (supports(configuredMode)) return configuredMode;
  if (supports(defaultMode)) return defaultMode;
  return "";
}
// This reads current catalog facts; it never turns stale rows into execution readiness.
export function validateIntakeCreation({ config, entries }) {
  const slash = config.provider.indexOf("/");
  if (slash <= 0 || !config.provider.slice(slash + 1))
    throw new Error("Choose an offered provider and model before starting this chat.");
  const provider = config.provider.slice(0, slash),
    modelId = config.provider.slice(slash + 1);
  const entry = entries.find((item) => item.provider === provider);
  if (!entry || entry.enabled === false || entry.status !== "ready")
    throw new Error(
      "The selected provider's current catalog is not ready. Retry it before starting this retained request.",
    );
  const model = entry.models?.find(
    (item) =>
      (item.id === modelId || item.aliases?.includes(modelId)) && item.isSelectable !== false,
  );
  if (!model) throw new Error("This model is not offered by the destination's current catalog.");
  if (
    config.thinkingOptionId &&
    !model.thinkingOptions?.some((item) => item.id === config.thinkingOptionId)
  )
    throw new Error("Choose a thinking option supported by the selected model.");
  const modes = entry.modes ?? [];
  if (config.modeId && !modes.some((item) => item.id === config.modeId))
    throw new Error("Choose a permission mode supported by the selected provider.");
  const resolved = { ...config };
  const defaultMode = selectIntakeMode({ modes, defaultMode: entry.defaultModeId });
  if (!resolved.modeId && defaultMode) resolved.modeId = defaultMode;
  return resolved;
}
