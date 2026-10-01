import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  generateKeyPair,
  exportPublicKey,
  exportSecretKey,
  importPublicKey,
  importSecretKey,
  createClientChannel,
  type KeyPair,
  type Transport,
} from "@getpaseo/client/relay-v3";
import { buildRelayWebSocketUrl } from "@getpaseo/protocol/daemon-endpoints";
import type { ConnectionOffer } from "@getpaseo/protocol/connection-offer";
import { getDesktopHost } from "@/desktop/host";
const key = "fulcra:relay-device-identity:v3";

interface StoredIdentity {
  publicKeyB64: string;
  secretKeyB64: string;
}
type IdentityStorage = Pick<typeof AsyncStorage, "getItem" | "setItem"> &
  Partial<Pick<typeof AsyncStorage, "removeItem">>;

/**
 * Secure storage for the relay device identity (FC-2). On desktop the Electron main process keeps it
 * wrapped with safeStorage. iOS, Android and the plain browser have no secure store for it yet and
 * keep the v0.2 plaintext entry (a documented risk).
 */
export interface SecureRelayIdentityStore {
  load(): Promise<StoredIdentity | null>;
  store(identity: StoredIdentity): Promise<void>;
}

export function desktopRelayIdentityStore(): SecureRelayIdentityStore | null {
  const invoke = getDesktopHost()?.invoke;
  if (typeof invoke !== "function") return null;
  return {
    load: async () => (await invoke("relay_identity_load")) as StoredIdentity | null,
    store: async (identity) => {
      await invoke("relay_identity_store", { ...identity });
    },
  };
}

function decode(value: StoredIdentity): KeyPair {
  return {
    publicKey: importPublicKey(value.publicKeyB64),
    secretKey: importSecretKey(value.secretKeyB64),
  };
}

function encode(identity: KeyPair): StoredIdentity {
  return {
    publicKeyB64: exportPublicKey(identity.publicKey),
    secretKeyB64: exportSecretKey(identity.secretKey),
  };
}

function parseStored(saved: string): StoredIdentity {
  const value = JSON.parse(saved);
  const identity = { publicKeyB64: value.publicKeyB64, secretKeyB64: value.secretKeyB64 };
  decode(identity);
  return identity;
}

async function removePlaintext(storage: IdentityStorage): Promise<void> {
  if (!storage.removeItem) throw new Error("Plaintext device identity cannot be removed");
  await storage.removeItem(key);
}

// Desktop: the secure copy is authoritative. An existing plaintext key moves there unchanged, so
// hosts paired with it keep admitting this device; the plaintext is removed only after the secure
// copy reads back identical. Any failure leaves the plaintext in place and never creates a new key.
async function loadSecureIdentity(
  storage: IdentityStorage,
  secure: SecureRelayIdentityStore,
): Promise<KeyPair> {
  const saved = await secure.load();
  const plaintext = await storage.getItem(key);
  if (saved) {
    const identity = decode(saved);
    if (plaintext) await removePlaintext(storage);
    return identity;
  }
  if (plaintext) {
    const value = parseStored(plaintext);
    await secure.store(value);
    const stored = await secure.load();
    if (stored?.publicKeyB64 !== value.publicKeyB64 || stored.secretKeyB64 !== value.secretKeyB64)
      throw new Error("Device identity migration was not confirmed");
    await removePlaintext(storage);
    return decode(value);
  }
  const identity = generateKeyPair();
  await secure.store(encode(identity));
  return identity;
}

async function loadPlaintextIdentity(storage: IdentityStorage): Promise<KeyPair> {
  const saved = await storage.getItem(key);
  if (saved) return decode(parseStored(saved));
  const identity = generateKeyPair();
  await storage.setItem(key, JSON.stringify(encode(identity)));
  return identity;
}

