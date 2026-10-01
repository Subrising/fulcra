/// <reference lib="dom" />
/**
 * Encrypted channel that wraps a WebSocket-like transport.
 *
 * Handles ECDH handshake and encrypts/decrypts all messages.
 * Works identically for daemon and client sides.
 */

import {
  generateKeyPair,
  exportPublicKey,
  importPublicKey,
  deriveSharedKey,
  deriveSessionKeysV3,
  createSessionChallenge,
  encrypt,
  decrypt,
  type KeyPair,
  type SharedKey,
} from "./crypto.js";
import { arrayBufferToBase64, base64ToArrayBuffer } from "./base64.js";

export interface Transport {
  send(data: string | ArrayBuffer): void | Promise<void>;
  close(code?: number, reason?: string): void;
  onmessage: ((message: TransportMessage) => void) | null;
  onclose: ((code: number, reason: string) => void) | null;
  onerror: ((error: Error) => void) | null;
}

export interface TransportMessage {
  data: string | ArrayBuffer;
  isBinary: boolean;
}

export interface EncryptedChannelEvents {
  onopen?: () => void;
  onmessage?: (data: string | ArrayBuffer) => void;
  onclose?: (code: number, reason: string, trusted: boolean) => void;
  onerror?: (error: Error) => void;
}

type ChannelState = "connecting" | "handshaking" | "open" | "closed";

interface EncryptedChannelOptions {
  /**
   * If set, the channel can validate repeated plaintext `{type:"e2ee_hello"}`
   * messages even after it is open.
   *
   * This is useful for robustness when the client retries the handshake
   * (e.g., it didn't observe the daemon's `{type:"e2ee_ready"}` yet). In that case,
   * the daemon should re-send `{type:"e2ee_ready"}` without changing keys.
   */
  daemonKeyPair?: KeyPair;
  binaryCiphertext?: boolean;
  receiveKey?: SharedKey;
  helloKey?: string;
  helloDevice?: string;
  readyText?: string;
  clientKeys?: { ephemeral: SharedKey; device: SharedKey; serverId: string };
}

interface E2EEHelloMessage {
  type: "e2ee_hello";
  key: string;
  v: 3;
  device: string;
  capabilities?: E2EECapabilities;
}

interface E2EEReadyMessage {
  type: "e2ee_ready";
  v: 3;
  challenge: string;
  capabilities?: E2EECapabilities;
}

