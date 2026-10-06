export interface IntakeDraft {
  id: string;
  text: string;
  workspaceId?: string;
  setText(text: string): void;
  bindSource?(): void;
}
export interface OrganizationNavigation {
  openIntake(intakeId: string, workspaceId?: string): void;
  newIntake(workspaceId?: string): void;
  openProject(serverId: string, projectId: string): void;
  createProject(): void;
  setDefaultCompanySource(): void;
  canReuseContext(serverId: string): boolean;
}
