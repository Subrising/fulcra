// CONTRACTS.md §3 (decision packet, invariants, storage/RPCs, inbox item) and §4.2 (daily digest). The shapes
// are exactly §3.1/§3.4; invariants #1, #2 and #9 are the controller's own rules (decision-rules.mjs), run
// again on askPacket. Stored packets are read back for structure only (v1.5 #7). The held-message and digest
// RPCs are J3's additions for the Inbox tab: reads of existing controller records, plus the three existing
// operator seat actions (receipt, reply, unhold).
import { z } from "zod";
import { defineContract } from "../rpc-contract";
import { ref } from "./refs";
import { choiceProof } from "./devices";
import { noPersonal } from "./refs.mjs";
import { validateAsk, KEY, SHA256, LIMITS, VIA, APP_VIA, KINDS, STATES, REVERSIBILITY, CONFIDENCE } from "./decision-rules.mjs";
const id = z.string().uuid();
const at = z.string().datetime({ offset: true });
const key = z.string().regex(KEY);
const sha256 = z.string().regex(SHA256);
const words = (max: number) => z.string().min(1).max(max).refine(noPersonal, { message: "Contains personal or host-specific data" });
const tuple = <T extends readonly [string, ...string[]]>(values: T) => z.enum(values as unknown as [T[number], ...T[number][]]);
export const decisionOption = z.object({
  id: key, title: words(LIMITS.optionTitle), summary: words(LIMITS.optionSummary), example: words(LIMITS.example).nullable(),
  impacts: z.object({ benefit: words(LIMITS.benefit), cost: words(LIMITS.cost), time: words(LIMITS.time), risk: words(LIMITS.risk),
    reversibility: tuple(REVERSIBILITY), blastRadius: ref.nullable() }).strict(),
  destructive: z.boolean(),
}).strict();
export const decisionAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }).strict(),
  z.object({ type: z.literal("promotion"), promotionId: id, digest: sha256 }).strict(),
  z.object({ type: z.literal("refresh"), refreshId: id, digest: sha256 }).strict(),
  z.object({ type: z.literal("change"), prRef: ref, digest: sha256 }).strict(),
  z.object({ type: z.literal("environment-change"), environmentId: id, digest: sha256 }).strict(),
]);
// v1.6: `human` is the owner proven by a paired device; `operator` holds the operator secret without that proof.
const actor = z.string().regex(/^(human|operator|seat:[a-z0-9][a-z0-9-]{0,63}|session:[0-9a-f-]{36}|system:[a-z0-9-]{1,64})$/);
export const decisionPacket = z.object({
  version: z.literal(1), id, revision: z.number().int().min(1),
  kind: tuple(KINDS), level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  projectId: id.nullable(), taskId: id.nullable(),
  // v1.15 §3.3: a packet the controller asks itself (askSystem) has no asking session and names its component.
  askedBy: z.object({ seat: key.nullable(), sessionId: id.nullable(), system: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/).optional() }).strict()
    .refine(a => (a.sessionId === null) === (a.system !== undefined), { message: "A packet is asked by a session or by a component, not both" }),
  askedOf: z.union([z.literal("human"), z.object({ seat: key }).strict()]),
  title: words(LIMITS.title), situation: words(LIMITS.situation),
  options: z.array(decisionOption).max(LIMITS.options),
  recommendation: z.object({ optionId: key, why: words(LIMITS.why), confidence: tuple(CONFIDENCE), wouldChangeIf: words(LIMITS.wouldChangeIf) }).strict().nullable(),
  evidence: z.array(z.object({ ref, label: words(LIMITS.evidenceLabel) }).strict()).max(LIMITS.evidence),
  action: decisionAction,
  expiresAt: at.nullable(),
  state: tuple(STATES),
  supersededBy: id.nullable(),
  choice: z.object({ optionId: key, by: actor, at, note: z.string().max(LIMITS.note), via: tuple(VIA), channelId: id.nullable(), deviceId: id.nullable(), proven: z.boolean() }).strict().nullable(),
  delivery: z.object({ state: z.enum(["pending", "delivered", "failed"]), at: at.nullable(), attempts: z.number().int().nonnegative() }).strict().nullable(),
  createdAt: at, updatedAt: at,
}).strict().superRefine((p, ctx) => {
  // §3.2 #7 v1.5 (R-J3-6): reading a stored packet checks structure, limits and noPersonal only. Invariants #1, #2
  // and #9 were checked when it was asked (askPacket below, and the controller), so a packet stays readable and
  // answerable after the jargon list grows.
  if ((p.state === "chosen") !== (p.choice !== null)) ctx.addIssue({ code: "custom", message: "A choice exists exactly when the packet is chosen" });
  if (p.choice && p.choice.proven !== (p.choice.by === "human")) ctx.addIssue({ code: "custom", message: "Only a proven answer is the owner's" });
});
export type DecisionPacket = z.infer<typeof decisionPacket>;
// What an agent sends to role_decision_ask (§3.3): the packet without server fields.
export const askPacket = z.object({
  kind: tuple(KINDS), level: z.union([z.literal(1), z.literal(2), z.literal(3)]), projectId: id.nullable().optional(), taskId: id.nullable().optional(),
  askedOf: z.union([z.literal("human"), z.object({ seat: key }).strict()]), title: words(LIMITS.title), situation: words(LIMITS.situation),
  options: z.array(decisionOption.extend({ example: words(LIMITS.example).nullable().optional(), destructive: z.boolean().optional() }).strict()).max(LIMITS.options),
  recommendation: z.object({ optionId: key, why: words(LIMITS.why), confidence: tuple(CONFIDENCE), wouldChangeIf: words(LIMITS.wouldChangeIf) }).strict().nullable().optional(),
  evidence: z.array(z.object({ ref, label: words(LIMITS.evidenceLabel) }).strict()).max(LIMITS.evidence).optional(),
  action: decisionAction.optional(), expiresAt: at.nullable().optional(),
}).strict().superRefine((p, ctx) => { try { validateAsk(p); } catch (e) { ctx.addIssue({ code: "custom", message: e instanceof Error ? e.message : "Invalid decision packet" }); } });