interface E2EECapabilities {
  binaryCiphertext?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isE2EECapabilities(value: unknown): value is E2EECapabilities {
  return (
    value === undefined ||
    (isRecord(value) &&
      (value.binaryCiphertext === undefined || typeof value.binaryCiphertext === "boolean"))
  );
}

function isE2EEHelloMessage(value: unknown): value is E2EEHelloMessage {
  return (
    isRecord(value) &&
    value.type === "e2ee_hello" &&
    value.v === 3 &&
    typeof value.device === "string" &&
    typeof value.key === "string" &&
    value.key.trim().length > 0 &&
    isE2EECapabilities(value.capabilities)
  );
}

function isE2EEReadyMessage(value: unknown): value is E2EEReadyMessage {
  return (
    isRecord(value) &&
    value.type === "e2ee_ready" &&
    value.v === 3 &&
    typeof value.challenge === "string" &&
    isE2EECapabilities(value.capabilities)
  );
}

function supportsBinaryCiphertext(message: E2EEHelloMessage | E2EEReadyMessage): boolean {
  return message.capabilities?.binaryCiphertext === true;
}

function buildInvalidHelloError(): Error {
  return new Error("Invalid hello message");
}

const HANDSHAKE_RETRY_MS = 1000;
const MAX_PENDING_SENDS = 200;
const REHANDSHAKE_REJECTION_CODE = 1008;
const ENCRYPTED_PAYLOAD_OVERHEAD_BYTES = 48;

export function base64EncryptedWireByteLength(plaintextBytes: number): number {
  return 4 * Math.ceil((plaintextBytes + ENCRYPTED_PAYLOAD_OVERHEAD_BYTES) / 3);
}

export function maxBase64EncryptedPlaintextByteLength(wireBytes: number): number {
  return Math.floor(wireBytes / 4) * 3 - ENCRYPTED_PAYLOAD_OVERHEAD_BYTES;
}
const REHANDSHAKE_KEY_MISMATCH_CLOSE_REASON = "E2EE re-handshake key mismatch";

interface TimeoutWithUnref {
  unref(): void;
}

function hasUnref(timeout: unknown): timeout is TimeoutWithUnref {
  return (
    typeof timeout === "object" &&
    timeout !== null &&
    "unref" in timeout &&
    typeof (timeout as Record<string, unknown>).unref === "function"
  );
}

/**
 * Creates an encrypted channel as the initiator (client).
 *
 * The client:
 * 1. Receives daemon's public key via QR code
 * 2. Generates own keypair
 * 3. Sends e2ee_hello with own public key
 * 4. Derives shared key and starts encrypted communication
 */
export async function createClientChannel(
  transport: Transport,
  daemonPublicKeyB64: string,
  events: EncryptedChannelEvents = {},
  identity: { deviceKeyPair?: KeyPair; serverId?: string } = {},
): Promise<EncryptedChannel> {
  const keyPair = generateKeyPair();
  const daemonPublicKey = importPublicKey(daemonPublicKeyB64);
  const sharedKey = deriveSharedKey(keyPair.secretKey, daemonPublicKey);

  const deviceKeyPair = identity.deviceKeyPair ?? generateKeyPair();
  const channel = new EncryptedChannel(transport, sharedKey, events, {
    clientKeys: {
      ephemeral: sharedKey,
      device: deriveSharedKey(deviceKeyPair.secretKey, daemonPublicKey),
      serverId: identity.serverId ?? "",
    },
  });

  // Send e2ee_hello with our public key
  const ourPublicKeyB64 = exportPublicKey(keyPair.publicKey);
  const hello: E2EEHelloMessage = {
    type: "e2ee_hello",
    v: 3,
    device: exportPublicKey(deviceKeyPair.publicKey),
    key: ourPublicKeyB64,
    capabilities: { binaryCiphertext: true },
  };
  const helloText = JSON.stringify(hello);

  let retry: ReturnType<typeof setInterval> | null = null;
  const emitSendError = (error: unknown) => {
    const err = error instanceof Error ? error : new Error(String(error));
    events.onerror?.(err);
  };
  const sendHello = () => {
    try {
      const result = transport.send(helloText);
      if (result) {
        void result.catch(emitSendError);
      }
      return true;
    } catch (error) {
      // This can happen during daemon restarts while the socket transitions
      // through CLOSING/CLOSED states. Report it but do not throw from timers.
      emitSendError(error);
      return false;
    }
  };
  const clearRetry = () => {
    if (retry) {
      clearInterval(retry);
      retry = null;
    }
  };

  channel.onTransitionToOpen(() => clearRetry());
  channel.onClose(() => clearRetry());

  sendHello();
  retry = setInterval(() => {
    if (channel.isOpen()) {
      clearRetry();
      return;
    }
    sendHello();
  }, HANDSHAKE_RETRY_MS);
  // Avoid keeping Node processes alive (e.g. tests) if the handshake is stuck.
  if (hasUnref(retry)) {
    retry.unref();
  }

  return channel;
}

/**
 * Creates an encrypted channel as the responder (daemon).
 *
 * The daemon:
 * 1. Has pre-generated keypair (public key was in QR)
 * 2. Waits for client's e2ee_hello with their public key
 * 3. Derives shared key and starts encrypted communication
 */
export async function createDaemonChannel(
  transport: Transport,
  daemonKeyPair: KeyPair,
  events: EncryptedChannelEvents = {},
  serverId = "",
): Promise<EncryptedChannel> {
  return new Promise((resolve, reject) => {
    const bufferedMessages: TransportMessage[] = [];
    const shouldIgnorePostHelloPlaintext = (message: TransportMessage): boolean => {
      try {
        if (message.isBinary) return false;
        const text = decodeTransportText(message.data);
        const parsed: unknown = JSON.parse(text);
        return isE2EEHelloMessage(parsed) || isE2EEReadyMessage(parsed);
      } catch {
        return false;
      }
    };

    const handleHello = async (message: TransportMessage): Promise<void> => {
      try {
        if (message.isBinary) {
          throw buildInvalidHelloError();
        }
        const helloText = decodeTransportText(message.data);

        let parsed: unknown;
        try {
          parsed = JSON.parse(helloText);
        } catch {
          throw buildInvalidHelloError();
        }

        if (!isE2EEHelloMessage(parsed)) {
          transport.close(4426, "Update Fulcra to pair");
          throw new Error("Update Fulcra to pair");
        }

        const msg = parsed;

        // Buffer any subsequent messages that arrive while we're doing async
        // WebCrypto work to derive the shared key. Without this, it's possible
        // for the next message (already encrypted) to be misinterpreted as a
        // second hello, causing the handshake to fail.
        const bufferNext = (next: TransportMessage): void => {
          bufferedMessages.push(next);
        };
        Object.assign(transport, { onmessage: bufferNext });

        const clientPublicKey = importPublicKey(msg.key);
        const sharedKey = deriveSharedKey(daemonKeyPair.secretKey, clientPublicKey);

        const challenge = createSessionChallenge();
        const keys = deriveSessionKeysV3(
          sharedKey,
          deriveSharedKey(daemonKeyPair.secretKey, importPublicKey(msg.device)),
          serverId,
          challenge,
        );
        const binaryCiphertext = supportsBinaryCiphertext(msg);
        const readyText = JSON.stringify({
          type: "e2ee_ready",
          v: 3,
          challenge: exportPublicKey(challenge),
          capabilities: { binaryCiphertext },
        });
        const channel = new EncryptedChannel(transport, keys.s2c, events, {
          daemonKeyPair,
          binaryCiphertext,
          receiveKey: keys.c2s,
          helloKey: msg.key,
          helloDevice: msg.device,
          readyText,
        });
        channel.devicePublicKeyB64 = msg.device;
        channel.setState("open");
        await transport.send(readyText);
        events.onopen?.();

        for (const buffered of bufferedMessages) {
          if (shouldIgnorePostHelloPlaintext(buffered)) continue;
          transport.onmessage?.(buffered);
        }

        resolve(channel);
      } catch (error) {
        reject(error);
      }
    };

    Object.assign(transport, {
      onmessage: handleHello,
      onerror: (error: Error) => {
        reject(error);
      },
      onclose: (code: number, reason: string) => {
        reject(new Error(`Connection closed during handshake: ${code} ${reason}`));
      },
    });
  });
}

/**
 * Encrypted channel that wraps a transport with E2EE.
 */
export class EncryptedChannel {
  devicePublicKeyB64?: string;
  private sentCounter = 0n;
  private receivedCounter = 0n;
  private transport: Transport;
  private sharedKey: SharedKey;
  private state: ChannelState = "handshaking";
  private events: EncryptedChannelEvents;
  private options: EncryptedChannelOptions;
  private pendingSends: Array<string | ArrayBuffer> = [];
  private onOpenCallbacks: Array<() => void> = [];
  private onCloseCallbacks: Array<() => void> = [];

