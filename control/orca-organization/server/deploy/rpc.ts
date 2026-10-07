// Deploy from Fulcra, server side: the app's RPCs over the engine (engine.mjs decides every rule). The engine is made
// on first use, in the Command Centre's state folder, so a host without one reports "not set up" instead of failing
// to load the plugin.
import path from "node:path";
import { createDeployEngine } from "./engine.mjs";
import { installationPath } from "../installation";
import type { DeploySecrets } from "./engine.mjs";

type Engine = ReturnType<typeof createDeployEngine>;
interface WorkspaceRow {
  id: string;
  projectDisplayName: string;
  projectRootPath: string;
  workspaceDirectory?: string;
  projectKind: string;
  name: string;
  gitRuntime?: { currentBranch?: string | null } | null;
}
interface PaseoLike {
  workspaces: { list(options?: unknown): Promise<{ entries: unknown[] }> };
}
type Run = (
  file: string,
  args: string[],
  options?: { cwd?: string; timeoutMs?: number },
) => Promise<{ code: number; stdout: string }>;

export function createDeployHandlers({
  secrets,
  root = () => path.join(installationPath("controllerHome"), "deploy"),
  run,
}: {
  secrets: DeploySecrets | null;
  root?: () => string;
  run?: Run;
}) {
  let engine: Engine | null = null;
  const get = (): Engine => {
    engine ??= createDeployEngine({ root: root(), secrets });
    return engine;
  };

  async function workspaces(paseo: PaseoLike): Promise<WorkspaceRow[]> {
    const page = await paseo.workspaces.list({ page: { limit: 200 } });
    return (page.entries as WorkspaceRow[]).filter((w) => w && w.projectKind === "git");
  }
  const folder = (w: WorkspaceRow) => w.workspaceDirectory ?? w.projectRootPath;

  async function pullRequests(cwd: string) {
    if (!run) return [];
    try {
      const r = await run(
        "gh",
        ["pr", "list", "--state", "open", "--limit", "20", "--json", "number,title"],
        { cwd, timeoutMs: 15_000 },
      );
      if (r.code !== 0) return [];
      return (JSON.parse(r.stdout) as { number: number; title: string }[]).map((p) => ({
        number: p.number,
        title: p.title.slice(0, 300),
      }));
    } catch {
      return [];
    }
  }

  return {
    async overview() {
      try {
        const view = await get().overview();
        return { available: true, message: null, ...view };
      } catch (error) {
        return {
          available: false,
          message: error instanceof Error ? error.message : String(error),
          environments: [],
          plans: [],
        };
      }
    },
    async sources(paseo: PaseoLike) {
      const rows = await workspaces(paseo);
      const seenRepos = new Map<string, { number: number; title: string }[]>();
      const sources = [];
      for (const w of rows.slice(0, 100)) {
        if (!seenRepos.has(w.projectRootPath))
          seenRepos.set(w.projectRootPath, await pullRequests(w.projectRootPath));
        sources.push({
          id: w.id,
          project: w.projectDisplayName,
          branch: w.gitRuntime?.currentBranch ?? w.name ?? null,
          pullRequests: seenRepos.get(w.projectRootPath) ?? [],
        });
      }
      return { sources };
    },
    connectLocal: (input: { name: string }) => get().connectLocal(input),
    connectCluster: (input: { name: string; kubeconfig: string; context: string }) =>
      get().connectCluster(input),
    disconnect: (input: { environmentId: string }) => get().disconnect(input),
    async plan(
      input: {
        environmentId: string;
        sourceId: string;
        ref: { kind: "branch" | "commit" | "pr"; value: string | number };
      },
      paseo: PaseoLike,
    ) {
      // The app names a Fulcra workspace, never a folder: the folder comes from the host's own workspace list.
      const w = (await workspaces(paseo)).find((x) => x.id === input.sourceId);
      if (!w) throw new Error("That project is not open in Fulcra on this host");
      return get().plan({
        environmentId: input.environmentId,
        repo: folder(w),
        project: w.projectDisplayName,
        ref: input.ref,
        preparedBy: { kind: "person" },
      });
    },
    rollbackPlan: (input: { environmentId: string }) => get().prepareRollback(input),
    planView: (input: { planId: string }) => get().planView(input),
    discard: (input: { planId: string }) => get().discard(input),
    confirm: (input: { planId: string; digest: string; typed: string | null }) =>
      get().confirm(input),
    job: (input: { jobId: string }) => get().job(input),
  };
}
