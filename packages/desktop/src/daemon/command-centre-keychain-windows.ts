import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CommandCentreKeychain } from "./command-centre-auth.js";

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(text: string): Buffer;
  decryptString(data: Buffer): string;
}

/**
 * Windows store for the Command Centre credential. The secret is encrypted with Electron
 * safeStorage (DPAPI, bound to the Windows user) and kept in one file in the app data folder.
 * There is no plain-text fallback: without OS encryption this reports the same error as an
 * unsupported platform. macOS keeps the Keychain (command-centre-keychain.ts).
 */
export function createWindowsCommandCentreKeychain(options: {
  safeStorage: SafeStorageLike;
  filePath: string;
}): CommandCentreKeychain {
  const { safeStorage, filePath } = options;
  function validate(service: string) {
    if (!safeStorage.isEncryptionAvailable())
      throw Error("Command Centre Keychain: unavailable-platform");
    if (!/^ai\.fulcra\.command-centre\.[a-f0-9]{64}$/.test(service))
      throw Error("Command Centre Keychain: invalid-service");
  }
  async function load(): Promise<Record<string, string>> {
    let text: string;
    try {
      text = await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return {};
      // eslint-disable-next-line preserve-caught-error
      throw Error("Command Centre Keychain: operation-failed");
    }
    try {
      const parsed = JSON.parse(text) as { version?: number; items?: Record<string, string> };
      if (parsed.version !== 1 || typeof parsed.items !== "object" || parsed.items === null)
        throw Error("shape");
      return parsed.items;
    } catch {
      throw Error("Command Centre Keychain: operation-failed");
    }
  }
  return {
    async get(service) {
      validate(service);
      const stored = (await load())[service];
      if (stored === undefined) return null;
      try {
        return safeStorage.decryptString(Buffer.from(stored, "base64"));
      } catch {
        throw Error("Command Centre Keychain: operation-failed");
      }
    },
    async set(service, password) {
      validate(service);
      if (!/^[a-f0-9]{64}$/.test(password))
        throw Error("Command Centre Keychain: invalid-generated-credential");
      const items = await load();
      items[service] = safeStorage.encryptString(password).toString("base64");
      try {
        await mkdir(path.dirname(filePath), { recursive: true });
        const temp = `${filePath}.${process.pid}.tmp`;
        await writeFile(temp, `${JSON.stringify({ version: 1, items }, null, 2)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        await rename(temp, filePath);
      } catch {
        throw Error("Command Centre Keychain: operation-failed");
      }
    },
  };
}
