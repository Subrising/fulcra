/** A validated association remains managed even when its display name is unavailable. */
export function managerDisplayName(title: string | null | undefined): string {
  const name = title?.trim();
  return name && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(name)
    ? name
    : "Current manager (name unavailable)";
}
