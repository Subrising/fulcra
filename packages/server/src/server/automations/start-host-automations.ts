import { projectOf, type AgentRecordFacts } from "../../utils/insights/agents.js";
import {
  AutomationService,
  setHostAutomations,
  type AutomationDeps,
  type AutomationTemplate,
} from "./automation-service.js";

interface ProjectRecord {
  projectId: string;
  rootPath: string;
  archivedAt?: string | null;
}

export interface HostAutomationsInput {
  paseoHome: string;
  schedules: AutomationDeps["schedules"];
  projects: {
    get(id: string): Promise<ProjectRecord | null>;
    list(): Promise<ProjectRecord[]>;
  };
  workspaces: { list(): Promise<{ workspaceId: string; projectId: string }[]> };
  agents: {
    get(id: string): Promise<(AgentRecordFacts & { labels: Record<string, string> }) | null>;
  };
  subscribe: (
    listener: (event: Parameters<AutomationService["onAgentEvent"]>[0]) => void,
  ) => unknown;
  templates: () => (AutomationTemplate & { id: string })[] | undefined;
  runGh: AutomationDeps["runGh"];
  onError: (error: unknown) => void;
}

/** Starts this host's automations and listens to agent events for session triggers. Never throws. */
export async function startHostAutomations(
  input: HostAutomationsInput,
): Promise<AutomationService | null> {
  const service = new AutomationService({
    paseoHome: input.paseoHome,
    schedules: input.schedules,
    projectRoot: async (projectId) => {
      const project = await input.projects.get(projectId);
      return project && !project.archivedAt ? project.rootPath : null;
    },
    projectOfAgent: async (agentId) => {
      const record = await input.agents.get(agentId);
      if (!record) return null;
      const projects = (await input.projects.list()).filter((p) => !p.archivedAt);
      const workspaces = new Map(
        (await input.workspaces.list()).map((w) => [w.workspaceId, w.projectId] as const),
      );
      return {
        projectId: projectOf(record, projects, workspaces) || null,
        labels: record.labels,
        internal: record.internal === true,
        archived: Boolean(record.archivedAt),
      };
    },
    runGh: input.runGh,
    profile: (id) => input.templates()?.find((p) => p.id === id) ?? null,
  });
  try {
    await service.start();
    input.subscribe((event) => void service.onAgentEvent(event).catch(input.onError));
    setHostAutomations(service);
    return service;
  } catch (error) {
    input.onError(error);
    return null;
  }
}