export async function hasStoredDeviceIdentity(
  storage: Pick<typeof AsyncStorage, "getItem">,
  secure: SecureRelayIdentityStore | null = desktopRelayIdentityStore(),
): Promise<boolean> {
  if (secure) {
    try {
      const saved = await secure.load();
      if (saved) {
        decode(saved);
        return true;
      }
    } catch {
      // Unreadable secure storage is not a missing identity: never ask for a re-pair because of it.
      // The connection itself reports "Unable to access device identity".
      return true;
    }
  }
  const saved = await storage.getItem(key);
  if (!saved) return false;
  try {
    parseStored(saved);
    return true;
  } catch {
    return false;
  }
}

const inflight = new WeakMap<object, Promise<KeyPair>>();
export function getDeviceIdentity(
  storage: IdentityStorage = AsyncStorage,
  secure: SecureRelayIdentityStore | null = desktopRelayIdentityStore(),
): Promise<KeyPair> {
  const pending = inflight.get(storage);
  if (pending) return pending;
  const created = (
    secure ? loadSecureIdentity(storage, secure) : loadPlaintextIdentity(storage)
  ).catch(() => {
    throw new Error("Unable to access device identity");
  });
  inflight.set(storage, created);
  void created.catch(() => inflight.delete(storage));
  return created;
}

export async function pairRelayDevice(
  offer: ConnectionOffer,
  storage: IdentityStorage = AsyncStorage,
  secure: SecureRelayIdentityStore | null = desktopRelayIdentityStore(),
): Promise<string> {
  if (Date.parse(offer.pairing.expiresAt) <= Date.now())
    throw new Error("This pairing offer expired. Pair new devices from this Mac.");
  const deviceKeyPair = await getDeviceIdentity(storage, secure);
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      buildRelayWebSocketUrl({
        endpoint: offer.relay.endpoint,
        useTls: offer.relay.useTls,
        serverId: offer.serverId,
        role: "client",
      }),
    );
    socket.binaryType = "arraybuffer";
    let settled = false;
    const finish = (error: Error | null, deviceId?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.close();
      if (error) reject(error);
      else resolve(deviceId!);
    };
    const timeout = setTimeout(
      () => finish(new Error("Pairing timed out. Try a new offer.")),
      15000,
    );
    const transport: Transport = {
      send: (data) => socket.send(data),
      close: (code, reason) => socket.close(code, reason),
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    // A fresh socket: each listener is attached exactly once, as the former on-handlers were.
    socket.addEventListener("message", (event) =>
      transport.onmessage?.({ data: event.data, isBinary: typeof event.data !== "string" }),
    );
    socket.addEventListener("error", () => finish(new Error("Unable to reach this host")));
    socket.addEventListener("close", (event) => {
      transport.onclose?.(event.code, event.reason);
      finish(new Error("Pairing refused. Use a fresh offer from this Mac."));
    });
    socket.addEventListener("open", () => {
      let channel: Awaited<ReturnType<typeof createClientChannel>>;
      void createClientChannel(
        transport,
        offer.daemonPublicKeyB64,
        {
          onopen: () => {
            void channel
              .send(
                JSON.stringify({
                  type: "pairing.claim",
                  offerId: offer.pairing.id,
                  secret: offer.pairing.secret,
                  deviceName: "Fulcra device",
                }),
              )
              .catch((error) => finish(error));
          },
          onmessage: (data) => {
            try {
              const response = JSON.parse(String(data));
              if (
                response.type !== "pairing.claimed" ||
                !/^dev_[A-Za-z0-9_-]{16}$/.test(response.deviceId)
              )
                throw new Error("Invalid pairing reply");
              finish(null, response.deviceId);
            } catch {
              finish(new Error("Invalid pairing reply"));
            }
          },
          onerror: (error) => finish(error),
        },
        { deviceKeyPair, serverId: offer.serverId },
      )
        .then((value) => {
          channel = value;
          return value;
        })
        .catch((error) => finish(error));
    });
  });
}
