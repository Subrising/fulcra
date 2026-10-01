import { isGeneratedSessionName } from "./session-display-name";

export function projectDisplayNameFromProjectId(projectId: string): string {
  const githubRemotePrefix = "remote:github.com/";
  if (projectId.startsWith(githubRemotePrefix)) {
    return projectId.slice(githubRemotePrefix.length) || projectId;
  }

  const segments = projectId.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] || projectId;
}

export function projectIconPlaceholderLabelFromDisplayName(displayName: string): string {
  const trimmedDisplayName = displayName.trim();
  if (!trimmedDisplayName) {
    return "";
  }

  const segments = trimmedDisplayName.split("/").filter(Boolean);
  return segments[segments.length - 1] || trimmedDisplayName;
}

/** Display-only fallback: custom names do not make generated identities human-readable. */
export function projectDisplayName(name: string, customName?: string | null): string {
  return (
    [customName, name].find((value) => value?.trim() && !isGeneratedSessionName(value))?.trim() ??
    "Untitled project"
  );
}
