import { createPrivateKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import {
  ChoicePayloadSchema,
  choicePayloadBytes,
  promptReason,
  toBase64,
  type ChoiceProof,
  type DevicePairResult,
  type DevicePlatform,
  type DeviceStatus,
} from "@getpaseo/protocol/device-proof";
import { z } from "zod";

// The desktop device key (CONTRACTS §3.6). The P-256 private key is generated and used only in this
// main process; the renderer, the daemon and plugins receive the public key and signatures only.
// At rest it is wrapped with Electron safeStorage: on macOS that key lives in the app's own
// keychain entry, on Windows in DPAPI, on Linux in the Secret Service when one is running. Each
// signature asks for Touch ID where the Mac has it; elsewhere the app asks for a click in a
// dialog, which confirms intent but is not user presence, and `userPresence` says so.

export class DevicePromptRefusedError extends Error {
  constructor() {
    super("The device prompt was cancelled; nothing was signed");
    this.name = "DevicePromptRefusedError";
  }
}

// CONTRACTS v1.12/13 §3.6 rule 3: pairing needs OS user presence (Touch ID, or the login password
// through LocalAuthentication). Electron offers Touch ID only, so a Mac without usable Touch ID
// cannot pair until a login-password path exists; a click in a dialog never pairs a Mac.
export const MAC_PAIRING_UNAVAILABLE = "Pair from your iPhone, or a Mac with Touch ID";

export class DevicePairingUnavailableError extends Error {
  constructor() {
    super(MAC_PAIRING_UNAVAILABLE);
    this.name = "DevicePairingUnavailableError";
  }
}

export interface DesktopDeviceKeyPlatform {
  platform: NodeJS.Platform;
  safeStorage: {
    isEncryptionAvailable(): boolean;
    encryptString(text: string): Buffer;
    decryptString(data: Buffer): string;
    getSelectedStorageBackend?(): string;
  };
  touchId: { canPrompt(): boolean; prompt(reason: string): Promise<void> };
  // A modal in-app confirmation. Returns true only when the user chose to continue.
  confirm(message: string, detail: string): Promise<boolean>;
  storePath: string;
}

const StoredKeySchema = z
  .object({
    version: z.literal(1),
    deviceId: z.string().uuid(),
    publicKey: z.string().min(1),
    wrap: z.enum(["safe-storage", "none"]),
    privateKey: z.string().min(1),
    keyStorage: z.enum(["os-protected", "software"]),
    userPresence: z.boolean(),
    pairedAt: z.string(),
  })
  .strict();
type StoredKey = z.infer<typeof StoredKeySchema>;

export const PairInputSchema = z
  .object({
    code: z
      .string()
      .regex(/^\d{6}$/)
      .optional(),
  })
  .strict();
export const SignInputSchema = z
  .object({ payload: ChoicePayloadSchema, reason: z.string().max(500) })
  .strict();

function devicePlatform(platform: NodeJS.Platform): DevicePlatform {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return "linux";
}

export function createDesktopDeviceKey(host: DesktopDeviceKeyPlatform) {
  const platform = devicePlatform(host.platform);

  // Protection this machine offers right now, before or after pairing.
  function protection(): {
    keyStorage: StoredKey["keyStorage"];
    userPresence: boolean;
    wrap: StoredKey["wrap"];
  } {
    const backend = host.safeStorage.getSelectedStorageBackend?.();
    const wrapped =
      host.safeStorage.isEncryptionAvailable() &&
      !(host.platform === "linux" && backend === "basic_text");
    return {
      keyStorage: wrapped ? "os-protected" : "software",
      userPresence: host.platform === "darwin" && host.touchId.canPrompt(),
      wrap: wrapped ? "safe-storage" : "none",
    };
  }

  async function load(): Promise<StoredKey | null> {
    let raw: string;
    try {
      raw = await readFile(host.storePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    return StoredKeySchema.parse(JSON.parse(raw));
  }

  async function save(record: StoredKey): Promise<void> {
    const temporary = `${host.storePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
    await rename(temporary, host.storePath);
  }

  // Touch ID where the key was paired with it; otherwise an in-app confirmation (Windows, Linux, and
  // any key already paired without Touch ID), reported honestly as `userPresence: false`.
  async function presence(reason: string, userPresence: boolean): Promise<void> {
    if (userPresence) {
      try {
        await host.touchId.prompt(reason);
      } catch {
        throw new DevicePromptRefusedError();
      }
      return;
    }
    const ok = await host.confirm(
      reason,
      "This device key is protected by your login only; there is no Touch ID check.",
    );
    if (!ok) throw new DevicePromptRefusedError();
  }

  return {
    async status(): Promise<DeviceStatus> {
      const stored = await load();
      if (stored) {
        return {
          paired: true,
          deviceId: stored.deviceId,
          publicKey: stored.publicKey,
          platform,
          keyStorage: stored.keyStorage,
          userPresence: stored.userPresence,
        };
      }
      const { keyStorage, userPresence } = protection();
      return { paired: false, platform, keyStorage, userPresence };
    },

    // The key is generated only after the user confirms. Pairing again replaces the key; the
    // controller treats the result as a new device.
    async pair(input: unknown): Promise<DevicePairResult> {
      const { code } = PairInputSchema.parse(input ?? {});
      const current = protection();
      if (host.platform === "darwin" && !current.userPresence) {
        throw new DevicePairingUnavailableError();
      }
      await presence(
        promptReason(code ? `Pair this device (code ${code})` : "Pair this device"),
        current.userPresence,
      );
      const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
      const pkcs8 = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
      const record: StoredKey = {
        version: 1,
        deviceId: randomUUID(),
        publicKey: toBase64(new Uint8Array(publicKey.export({ type: "spki", format: "der" }))),
        wrap: current.wrap,
        privateKey:
          current.wrap === "safe-storage"
            ? host.safeStorage.encryptString(pkcs8).toString("base64")
            : Buffer.from(pkcs8, "utf8").toString("base64"),
        keyStorage: current.keyStorage,
        userPresence: current.userPresence,
        pairedAt: new Date().toISOString(),
      };
      await save(record);
      return {
        deviceId: record.deviceId,
        publicKey: record.publicKey,
        alg: "ES256",
        platform,
        keyStorage: record.keyStorage,
        userPresence: record.userPresence,
      };
    },

    async sign(input: unknown): Promise<ChoiceProof> {
      const { payload, reason } = SignInputSchema.parse(input);
      const stored = await load();
      if (!stored) throw new Error("This device is not paired");
      const message = choicePayloadBytes(payload);
      await presence(promptReason(reason), stored.userPresence);
      const wrapped = Buffer.from(stored.privateKey, "base64");
      const pem =
        stored.wrap === "safe-storage"
          ? host.safeStorage.decryptString(wrapped)
          : wrapped.toString("utf8");
      const signature = sign("sha256", message, {
        key: createPrivateKey(pem),
        dsaEncoding: "ieee-p1363",
      });
      return {
        deviceId: stored.deviceId,
        alg: "ES256",
        signature: signature.toString("base64"),
        payload,
      };
    },
  };
}

export type DesktopDeviceKey = ReturnType<typeof createDesktopDeviceKey>;
