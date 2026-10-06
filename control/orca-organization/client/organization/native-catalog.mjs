// Bounded native directory reads, not provider/timeline restores or model turns.
export async function readOrganizationNativeCatalog(api, serverId, maxPages = 4) {
  const projects = await api.projects.list();
  const contexts = [],
    sessions = [];
  let partial = false;
  async function pages(read, append) {
    let cursor;
    for (let page = 0; page < maxPages; page++) {
      const result = await read({ page: { limit: 128, ...(cursor ? { cursor } : {}) } });
      append(result.entries);
      if (!result.pageInfo.hasMore) return;
      if (!result.pageInfo.nextCursor || result.pageInfo.nextCursor === cursor) {
        partial = true;
        return;
      }
      cursor = result.pageInfo.nextCursor;
    }
    partial = true;
  }
  await Promise.all([
    pages(
      (query) => api.workspaces.list(query),
      (entries) =>
        contexts.push(
          ...entries.map((context) => ({
            serverId,
            projectId: context.projectId,
            workspaceId: context.id,
            name: context.name,
            directory: context.workspaceDirectory,
            status: context.status,
            isProjectRoot: context.workspaceDirectory === context.projectRootPath,
          })),
        ),
    ),
    pages(
      (query) => api.agents.list({ ...query, filter: { includeArchived: false } }),
      (entries) =>
        sessions.push(
          ...entries.map(({ agent }) => ({
            serverId,
            agentId: agent.id,
            workspaceId: agent.workspaceId,
            parentAgentId: agent.parentAgentId ?? null,
            title: agent.title ?? "Saved conversation",
            status: agent.status,
          })),
        ),
    ),
  ]);
  return {
    projects: projects.projects.map((project) => ({
      serverId,
      projectId: project.projectId,
      name: project.projectCustomName ?? project.projectDisplayName,
    })),
    contexts,
    sessions,
    partial,
  };
}
