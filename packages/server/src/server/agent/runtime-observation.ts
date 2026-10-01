/** Shared by wire snapshots and trusted runtime facts; invalid dates never become observations. */
export function validatedTimestamp(value: Date | string | null): string | null {
  if (value === null) return null;
  if (!(value instanceof Date) && typeof value !== "string")
    throw new TypeError("Invalid timestamp");
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("Invalid timestamp");
  return date.toISOString();
}
/** Provider-resolved legacy fast mode has exactly two native tier representations. */
export function resolvedServiceTier(fastMode: boolean): "fast" | null {
  if (typeof fastMode !== "boolean") throw new TypeError("Service tier unavailable");
  return fastMode ? "fast" : null;
}
