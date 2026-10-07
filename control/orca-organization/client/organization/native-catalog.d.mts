import type { PaseoApi } from "@getpaseo/client";
export function readOrganizationNativeCatalog(
  api: PaseoApi,
  serverId: string,
  maxPages?: number,
): Promise<{
  projects: { serverId: string; projectId: string; name: string }[];
  contexts: {
    serverId: string;
    projectId: string;
    workspaceId: string;
    name: string;
    directory: string;
    status: string;
    isProjectRoot: boolean;
  }[];
  sessions: {
    serverId: string;
    agentId: string;
    workspaceId: string | null | undefined;
    parentAgentId: string | null;
    title: string;
    status: string;
  }[];
  partial: boolean;
}>;