// §3.4: the one list the owner sees.
export const inboxSource = z.enum(["decision", "outcome", "held", "digest", "attention"]);
export const urgency = z.enum(["now", "today", "fyi"]);
export const inboxItem = z.object({
  key: z.string().min(1).max(200).regex(/^[a-z0-9-]+$/), source: inboxSource, ref: ref.nullable(), title: words(120), summary: words(280),
  projectId: id.nullable(), urgency, createdAt: at, unread: z.boolean(),
}).strict();
export type InboxItem = z.infer<typeof inboxItem>;
const count = z.number().int().nonnegative();
export const inboxCounts = z.object({ now: count, today: count, fyi: count, decisions: count, approvals: count, held: count, digests: count, total: count }).strict();
// Every read carries the observation fields (CONTRACTS §1): a stall returns the last good list, marked stale.
const observation = { version: z.literal(1), observedAt: at, partial: z.boolean(), stale: z.boolean(), error: z.string().max(500).nullable() };
export const inboxRpc = defineContract({ name: "organization.inbox", input: z.object({}).strict(),
  // U5-D01: which parts of the inbox could not be read (section -> rows skipped); absent when every part was read.
  output: z.object({ ...observation, items: z.array(inboxItem).max(200), counts: inboxCounts, unreadable: z.object(Object.fromEntries(["decisions", "held", "digests", "devices", "attention", "outcomes"].map(k => [k, z.number().int().nonnegative().optional()])) as Record<"decisions" | "held" | "digests" | "devices" | "attention" | "outcomes", z.ZodOptional<z.ZodNumber>>).strict().optional() }).strict() });
// §3.3: the full packet, with evidence resolved to labels and kinds for the Details disclosure.
export const decisionRpc = defineContract({ name: "organization.decision", input: z.object({ id }).strict(),
  output: z.object({ ...observation, decision: decisionPacket.nullable(), answered: z.string().max(200).nullable(),
    evidence: z.array(z.object({ ref, label: z.string().max(LIMITS.evidenceLabel), kind: z.string().max(20) }).strict()).max(LIMITS.evidence) }).strict() });
export const decisionChooseInput = z.object({ messageId: id, id, expectedRevision: z.number().int().min(1), optionId: key, note: z.string().max(LIMITS.note).refine(noPersonal, { message: "Contains personal or host-specific data" }), confirmDestructive: z.boolean(), via: tuple(APP_VIA).optional(), proof: choiceProof.optional() }).strict();
const writeResult = { ok: z.boolean(), message: z.string().max(500).nullable(), observedAt: at };
export const decisionChooseRpc = defineContract({ name: "organization.decision-choose", input: decisionChooseInput,
  output: z.object({ ...writeResult, decision: decisionPacket.nullable() }).strict() });
