/**
 * The name a person sees for a host: its label, never its server id.
 *
 * A host's stored label falls back to its server id when pairing learned no hostname (see
 * `normalizeHostLabel`), and an id such as `srv_…` means nothing to a reader. Any label that is empty
 * or merely repeats the id reads as "Unnamed host", which is also the cue to rename it in the host's
 * settings.
 */
export const UNNAMED_HOST = "Unnamed host";

export function hostDisplayName(host: { serverId: string; label?: string | null }): string {
  const label = host.label?.trim() ?? "";
  if (label.length === 0 || label === host.serverId.trim()) return UNNAMED_HOST;
  return label;
}
