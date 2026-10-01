// CONTRACTS v1.6 §3.5 (D4): one inbox, any channel. The app pairs, pauses and revokes channels; the controller
// (src/control/inbox-channels.mjs) is the only authority for what a channel may show or answer. Stored bindings hold
// only hashes of external ids (CONTRACT-CHANGE-J3-2).
import { z } from "zod";
import { defineContract } from "../rpc-contract";
import { noPersonal } from "./refs.mjs";
const id = z.string().uuid();
const at = z.string().datetime({ offset: true });
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const channelKind = z.enum(["discord-openclaw", "session", "cli"]);
export const channelScope = z.object({ projects: z.union([z.literal("all"), z.array(id).max(64)]), canAnswer: z.boolean(), levels: z.array(z.union([z.literal(1), z.literal(2), z.literal(3)])).min(1).max(3) }).strict();
export const channel = z.object({
  version: z.literal(1), id, revision: z.number().int().min(1), kind: channelKind, label: z.string().min(1).max(80),
  binding: z.union([
    // v1.13 R3-3: the OpenClaw conversation is bound too (absent on channels paired before v1.13).
    z.object({ kind: z.literal("discord-openclaw"), agentId: z.string().min(1).max(128), nativeChannelHash: sha256, ownerSenderHash: sha256, sessionKeyHash: sha256.optional() }).strict(),
    z.object({ kind: z.literal("session"), sessionId: id }).strict(),
    z.object({ kind: z.literal("cli"), hostId: z.string().min(1).max(64) }).strict(),
  ]),
  scope: channelScope, pairedAt: at, pairedBy: z.enum(["human", "operator"]), state: z.enum(["active", "paused", "revoked"]),
  answersCountAsOwner: z.boolean(),
}).strict();
export type Channel = z.infer<typeof channel>;
const observation = { version: z.literal(1), observedAt: at, stale: z.boolean(), error: z.string().max(500).nullable() };
const writeResult = { ok: z.boolean(), message: z.string().max(500).nullable(), observedAt: at };
export const channelsRpc = defineContract({ name: "organization.channels", input: z.object({}).strict(), output: z.object({ ...observation, channels: z.array(channel).max(64) }).strict() });
// The paired-device proof that makes a chat channel's answers count as the owner's (J5b ctx.device signs it).
export const channelPairOpenProof = z.object({ deviceId: id, alg: z.literal("ES256"), signature: z.string().min(1).max(200).regex(/^[A-Za-z0-9+/]+={0,2}$/),
  payload: z.object({ purpose: z.literal("fulcra.channel.pair-open"), kind: channelKind, label: z.string().min(1).max(80), scope: channelScope, messageId: id, at }).strict() }).strict();
// Opening a pairing window. A paired-device proof (J5b ctx.device) makes a chat channel's answers count as the owner's.
export const channelPairOpenRpc = defineContract({ name: "organization.channel-pair-open",
  input: z.object({ kind: channelKind, label: z.string().min(1).max(80).refine(noPersonal, { message: "Contains personal or host-specific data" }), scope: channelScope, proof: channelPairOpenProof.optional() }).strict(),
  output: z.object({ ...writeResult, windowId: id.nullable(), code: z.string().regex(/^\d{6}$/).nullable(), expiresAt: at.nullable(), pairedBy: z.enum(["human", "operator"]).nullable() }).strict() });
const change = z.object({ id, expectedRevision: z.number().int().min(1) }).strict();
export const channelPauseRpc = defineContract({ name: "organization.channel-pause", input: change.extend({ paused: z.boolean() }).strict(), output: z.object({ ...writeResult, channel: channel.nullable() }).strict() });
export const channelRevokeRpc = defineContract({ name: "organization.channel-revoke", input: change, output: z.object({ ...writeResult, channel: channel.nullable() }).strict() });
const KIND_NAME: Record<string, string> = { "discord-openclaw": "Discord", session: "A Claude or Codex session", cli: "A terminal" };
export const channelKindName = (kind: string) => KIND_NAME[kind] ?? kind;
// What answers from this channel mean, in words.
export function channelAnswerText(c: Pick<Channel, "scope" | "answersCountAsOwner">): string {
  if (!c.scope.canAnswer) return "Shows your inbox; can't answer";
  return c.answersCountAsOwner ? "Answers here count as yours" : "Answers here are marked as answered by the operator";
}
