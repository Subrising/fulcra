import { generateKeyPairSync, randomBytes, sign as nodeSign, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ChoicePayloadSchema,
  canonicalJson,
  choicePayloadBytes,
  derToP1363,
  fromBase64,
  promptReason,
  toBase64,
  type ChoicePayload,
} from "./device-proof";

// Fixture values are obviously fake.
const FIXTURE_PAYLOAD: ChoicePayload = {
  decisionId: "00000000-0000-4000-8000-00000000d001",
  revision: 3,
  optionId: "option-b",
  digest: "a".repeat(64),
  messageId: "00000000-0000-4000-8000-00000000e001",
  note: 'Go with B — "quoted" and ünïcode',
  at: "2026-09-24T21:04:00.000+10:00",
  confirmDestructive: false,
};

describe("canonical JSON (sorted keys, no whitespace)", () => {
  it("produces the exact bytes a verifier checks", () => {
    expect(canonicalJson(FIXTURE_PAYLOAD)).toBe(
      '{"at":"2026-09-24T21:04:00.000+10:00","confirmDestructive":false,' +
        '"decisionId":"00000000-0000-4000-8000-00000000d001",' +
        '"digest":"' +
        "a".repeat(64) +
        '",' +
        '"messageId":"00000000-0000-4000-8000-00000000e001",' +
        '"note":"Go with B — \\"quoted\\" and ünïcode","optionId":"option-b","revision":3}',
    );
  });

  it("does not depend on key order, sorts nested keys and refuses undefined or non-finite values", () => {
    const shuffled = Object.fromEntries(Object.entries(FIXTURE_PAYLOAD).toReversed());
    expect(canonicalJson(shuffled)).toBe(canonicalJson(FIXTURE_PAYLOAD));
    expect(canonicalJson({ b: [2, { d: 1, c: null }], a: "x" })).toBe(
      '{"a":"x","b":[2,{"c":null,"d":1}]}',
    );
    expect(() => canonicalJson({ a: undefined })).toThrow("undefined");
    expect(() => canonicalJson({ a: Number.NaN })).toThrow("non-finite");
  });

  it("signs only the choice shape: extra or missing fields are refused", () => {
    expect(() => choicePayloadBytes({ ...FIXTURE_PAYLOAD, extra: 1 } as ChoicePayload)).toThrow();
    const { confirmDestructive: _omit, ...missing } = FIXTURE_PAYLOAD;
    expect(ChoicePayloadSchema.safeParse(missing).success).toBe(false);
    expect(ChoicePayloadSchema.safeParse({ ...FIXTURE_PAYLOAD, digest: null }).success).toBe(true);
  });
});

describe("encodings", () => {
  it("base64 matches Node for every length remainder", () => {
    for (let length = 0; length < 40; length += 1) {
      const bytes = new Uint8Array(randomBytes(length));
      const encoded = toBase64(bytes);
      expect(encoded).toBe(Buffer.from(bytes).toString("base64"));
      expect(Array.from(fromBase64(encoded))).toEqual(Array.from(bytes));
    }
  });

  it("converts DER ECDSA signatures (as iOS and Android return them) to verifiable ES256 r‖s", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const message = choicePayloadBytes(FIXTURE_PAYLOAD);
    for (let round = 0; round < 50; round += 1) {
      const der = new Uint8Array(nodeSign("sha256", message, privateKey));
      const raw = derToP1363(der);
      expect(raw.length).toBe(64);
      expect(verify("sha256", message, { key: publicKey, dsaEncoding: "ieee-p1363" }, raw)).toBe(
        true,
      );
    }
    expect(() => derToP1363(new Uint8Array([0x30, 0x02, 0x02, 0x00]))).toThrow("Invalid DER");
  });

  it("builds a one-line, bounded, host-prefixed prompt reason", () => {
    expect(promptReason("Approve the release\nnow")).toBe("Fulcra: Approve the release now");
    expect(promptReason("x".repeat(500))).toHaveLength("Fulcra: ".length + 120);
    expect(() => promptReason("  \n ")).toThrow("reason");
  });
});
