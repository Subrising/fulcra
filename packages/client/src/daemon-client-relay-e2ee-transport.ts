import { MAX_RELAY_WEBSOCKET_MESSAGE_BYTES } from "@getpaseo/protocol/websocket-message-limit";
import { PROTECTED_HANDSHAKE_FAILED_CLOSE_CODE, type SecurityMode } from "@getpaseo/relay/e2ee";
// FULCRA(relay-v3): the Fulcra relay keeps its own device-key handshake. The upstream protected
// (Noise) channel is a different wire protocol, so this transport stays on the v3 channel.
import {
  base64EncryptedWireByteLength,
  createClientChannel,
  maxBase64EncryptedPlaintextByteLength,
  type EncryptedChannel,
  type KeyPair,
  type Transport as RelayTransport,
} from "./relay-v3/index.js";
import type {
  DaemonTransport,
  DaemonTransportFactory,
  TransportLogger,
} from "./daemon-client-transport-types.js";
import {
  extractRelayMessage,
  normalizeTransportPayload,
  messageTooLargeError,
} from "./daemon-client-transport-utils.js";

type OpenHandler = () => void;
type CloseHandler = (event?: unknown) => void;
type ErrorHandler = (event?: unknown) => void;
type MessageHandler = (data: unknown, isBinary: boolean) => void;

export interface RelayE2eeTransportOptions {
  daemonPublicKeyB64: string;
  logger: TransportLogger;
  serverId?: string;
  getDeviceKeyPair?: () => Promise<KeyPair>;
  /** Direct device login: offer the device subprotocol on the upgrade. */
  directDevice?: boolean;
  assertOutboundCapacity?: (wireBytes: number) => void;
  /** Not supported on the Fulcra relay channel: a request for "protected" fails the handshake. */
  minimumMode?: SecurityMode;
  /** Reports the negotiated mode once the daemon has authenticated the handshake. */
  onSecurityMode?: (mode: SecurityMode) => void;
}

export function createRelayE2eeTransportFactory(
  args: RelayE2eeTransportOptions & { baseFactory: DaemonTransportFactory },
): DaemonTransportFactory {
  const { baseFactory, ...options } = args;
  // A relay upgrade carries routing only. Subprotocols pass through only for a direct device socket, where
  // they name the login (fulcra.device.v1) and carry no secret.
  return ({ url, protocols }) =>
    createEncryptedTransport(
      baseFactory(options.directDevice && protocols ? { url, protocols } : { url }),
      options,
    );
}

/**
 * Returns a user-facing message when this client closed the session itself
 * because endpoint security could not be established, so reconnecting cannot help.
 *
 * The daemon's own policy close never reaches the client: both relays replace a
 * daemon-side close with their own code (1012 on the wrangler relay).
 */
export function describeEndpointSecurityClose(event: unknown): string | null {
  if (!event || typeof event !== "object") return null;
  const code = "code" in event ? event.code : undefined;
  const reason = "reason" in event && typeof event.reason === "string" ? event.reason : "";
  if (code === PROTECTED_HANDSHAKE_FAILED_CLOSE_CODE) {
    return `Endpoint security handshake failed: ${reason || "protected mode unavailable"}`;
  }
  return null;
}

/**
 * Relay upgrades carry routing only. Daemon credentials and subprotocols must
 * never reach the relay; they travel inside the encrypted hello.
 */
export function createRelayUpgradeTransportFactory(
  baseFactory: DaemonTransportFactory,
): DaemonTransportFactory {
  return ({ url }) => baseFactory({ url });
}