  constructor(
    transport: Transport,
    sharedKey: SharedKey,
    events: EncryptedChannelEvents = {},
    options: EncryptedChannelOptions = {},
  ) {
    this.transport = transport;
    this.sharedKey = sharedKey;
    this.events = events;
    this.options = options;

    Object.assign(transport, {
      onmessage: (message: TransportMessage) => this.handleMessage(message),
      onclose: (code: number, reason: string) => {
        this.state = "closed";
        this.events.onclose?.(code, reason, false);
        for (const cb of this.onCloseCallbacks) cb();
      },
      onerror: (error: Error) => {
        this.events.onerror?.(error);
      },
    });
  }

  setState(state: ChannelState): void {
    this.state = state;
  }

  private async handleMessage(message: TransportMessage): Promise<void> {
    if (this.state === "handshaking") {
      await this.handleHandshakeMessage(message);
      return;
    }

    if (this.state !== "open") return;

    await this.handleOpenMessage(message);
  }

  private async handleHandshakeMessage(message: TransportMessage): Promise<void> {
    try {
      if (message.isBinary) return;
      const text = decodeTransportText(message.data);
      const parsed: unknown = JSON.parse(text);
      if (isRecord(parsed) && parsed.type === "e2ee_ready" && !isE2EEReadyMessage(parsed)) {
        this.close(4426, "Update Fulcra to pair");
        return;
      }
      if (isE2EEReadyMessage(parsed)) {
        const inputs = this.options.clientKeys;
        if (!inputs) throw new Error("Missing client identity");
        const keys = deriveSessionKeysV3(
          inputs.ephemeral,
          inputs.device,
          inputs.serverId,
          importPublicKey(parsed.challenge),
        );
        this.sharedKey = keys.c2s;
        this.options.receiveKey = keys.s2c;
        this.options.binaryCiphertext = supportsBinaryCiphertext(parsed);
        this.state = "open";
        this.events.onopen?.();
        for (const cb of this.onOpenCallbacks) cb();
        try {
          await this.flushPendingSends();
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          this.events.onerror?.(err);
          this.close(1011, err.message);
        }
      }
    } catch {
      // ignore non-ready handshake traffic
    }
  }

