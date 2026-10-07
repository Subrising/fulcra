import type {
  OrganizationState,
  WorkspaceUmbrella,
  OrganizationProject,
  ContextReference,
  ProjectReference,
} from "./workspace-organization";
export function projectReferenceKey(ref: ProjectReference): string;
export function sameContext(a: ContextReference | null, b: ContextReference | null): boolean;
export function resolveIntakeDestination(
  workspace: WorkspaceUmbrella,
  text: string,
  recordedProjectKey?: string | null,
):
  | { kind: "resolved"; projectKey: string; basis: string }
  | { kind: "ambiguous" | "needs-prime"; candidates: string[] };
export function resolveExistingContext<T extends ContextReference & { isProjectRoot?: boolean }>(
  project: OrganizationProject,
  contexts: T[],
):
  | { kind: "resolved"; context: T; basis: string }
  | { kind: "unavailable" | "ambiguous"; reason: string; contexts?: T[] };
export function parsePrimeDestination(
  reply: string,
  workspace: WorkspaceUmbrella,
  intakeId?: string | null,
): string | null;

export function resolveIntakeWorkspace(
  state: OrganizationState,
  text: string,
  selectedId?: string | null,
):
  | { kind: "resolved"; workspace: WorkspaceUmbrella; basis: string }
  | { kind: "ambiguous"; candidates: string[] };

export function parsePrimeQuestion(reply: string | null, intakeId: string): string | null;
