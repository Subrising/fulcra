import { createPublicKey, generateKeyPairSync, sign as nodeSign, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  choicePayloadBytes,
  derToP1363,
  toBase64,
  type ChoicePayload,
} from "./device-proof";

// Interop with an independent host-side verifier, under the device-proof wire rules: the envelope is { deviceId, alg: "ES256", signature, payload }; the
// signature is ES256 over the canonical JSON of `payload` (sorted keys, no whitespace); it is base64
// of either raw 64-byte r‖s or DER, told apart by length; P-256 SPKI keys only.
//
// This verifier is written independently of device-proof.ts: canonical JSON comes from the common
// JSON.stringify sorted-key replacer, not from our canonicalJson.

function j3Canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item as Record<string, unknown>)
            .sort()
            .map((key) => [key, (item as Record<string, unknown>)[key]]),
        )
      : item,
  );
}

function j3Verify(
  envelope: { deviceId: string; alg: string; signature: string; payload: unknown },
  spkiBase64: string,
): boolean {
  if (envelope.alg !== "ES256") return false;
  const key = createPublicKey({
    key: Buffer.from(spkiBase64, "base64"),
    format: "der",
    type: "spki",
  });
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    return false;
  }
  const signature = Buffer.from(envelope.signature, "base64");
  const message = Buffer.from(j3Canonical(envelope.payload), "utf8");
  return verify(
    "sha256",
    message,
    { key, dsaEncoding: signature.length === 64 ? "ieee-p1363" : "der" },
    signature,
  );
}

const CHOICE: ChoicePayload = {
  decisionId: "00000000-0000-4000-8000-00000000d001",
  revision: 7,
  optionId: "option-c",
  digest: "b".repeat(64),
  messageId: "00000000-0000-4000-8000-00000000e001",
  note: 'Ship it — "carefully" / ünïcode',
  at: "2026-09-25T09:15:00.000+10:00",
  confirmDestructive: true,
};

function freshKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    privateKey,
    spki: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  };
}

describe("device proofs verify under the independent verifier's rules", () => {
  it("our canonical bytes equal the verifier's for the choice payload, whatever the key order", () => {
    const shuffled = Object.fromEntries(Object.entries(CHOICE).toReversed());
    expect(canonicalJson(CHOICE)).toBe(j3Canonical(CHOICE));
    expect(canonicalJson(shuffled)).toBe(j3Canonical(CHOICE));
    expect(Buffer.from(choicePayloadBytes(CHOICE)).toString("utf8")).toBe(j3Canonical(CHOICE));
  });

  it("our canonical bytes equal the verifier's for its purpose-carrying device-write payloads", () => {
    const device = {
      userPresence: true,
      label: "Fixture phone",
      publicKey: "AAAA",
      platform: "ios",
      keyStorage: "secure-enclave",
    };
    for (const payload of [
      {
        purpose: "fulcra.device.pair",
        windowId: "00000000-0000-4000-8000-0000000000f1",
        code: "123456",
        device,
        messageId: "00000000-0000-4000-8000-0000000000f2",
        at: "2026-09-25T09:15:00.000+10:00",
      },
      {
        purpose: "fulcra.device.approve",
        device,
        messageId: "00000000-0000-4000-8000-0000000000f3",
        at: "2026-09-25T09:15:00.000+10:00",
      },
      {
        purpose: "fulcra.device.revoke",
        deviceId: "00000000-0000-4000-8000-0000000000f4",
        messageId: "00000000-0000-4000-8000-0000000000f5",
        at: "2026-09-25T09:15:00.000+10:00",
      },
    ]) {
      expect(canonicalJson(payload)).toBe(j3Canonical(payload));
    }
  });

  it("a proof as the app returns it (raw r‖s, converted from the platform's DER) verifies", () => {
    const key = freshKey();
    for (let round = 0; round < 25; round += 1) {
      const der = new Uint8Array(nodeSign("sha256", choicePayloadBytes(CHOICE), key.privateKey));
      const proof = {
        deviceId: "00000000-0000-4000-8000-00000000a001",
        alg: "ES256",
        signature: toBase64(derToP1363(der)),
        payload: CHOICE,
      };
      expect(Buffer.from(proof.signature, "base64")).toHaveLength(64);
      expect(j3Verify(proof, key.spki)).toBe(true);
    }
  });

  it("a DER signature, which the verifier also accepts, verifies too", () => {
    const key = freshKey();
    const der = nodeSign("sha256", choicePayloadBytes(CHOICE), key.privateKey);
    expect(
      j3Verify(
        { deviceId: "d", alg: "ES256", signature: der.toString("base64"), payload: CHOICE },
        key.spki,
      ),
    ).toBe(true);
  });

  it("fails on any change to the signed payload, another key, or another algorithm", () => {
    const key = freshKey();
    const signature = toBase64(
      derToP1363(new Uint8Array(nodeSign("sha256", choicePayloadBytes(CHOICE), key.privateKey))),
    );
    const proof = { deviceId: "d", alg: "ES256", signature, payload: CHOICE };
    expect(
      j3Verify({ ...proof, payload: { ...CHOICE, confirmDestructive: false } }, key.spki),
    ).toBe(false);
    expect(j3Verify({ ...proof, payload: { ...CHOICE, revision: 8 } }, key.spki)).toBe(false);
    expect(j3Verify(proof, freshKey().spki)).toBe(false);
    expect(j3Verify({ ...proof, alg: "ES384" }, key.spki)).toBe(false);
  });
});
