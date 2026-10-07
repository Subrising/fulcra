import type { OrganizationState, OrganizationCommand } from "../../shared/workspace-organization";
export class OrganizationStore {
  constructor(file: string, options?: { now?: () => string; id?: () => string });
  read(): OrganizationState;
  mutate(input: {
    requestId: string;
    expectedRevision: number;
    command: OrganizationCommand;
  }): OrganizationState;
  close(): void;
}
