// CONTRACTS.md §5 (prime remit). The shapes are exactly §5.1; the rules are the controller's own (remit-rules.mjs),
// run again here so a malformed record is never rendered as if it were valid. The four writes take
// {messageId, expectedRevision, …, note}; who made the change is derived by the controller, never sent.
import { z } from "zod";
import { defineContract } from "../rpc-contract";
import { noPersonal } from "./refs.mjs";
import { KEY, REMIT_LIMITS, REMIT_STATES, REMIT_ACTIONS } from "./remit-rules.mjs";
const id = z.string().uuid();
const at = z.string().datetime({ offset: true });
const key = z.string().regex(KEY);
const tuple = <T extends readonly [string, ...string[]]>(values: T) => z.enum(values as unknown as [T[number], ...T[number][]]);
const clean = { message: "Contains personal or host-specific data" };
export const remitNote = z.string().max(REMIT_LIMITS.note).refine(v => v.trim().length >= REMIT_LIMITS.noteMin, { message: `Give a reason of ${REMIT_LIMITS.noteMin} to ${REMIT_LIMITS.note} characters` }).refine(noPersonal, clean);
export const remitScope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project"), projectId: id }).strict(),
  z.object({ kind: z.literal("domain"), domain: key, label: z.string().min(1).max(REMIT_LIMITS.label).refine(noPersonal, clean) }).strict(),
]);
export const remit = z.object({
  version: z.literal(1), id, revision: z.number().int().min(1),
  primeSeat: key, scope: remitScope, state: tuple(REMIT_STATES),
  since: at, endedAt: at.nullable(), note: z.string().min(REMIT_LIMITS.noteMin).max(REMIT_LIMITS.note),
}).strict().refine(r => (r.state === "ended") === (r.endedAt !== null), { message: "An ended remit has an end time, and only then" });
export type Remit = z.infer<typeof remit>;
export const projectDomain = z.object({ projectId: id, domain: key.nullable(), revision: z.number().int().min(1) }).strict();
export type ProjectDomain = z.infer<typeof projectDomain>;
// §5.2 resolution, computed by the controller: project remit, then the area remit, then nobody ("No prime yet").
export const owner = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project"), primeSeat: key, remitId: id }).strict(),
  z.object({ kind: z.literal("domain"), primeSeat: key, remitId: id }).strict(),
  z.object({ kind: z.literal("unassigned"), primeSeat: z.null(), remitId: z.null() }).strict(),
]);
export type Owner = z.infer<typeof owner>;
const actor = z.string().regex(/^(human|operator|seat:[a-z0-9][a-z0-9-]{0,63}|session:[0-9a-f-]{36}|system:[a-z0-9-]{1,64})$/);
export const remitHistoryEntry = z.object({
  id, entityId: id, action: tuple(REMIT_ACTIONS), before: z.union([remit, projectDomain]).nullable(), after: z.union([remit, projectDomain]),
  previousRevision: z.number().int().min(0), revision: z.number().int().min(1), actor, note: z.string().max(REMIT_LIMITS.note), at,
}).strict();
export type RemitHistoryEntry = z.infer<typeof remitHistoryEntry>;
export const primeSeat = z.object({ seat: key, state: z.enum(["assigned", "vacant"]), sessionId: id.nullable() }).strict();
export const remitProject = z.object({ projectId: id, name: z.string().min(1).max(160).nullable(), domain: key.nullable(), domainRevision: z.number().int().min(0), owner }).strict();
export type RemitProject = z.infer<typeof remitProject>;
const observation = { version: z.literal(1), observedAt: at, partial: z.boolean(), stale: z.boolean(), error: z.string().max(500).nullable() };
export const remitsView = z.object({
  ...observation,
  primes: z.array(primeSeat).max(64), remits: z.array(remit).max(2100), domains: z.array(projectDomain).max(1000),
  projects: z.array(remitProject).max(256), history: z.array(remitHistoryEntry).max(100),
}).strict();
export type RemitsView = z.infer<typeof remitsView>;
export const remitsRpc = defineContract({ name: "organization.remits", input: z.object({}).strict(), output: remitsView });

const writeResult = { ok: z.boolean(), message: z.string().max(500).nullable(), observedAt: at };
export const remitAssignRpc = defineContract({ name: "organization.remit-assign",
  input: z.object({ messageId: id, expectedRevision: z.number().int().min(0), primeSeat: key, scope: remitScope, note: remitNote }).strict(),
  output: z.object({ ...writeResult, remit: remit.nullable() }).strict() });
export const remitMoveRpc = defineContract({ name: "organization.remit-move",
  input: z.object({ messageId: id, expectedRevision: z.number().int().min(1), remitId: id, toPrimeSeat: key, note: remitNote }).strict(),
  output: z.object({ ...writeResult, remit: remit.nullable(), ended: remit.nullable() }).strict() });
export const remitEndRpc = defineContract({ name: "organization.remit-end",
  input: z.object({ messageId: id, expectedRevision: z.number().int().min(1), remitId: id, note: remitNote }).strict(),
  output: z.object({ ...writeResult, remit: remit.nullable() }).strict() });
export const projectDomainSetRpc = defineContract({ name: "organization.project-domain-set",
  input: z.object({ messageId: id, expectedRevision: z.number().int().min(0), projectId: id, domain: key.nullable(), note: remitNote }).strict(),
  output: z.object({ ...writeResult, domain: projectDomain.nullable() }).strict() });
