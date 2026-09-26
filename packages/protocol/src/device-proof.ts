import { z } from "zod";

// Device keys and choice proofs (proof that the user answered). Shared by the app,
// the desktop main process and the plugin SDK types. Runtime-neutral: no Node or DOM APIs, so the
// same canonical bytes are produced on iOS/Android (Hermes), in Electron and in Node.

export const DevicePlatformSchema = z.enum(["macos", "ios", "android", "windows", "linux"]);
export type DevicePlatform = z.infer<typeof DevicePlatformSchema>;

export const DeviceKeyStorageSchema = z.enum([
  "secure-enclave",
  "keychain-biometric",
  "android-keystore",
  "os-protected",
  "software",
]);
export type DeviceKeyStorage = z.infer<typeof DeviceKeyStorageSchema>;

// The signed payload. Exactly these fields: a device key signs choices and nothing else, so a
// plugin cannot turn it into a general signing oracle.
export const ChoicePayloadSchema = z
  .object({
    decisionId: z.string().uuid(),
    revision: z.number().int().min(1),
    optionId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    digest: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    messageId: z.string().uuid(),
    note: z.string().max(500),
    at: z.string().datetime({ offset: true }),
    confirmDestructive: z.boolean(),
  })
  .strict();
export type ChoicePayload = z.infer<typeof ChoicePayloadSchema>;

export const ChoiceProofSchema = z
  .object({
    deviceId: z.string().uuid(),
    alg: z.literal("ES256"),
    // base64 of the raw 64-byte r‖s (IEEE P1363, as in JWS ES256) over canonicalJson(payload).
    signature: z.string().min(1),
    payload: ChoicePayloadSchema,
  })
  .strict();
export type ChoiceProof = z.infer<typeof ChoiceProofSchema>;

export interface DeviceStatus {
  paired: boolean;
  deviceId?: string;
  publicKey?: string;
  platform: DevicePlatform;
  keyStorage: DeviceKeyStorage;
  // True when every signature needs Touch ID / Face ID / fingerprint (or the device passcode).
  userPresence: boolean;
}

export interface DevicePairResult {
  deviceId: string;
  // base64 DER SubjectPublicKeyInfo of the P-256 public key.
  publicKey: string;
  alg: "ES256";
  platform: DevicePlatform;
  keyStorage: DeviceKeyStorage;
  userPresence: boolean;
}

// The reason shown in the OS prompt: one plain line, bounded, always prefixed by the host.
export function promptReason(reason: string): string {
  let flattened = "";
  for (const char of reason) {
    const code = char.charCodeAt(0);
    flattened += code < 0x20 || code === 0x7f ? " " : char;
  }
  const oneLine = flattened.replace(/ {2,}/g, " ").trim().slice(0, 120);
  if (!oneLine) throw new Error("A reason is required for the device prompt");
  return `Fulcra: ${oneLine}`;
}

// Canonical JSON: object keys sorted by UTF-16 code unit order, no whitespace, strings and numbers
// as JSON.stringify writes them, arrays in order. undefined, functions and non-finite numbers are
// refused rather than dropped, so the signer and the verifier can never disagree silently.
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON refuses non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => {
        const item = (value as Record<string, unknown>)[key];
        if (item === undefined) throw new Error(`Canonical JSON refuses undefined at ${key}`);
        return `${JSON.stringify(key)}:${canonicalJson(item)}`;
      });
    return `{${entries.join(",")}}`;
  }
  throw new Error(`Canonical JSON refuses ${typeof value}`);
}

export function choicePayloadBytes(payload: ChoicePayload): Uint8Array {
  return utf8(canonicalJson(ChoicePayloadSchema.parse(payload)));
}

// -- encodings (no Buffer/atob: Hermes, Electron and Node all run this) --------------------------

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    out += BASE64[a >> 2];
    out += BASE64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? "=" : BASE64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? "=" : BASE64[c & 63];
  }
  return out;
}

export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/=+$/, "");
  if (/[^A-Za-z0-9+/]/.test(clean)) throw new Error("Invalid base64");
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    buffer = (buffer << 6) | BASE64.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

// iOS (SecKeyCreateSignature X9.62) and Android (SHA256withECDSA) return a DER ECDSA signature;
// ES256 carries the raw 32-byte r and s. Converts DER → raw r‖s, rejecting anything malformed.
export function derToP1363(der: Uint8Array, size = 32): Uint8Array {
  let offset = 0;
  const read = () => {
    if (offset >= der.length) throw new Error("Invalid DER signature");
    return der[offset++];
  };
  if (read() !== 0x30) throw new Error("Invalid DER signature");
  let length = read();
  if (length & 0x80) {
    const lengthBytes = length & 0x7f;
    length = 0;
    for (let index = 0; index < lengthBytes; index += 1) length = (length << 8) | read();
  }
  if (offset + length !== der.length) throw new Error("Invalid DER signature");
  const out = new Uint8Array(size * 2);
  for (let part = 0; part < 2; part += 1) {
    if (read() !== 0x02) throw new Error("Invalid DER signature");
    let integerLength = read();
    while (integerLength > 0 && der[offset] === 0 && integerLength > size) {
      offset += 1;
      integerLength -= 1;
    }
    if (integerLength > size || offset + integerLength > der.length) {
      throw new Error("Invalid DER signature");
    }
    out.set(der.subarray(offset, offset + integerLength), part * size + (size - integerLength));
    offset += integerLength;
  }
  if (offset !== der.length) throw new Error("Invalid DER signature");
  return out;
}
