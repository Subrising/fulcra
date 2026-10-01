import {
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import {
  canonicalJson,
  type ChoicePayload,
  type ChoiceProof,
} from "@getpaseo/protocol/device-proof";
import { describe, expect, it } from "vitest";
import {
  DevicePairingUnavailableError,
  DevicePromptRefusedError,
  createDesktopDeviceKey,
  createNativeDeviceKey,
  type NativeDeviceKeyModule,
} from "./device-key-adapters";

const PAYLOAD: ChoicePayload = {
  decisionId: "00000000-0000-4000-8000-00000000d001",
  revision: 4,
  optionId: "option-a",
  digest: "0".repeat(64),
  messageId: "00000000-0000-4000-8000-00000000e001",
  note: "Fine by me",
  at: "2026-09-24T21:04:00.000+10:00",
  confirmDestructive: true,
};

// A stand-in for the iOS Secure Enclave / Android Keystore module: a real P-256 key the test never
// hands to the adapter, a mocked OS prompt, and DER signatures exactly as the platforms return them.
function fakeNativeModule(options: {
  keyStorage: "secure-enclave" | "android-keystore";
  answer?: () => boolean;
  // Runs inside sign after the key is chosen and before it returns (to interleave a re-pair).
  duringSign?: () => Promise<void>;
}) {
  // Like the native modules: one immutable key per device id, and a current record naming one.
  const keys = new Map<string, { privateKey: KeyObject; publicKey: string }>();
  let current: string | null = null;
  const prompts: string[] = [];
  const signedData: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const cancel = () => Object.assign(new Error("cancelled"), { code: "E_CANCELLED" });
  async function track<Result>(work: () => Promise<Result>): Promise<Result> {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return await work();
    } finally {
      inFlight -= 1;
    }
  }
  function createKey(): { deviceId: string; publicKey: string } {
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const deviceId = randomUUID();
    const publicKey = pair.publicKey.export({ type: "spki", format: "der" }).toString("base64");
    keys.set(deviceId, { privateKey: pair.privateKey, publicKey });
    current = deviceId;
    return { deviceId, publicKey };
  }
  const module: NativeDeviceKeyModule = {
    async status() {
      return current
        ? {
            paired: true,
            deviceId: current,
            publicKey: keys.get(current)!.publicKey,
            keyStorage: options.keyStorage,
            userPresence: true,
          }
        : { paired: false, keyStorage: options.keyStorage, userPresence: true };
    },
    pair(reason) {
      return track(async () => {
        prompts.push(reason);
        if (!(options.answer?.() ?? true)) throw cancel();
        return { ...createKey(), keyStorage: options.keyStorage, userPresence: true };
      });
    },
    sign(dataBase64, reason) {
      return track(async () => {
        prompts.push(reason);
        if (!(options.answer?.() ?? true)) throw cancel();
        const deviceId = current;
        if (!deviceId) throw Object.assign(new Error("not paired"), { code: "E_NOT_PAIRED" });
        const key = keys.get(deviceId)!;
        await options.duringSign?.();
        signedData.push(dataBase64);
        return {
          signature: sign("sha256", Buffer.from(dataBase64, "base64"), key.privateKey).toString(
            "base64",
          ),
          deviceId,
        };
      });
    },
  };
  return {
    module,
    prompts,
    signedData,
    keys,
    createKey,
    maxInFlight: () => maxInFlight,
  };
}

function verifyProof(proof: ChoiceProof, publicKey: string): boolean {
  return verify(
    "sha256",
    Buffer.from(canonicalJson(proof.payload), "utf8"),
    {
      key: createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" }),
      dsaEncoding: "ieee-p1363",
    },
    Buffer.from(proof.signature, "base64"),
  );
}

