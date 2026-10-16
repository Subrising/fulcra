import type { PaseoApi } from "@getpaseo/client";
import type { ProgressBoard } from "../shared/progress-board";
import { scrubFreeText } from "../shared/privacy-scrub";

// Sessions use the native host API. An older or absent board plugin cannot hide live work.
export async function readProgressHost(
  api: PaseoApi,
  snapshot: () => Promise<ProgressBoard>,
): Promise<ProgressBoard> {
  const [saved, agents, workspaces] = await Promise.all([
    snapshot().catch(() => null),
    api.agents.list({
      filter: { includeArchived: false },
      page: { limit: 100 },
      sort: [{ key: "updated_at", direction: "desc" }],
    }),
    api.workspaces.list({ page: { limit: 100 } }),
  ]);
  while (agents.pageInfo.hasMore && agents.pageInfo.nextCursor) {
    const page = await api.agents.list({
      filter: { includeArchived: false },
      page: { limit: 100, cursor: agents.pageInfo.nextCursor },
      sort: [{ key: "updated_at", direction: "desc" }],
    });
    agents.entries.push(...page.entries);
    agents.pageInfo = page.pageInfo;
  }
  while (workspaces.pageInfo.hasMore && workspaces.pageInfo.nextCursor) {
    const page = await api.workspaces.list({
      page: { limit: 100, cursor: workspaces.pageInfo.nextCursor },
    });
    workspaces.entries.push(...page.entries);
    workspaces.pageInfo = page.pageInfo;
  }
  const board: ProgressBoard = saved ?? {
    observedAt: new Date().toISOString(),
    machine: "This computer",
    warnings: ["Project lists are unavailable. Running sessions are current."],
    projects: [],
  };
  const projects = new Map(
    board.projects.map((project) => [
      project.name,
      { ...project, jobs: [] as ProgressBoard["projects"][number]["jobs"] },
    ]),
  );
  const spaces = new Map(workspaces.entries.map((workspace) => [workspace.id, workspace]));
  await Promise.all(
    agents.entries.map(async ({ agent }) => {
      if (agent.archivedAt || !["running", "initializing"].includes(agent.status)) return;
      const workspace = agent.workspaceId ? spaces.get(agent.workspaceId) : undefined;
      const name =
        agent.labels?.project?.trim() ||
        agent.labels?.["fulcra.project"]?.trim() ||
        workspace?.projectDisplayName ||
        "Other sessions";
      const safe = (text: string) => scrubFreeText(text, null);
      const projectName = safe(name);
      let project = projects.get(projectName);
      if (!project) {
        project = {
          id: projectName,
          name: projectName,
          ledgerState: "No readable project list on this computer.",
          items: [],
          branches: [],
          jobs: [],
        };
        projects.set(projectName, project);
      }
      const previous = saved?.projects.flatMap((p) => p.jobs).find((job) => job.id === agent.id);
      let result = previous?.result ?? null;
      try {
        const page = await api.agents.ref(agent.id).timeline.refetch({ limit: 20 });
        const entries = page.entries.toReversed();
        const line = (text: string) =>
          text
            .trim()
            .split(/\r?\n/)
            .find((part) => part.trim() && !/^[-_*=#]{2,}$/.test(part.trim()));
        const message = entries.find(
          (entry) => entry.item.type === "assistant_message" && line(entry.item.text),
        );
        if (message?.item.type === "assistant_message")
          result = safe(line(message.item.text) ?? "").slice(0, 320);
        else if (entries.some((entry) => entry.item.type === "tool_call"))
          result = "Working on the task";
      } catch {
        /* The session remains visible when its activity is unavailable. */
      }
      project.jobs.push({
        id: agent.id,
        title: safe(agent.title ?? "Untitled session"),
        status: agent.status,
        machine: "This computer",
        createdAt: agent.createdAt,
        updatedAt: agent.updatedAt,
        startedAt: agent.activeTurn?.startedAt ?? null,
        model: agent.model ?? null,
        permissions: agent.pendingPermissions.length,
        result,
      });
    }),
  );
  return {
    ...board,
    observedAt: new Date().toISOString(),
    projects: [...projects.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((project) => ({
        ...project,
        jobs: project.jobs.sort((a, b) => a.title.localeCompare(b.title)),
      })),
  };
}
