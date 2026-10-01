import {
  ChoicePayloadSchema,
  choicePayloadBytes,
  derToP1363,
  fromBase64,
  promptReason,
  toBase64,
  type ChoicePayload,
  type ChoiceProof,
  type DeviceKeyStorage,
  type DevicePairResult,
  type DeviceStatus,
} from "@getpaseo/protocol/device-proof";
import type { PluginDevice } from "@getpaseo/plugin/client";

// Device key adapters for `ctx.device` (CONTRACTS §3.6). The private key stays in the platform:
// the Secure Enclave or keychain on iOS, the Android Keystore, the Electron main process on desktop.
// These adapters validate the choice payload before any prompt, pass bytes and a bounded reason
// to the platform, and turn its answer into a ChoiceProof. Nothing here can see a private key.

export class DevicePromptRefusedError extends Error {
  constructor() {
    super("The device prompt was cancelled; nothing was signed");
    this.name = "DevicePromptRefusedError";
  }
}

// The desktop refused to pair because this Mac has no usable Touch ID (CONTRACTS §3.6 rule 3).
export class DevicePairingUnavailableError extends Error {
  constructor(message = "Pair from your iPhone, or a Mac with Touch ID") {
    super(message);
    this.name = "DevicePairingUnavailableError";
  }
}

const PAIR_CODE = /^\d{6}$/;

function pairReason(code: string | undefined): string {
  if (code !== undefined && !PAIR_CODE.test(code)) throw new Error("The pairing code has 6 digits");
  return promptReason(code ? `Pair this device (code ${code})` : "Pair this device");
}

// -- iOS and Android: the local `PaseoDeviceKey` Expo module ------------------------------------

export interface NativeDeviceKeyModule {
  status(): Promise<{
    paired: boolean;
    deviceId?: string;
    publicKey?: string;
    keyStorage: DeviceKeyStorage;
    userPresence: boolean;
  }>;
  // Prompts for a biometric first, then generates the key. Rejects with code E_CANCELLED.
  pair(reason: string): Promise<{
    deviceId: string;
    publicKey: string;
    keyStorage: DeviceKeyStorage;
    userPresence: boolean;
  }>;
  // Signs base64 bytes after a biometric. Resolves the base64 DER ECDSA signature and the device id
  // of the exact key that made it (each pairing has its own key alias, R-D-4).
  sign(dataBase64: string, reason: string): Promise<{ signature: string; deviceId: string }>;
}

function isCancelled(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "E_CANCELLED"
  );
}

export function createNativeDeviceKey(input: {
  module: NativeDeviceKeyModule;
  platform: "ios" | "android";
}): PluginDevice {
  const { module, platform } = input;
  // Pair and sign run one at a time, so a re-pair never interleaves with a signature.
  let queue: Promise<unknown> = Promise.resolve();
  function serial<Result>(work: () => Promise<Result>): Promise<Result> {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  }
  return {
    async status(): Promise<DeviceStatus> {
      const status = await module.status();
      return {
        paired: status.paired,
        ...(status.paired ? { deviceId: status.deviceId, publicKey: status.publicKey } : {}),
        platform,
        keyStorage: status.keyStorage,
        userPresence: status.userPresence,
      };
    },
    async pair(options?: { code?: string }): Promise<DevicePairResult> {
      const reason = pairReason(options?.code);
      return serial(async () => {
        try {
          const paired = await module.pair(reason);
          return { ...paired, alg: "ES256", platform };
        } catch (error) {
          if (isCancelled(error)) throw new DevicePromptRefusedError();
          throw error;
        }
      });
    },
    async sign(payload: ChoicePayload, reason: string): Promise<ChoiceProof> {
      const valid = ChoicePayloadSchema.parse(payload);
      const bytes = choicePayloadBytes(valid);
      const prompt = promptReason(reason);
      return serial(async () => {
        let signed: { signature: string; deviceId: string };
        try {
          signed = await module.sign(toBase64(bytes), prompt);
        } catch (error) {
          if (isCancelled(error)) throw new DevicePromptRefusedError();
          throw error;
        }
        return {
          // The key that signed names itself; nothing read earlier is trusted for this.
          deviceId: signed.deviceId,
          alg: "ES256",
          signature: toBase64(derToP1363(fromBase64(signed.signature))),
          payload: valid,
        };
      });
    },
  };
}

// -- Desktop: the Electron main process ---------------------------------------------------------

export type DesktopInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

function isDesktopRefusal(error: unknown): boolean {
  return error instanceof Error && /prompt was cancelled/.test(error.message);
}

export function createDesktopDeviceKey(invoke: DesktopInvoke): PluginDevice {
  return {
    status: async () => (await invoke("device_status")) as DeviceStatus,
    async pair(options?: { code?: string }) {
      pairReason(options?.code);
      try {
        return (await invoke(
          "device_pair",
          options?.code ? { code: options.code } : {},
        )) as DevicePairResult;
      } catch (error) {
        if (isDesktopRefusal(error)) throw new DevicePromptRefusedError();
        if (error instanceof Error && /Pair from your iPhone/.test(error.message)) {
          throw new DevicePairingUnavailableError();
        }
        throw error;
      }
    },
    async sign(payload: ChoicePayload, reason: string) {
      const valid = ChoicePayloadSchema.parse(payload);
      promptReason(reason);
      try {
        return (await invoke("device_sign", { payload: valid, reason })) as ChoiceProof;
      } catch (error) {
        if (isDesktopRefusal(error)) throw new DevicePromptRefusedError();
        throw error;
      }
    },
  };
}
