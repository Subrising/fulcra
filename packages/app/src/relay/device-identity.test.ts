import { describe, expect, it, vi } from "vitest";
vi.mock("@react-native-async-storage/async-storage", () => ({ default: {} }));
import {
  createDaemonChannel,
  exportPublicKey,
  exportSecretKey,
  generateKeyPair,
  type Transport,
} from "@getpaseo/client/relay-v3";
import type { ConnectionOffer } from "@getpaseo/protocol/connection-offer";
import { getDeviceIdentity, hasStoredDeviceIdentity, pairRelayDevice } from "./device-identity";

it("does not disclose damaged or rejected device-key storage in errors", async () => {
  const secret = "DEVICE_KEY_SENTINEL_DO_NOT_LOG";
  for (const storage of [
    { getItem: async () => `${secret}{`, setItem: async () => {} },
    {
      getItem: async () => null,
      setItem: async () => {
        throw new Error(secret);
      },
    },
  ]) {
    const error = await getDeviceIdentity(storage).catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toBe("Error: Unable to access device identity");
    expect(String(error)).not.toContain(secret);
  }
});
it("reuses one persisted device key rather than creating a key on every connection", async () => {
  let saved: string | null = null;
  const storage = {
    getItem: async () => saved,
    setItem: async (_key: string, value: string) => {
      saved = value;
    },
  };
  const [a, b] = await Promise.all([getDeviceIdentity(storage), getDeviceIdentity(storage)]);
  expect(a.publicKey).toEqual(b.publicKey);
  expect((await getDeviceIdentity({ ...storage })).secretKey).toEqual(a.secretKey);
});

it("REPAIR detects missing or damaged identity without silently generating a key", async () => {
  expect(await hasStoredDeviceIdentity({ getItem: async () => null })).toBe(false);
  expect(await hasStoredDeviceIdentity({ getItem: async () => "not-json" })).toBe(false);
  let saved: string | null = null;
  await getDeviceIdentity({
    getItem: async () => saved,
    setItem: async (_key, value) => {
      saved = value;
    },
  });
  expect(await hasStoredDeviceIdentity({ getItem: async () => saved })).toBe(true);
});

