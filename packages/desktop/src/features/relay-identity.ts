import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { z } from "zod";

// The relay device identity (FC-2): the X25519 key this device presents to every paired host over
// the relay. It is kept here, wrapped with Electron safeStorage (the app's own keychain entry on
// macOS), and never in renderer storage. Relay-v3 derives its per-host keys in the renderer, so the
// renderer holds the secret in memory only while the app runs.
//
// Unlike the plugin device key there is no unwrapped fallback: with no OS encryption the store
// refuses, and the renderer keeps any existing identity where it is rather than creating a new one.

const KeyB64 = z.string().regex(/^[A-Za-z0-9+/]{43}=$/); // 32 bytes

export const RelayIdentitySchema = z
  .object({ publicKeyB64: KeyB64, secretKeyB64: KeyB64 })
  .strict();
export type RelayIdentity = z.infer<typeof RelayIdentitySchema>;

const StoredSchema = z
  .object({
    version: z.literal(1),
    publicKeyB64: KeyB64,
    wrap: z.literal("safe-storage"),
    secretKey: z.string().min(1),
  })
  .strict();
type Stored = z.infer<typeof StoredSchema>;

export class RelayIdentityUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayIdentityUnavailableError";
  }
}

export interface RelayIdentityPlatform {
  platform: NodeJS.Platform;
  safeStorage: {
    isEncryptionAvailable(): boolean;
    encryptString(text: string): Buffer;
    decryptString(data: Buffer): string;
    getSelectedStorageBackend?(): string;
  };
  storePath: string;
}

export function createRelayIdentityStore(host: RelayIdentityPlatform) {
  function encryptionAvailable(): boolean {
    const backend = host.safeStorage.getSelectedStorageBackend?.();
    return (
      host.safeStorage.isEncryptionAvailable() &&
      !(host.platform === "linux" && backend === "basic_text")
    );
  }

  async function read(): Promise<Stored | null> {
    let raw: string;
    try {
      raw = await readFile(host.storePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    return StoredSchema.parse(JSON.parse(raw));
  }

  async function load(): Promise<RelayIdentity | null> {
    const stored = await read();
    if (!stored) return null;
    const secretKeyB64 = host.safeStorage.decryptString(Buffer.from(stored.secretKey, "base64"));
    return RelayIdentitySchema.parse({ publicKeyB64: stored.publicKeyB64, secretKeyB64 });
  }

  return {
    load,

    // Stores the identity once. Storing the same identity again is a no-op; a different identity is
    // refused, so nothing here can replace the key that paired hosts already know.
    async store(input: unknown): Promise<void> {
      const identity = RelayIdentitySchema.parse(input);
      const existing = await load();
      if (existing) {
        if (
          existing.publicKeyB64 === identity.publicKeyB64 &&
          existing.secretKeyB64 === identity.secretKeyB64
        )
          return;
        throw new RelayIdentityUnavailableError("A different relay device identity is stored");
      }
      if (!encryptionAvailable())
        throw new RelayIdentityUnavailableError("Secure storage is unavailable on this computer");
      const record: Stored = {
        version: 1,
        publicKeyB64: identity.publicKeyB64,
        wrap: "safe-storage",
        secretKey: host.safeStorage.encryptString(identity.secretKeyB64).toString("base64"),
      };
      const temporary = `${host.storePath}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
      await rename(temporary, host.storePath);
    },
  };
}

export type RelayIdentityStore = ReturnType<typeof createRelayIdentityStore>;
