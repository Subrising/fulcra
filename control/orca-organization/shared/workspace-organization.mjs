// Organization references are presentation/routing metadata, never controller capabilities.
export const projectReferenceKey = ({ serverId, projectId }) =>
  JSON.stringify([serverId, projectId]);
export function sameContext(a, b) {
  return (
    !!a &&
    !!b &&
    a.serverId === b.serverId &&
    a.workspaceId === b.workspaceId &&
    a.projectId === b.projectId
  );
}
function namesInText(entries, text) {
  const normalized = text
    .normalize("NFKC")
    .toLocaleLowerCase("en-GB")
    .replace(/[-_\s]+/g, " ");
  return entries.filter((entry) => {
    const name = entry.name
      .normalize("NFKC")
      .toLocaleLowerCase("en-GB")
      .replace(/[-_\s]+/g, " ")
      .trim();
    if (!name) return false;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`, "u").test(normalized);
  });
}
export function resolveIntakeDestination(workspace, text, recordedProjectKey = null) {
  const matches = namesInText(workspace.projects, text);
  if (matches.length > 1) return { kind: "ambiguous", candidates: matches.map((p) => p.key) };
  if (matches.length === 1)
    return { kind: "resolved", projectKey: matches[0].key, basis: "named project" };
  const recorded = workspace.projects.find((p) => p.key === recordedProjectKey);
  if (recorded)
    return { kind: "resolved", projectKey: recorded.key, basis: "recorded destination" };
  if (workspace.projects.length === 1)
    return { kind: "resolved", projectKey: workspace.projects[0].key, basis: "only child project" };
  return { kind: "needs-prime", candidates: workspace.projects.map((p) => p.key) };
}
export function resolveExistingContext(project, contexts) {
  const members = contexts.filter((c) =>
    project.placements.some((p) => p.serverId === c.serverId && p.projectId === c.projectId),
  );
  if (project.preferredContext) {
    const saved = members.find((c) => sameContext(c, project.preferredContext));
    return saved
      ? { kind: "resolved", context: saved, basis: "saved context" }
      : {
          kind: "unavailable",
          reason: "The saved execution context is not available. Choose another existing context.",
        };
  }
  const roots = members.filter((c) => c.isProjectRoot);
  if (roots.length === 1)
    return { kind: "resolved", context: roots[0], basis: "existing project context" };
  if (members.length === 1)
    return { kind: "resolved", context: members[0], basis: "only existing context" };
  return {
    kind: members.length ? "ambiguous" : "unavailable",
    contexts: members,
    reason: members.length
      ? "Choose the project's existing execution context once."
      : "No existing execution context is available. Open an existing project context deliberately.",
  };
}
export function parsePrimeDestination(reply, workspace, intakeId = null) {
  const text = reply.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (intakeId && value?.intakeId !== intakeId) return null;
  if (typeof value?.projectKey === "string" && /^p[1-9][0-9]*$/.test(value.projectKey))
    return workspace.projects[Number(value.projectKey.slice(1)) - 1]?.key ?? null;
  if (value?.projectKey && workspace.projects.some((p) => p.key === value.projectKey))
    return value.projectKey;
  return null;
}

export function resolveIntakeWorkspace(state, text, selectedId = null) {
  const explicit = state.workspaces.find((w) => w.id === selectedId);
  if (explicit) return { kind: "resolved", workspace: explicit, basis: "selected workspace" };
  const matches = namesInText(state.workspaces, text);
  if (matches.length > 1) return { kind: "ambiguous", candidates: matches.map((w) => w.id) };
  if (matches.length === 1)
    return { kind: "resolved", workspace: matches[0], basis: "named workspace" };
  const configured = state.workspaces.find((w) => w.id === state.defaultWorkspaceId);
  if (configured)
    return { kind: "resolved", workspace: configured, basis: "configured intake workspace" };
  if (state.workspaces.length === 1)
    return { kind: "resolved", workspace: state.workspaces[0], basis: "only workspace" };
  return { kind: "ambiguous", candidates: state.workspaces.map((w) => w.id) };
}

export function parsePrimeQuestion(reply, intakeId) {
  if (!reply) return null;
  let value;
  try {
    value = JSON.parse(reply.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    return null;
  }
  return value?.intakeId === intakeId && typeof value.question === "string" && value.question.trim()
    ? value.question.trim().slice(0, 2000)
    : null;
}
