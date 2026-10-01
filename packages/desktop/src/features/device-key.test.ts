import { createPublicKey, verify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { choicePayloadBytes, type ChoicePayload } from "@getpaseo/protocol/device-proof";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDesktopDeviceKey,
  DevicePairingUnavailableError,
  DevicePromptRefusedError,
} from "./device-key";

const PAYLOAD: ChoicePayload = {
  decisionId: "00000000-0000-4000-8000-00000000d001",
  revision: 2,
  optionId: "ship-it",
  digest: null,
  messageId: "00000000-0000-4000-8000-00000000e001",
  note: "",
  at: "2026-09-24T21:04:00.000+10:00",
  confirmDestructive: true,
};

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

// A stand-in for Electron safeStorage: reversible, and visibly not plaintext.
const fakeSafeStorage = (options: { available?: boolean; backend?: string } = {}) => ({
  isEncryptionAvailable: () => options.available ?? true,
  encryptString: (text: string) => Buffer.from(`wrapped:${Buffer.from(text).toString("hex")}`),
  decryptString: (data: Buffer) =>
    Buffer.from(data.toString().replace(/^wrapped:/, ""), "hex").toString(),
  getSelectedStorageBackend: () => options.backend ?? "gnome_libsecret",
});

function desktop(options: {
  platform: NodeJS.Platform;
  touchId?: boolean;
  touchIdAnswer?: () => Promise<void>;
  confirmAnswer?: boolean;
  safeStorage?: ReturnType<typeof fakeSafeStorage>;
}) {
  const directory = mkdtempSync(path.join(tmpdir(), "fulcra-device-key-"));
  directories.push(directory);
  const prompts: string[] = [];
  const storePath = path.join(directory, "device-key.json");
  const key = createDesktopDeviceKey({
    platform: options.platform,
    safeStorage: options.safeStorage ?? fakeSafeStorage(),
    touchId: {
      canPrompt: () => options.touchId ?? false,
      prompt: async (reason) => {
        prompts.push(`touch-id: ${reason}`);
        await (options.touchIdAnswer ?? (async () => undefined))();
      },
    },
    confirm: async (message) => {
      prompts.push(`dialog: ${message}`);
      return options.confirmAnswer ?? true;
    },
    storePath,
  });
  return { key, prompts, storePath };
}

function verifies(
  proof: { signature: string; payload: ChoicePayload },
  publicKey: string,
): boolean {
  const spki = createPublicKey({
    key: Buffer.from(publicKey, "base64"),
    format: "der",
    type: "spki",
  });
  return verify(
    "sha256",
    choicePayloadBytes(proof.payload),
    { key: spki, dsaEncoding: "ieee-p1363" },
    Buffer.from(proof.signature, "base64"),
  );
}

