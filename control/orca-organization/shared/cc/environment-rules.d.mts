export declare const KEY: RegExp;
export declare const SHA256: RegExp;
export declare const UUID: RegExp;
export declare const LIMITS: Readonly<
  Record<
    | "label"
    | "targetLabel"
    | "site"
    | "hostId"
    | "requirements"
    | "requirementLabel"
    | "args"
    | "arg"
    | "checkTimeout"
    | "stepTimeout"
    | "detail"
    | "impact"
    | "readiness"
    | "rollbackPlan"
    | "log"
    | "logLine"
    | "deploymentNote"
    | "tag",
    number
  >
>;
export declare const ENVIRONMENT_STATES: readonly ["active", "retired"];
export declare const PROMOTION_STATES: readonly [
  "proposed",
  "awaiting-approval",
  "approved",
  "running",
  "verifying",
  "succeeded",
  "failed",
  "rolling-back",
  "rolled-back",
  "cancelled",
];
export declare const DEPLOYMENT_STATUS: readonly ["succeeded", "failed", "rolled-back", "unknown"];
export declare const STEP_NAMES: readonly ["deploy", "verify", "rollback"];
export declare const FINISHED: readonly string[];
export declare const DEFINITION_KEYS: readonly string[];
export declare class EnvironmentRefused extends Error {}
export declare function relpath(value: unknown, where?: string): string;
export declare function step(
  value: unknown,
  where: string,
): { script: string; args: string[]; timeoutS: number; destructive: boolean };
export declare function repoKey(value: unknown): string;
export declare function validateDefinition(definition: unknown): Record<string, unknown>;
export declare function sameDefinition(before: unknown, after: unknown): boolean;
export declare function definitionChanges(before: unknown, after: unknown): string[];
export declare function definitionBound(
  id: string,
  projectId: string,
  definition: unknown,
): Record<string, unknown>;
export declare function promotionBound(
  promotion: { from: string; to: string; commit: string; readiness: unknown[] },
  toSteps: unknown,
): Record<string, unknown>;
export declare function destructiveSteps(steps: Record<string, { destructive: boolean }>): string[];
export declare function commitRef(value: unknown, repo: string): { ref: string; sha: string };