// G4: the review screen's decision on a pull request, recorded as a record-only Inbox item (the controller's
// decisions-record-review). The workspace only identifies the review for a retry; it is hashed, never shown.
export const REVIEW_CHOICES = ["approve", "request_changes", "comment"] as const;
export const reviewRecordInput = z.object({
  workspace: z.string().min(1).max(1024), repo: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/),
  number: z.number().int().min(1).max(2147483647), headSha: z.string().regex(/^[0-9a-f]{40}$/), choice: z.enum(REVIEW_CHOICES),
  note: z.string().max(LIMITS.note).refine(noPersonal, { message: "Contains personal or host-specific data" }),
  projectId: id.nullable().optional(), via: tuple(APP_VIA).optional(),
}).strict();
export const reviewRecordRpc = defineContract({ name: "organization.review-record", input: reviewRecordInput,
  output: z.object({ ...writeResult, decisionId: id.nullable(), already: z.boolean() }).strict() });

// Held messages (§3.4): metadata in the list, the body only here, on open. Its text is another seat's words.
export const heldMessageRef = z.object({ channelId: id, messageId: id }).strict();
export const heldMessage = z.object({ channelId: id, messageId: id, fromSeat: z.string().max(64), toSeat: z.string().max(64), at, untrustedText: z.string().max(16384),
  read: z.object({ at }).strict().nullable(), reply: z.object({ messageId: id, state: z.string().max(40), at }).strict().nullable(),
  pins: z.object({ seatRevision: z.number().int().min(1), holderGeneration: z.number().int().min(1) }).strict().nullable(),
  canReply: z.boolean(), replyBlocked: z.string().max(500).nullable(), canRelease: z.boolean(), note: z.string().max(300) }).strict();
export const heldMessageRpc = defineContract({ name: "organization.held-message", input: heldMessageRef, output: z.object({ ...observation, message: heldMessage.nullable() }).strict() });
export const heldReadRpc = defineContract({ name: "organization.held-read", input: heldMessageRef, output: z.object(writeResult).strict() });
export const heldReplyRpc = defineContract({ name: "organization.held-reply",
  input: z.object({ channelId: id, inReplyTo: id, messageId: id, text: z.string().min(1).max(4000).refine(noPersonal, { message: "Contains personal or host-specific data" }), expectedSeatRevision: z.number().int().min(1), expectedHolderGeneration: z.number().int().min(1) }).strict(),
  output: z.object({ ...writeResult, state: z.string().max(40).nullable() }).strict() });
export const heldReleaseRpc = defineContract({ name: "organization.held-release", input: z.object({ channelId: id, messageId: id, expectedSeatRevision: z.number().int().min(1) }).strict(),
  output: z.object(writeResult).strict() });

// §4.2: derived, never authored.
export const digestBody = z.object({
  version: z.literal(1), projectId: id.nullable(), projectName: z.string().min(1).max(160), periodStart: at, periodEnd: at, composedAt: at,
  brief: z.object({ headline: z.string().max(140), health: z.string().max(20).nullable(), writtenAt: at }).strict().nullable(),
  healthChange: z.object({ from: z.string().max(20).nullable(), to: z.string().max(20).nullable() }).strict().nullable(),
  noUpdate: z.string().max(80).nullable(),
  shipped: z.array(z.object({ text: z.string().max(200), ref: ref.nullable() }).strict()).max(10),
  decisions: z.object({ chosen: z.array(z.object({ id, title: z.string().max(120), optionTitle: z.string().max(80), at, by: actor, proven: z.boolean() }).strict()).max(10),
    open: z.array(z.object({ id, title: z.string().max(120), level: z.number().int().min(1).max(3), kind: tuple(KINDS) }).strict()).max(10), chosenCount: count, openCount: count }).strict(),
  held: z.object({ waiting: count, oldestAt: at.nullable() }).strict().nullable(),
  devices: z.array(z.object({ label: z.string().max(60), action: z.enum(["paired", "revoked"]), at }).strict()).max(10),
  // v1.13 R3-7: chat, session and command-line channel pairings, revocations and device-revoked pauses.
  channels: z.array(z.object({ label: z.string().max(80), kind: z.enum(["discord-openclaw", "session", "cli"]), action: z.enum(["paired", "revoked", "device-revoked"]), ownerCapable: z.boolean(), at }).strict()).max(10).optional(),
  deployments: z.array(z.never()).max(0), partial: z.boolean(), summary: z.string().max(400),
}).strict();
export const digestRpc = defineContract({ name: "organization.digest", input: z.object({ id }).strict(), output: z.object({ ...observation, digest: digestBody.nullable() }).strict() });
