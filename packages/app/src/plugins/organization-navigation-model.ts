import { randomId } from "../../../../control/orca-organization/client/random-id";
import type { OrganizationNavigation } from "../../../../control/orca-organization/shared/intake-draft";
interface IntakeNavigationPorts {
  push(path: string): void;
  newId(): string;
  chooseCompany(serverId: string): void;
  projectRoute(serverId: string, projectId: string): string;
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
export function globalIntakeRoute(): string {
  return `/intake?thread=${newIntakeId()}`;
}
