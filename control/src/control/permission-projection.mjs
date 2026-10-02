// Pure wire projection, extracted unchanged from the legacy guard. V3 must share this with its host hook.
export function permissionProjection(request) {
  const json = (value) => {
    if (value == null) return value;
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map(json).filter((v) => v !== undefined);
    if (typeof value === "object") {
      const result = Object.fromEntries(
        Object.entries(value)
          .map(([k, v]) => [k, json(v)])
          .filter(([, v]) => v !== undefined),
      );
      return Object.keys(result).length ? result : undefined;
    }
    return ["string", "number", "boolean"].includes(typeof value) ? value : undefined;
  };
  const metadata = (value) => {
    const v = json(value);
    return v && typeof v === "object" && !Array.isArray(v) ? v : undefined;
  };
  const suggestions = Array.isArray(request.suggestions)
    ? request.suggestions.map(metadata).filter((v) => v !== undefined)
    : [];
  return {
    ...request,
    input: metadata(request.input),
    metadata: metadata(request.metadata),
    suggestions: suggestions.length ? suggestions : undefined,
    actions: request.actions?.map((a) => ({ ...a })),
  };
}
