// CONTRACTS.md §4 (project brief). `projectBrief` is exactly §4.1; `observed` and `stale` are attached by the
// server on read and never authored. The authoring rules (noPersonal refuses, plain language warns) are the
// controller's own (brief-rules.mjs), run again here so a malformed brief is never rendered.
import { z } from "zod";
import { defineContract } from "../rpc-contract";
import { ref } from "./refs";
import { noPersonal } from "./refs.mjs";
import { HEALTH, SEVERITY, BRIEF_LIMITS as L } from "./brief-rules.mjs";
const id = z.string().uuid();
const at = z.string().datetime({ offset: true });
const tuple = <T extends readonly [string, ...string[]]>(values: T) => z.enum(values as unknown as [T[number], ...T[number][]]);
const words = (max: number, min = 1) => z.string().min(min).max(max).refine(noPersonal, { message: "Contains personal or host-specific data" });
export const projectBrief = z.object({
  version: z.literal(1), projectId: id, revision: z.number().int().min(1),
  author: z.object({ seat: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), sessionId: id }).strict(),
  writtenAt: at,
  health: tuple(HEALTH),
  headline: words(L.headline),
  now: words(L.now),
  next: z.array(z.object({ text: words(L.itemText), by: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable() }).strict()).max(L.items),
  needsYou: z.array(z.object({ text: words(L.itemText), decision: id.nullable() }).strict()).max(L.items),
  risks: z.array(z.object({ text: words(L.itemText), severity: tuple(SEVERITY), mitigation: words(L.mitigation, 0) }).strict()).max(L.items),
  shipped: z.array(z.object({ text: words(L.itemText), ref: ref.nullable() }).strict()).max(L.items),
  evidence: z.array(z.object({ ref, label: words(L.evidenceLabel) }).strict()).max(L.evidence),
}).strict();
export type ProjectBrief = z.infer<typeof projectBrief>;
const count = z.number().int().nonnegative();
export const briefObserved = z.object({ sessionsRunning: count, sessionsTotal: count, openDecisions: count, heldMessages: count, lastActivityAt: at.nullable(), observedAt: at }).strict();
export type BriefObserved = z.infer<typeof briefObserved>;
const observation = { version: z.literal(1), observedAt: at, partial: z.boolean(), error: z.string().max(500).nullable() };
// §4.2 reader. `authorName` is the seat's display name for "Written by <name>, <time>" (never an id).
export const projectBriefRpc = defineContract({ name: "organization.project-brief", input: z.object({ projectId: id }).strict(),
  output: z.object({ ...observation, projectId: id, brief: projectBrief.nullable(), authorName: z.string().max(200).nullable(), observed: briefObserved.nullable(), stale: z.boolean() }).strict() });