// FC-2: the relay device identity lives in desktop secure storage, never in renderer storage.
describe("FC-2 relay device identity in secure storage", () => {
  const plaintextKey = "fulcra:relay-device-identity:v3";

  function memoryStorage(initial: Record<string, string> = {}) {
    const values = new Map(Object.entries(initial));
    return {
      values,
      getItem: vi.fn(async (name: string) => values.get(name) ?? null),
      setItem: vi.fn(async (name: string, value: string) => {
        values.set(name, value);
      }),
      removeItem: vi.fn(async (name: string) => {
        values.delete(name);
      }),
    };
  }

  function secureStore(options: { failStore?: boolean; failLoad?: boolean } = {}) {
    let saved: SecureIdentity | null = null;
    return {
      options,
      get saved() {
        return saved;
      },
      load: vi.fn(async () => {
        if (options.failLoad) throw new Error("keychain locked");
        return saved;
      }),
      store: vi.fn(async (identity: SecureIdentity) => {
        if (options.failStore) throw new Error("keychain refused");
        saved = { ...identity };
      }),
    };
  }
  interface SecureIdentity {
    publicKeyB64: string;
    secretKeyB64: string;
  }

  function plaintextIdentity() {
    const pair = generateKeyPair();
    const value = {
      publicKeyB64: exportPublicKey(pair.publicKey),
      secretKeyB64: exportSecretKey(pair.secretKey),
    };
    return { pair, value, json: JSON.stringify(value) };
  }

  it("creates a fresh identity in secure storage and writes nothing to renderer storage", async () => {
    const storage = memoryStorage();
    const secure = secureStore();
    const identity = await getDeviceIdentity(storage, secure);
    expect(secure.saved?.publicKeyB64).toBe(exportPublicKey(identity.publicKey));
    expect(secure.saved?.secretKeyB64).toBe(exportSecretKey(identity.secretKey));
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.values.size).toBe(0);
    expect(await hasStoredDeviceIdentity(storage, secure)).toBe(true);
  });

  it("migrates an existing plaintext v3 key unchanged, then removes the plaintext", async () => {
    const legacy = plaintextIdentity();
    const storage = memoryStorage({ [plaintextKey]: legacy.json });
    const secure = secureStore();
    const identity = await getDeviceIdentity(storage, secure);
    expect(identity.publicKey).toEqual(legacy.pair.publicKey);
    expect(identity.secretKey).toEqual(legacy.pair.secretKey);
    expect(secure.saved).toEqual(legacy.value);
    expect(storage.values.has(plaintextKey)).toBe(false);
    expect(storage.setItem).not.toHaveBeenCalled();
    // A later start finds only the secure copy and keeps the same identity: no re-pair.
    const again = await getDeviceIdentity(memoryStorage(), secure);
    expect(again.publicKey).toEqual(legacy.pair.publicKey);
    expect(await hasStoredDeviceIdentity(storage, secure)).toBe(true);
  });

  it("removes a leftover plaintext copy once the secure identity exists", async () => {
    const legacy = plaintextIdentity();
    const secure = secureStore();
    await secure.store(legacy.value);
    const storage = memoryStorage({ [plaintextKey]: legacy.json });
    const identity = await getDeviceIdentity(storage, secure);
    expect(identity.publicKey).toEqual(legacy.pair.publicKey);
    expect(storage.values.has(plaintextKey)).toBe(false);
  });

  it("a failed migration keeps the plaintext key and never creates a new identity", async () => {
    const legacy = plaintextIdentity();
    const storage = memoryStorage({ [plaintextKey]: legacy.json });
    const secure = secureStore({ failStore: true });
    const error = await getDeviceIdentity(storage, secure).catch((caught: Error) => caught);
    expect(String(error)).toBe("Error: Unable to access device identity");
    expect(storage.values.get(plaintextKey)).toBe(legacy.json);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(secure.saved).toBeNull();
    // The host list must not demand a re-pair while the key is still only in plaintext.
    expect(await hasStoredDeviceIdentity(storage, secure)).toBe(true);
    // Once secure storage works, the same key migrates.
    secure.options.failStore = false;
    const identity = await getDeviceIdentity(storage, secure);
    expect(identity.publicKey).toEqual(legacy.pair.publicKey);
    expect(storage.values.has(plaintextKey)).toBe(false);
  });

  it("an unconfirmed migration or unreadable secure storage fails safe", async () => {
    const legacy = plaintextIdentity();
    const storage = memoryStorage({ [plaintextKey]: legacy.json });
    const lost = secureStore();
    lost.store.mockImplementation(async () => {}); // accepted, but never reads back
    await expect(getDeviceIdentity(storage, lost)).rejects.toThrow(
      "Unable to access device identity",
    );
    expect(storage.values.get(plaintextKey)).toBe(legacy.json);

    const locked = secureStore({ failLoad: true });
    const empty = memoryStorage();
    await expect(getDeviceIdentity(empty, locked)).rejects.toThrow(
      "Unable to access device identity",
    );
    expect(locked.store).not.toHaveBeenCalled();
    expect(empty.setItem).not.toHaveBeenCalled();
    expect(await hasStoredDeviceIdentity(empty, locked)).toBe(true);
  });

  it("a migrated device still pairs, presenting the same device key to the host", async () => {
    const legacy = plaintextIdentity();
    const storage = memoryStorage({ [plaintextKey]: legacy.json });
    const secure = secureStore();
    const host = generateKeyPair();
    const seenDevices: string[] = [];
    const claims: unknown[] = [];
    const stages: string[] = [];
    // Socket events arrive on a later task, as they do from a real relay.
    const later = (work: () => void) => setTimeout(work, 1);

    class RelaySocket {
      binaryType = "";
      private listeners = new Map<string, Array<(event: unknown) => void>>();
      private readonly daemonSide: Transport;
      constructor() {
        const emit = (type: string, event: unknown) => {
          for (const listener of this.listeners.get(type) ?? []) listener(event);
        };
        this.daemonSide = {
          send: (data) => {
            stages.push("daemon-send");
            later(() => emit("message", { data }));
          },
          close: () => {},
          onmessage: null,
          onclose: null,
          onerror: null,
        };
        let channel: Awaited<ReturnType<typeof createDaemonChannel>> | undefined;
        void createDaemonChannel(
          this.daemonSide,
          host,
          {
            onmessage: (data) => {
              stages.push("claim");
              claims.push(JSON.parse(String(data)));
              void channel?.send(
                JSON.stringify({ type: "pairing.claimed", deviceId: "dev_ABCDEFGHIJKLMNOP" }),
              );
            },
          },
          "srv-fixture",
        ).then((opened) => {
          stages.push("daemon-open");
          channel = opened;
          seenDevices.push(opened.devicePublicKeyB64 ?? "");
          return opened;
        });
        later(() => emit("open", {}));
      }
      addEventListener(type: string, listener: (event: unknown) => void) {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
      }
      send(data: string | ArrayBuffer) {
        stages.push("client-send");
        later(() => this.daemonSide.onmessage?.({ data, isBinary: typeof data !== "string" }));
      }
      close() {}
    }
    vi.stubGlobal("WebSocket", RelaySocket);
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stuck = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Pairing stalled after: ${stages}`)), 4000);
      });
      const deviceId = await Promise.race([
        pairRelayDevice(
          {
            serverId: "srv-fixture",
            daemonPublicKeyB64: exportPublicKey(host.publicKey),
            relay: { endpoint: "relay.example.test:443", useTls: true },
            pairing: {
              id: "offer-fixture",
              secret: "A".repeat(43),
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
          } as unknown as ConnectionOffer,
          storage,
          secure,
        ),
        stuck,
      ]).finally(() => clearTimeout(timer));
      expect(deviceId).toBe("dev_ABCDEFGHIJKLMNOP");
      expect(seenDevices).toEqual([legacy.value.publicKeyB64]);
      expect(claims).toEqual([expect.objectContaining({ type: "pairing.claim" })]);
      expect(storage.values.has(plaintextKey)).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