for (const [platform, keyStorage] of [
  ["ios", "secure-enclave"],
  ["android", "android-keystore"],
] as const) {
  describe(`${platform} device key adapter (OS prompt mocked)`, () => {
    it("pairs after a prompt and signs the canonical payload into a verifiable ES256 proof", async () => {
      const fake = fakeNativeModule({ keyStorage });
      const device = createNativeDeviceKey({ module: fake.module, platform });
      await expect(device.status()).resolves.toEqual({
        paired: false,
        platform,
        keyStorage,
        userPresence: true,
      });
      const paired = await device.pair({ code: "042042" });
      expect(paired).toMatchObject({ alg: "ES256", platform, keyStorage, userPresence: true });
      expect(fake.prompts).toEqual(["Fulcra: Pair this device (code 042042)"]);

      const proof = await device.sign(PAYLOAD, "Approve the release?");
      expect(fake.prompts.at(-1)).toBe("Fulcra: Approve the release?");
      // The platform signed exactly the canonical JSON bytes the controller verifies.
      expect(Buffer.from(fake.signedData[0], "base64").toString("utf8")).toBe(
        canonicalJson(PAYLOAD),
      );
      expect(proof).toMatchObject({ deviceId: paired.deviceId, alg: "ES256", payload: PAYLOAD });
      expect(Buffer.from(proof.signature, "base64")).toHaveLength(64);
      expect(verifyProof(proof, paired.publicKey)).toBe(true);
      expect(
        verifyProof(
          { ...proof, payload: { ...PAYLOAD, confirmDestructive: false } },
          paired.publicKey,
        ),
      ).toBe(false);
    });

    it("a refused prompt pairs nothing and signs nothing", async () => {
      let allow = false;
      const fake = fakeNativeModule({ keyStorage, answer: () => allow });
      const device = createNativeDeviceKey({ module: fake.module, platform });
      await expect(device.pair()).rejects.toBeInstanceOf(DevicePromptRefusedError);
      await expect(device.status()).resolves.toMatchObject({ paired: false });
      allow = true;
      await device.pair();
      allow = false;
      await expect(device.sign(PAYLOAD, "Approve?")).rejects.toBeInstanceOf(
        DevicePromptRefusedError,
      );
      expect(fake.signedData).toEqual([]);
    });

    it("refuses anything but a choice payload, and a bad pairing code, before any prompt", async () => {
      const fake = fakeNativeModule({ keyStorage });
      const device = createNativeDeviceKey({ module: fake.module, platform });
      await device.pair();
      const before = fake.prompts.length;
      await expect(
        device.sign({ ...PAYLOAD, extra: "x" } as unknown as ChoicePayload, "Approve?"),
      ).rejects.toThrow();
      await expect(device.sign(PAYLOAD, "   ")).rejects.toThrow("reason");
      await expect(device.pair({ code: "12" })).rejects.toThrow("6 digits");
      expect(fake.prompts.length).toBe(before);
    });
  });
}

describe("native signing reports the key that signed (R-D-4)", () => {
  it("a re-pair that lands during a signature cannot mislabel the proof", async () => {
    let fake!: ReturnType<typeof fakeNativeModule>;
    fake = fakeNativeModule({
      keyStorage: "secure-enclave",
      // The OS finishes a re-pair while this signature's prompt is up.
      duringSign: async () => {
        fake.createKey();
      },
    });
    const device = createNativeDeviceKey({ module: fake.module, platform: "ios" });
    const first = await device.pair();
    const proof = await device.sign(PAYLOAD, "Approve?");
    // The proof names the key that actually signed, and verifies under that key's public key.
    expect(proof.deviceId).toBe(first.deviceId);
    expect(verifyProof(proof, fake.keys.get(proof.deviceId)!.publicKey)).toBe(true);
    const replacement = [...fake.keys.keys()].find((id) => id !== first.deviceId)!;
    expect(verifyProof(proof, fake.keys.get(replacement)!.publicKey)).toBe(false);
  });

  it("serialises pair and sign issued at the same time", async () => {
    const fake = fakeNativeModule({ keyStorage: "android-keystore" });
    const device = createNativeDeviceKey({ module: fake.module, platform: "android" });
    await device.pair();
    const [proof, repaired] = await Promise.all([device.sign(PAYLOAD, "Approve?"), device.pair()]);
    expect(fake.maxInFlight()).toBe(1);
    expect(verifyProof(proof, fake.keys.get(proof.deviceId)!.publicKey)).toBe(true);
    expect(repaired.deviceId).not.toBe(proof.deviceId);
  });
});

describe("desktop device key adapter (relays to the Electron main process)", () => {
  it("sends only a validated payload and maps a refused prompt", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    let refuse = false;
    const device = createDesktopDeviceKey(async (command, args) => {
      calls.push({ command, args });
      if (refuse) {
        throw new Error(
          "Error invoking remote method 'paseo:invoke': DevicePromptRefusedError: The device prompt was cancelled; nothing was signed",
        );
      }
      if (command === "device_status") {
        return { paired: false, platform: "macos", keyStorage: "os-protected", userPresence: true };
      }
      return { ok: true };
    });
    await expect(device.status()).resolves.toMatchObject({ platform: "macos" });
    await device.pair({ code: "123456" });
    await device.sign(PAYLOAD, "Approve?");
    expect(calls.map((call) => call.command)).toEqual([
      "device_status",
      "device_pair",
      "device_sign",
    ]);
    expect(calls[2].args).toEqual({ payload: PAYLOAD, reason: "Approve?" });
    await expect(
      device.sign({ ...PAYLOAD, revision: 0 } as ChoicePayload, "Approve?"),
    ).rejects.toThrow();
    expect(calls).toHaveLength(3);
    refuse = true;
    await expect(device.sign(PAYLOAD, "Approve?")).rejects.toBeInstanceOf(DevicePromptRefusedError);
  });

  it("reports a Mac without Touch ID as unable to pair", async () => {
    const device = createDesktopDeviceKey(async () => {
      throw new Error(
        "Error invoking remote method 'paseo:invoke': DevicePairingUnavailableError: Pair from your iPhone, or a Mac with Touch ID",
      );
    });
    const error = await device.pair().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DevicePairingUnavailableError);
    expect((error as Error).message).toBe("Pair from your iPhone, or a Mac with Touch ID");
  });
});
