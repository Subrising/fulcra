import type { DeployJob, DeployPlan, DeployEnvironment } from "../../shared/cc/deploy";
import type { runTool } from "./run.mjs";
export interface DeploySecrets {
  read(name: string): Promise<string | null>;
  save?(name: string, value: string): Promise<void>;
  remove?(name: string): Promise<void>;
}
type Ref = { kind: "branch" | "commit" | "pr"; value: string | number };
type PreparedBy = { kind: "person" } | { kind: "session"; sessionId: string; label: string };
export function packKubeconfig(text: string): string;
export function unpackKubeconfig(value: string): string;
export function kubeconfigContexts(text: string): { names: string[]; current: string | null };
export function reach(environment: unknown, template: unknown, reported: string | null): { endpoint: string | null; note: string | null };
export function endpointFor(
  environment: unknown,
  template: unknown,
  reported: string | null,
): string | null;
export function slug(name: string): string;
export function createDeployEngine(options: {
  root: string;
  secrets?: DeploySecrets | null;
  run?: typeof runTool;
  fetcher?: typeof fetch;
  now?: () => string;
  tools?: unknown;
}): {
  idle(): Promise<void>;
  overview(): Promise<{ environments: DeployEnvironment[]; plans: DeployPlan[] }>;
  connectLocal(input: { name: string }): Promise<{ environmentId: string; jobId: string }>;
  connectCluster(input: {
    name: string;
    kubeconfig: string;
    context: string;
  }): Promise<{ environmentId: string; jobId: string }>;
  disconnect(input: {
    environmentId: string;
  }): Promise<{ removed: boolean; leftRunning: string | null }>;
  plan(input: {
    environmentId: string;
    repo: string;
    project: string;
    ref: Ref;
    preparedBy: PreparedBy;
  }): Promise<DeployPlan>;
  prepareRollback(input: { environmentId: string }): Promise<DeployPlan>;
  planView(input: { planId: string }): Promise<DeployPlan>;
  discard(input: { planId: string }): Promise<{ discarded: boolean }>;
  confirm(input: {
    planId: string;
    digest: string;
    typed?: string | null;
  }): Promise<{ jobId: string; deploymentId: string }>;
  job(input: { jobId: string }): Promise<DeployJob>;
};
