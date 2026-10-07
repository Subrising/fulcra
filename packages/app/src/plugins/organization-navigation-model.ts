import { randomId } from "../../../../control/orca-organization/client/random-id";
import type { OrganizationNavigation } from "../../../../control/orca-organization/shared/intake-draft";
type ProjectSettingsPath = `/settings/hosts/${string}/projects/${string}`;
type IntakeNavigationPath = "/open-project" | `/intake?${string}` | ProjectSettingsPath;
interface IntakeNavigationPorts {
  push(path: IntakeNavigationPath): void;
  newId(): string;
  chooseCompany(serverId: string): void;
  projectRoute(serverId: string, projectId: string): ProjectSettingsPath;
  connection(serverId: string): { online: boolean; workspaceMultiplicity: boolean };
}
export function createIntakeNavigation(
  controllerId: string,
  ports: IntakeNavigationPorts,
): OrganizationNavigation {
  const openIntake = (intakeId: string, workspaceId?: string) =>
    ports.push(
      `/intake?thread=${encodeURIComponent(intakeId)}&controller=${encodeURIComponent(controllerId)}${workspaceId ? `&workspace=${encodeURIComponent(workspaceId)}` : ""}`,
    );
  return {
    openIntake,
    setDefaultCompanySource: () => ports.chooseCompany(controllerId),
    newIntake: (workspaceId) => openIntake(ports.newId(), workspaceId),
    openProject: (serverId, projectId) => ports.push(ports.projectRoute(serverId, projectId)),
    createProject: () => ports.push("/open-project"),
    canReuseContext: (serverId) => {
      const connection = ports.connection(serverId);
      return connection.online && connection.workspaceMultiplicity;
    },
  };
}

export const newIntakeId = randomId;
export function globalIntakeRoute(): `/intake?thread=${string}` {
  return `/intake?thread=${newIntakeId()}`;
}
