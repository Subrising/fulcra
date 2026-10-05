import type { OrganizationProject } from "../../../../control/orca-organization/shared/workspace-organization";
/** A saved company remains the source when unavailable; another host is never substituted. */
export function selectOrganizationSource<T extends { serverId: string }>(
  sources: T[],
  preferred: string | null,
): T | null {
  if (preferred) return sources.find((source) => source.serverId === preferred) ?? null;
  return sources.length === 1 ? sources[0] : null;
}
export function organizationContextEntries<T extends { workspaceKey: string; serverId: string }>(
  project: Pick<OrganizationProject, "placements">,
  props: {
    projects: {
      hosts: { serverId: string; projectId: string }[];
      workspaces: { serverId: string; workspaceKey: string }[];
    }[];
    entries: ReadonlyMap<string, T>;
  },
) {
  const memberships = new Map<string, { serverId: string; projectId: string } | null>();
  for (const nativeProject of props.projects) {
    for (const placement of nativeProject.workspaces) {
      const candidates = nativeProject.hosts.filter((host) => host.serverId === placement.serverId);
      const before = memberships.get(placement.workspaceKey);
      if (
        candidates.length !== 1 ||
        before === null ||
        (before &&
          (before.serverId !== placement.serverId || before.projectId !== candidates[0].projectId))
      )
        memberships.set(placement.workspaceKey, null);
      else
        memberships.set(placement.workspaceKey, {
          serverId: placement.serverId,
          projectId: candidates[0].projectId,
        });
    }
  }
  return [...props.entries.values()].filter((entry) => {
    const identity = memberships.get(entry.workspaceKey);
    return (
      identity &&
      entry.serverId === identity.serverId &&
      project.placements.some(
        (ref) => ref.serverId === identity.serverId && ref.projectId === identity.projectId,
      )
    );
  });
}
export function bindIntakeSource(
  sources: Record<string, string>,
  intakeId: string,
  serverId: string,
): Record<string, string> {
  const before = sources[intakeId];
  if (before && before !== serverId)
    throw new Error(
      "This request already belongs to its original company intake. Start a new request to change companies.",
    );
  if (before) return sources;
  if (Object.keys(sources).length >= 10000)
    throw new Error(
      "Your retained intake index is full. Open an existing intake; its conversation stays unchanged.",
    );
  return { ...sources, [intakeId]: serverId };
}

/** Company navigation is independent of the execution host. A missing saved source is never replaced. */
export function selectCompanyTarget<T extends { plugin: { serverId: string } }>(
  targets: readonly T[],
  companyHost: string | null,
): T | null {
  if (companyHost) return targets.find((target) => target.plugin.serverId === companyHost) ?? null;
  return targets.length === 1 ? targets[0] : null;
}