  /** Stray plaintext handshake traffic yields null; otherwise the frame's ciphertext. */
  private async readCiphertext(
    message: TransportMessage,
  ): Promise<{ data: ArrayBuffer; isBinary: boolean | null } | null> {
    // Handle (or ignore) any stray plaintext handshake traffic.
    try {
      if (message.isBinary) throw new Error("not plaintext handshake traffic");
      const text = decodeTransportText(message.data);
      if (text.trim().startsWith("{")) {
        const parsed: unknown = JSON.parse(text);

        if (isE2EEHelloMessage(parsed)) {
          if (this.options.daemonKeyPair) {
            await this.handleDaemonRehello(parsed);
          }
          return null;
        }

        if (isE2EEReadyMessage(parsed)) {
          return null;
        }

        // Any other JSON-looking payload is plaintext app traffic, which
        // means the peer is not encrypting (or we are out of sync).
        throw new Error("Received plaintext frame on encrypted channel");
      }
    } catch (error) {
      // If we detected plaintext protocol mismatch, fail hard.
      if (error instanceof Error && error.message.includes("plaintext frame")) {
        throw error;
      }
      // Otherwise ignore JSON parse/TextDecoder failures and fall back to
      // decoding ciphertext below.
    }

    if (this.options.binaryCiphertext) {
      return message.isBinary
        ? { data: requireArrayBuffer(message.data), isBinary: true as const }
        : {
            data: base64ToArrayBuffer(decodeTransportText(message.data)),
            isBinary: false as const,
          };
    }

    // COMPAT(binaryCiphertext): added in v0.2.3, remove legacy base64-only
    // receive mode after 2027-01-27.
    if (!message.isBinary) {
      return { data: base64ToArrayBuffer(decodeTransportText(message.data)), isBinary: null };
    }

    // Older transport adapters could lose the opcode. Retain the former
    // base64-first behavior only in the legacy path.
    try {
      return { data: base64ToArrayBuffer(decodeTransportText(message.data)), isBinary: null };
    } catch {
      return { data: requireArrayBuffer(message.data), isBinary: null };
    }
  }

  private async handleOpenMessage(message: TransportMessage): Promise<void> {
    try {
      const ciphertext = await this.readCiphertext(message);

      if (ciphertext) {
        const framed = decrypt(this.options.receiveKey ?? this.sharedKey, ciphertext.data);
        if (
          framed.byteLength < 8 ||
          new DataView(framed).getBigUint64(0) !== this.receivedCounter + 1n
        ) {
          this.state = "closed";
          this.transport.close(4409, "E2EE sequence error");
          return;
        }
        this.receivedCounter += 1n;
        const plaintext = decodePlaintext(framed.slice(8), ciphertext.isBinary);
        if (!this.options.daemonKeyPair && typeof plaintext === "string") {
          let terminal: unknown;
          try {
            terminal = JSON.parse(plaintext);
          } catch {
            /* application payload */
          }
          if (
            isRecord(terminal) &&
            terminal.type === "fulcra.channel.closed" &&
            (terminal.code === 4403 || terminal.code === 4426)
          ) {
            // Authentication and sequence checks above precede this terminal signal.
            this.close(
              terminal.code,
              terminal.code === 4403 ? "Device unpaired" : "Update Fulcra to pair",
              true,
            );
            return;
          }
        }
        this.events.onmessage?.(plaintext);
      }
    } catch {
      // Treat decryption/protocol errors as fatal so the peer can reconnect and
      // re-handshake. Emitting an error event here can cause higher-level code
      // to tear down the session without triggering a clean reconnect.
      try {
        this.state = "closed";
        this.transport.close(4409, "E2EE sequence error");
      } catch {
        // ignore
      }
    }
  }