export function createEncryptedTransport(
  base: DaemonTransport,
  options: RelayE2eeTransportOptions,
): DaemonTransport {
  const { daemonPublicKeyB64, logger, minimumMode, onSecurityMode } = options;
  const assertOutboundCapacity = options.assertOutboundCapacity ?? (() => {});
  let channel: EncryptedChannel | null = null;
  let opened = false;
  let closed = false;

  const openHandlers = new Set<OpenHandler>();
  const closeHandlers = new Set<CloseHandler>();
  const errorHandlers = new Set<ErrorHandler>();
  const messageHandlers = new Set<MessageHandler>();

  const emitOpen = () => {
    if (opened || closed) {
      return;
    }
    opened = true;
    emitHandlers(openHandlers);
  };

  const emitClose = (event?: unknown) => {
    if (closed) {
      return;
    }
    closed = true;
    emitHandlers(closeHandlers, event);
  };

  const emitError = (event?: unknown) => {
    if (closed) {
      return;
    }
    emitHandlers(errorHandlers, event);
  };

  const emitMessage = (data: unknown) => {
    if (closed) {
      return;
    }
    emitHandlers(messageHandlers, data, data instanceof ArrayBuffer);
  };

  const relayTransport: RelayTransport = {
    send: (data) => {
      if (typeof data === "string") {
        return base.send(data);
      }
      if (ArrayBuffer.isView(data)) {
        return base.send(normalizeTransportPayload(data));
      }
      if (data instanceof ArrayBuffer) {
        return base.send(data);
      }
      return base.send(String(data));
    },
    close: (code?: number, reason?: string) => base.close(code, reason),
    onmessage: null,
    onclose: null,
    onerror: null,
  };

  const startHandshake = async () => {
    try {
      if (minimumMode === "protected") {
        throw new Error("Protected endpoint security is not available on this relay channel");
      }
      const deviceKeyPair = await options.getDeviceKeyPair?.();
      channel = await createClientChannel(
        relayTransport,
        daemonPublicKeyB64,
        {
          onopen: () => {
            onSecurityMode?.("legacy");
            emitOpen();
          },
          onmessage: (data) => emitMessage(data),
          onclose: (code, reason, trusted) =>
            emitClose({ code, reason: trusted ? reason : "Relay connection closed", trusted }),
          onerror: (error) => emitError(error),
        },
        { deviceKeyPair, serverId: options.serverId },
      );
    } catch {
      logger.warn({}, "relay_e2ee_handshake_failed");
      emitError(new Error("Unable to establish secure relay connection"));
      // Browser WebSocket.close only accepts 1000 or 3000-4999.
      // Use an app-defined code so this path works in browser and Node runtimes.
      base.close(4001, "E2EE handshake failed");
    }
  };

  base.onOpen(() => {
    void startHandshake();
  });
  base.onMessage((data, isBinary) => {
    relayTransport.onmessage?.(extractRelayMessage(data, isBinary));
  });
  base.onClose((event) => {
    const record = event as { code?: number; reason?: string } | undefined;
    relayTransport.onclose?.(record?.code ?? 0, record?.reason ?? "");
    emitClose({ code: record?.code, reason: "Relay connection closed", trusted: false });
  });
  base.onError((event) => {
    relayTransport.onerror?.(event instanceof Error ? event : new Error(String(event)));
    emitError(event);
  });

  return {
    supportsDrain: base.supportsDrain,
    maxFrameBytes: maxBase64EncryptedPlaintextByteLength(MAX_RELAY_WEBSOCKET_MESSAGE_BYTES),
    send: (data) => {
      if (!channel) {
        throw new Error("Encrypted channel not ready");
      }
      const payload = normalizeTransportPayload(data);
      // Reject synchronously so the requesting operation fails without closing the transport.
      const wireBytes = base64EncryptedWireByteLength(
        typeof payload === "string"
          ? new TextEncoder().encode(payload).byteLength
          : payload.byteLength,
      );
      if (wireBytes > MAX_RELAY_WEBSOCKET_MESSAGE_BYTES) {
        throw messageTooLargeError(wireBytes, MAX_RELAY_WEBSOCKET_MESSAGE_BYTES);
      }
      // Encryption and its transport handoff are synchronous up to send's first await.
      // Reject capacity failures here so a routed sender loses only its own channel.
      assertOutboundCapacity(wireBytes);
      return channel.send(payload).catch((error) => {
        emitError(error);
        throw error;
      });
    },
    close: (code?: number, reason?: string) => {
      // Record local intent before a synchronous base close callback can race it.
      emitClose({ code, reason, trusted: true });
      if (channel) {
        channel.close(code, reason);
      } else {
        base.close(code, reason);
      }
    },
    onMessage: (handler) => {
      messageHandlers.add(handler);
      return () => messageHandlers.delete(handler);
    },
    onOpen: (handler) => {
      openHandlers.add(handler);
      if (opened) {
        invokeHandler(handler);
      }
      return () => openHandlers.delete(handler);
    },
    onClose: (handler) => {
      closeHandlers.add(handler);
      if (closed) {
        invokeHandler(handler);
      }
      return () => closeHandlers.delete(handler);
    },
    onError: (handler) => {
      errorHandlers.add(handler);
      return () => errorHandlers.delete(handler);
    },
  };
}

function emitHandlers<TArgs extends unknown[]>(
  handlers: Set<(...args: TArgs) => void>,
  ...args: TArgs
) {
  for (const handler of handlers) {
    invokeHandler(handler, ...args);
  }
}

function invokeHandler<TArgs extends unknown[]>(handler: (...args: TArgs) => void, ...args: TArgs) {
  try {
    handler(...args);
  } catch {
    // no-op
  }
}
