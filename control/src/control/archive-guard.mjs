// Lists can contain stale records. Read native archive state before each operation.
export function isArchived(agent) {
  return Boolean(
    agent?.archivedAt ||
    agent?.ArchivedAt ||
    agent?.archived === true ||
    agent?.Archived === true ||
    agent?.status === "archived",
  );
}

export async function activeAgent(rpc, agentId) {
  const agent = (await rpc("native:fetch_agent_request", { agentId }))?.agent;
  return agent && !isArchived(agent) ? agent : null;
}
