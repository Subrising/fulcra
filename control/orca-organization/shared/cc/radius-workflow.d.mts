export interface RadiusResource {
  id: string;
  image: string;
  port: number;
}
export interface RadiusRequirement {
  id: string;
  resourceId: string;
  port: number;
}
export interface RadiusDraft {
  application: string;
  requirements: RadiusRequirement[];
  current: RadiusResource[];
  proposed: RadiusResource[];
}
export interface RadiusChange {
  id: string;
  kind: "add" | "update" | "remove";
  before: RadiusResource | null;
  after: RadiusResource | null;
}
export interface RadiusPlan {
  target: "0.61.x";
  definition: RadiusDraft;
  revision: string;
  changes: RadiusChange[];
}
export interface RadiusValidation {
  kind: "valid" | "blocked";
  requirements: { id: string; state: "pass" | "fail" }[];
  basis: "local-structural-validation";
  nativeCompilation: "not_run";
  environmentDeployment: "held";
}
export const RADIUS_TARGET: "0.61.x";
export function planRadiusChange(input: unknown): RadiusPlan;
export function validateRadiusPlan(plan: RadiusPlan, expectedRevision: string): RadiusValidation;
export function radiusScratchFiles(
  plan: RadiusPlan,
  expectedRevision: string,
): Record<
  "app.bicep" | "requirements.json" | "infra-change.json" | "deployment-simulation.json",
  string
>;
