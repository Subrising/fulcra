import type { Command } from "commander";
import type { CommandOptions, ListResult } from "../../output/index.js";
import { buildDaemonConnectionCommandError, connectToDaemon } from "../../utils/client.js";
import { projectSchema, toProjectRow, type ProjectRow } from "./shared.js";
import { groupSessionProjects } from "./group.js";

export async function runLsCommand(
  options: CommandOptions & { folders?: boolean },
  _command: Command,
): Promise<ListResult<ProjectRow>> {
  const client = await connectToDaemon({ target: options.daemonTarget }).catch((error: unknown) => {
    throw buildDaemonConnectionCommandError({ target: options.daemonTarget, error });
  });

  try {
    const payload = await client.listProjects();
    if (!options.folders) {
      const agents: Awaited<ReturnType<typeof client.fetchAgents>>["entries"] = [];
      const workspaces: Awaited<ReturnType<typeof client.fetchWorkspaces>>["entries"] = [];
      let agentCursor: string | undefined;
      do {
        const page = await client.fetchAgents({
          page: { limit: 200, ...(agentCursor ? { cursor: agentCursor } : {}) },
        });
        agents.push(...page.entries);
        agentCursor = page.pageInfo.nextCursor ?? undefined;
      } while (agentCursor);
      let workspaceCursor: string | undefined;
      do {
        const page = await client.fetchWorkspaces({
          page: { limit: 200, ...(workspaceCursor ? { cursor: workspaceCursor } : {}) },
        });
        workspaces.push(...page.entries);
        workspaceCursor = page.pageInfo.nextCursor ?? undefined;
      } while (workspaceCursor);
      return {
        type: "list",
        data: groupSessionProjects({
          projects: payload.projects,
          workspaces,
          agents: agents.map((entry) => entry.agent),
        }),
        schema: projectSchema,
      };
    }
    return {
      type: "list",
      data: payload.projects.map(toProjectRow),
      schema: projectSchema,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}
