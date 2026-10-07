// Deploy from Fulcra: the app's RPCs. The rules live in server/deploy/engine.mjs; these are the shapes on the wire.
// There is one RPC that touches an environment, deploy-confirm, and it needs the fingerprint of the previewed plan.
import { z } from "zod";
import { defineContract } from "../rpc-contract";

const id = z.string().uuid();
const text = (max: number) => z.string().max(max);
const at = z.string();

const step = z.object({
  label: text(200),
  state: z.enum(["waiting", "running", "done", "failed", "skipped"]),
  note: text(800).nullable(),
});
export const deployJob = z.object({
  id,
  kind: z.enum(["connect", "deploy", "rollback"]),
  environmentId: id,
  status: z.enum(["running", "succeeded", "failed"]),
  startedAt: at,
  finishedAt: at.nullable(),
  steps: z.array(step).max(12),
  log: z.array(text(4000)).max(400),
  message: text(800).nullable(),
  result: z.unknown().nullable(),
});
export type DeployJob = z.infer<typeof deployJob>;

const ref = z.object({
  kind: z.enum(["branch", "commit", "pr"]),
  label: text(300),
  commit: z.string().regex(/^[0-9a-f]{40,64}$/),
  url: z.string().url().nullable(),
  number: z.number().int().nullable(),
});
const preparedBy = z.union([
  z.object({ kind: z.literal("person") }),
  z.object({ kind: z.literal("session"), sessionId: text(100), label: text(200) }),
]);
const changeItem = z.object({
  key: text(400),
  type: text(200),
  radiusType: text(200).optional(),
  name: text(200),
  label: text(100),
  kind: z.enum(["add", "update", "remove"]),
  details: z.array(text(400)).max(20),
  destructive: z.boolean(),
  deletesData: z.boolean(),
});
export const deployChange = z.object({
  application: text(200),
  first: z.boolean(),
  summary: text(1000),
  changes: z.array(changeItem).max(500),
  unchanged: z.number().int(),
  destructive: z.boolean(),
  deletesData: z.boolean(),
  risks: z.array(text(400)).max(100),
  notes: z.array(text(600)).max(20),
  map: z.object({
    parts: z
      .array(
        z.object({
          id: text(400),
          name: text(200),
          label: text(100),
          state: z.enum(["new", "changed", "removed", "affected", "same"]),
        }),
      )
      .max(500),
    links: z
      .array(
        z.object({ from: text(400), to: text(400), state: z.enum(["new", "removed", "same"]) }),
      )
      .max(2000),
  }),
});
export type DeployChange = z.infer<typeof deployChange>;

export const deployPlan = z.object({
  id,
  environmentId: id,
  environmentName: text(100),
  source: z.object({ project: text(200), repo: text(1000), bicep: text(300) }),
  ref,
  preparedBy,
  rollbackOf: id.nullable(),
  createdAt: at,
  status: z.enum(["ready", "deploying", "deployed", "failed", "stale", "discarded"]),
  statusNote: text(800).nullable(),
  previousDeploymentId: id.nullable(),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  confirmWord: text(100).nullable(),
  change: deployChange,
});
export type DeployPlan = z.infer<typeof deployPlan>;

const deployment = z.object({
  id,
  planId: id,
  environmentId: id,
  kind: z.enum(["deploy", "rollback"]),
  rollbackOf: id.nullable(),
  ref,
  project: text(200),
  summary: text(1000),
  preparedBy,
  confirmedAt: at,
  startedAt: at,
  finishedAt: at.nullable(),
  status: z.enum(["running", "succeeded", "failed"]),
  message: text(800).nullable(),
  endpoint: text(500).nullable(),
  endpointNote: text(500).nullable().optional(),
  jobId: id.nullable(),
});
export type Deployment = z.infer<typeof deployment>;

export const deployEnvironment = z.object({
  id,
  name: text(100),
  kind: z.enum(["local", "cluster"]),
  state: z.enum(["connecting", "ready", "failed"]),
  problem: text(800).nullable(),
  where: text(300),
  runningJobId: id.nullable(),
  current: deployment.nullable(),
  canRollBack: z.boolean(),
  history: z.array(deployment).max(20),
});
export type DeployEnvironment = z.infer<typeof deployEnvironment>;

export const deployOverviewRpc = defineContract({
  name: "organization.deploy-overview",
  input: z.object({}).strict(),
  output: z.object({
    available: z.boolean(),
    message: text(800).nullable(),
    environments: z.array(deployEnvironment).max(50),
    plans: z.array(deployPlan).max(50),
  }),
});

export const deploySourcesRpc = defineContract({
  name: "organization.deploy-sources",
  input: z.object({}).strict(),
  output: z.object({
    sources: z
      .array(
        z.object({
          id: text(200),
          project: text(200),
          branch: text(300).nullable(),
          pullRequests: z.array(z.object({ number: z.number().int(), title: text(300) })).max(30),
        }),
      )
      .max(100),
  }),
});

const started = z.object({ environmentId: id, jobId: id });
export const deployConnectLocalRpc = defineContract({
  name: "organization.deploy-connect-local",
  input: z.object({ name: z.string().min(1).max(30) }).strict(),
  output: started,
});
export const deployConnectClusterRpc = defineContract({
  name: "organization.deploy-connect-cluster",
  input: z
    .object({
      name: z.string().min(1).max(30),
      kubeconfig: z.string().min(20).max(60_000),
      context: z.string().min(1).max(200),
    })
    .strict(),
  output: started,
});
export const deployDisconnectRpc = defineContract({
  name: "organization.deploy-disconnect",
  input: z.object({ environmentId: id }).strict(),
  output: z.object({ removed: z.boolean(), leftRunning: text(100).nullable() }),
});
export const deployPlanRpc = defineContract({
  name: "organization.deploy-plan",
  input: z
    .object({
      environmentId: id,
      sourceId: z.string().min(1).max(200),
      ref: z
        .object({
          kind: z.enum(["branch", "commit", "pr"]),
          value: z.union([z.string().min(1).max(200), z.number().int()]),
        })
        .strict(),
    })
    .strict(),
  output: deployPlan,
});
export const deployRollbackPlanRpc = defineContract({
  name: "organization.deploy-rollback-plan",
  input: z.object({ environmentId: id }).strict(),
  output: deployPlan,
});
export const deployPlanViewRpc = defineContract({
  name: "organization.deploy-plan-view",
  input: z.object({ planId: id }).strict(),
  output: deployPlan,
});
export const deployDiscardRpc = defineContract({
  name: "organization.deploy-discard",
  input: z.object({ planId: id }).strict(),
  output: z.object({ discarded: z.boolean() }),
});
export const deployConfirmRpc = defineContract({
  name: "organization.deploy-confirm",
  input: z
    .object({
      planId: id,
      digest: z.string().regex(/^[0-9a-f]{64}$/),
      typed: z.string().max(100).nullable(),
    })
    .strict(),
  output: z.object({ jobId: id, deploymentId: id }),
});
export const deployJobRpc = defineContract({
  name: "organization.deploy-job",
  input: z.object({ jobId: id }).strict(),
  output: deployJob,
});
