/** Folder identities are useful for routing, never as generated display names. */
export function isGeneratedSessionName(value: string): boolean {
  return /(?:^|[\\/])[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}[\\/]*$/i.test(value.trim());
}

export function sessionDisplayName(
  name: string,
  title?: string | null,
  conversationTitle?: string | null,
): string {
  if (title != null) return title;
  if (!isGeneratedSessionName(name)) return name;
  return conversationTitle && !isGeneratedSessionName(conversationTitle)
    ? conversationTitle
    : "Untitled session";
}