describe("desktop device key (Electron main process)", () => {
  it("macOS with Touch ID: pairs after a prompt, signs after a prompt, and the signature verifies", async () => {
    const { key, prompts, storePath } = desktop({ platform: "darwin", touchId: true });
    await expect(key.status()).resolves.toEqual({
      paired: false,
      platform: "macos",
      keyStorage: "os-protected",
      userPresence: true,
    });
    const paired = await key.pair({ code: "123456" });
    expect(paired).toMatchObject({
      alg: "ES256",
      platform: "macos",
      keyStorage: "os-protected",
      userPresence: true,
    });
    expect(prompts).toEqual(["touch-id: Fulcra: Pair this device (code 123456)"]);

    const proof = await key.sign({ payload: PAYLOAD, reason: "Approve the release?" });
    expect(prompts.at(-1)).toBe("touch-id: Fulcra: Approve the release?");
    expect(proof).toMatchObject({ deviceId: paired.deviceId, alg: "ES256", payload: PAYLOAD });
    expect(Buffer.from(proof.signature, "base64")).toHaveLength(64);
    expect(verifies(proof, paired.publicKey)).toBe(true);
    // Tampering with any signed field breaks it: confirmDestructive is covered.
    expect(
      verifies({ ...proof, payload: { ...PAYLOAD, confirmDestructive: false } }, paired.publicKey),
    ).toBe(false);

    // At rest: owner-only file, private key wrapped, never plaintext PEM.
    const stored = readFileSync(storePath, "utf8");
    expect(statSync(storePath).mode & 0o777).toBe(0o600);
    expect(Buffer.from(JSON.parse(stored).privateKey, "base64").toString()).toMatch(/^wrapped:/);
    expect(stored).not.toContain("PRIVATE KEY");
    await expect(key.status()).resolves.toMatchObject({ paired: true, deviceId: paired.deviceId });
  });

  it("a refused Touch ID prompt pairs nothing and signs nothing", async () => {
    const refuse = async () => {
      throw new Error("User cancelled");
    };
    const refusing = desktop({ platform: "darwin", touchId: true, touchIdAnswer: refuse });
    await expect(refusing.key.pair({})).rejects.toBeInstanceOf(DevicePromptRefusedError);
    await expect(refusing.key.status()).resolves.toMatchObject({ paired: false });

    let allow = true;
    const later = desktop({
      platform: "darwin",
      touchId: true,
      touchIdAnswer: async () => {
        if (!allow) throw new Error("User cancelled");
      },
    });
    await later.key.pair({});
    allow = false;
    await expect(later.key.sign({ payload: PAYLOAD, reason: "Approve?" })).rejects.toBeInstanceOf(
      DevicePromptRefusedError,
    );
  });

  it("Windows and Linux report os-protected with an OS store, and software without one", async () => {
    await expect(desktop({ platform: "win32" }).key.pair({})).resolves.toMatchObject({
      platform: "windows",
      keyStorage: "os-protected",
      userPresence: false,
    });
    await expect(
      desktop({
        platform: "linux",
        safeStorage: fakeSafeStorage({ backend: "basic_text" }),
      }).key.status(),
    ).resolves.toMatchObject({ platform: "linux", keyStorage: "software", userPresence: false });
    const software = desktop({
      platform: "linux",
      safeStorage: fakeSafeStorage({ available: false }),
    });
    const paired = await software.key.pair({});
    expect(paired.keyStorage).toBe("software");
    const proof = await software.key.sign({ payload: PAYLOAD, reason: "Approve?" });
    expect(verifies(proof, paired.publicKey)).toBe(true);
  });

  it("signs only a well-formed choice payload, and refuses before prompting otherwise", async () => {
    const { key, prompts } = desktop({ platform: "darwin", touchId: true });
    await key.pair({});
    const before = prompts.length;
    await expect(
      key.sign({ payload: { ...PAYLOAD, anything: "else" }, reason: "x" }),
    ).rejects.toThrow();
    await expect(key.sign({ payload: "arbitrary bytes", reason: "x" })).rejects.toThrow();
    await expect(key.pair({ code: "12ab" })).rejects.toThrow();
    expect(prompts.length).toBe(before);
    const unpaired = desktop({ platform: "darwin", touchId: true });
    await expect(unpaired.key.sign({ payload: PAYLOAD, reason: "x" })).rejects.toThrow(
      "not paired",
    );
  });
});

describe("Mac pairing needs Touch ID (CONTRACTS §3.6 rule 3, R-D-3)", () => {
  it("Touch ID unavailable: pairing refuses with a clear result, shows no dialog and writes no key", async () => {
    const { key, prompts, storePath } = desktop({ platform: "darwin", touchId: false });
    const error = await key.pair({ code: "123456" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DevicePairingUnavailableError);
    expect((error as Error).message).toBe("Pair from your iPhone, or a Mac with Touch ID");
    expect(prompts).toEqual([]);
    expect(() => statSync(storePath)).toThrow();
    await expect(key.status()).resolves.toEqual({
      paired: false,
      platform: "macos",
      keyStorage: "os-protected",
      userPresence: false,
    });
  });

  it("Touch ID accepted: pairs with userPresence true", async () => {
    const { key, prompts } = desktop({ platform: "darwin", touchId: true });
    await expect(key.pair({})).resolves.toMatchObject({ platform: "macos", userPresence: true });
    expect(prompts).toEqual(["touch-id: Fulcra: Pair this device"]);
  });

  it("Touch ID refused: nothing is paired", async () => {
    const { key, storePath } = desktop({
      platform: "darwin",
      touchId: true,
      touchIdAnswer: async () => {
        throw new Error("User cancelled");
      },
    });
    await expect(key.pair({})).rejects.toBeInstanceOf(DevicePromptRefusedError);
    expect(() => statSync(storePath)).toThrow();
  });

  it("a key already paired without Touch ID still signs, confirmed in a dialog, reporting userPresence false", async () => {
    // A key paired on Windows (dialog, userPresence false) and later read on a Mac without Touch ID.
    const windows = desktop({ platform: "win32" });
    const paired = await windows.key.pair({});
    expect(paired.userPresence).toBe(false);
    const mac = createDesktopDeviceKey({
      platform: "darwin",
      safeStorage: fakeSafeStorage(),
      touchId: { canPrompt: () => false, prompt: async () => undefined },
      confirm: async () => true,
      storePath: windows.storePath,
    });
    await expect(mac.status()).resolves.toMatchObject({ paired: true, userPresence: false });
    const proof = await mac.sign({ payload: PAYLOAD, reason: "Approve?" });
    expect(verifies(proof, paired.publicKey)).toBe(true);
    const declining = createDesktopDeviceKey({
      platform: "darwin",
      safeStorage: fakeSafeStorage(),
      touchId: { canPrompt: () => false, prompt: async () => undefined },
      confirm: async () => false,
      storePath: windows.storePath,
    });
    await expect(declining.sign({ payload: PAYLOAD, reason: "Approve?" })).rejects.toBeInstanceOf(
      DevicePromptRefusedError,
    );
  });
});
