// CONTRACTS v1.6 §3.6 (prime decision S-1): paired devices, the only proof that the owner answered. The signed
// write envelopes follow CONTRACT-CHANGE-J3-1: { deviceId, alg: "ES256", signature, payload }, signed over the
// canonical JSON of `payload`, whose `purpose` names the act. The controller verifies every signature; these schemas
// only shape the calls. Keys are generated on the device and only the public half is ever sent (J5b, ctx.device).
import { z } from "zod";
import { defineContract } from "../rpc-contract";
import { noPersonal } from "./refs.mjs";
const id = z.string().uuid();
const at = z.string().datetime({ offset: true });
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const base64 = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/);
export const devicePlatform = z.enum(["macos", "ios", "android", "windows", "linux"]);
export const keyStorage = z.enum([
  "secure-enclave",
  "keychain-biometric",
  "android-keystore",
  "os-protected",
  "software",
]);
export const deviceDescription = z
  .object({
    label: z
      .string()
      .min(1)
      .max(60)
      .refine(noPersonal, { message: "Contains personal or host-specific data" }),
    platform: devicePlatform,
    publicKey: base64(400),
    keyStorage,
    userPresence: z.boolean(),
  })
  .strict();
export const device = z
  .object({
    version: z.literal(1),
    id,
    label: z.string().min(1).max(60),
    platform: devicePlatform,
    publicKey: base64(400),
    alg: z.literal("ES256"),
    keyStorage,
    userPresence: z.boolean(),
    pairedAt: at,
    pairedVia: z.union([
      z.object({ kind: z.literal("first-device"), windowId: id }).strict(),
      z.object({ kind: z.literal("approved"), byDeviceId: id }).strict(),
    ]),
    state: z.enum(["active", "revoked"]),
    revokedAt: at.nullable(),
    lastUsedAt: at.nullable(),
    revision: z.number().int().min(1),
  })
  .strict();
export type Device = z.infer<typeof device>;
const signedBy = <P extends z.ZodTypeAny>(payload: P) =>
  z.object({ deviceId: id, alg: z.literal("ES256"), signature: base64(200), payload }).strict();
// §3.6: what the owner's device signs to answer a decision.
export const choiceProof = signedBy(
  z
    .object({
      decisionId: id,
      revision: z.number().int().min(1),
      optionId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
      digest: sha256.nullable(),
      messageId: id,
      note: z.string().max(500),
      confirmDestructive: z.boolean(),
      at,
    })
    .strict(),
);
export type ChoiceProof = z.infer<typeof choiceProof>;
const signedAct = { messageId: id, at };
export const pairPayload = z
  .object({
    purpose: z.literal("fulcra.device.pair"),
    windowId: id,
    code: z.string().regex(/^\d{6}$/),
    device: deviceDescription,
    ...signedAct,
  })
  .strict();
export const approvePayload = z
  .object({ purpose: z.literal("fulcra.device.approve"), device: deviceDescription, ...signedAct })
  .strict();
export const revokePayload = z
  .object({ purpose: z.literal("fulcra.device.revoke"), deviceId: id, ...signedAct })
  .strict();
const observation = {
  version: z.literal(1),
  observedAt: at,
  stale: z.boolean(),
  error: z.string().max(500).nullable(),
};
const writeResult = { ok: z.boolean(), message: z.string().max(500).nullable(), observedAt: at };
export const devicesRpc = defineContract({
  name: "organization.devices",
  input: z.object({}).strict(),
  output: z
    .object({
      ...observation,
      devices: z.array(device).max(64),
      pairingWindow: z
        .object({ id, expiresAt: at, codeAvailable: z.boolean() })
        .strict()
        .nullable(),
    })
    .strict(),
});
// The one unsigned write: the operator opens a 10-minute window for the FIRST device. The code is returned once, to show.
export const devicePairOpenRpc = defineContract({
  name: "organization.device-pair-open",
  input: z.object({}).strict(),
  output: z
    .object({
      ...writeResult,
      windowId: id.nullable(),
      code: z
        .string()
        .regex(/^\d{6}$/)
        .nullable(),
      expiresAt: at.nullable(),
    })
    .strict(),
});
export const devicePairCompleteRpc = defineContract({
  name: "organization.device-pair-complete",
  input: z.object({ payload: pairPayload, signature: base64(200) }).strict(),
  output: z.object({ ...writeResult, device: device.nullable() }).strict(),
});
export const devicePairApproveRpc = defineContract({
  name: "organization.device-pair-approve",
  input: z
    .object({
      device: deviceDescription,
      approval: signedBy(approvePayload),
      signature: base64(200),
    })
    .strict(),
  output: z.object({ ...writeResult, device: device.nullable() }).strict(),
});
export const deviceRevokeRpc = defineContract({
  name: "organization.device-revoke",
  input: z.object({ proof: signedBy(revokePayload) }).strict(),
  output: z.object({ ...writeResult, device: device.nullable() }).strict(),
});
// How strongly each device's key is held, in words (shared with the controller's security alerts).
export { protectionText, PLATFORM_NAME, deviceLine } from "./device-text.mjs";
