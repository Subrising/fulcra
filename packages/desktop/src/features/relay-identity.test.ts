import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRelayIdentityStore } from "./relay-identity";

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

function store(
  options: { platform?: NodeJS.Platform; available?: boolean; backend?: string } = {},
) {
  const directory = mkdtempSync(path.join(tmpdir(), "relay-identity-"));
  directories.push(directory);
  const storePath = path.join(directory, "relay-device-identity.json");
  return {
    storePath,
    identity: createRelayIdentityStore({
      platform: options.platform ?? "darwin",
      safeStorage: fakeSafeStorage(options),
      storePath,
    }),
  };
}

const identity = {
  publicKeyB64: Buffer.alloc(32, 1).toString("base64"),
  secretKeyB64: Buffer.alloc(32, 2).toString("base64"),
};

describe("relay device identity store (FC-2)", () => {
  it("wraps the secret with safeStorage in a private file and reads it back", async () => {
    const { storePath, identity: relay } = store();
    expect(await relay.load()).toBeNull();
    await relay.store(identity);
    const raw = readFileSync(storePath, "utf8");
    expect(raw).not.toContain(identity.secretKeyB64);
    expect(JSON.parse(raw)).toMatchObject({
      version: 1,
      wrap: "safe-storage",
      publicKeyB64: identity.publicKeyB64,
    });
    expect(statSync(storePath).mode & 0o777).toBe(0o600);
    expect(await relay.load()).toEqual(identity);
  });

  it("never replaces a stored identity with a different one", async () => {
    const { identity: relay } = store();
    await relay.store(identity);
    await relay.store({ ...identity }); // the same identity again is a no-op
    await expect(
      relay.store({ ...identity, secretKeyB64: Buffer.alloc(32, 3).toString("base64") }),
    ).rejects.toThrow("A different relay device identity is stored");
    expect(await relay.load()).toEqual(identity);
  });

  it("refuses to store without OS encryption instead of writing it unwrapped", async () => {
    for (const options of [
      { available: false },
      { platform: "linux" as const, backend: "basic_text" },
    ]) {
      const { storePath, identity: relay } = store(options);
      await expect(relay.store(identity)).rejects.toThrow(
        "Secure storage is unavailable on this computer",
      );
      expect(existsSync(storePath)).toBe(false);
    }
  });

  it("rejects malformed identities and damaged records without echoing the secret", async () => {
    const { storePath, identity: relay } = store();
    for (const bad of [
      { publicKeyB64: identity.publicKeyB64 },
      { ...identity, secretKeyB64: "short" },
      { ...identity, extra: true },
    ]) {
      const error = await relay.store(bad).catch((caught: Error) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(existsSync(storePath)).toBe(false);
    }
    writeFileSync(storePath, JSON.stringify({ version: 1, secretKeyB64: identity.secretKeyB64 }));
    const error = await relay.load().catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(identity.secretKeyB64);
  });
});
