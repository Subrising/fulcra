// CONTRACTS.md §6 (environment, deployment, promotion) for the plugin. The shapes are exactly §6.1; the rules the
// controller enforces (repo-relative scripts, approval for execution changes) live in environment-rules.mjs and
// run again here on writes. RPCs are §6.2's: read, propose, promotion-create and promotion-cancel. There is no RPC
// that runs a promotion: running follows a chosen, proven approval only.
import { z } from "zod";
import { defineContract } from "../rpc-contract";
import { ref } from "./refs";
import { noPersonal, parseRef } from "./refs.mjs";
import { validateDefinition, LIMITS, KEY, SHA256, ENVIRONMENT_STATES, PROMOTION_STATES, DEPLOYMENT_STATUS } from "./environment-rules.mjs";
const id = z.string().uuid();
const at = z.string().datetime({ offset: true });
const key = z.string().regex(KEY);
const words = (max: number) => z.string().max(max).refine(noPersonal, { message: "Contains personal or host-specific data" });
const tuple = <T extends readonly [string, ...string[]]>(values: T) => z.enum(values as unknown as [T[number], ...T[number][]]);
const refOf = (...kinds: string[]) => ref.refine(v => kinds.includes(parseRef(v)?.kind ?? ""), { message: `Must be a ${kinds.join(" or ")} ref` });
const relpath = z.string().min(1).max(255).refine(v => !v.startsWith("/") && !v.split("/").some(p => p === ".." || p === "."), { message: "Must be a path inside the repository" });
const args = z.array(words(LIMITS.arg)).max(LIMITS.args);

export const step = z.object({ script: relpath, args, timeoutS: z.number().int().min(1).max(LIMITS.stepTimeout), destructive: z.boolean() }).strict();
export const check = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("script"), script: relpath, args, timeoutS: z.number().int().min(1).max(LIMITS.checkTimeout) }).strict(),
  z.object({ kind: z.literal("manual") }).strict(),
]);
export const requirementResult = z.object({ state: z.enum(["pass", "fail", "unknown"]), at: at.nullable(), detail: z.string().max(LIMITS.detail) }).strict();
export const target = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fulcra-host"), hostId: z.string().min(1).max(LIMITS.hostId) }).strict(),
  z.object({ kind: z.literal("external"), label: words(LIMITS.targetLabel), site: z.string().max(LIMITS.site).nullable() }).strict(),
]);
const steps = z.object({ deploy: step, verify: step, rollback: step }).strict();
export const environment = z.object({
  version: z.literal(1), id, revision: z.number().int().min(1), projectId: id, key, label: words(LIMITS.label), order: z.number().int().min(0).max(9),
  target, repo: z.string().max(200), requirements: z.array(z.object({ id: key, label: words(LIMITS.requirementLabel), check, last: requirementResult }).strict()).max(LIMITS.requirements),
  steps, state: tuple(ENVIRONMENT_STATES),
  // v1.15 §6.2 #1 (J8-4): the version of the repository whose scripts this environment runs, pinned by its approval.
  definitionCommit: refOf("commit"),
}).strict();
export const deployment = z.object({
  id, environmentId: id, version: z.object({ commit: refOf("commit"), tag: z.string().max(LIMITS.tag).nullable() }).strict(),
  at, by: z.string().max(80), promotionId: id.nullable(), status: tuple(DEPLOYMENT_STATUS), note: z.string().max(LIMITS.deploymentNote),
}).strict();
export const promotion = z.object({
  version: z.literal(1), id, revision: z.number().int().min(1), projectId: id, from: id, to: id, commit: refOf("commit"),
  impact: z.array(refOf("archmap", "pr", "commit")).max(LIMITS.impact),
  readiness: z.array(z.object({ requirementId: key, state: z.enum(["pass", "fail", "unknown"]) }).strict()).max(LIMITS.readiness),
  rollbackPlan: z.string().max(LIMITS.rollbackPlan), decisionId: id.nullable(), state: tuple(PROMOTION_STATES),
  log: z.array(z.object({ at, step: z.enum(["deploy", "verify", "rollback"]), line: z.string().max(LIMITS.logLine) }).strict()).max(LIMITS.log),
  digest: z.string().regex(SHA256),
}).strict();
export type Environment = z.infer<typeof environment>;
export type Deployment = z.infer<typeof deployment>;
export type Promotion = z.infer<typeof promotion>;

// What a proposer sends: the definition without the server's fields, checked by the controller's own rules too.
export const definitionInput = z.object({
  key, label: words(LIMITS.label), order: z.number().int().min(0).max(9), target, repo: z.string().max(200),
  requirements: z.array(z.object({ id: key, label: words(LIMITS.requirementLabel), check }).strict()).max(LIMITS.requirements), steps, state: tuple(ENVIRONMENT_STATES),
}).strict().superRefine((d, ctx) => { try { validateDefinition(d); } catch (e) { ctx.addIssue({ code: "custom", message: e instanceof Error ? e.message : "Invalid environment" }); } });

// Every read carries the observation fields (CONTRACTS §1): a stall returns the last good view, marked stale.
const observation = { version: z.literal(1), observedAt: at, partial: z.boolean(), stale: z.boolean(), error: z.string().max(500).nullable() };
const changes = z.object({ from: refOf("commit").nullable(), files: z.number().int().nonnegative().nullable(), sample: z.array(z.string().max(255)).max(12) }).strict();
export const environmentView = z.object({
  id, key, order: z.number().int().min(0).max(9), environment: environment.nullable(),
  pending: z.object({ definition: z.unknown(), decisionId: id.nullable() }).strict().nullable(),
  current: deployment.nullable(), latest: deployment.nullable(), health: z.enum(["good", "attention", "unknown"]), meaning: z.string().max(120).nullable(),
}).strict();
export const promotionView = z.object({ promotion, preparing: z.boolean(), askedVia: z.enum(["operator", "role"]), changes: changes.nullable() }).strict();
export type EnvironmentView = z.infer<typeof environmentView>;
export type PromotionView = z.infer<typeof promotionView>;

export const environmentsRpc = defineContract({ name: "organization.environments", input: z.object({ projectId: id }).strict(),
  output: z.object({ ...observation, projectId: id, environments: z.array(environmentView).max(10), promotions: z.array(promotionView).max(10) }).strict() });
const writeResult = { ok: z.boolean(), message: z.string().max(500).nullable(), observedAt: at };
export const environmentProposeRpc = defineContract({ name: "organization.environment-propose",
  input: z.object({ messageId: id, projectId: id, environmentId: id.nullable(), expectedRevision: z.number().int().min(0), definition: definitionInput, note: words(500) }).strict(),
  output: z.object({ ...writeResult, environmentId: id.nullable(), decisionId: id.nullable(), waiting: z.string().max(300).nullable() }).strict() });
export const promotionCreateRpc = defineContract({ name: "organization.promotion-create",
  input: z.object({ messageId: id, projectId: id, from: id, to: id, commit: refOf("commit"), expectedRevision: z.number().int().min(1) }).strict(),
  output: z.object({ ...writeResult, promotion: promotion.nullable(), waiting: z.string().max(300).nullable() }).strict() });
export const promotionCancelRpc = defineContract({ name: "organization.promotion-cancel",
  input: z.object({ messageId: id, id, expectedRevision: z.number().int().min(1), note: words(500) }).strict(),
  output: z.object({ ...writeResult, promotion: promotion.nullable() }).strict() });
