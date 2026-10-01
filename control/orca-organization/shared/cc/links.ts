// CONTRACTS.md §2.2: a link between two refs, with provenance. The allowed pairs and precedence live in
// link-rules.mjs, shared with the controller, which enforces them again on every write.
import { z } from "zod";
import { defineContract } from "../rpc-contract";
import { ref } from "./refs";
import { RELATIONS, PROVENANCE, CONFIDENCE, LINK_STATES, EVIDENCE_MAX, evidenceProblem } from "./link-rules.mjs";
const id = z.string().uuid();
const at = z.string().datetime({ offset: true });
const tuple = <T extends readonly [string, ...string[]]>(values: T) => z.enum(values as unknown as [T[number], ...T[number][]]);
export const relation = tuple(RELATIONS as unknown as readonly ["worked-by", "produced", "fixes", "implements", "reviewed-by", "deployed", "decided-by", "supersedes"]);
const evidence = z.string().min(1).max(EVIDENCE_MAX).refine(v => evidenceProblem(v) === null, { message: "Evidence must be one short sentence with no personal data" });
const actor = z.string().regex(/^(human|operator|seat:[a-z0-9][a-z0-9-]{0,63}|session:[0-9a-f-]{36}|system:[a-z0-9-]{1,64})$/);
export const link = z.object({
  id, from: ref, to: ref, relation,
  provenance: tuple(PROVENANCE as unknown as readonly ["manual", "reported", "inferred"]), confidence: tuple(CONFIDENCE as unknown as readonly ["high", "medium", "low"]),
  evidence, state: tuple(LINK_STATES as unknown as readonly ["active", "removed"]), revision: z.number().int().min(1), createdAt: at, by: actor,
}).strict();
export type Link = z.infer<typeof link>;
const outcome = { ok: z.boolean(), message: z.string().max(300).nullable(), link: link.nullable() };
// Manual links (the Trackers and Sessions views). A manual link overrides an inferred one.
export const linkSetRpc = defineContract({
  name: "organization.links.set",
  input: z.object({ messageId: id, from: ref, relation, to: ref, evidence, expectedRevision: z.number().int().min(0) }).strict(),
  output: z.object(outcome).strict(),
});
export const linkRemoveRpc = defineContract({
  name: "organization.links.remove", input: z.object({ messageId: id, id, expectedRevision: z.number().int().min(1) }).strict(),
  output: z.object(outcome).strict(),
});
// Read for any view (J6 Sessions, J7 Changes, J8 Environments): active links touching the refs.
export const linksRpc = defineContract({
  name: "organization.links", input: z.object({ refs: z.array(ref).min(1).max(64) }).strict(),
  output: z.object({ version: z.literal(1), observedAt: at, partial: z.boolean(), links: z.array(link).max(1000) }).strict(),
});
