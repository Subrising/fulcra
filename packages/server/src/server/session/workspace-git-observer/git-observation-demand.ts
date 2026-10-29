import { resolve } from "node:path";

/** How many recently opened checkouts one client session keeps live. */
export const OPEN_CHECKOUT_CWD_LIMIT = 16;

export interface GitObservationAgent {
  id: string;
  cwd: string;
  workspaceId?: string | null;
  archivedAt?: string | null;
  lifecycle: string;
}

export interface GitObservationWorkspace {
  id: string;
  workspaceDirectory: string;
}

function normalizeCwd(cwd: string): string {
  const resolved = resolve(cwd);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isLiveAgent(agent: GitObservationAgent): boolean {
  return !agent.archivedAt && agent.lifecycle !== "closed";
}

/**
 * FU-590: decides which workspaces a session keeps under git observation (watcher,
 * background fetch, degraded poll). Only a workspace with a live agent or other live work,
 * or a checkout that this client opened, stays observed. Every other workspace gets its git status
 * on demand, when a client asks for it.
 */
export class GitObservationDemand {
  private readonly openCwds = new Map<string, true>();
  private liveAgents: Map<string, { workspaceId: string | null; cwd: string }> | null = null;

  constructor(
    private readonly listAgents: () => GitObservationAgent[],
    /** Other live work in a workspace, for example a running service script. */
    private readonly hasOtherLiveWork: (workspaceId: string) => boolean = () => false,
  ) {}

  /** Records a checkout a client opened. Returns true when the demand changed. */
  noteOpenedCwd(cwd: string): boolean {
    const key = normalizeCwd(cwd);
    const known = this.openCwds.delete(key);
    this.openCwds.set(key, true);
    while (this.openCwds.size > OPEN_CHECKOUT_CWD_LIMIT) {
      const oldest = this.openCwds.keys().next().value;
      if (oldest === undefined) break;
      this.openCwds.delete(oldest);
    }
    return !known;
  }

  /** Records an agent state change. Returns true when the set of live workspaces changed. */
  noteAgentState(agent: GitObservationAgent): boolean {
    // A first read already holds this state, so the change cannot be seen. Report it as a change.
    const seeded = this.liveAgents === null;
    const agents = this.ensureLiveAgents();
    const previous = agents.get(agent.id);
    if (!isLiveAgent(agent)) {
      return agents.delete(agent.id) || seeded;
    }
    const next = {
      workspaceId: agent.workspaceId ?? null,
      cwd: normalizeCwd(agent.cwd),
    };
    agents.set(agent.id, next);
    return seeded || previous?.workspaceId !== next.workspaceId || previous?.cwd !== next.cwd;
  }

  isDemanded(workspace: GitObservationWorkspace): boolean {
    const cwd = normalizeCwd(workspace.workspaceDirectory);
    if (this.openCwds.has(cwd) || this.hasOtherLiveWork(workspace.id)) return true;
    for (const agent of this.ensureLiveAgents().values()) {
      if (agent.workspaceId === workspace.id || agent.cwd === cwd) return true;
    }
    return false;
  }

  filter<T extends GitObservationWorkspace>(workspaces: Iterable<T>): T[] {
    return [...workspaces].filter((workspace) => this.isDemanded(workspace));
  }

  private ensureLiveAgents(): Map<string, { workspaceId: string | null; cwd: string }> {
    if (!this.liveAgents) {
      this.liveAgents = new Map(
        this.listAgents()
          .filter(isLiveAgent)
          .map((agent) => [
            agent.id,
            {
              workspaceId: agent.workspaceId ?? null,
              cwd: normalizeCwd(agent.cwd),
            },
          ]),
      );
    }
    return this.liveAgents;
  }
}