  async send(data: string | ArrayBuffer): Promise<void> {
    if (this.state === "handshaking") {
      if (this.pendingSends.length >= MAX_PENDING_SENDS) {
        this.pendingSends.shift();
      }
      this.pendingSends.push(data);
      return;
    }

    if (this.state !== "open") {
      throw new Error("Channel not open");
    }

    if (this.sentCounter === 0xffffffffffffffffn) throw new Error("E2EE counter exhausted");
    const payload =
      typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
    const framed = new Uint8Array(8 + payload.length);
    new DataView(framed.buffer).setBigUint64(0, ++this.sentCounter);
    framed.set(payload, 8);
    const ciphertext = encrypt(this.sharedKey, framed.buffer);
    if (this.options.binaryCiphertext && data instanceof ArrayBuffer) {
      await this.transport.send(ciphertext);
      return;
    }
    // COMPAT(binaryCiphertext): added in v0.2.3, remove base64 binary sends
    // after 2027-01-27 once the supported peer floor includes negotiation.
    await this.transport.send(arrayBufferToBase64(ciphertext));
  }

  outboundWireByteLength(data: string | ArrayBuffer): number {
    const plaintextBytes = utf8ByteLength(data);
    const encryptedBytes = plaintextBytes + ENCRYPTED_PAYLOAD_OVERHEAD_BYTES;
    if (this.options.binaryCiphertext && data instanceof ArrayBuffer) {
      return encryptedBytes;
    }
    return base64EncryptedWireByteLength(plaintextBytes);
  }

  private async flushPendingSends(): Promise<void> {
    if (this.state !== "open") return;
    const pending = this.pendingSends;
    this.pendingSends = [];
    for (const item of pending) {
      await this.send(item);
    }
  }

  private async handleDaemonRehello(message: E2EEHelloMessage): Promise<void> {
    if (!this.options.daemonKeyPair) return;
    if (message.key !== this.options.helloKey || message.device !== this.options.helloDevice)
      return this.rejectKeyRotation();
    if (this.options.readyText) await this.transport.send(this.options.readyText);
  }

  private rejectKeyRotation(): void {
    this.state = "closed";
    this.transport.close(REHANDSHAKE_REJECTION_CODE, REHANDSHAKE_KEY_MISMATCH_CLOSE_REASON);
  }

  close(code = 1000, reason = "Normal closure", authenticated = false): void {
    if (this.options.daemonKeyPair && this.state === "open" && code === 4403) {
      // send() synchronously queues ciphertext before the close handshake.
      void this.send(JSON.stringify({ type: "fulcra.channel.closed", code: 4403 })).catch(() => {});
    }
    this.state = "closed";
    for (const cb of this.onCloseCallbacks) cb();
    this.events.onclose?.(code, reason, authenticated);
    this.transport.close(code, reason);
  }

  isOpen(): boolean {
    return this.state === "open";
  }

  onTransitionToOpen(cb: () => void): void {
    this.onOpenCallbacks.push(cb);
  }

  onClose(cb: () => void): void {
    this.onCloseCallbacks.push(cb);
  }
}

function decodeTransportText(data: string | ArrayBuffer): string {
  return typeof data === "string" ? data : new TextDecoder().decode(data);
}

function requireArrayBuffer(data: string | ArrayBuffer): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  throw new Error("Binary WebSocket frame did not contain bytes");
}

function decodeLegacyPlaintext(data: ArrayBuffer): string | ArrayBuffer {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return data;
  }
}

function decodePlaintext(data: ArrayBuffer, isBinary: boolean | null): string | ArrayBuffer {
  if (isBinary === true) return data;
  if (isBinary === false) return new TextDecoder("utf-8", { fatal: true }).decode(data);
  return decodeLegacyPlaintext(data);
}

function utf8ByteLength(data: string | ArrayBuffer): number {
  return typeof data === "string" ? new TextEncoder().encode(data).byteLength : data.byteLength;
}
