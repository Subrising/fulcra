import { DEFAULT_RELAY_ENDPOINT } from "@getpaseo/protocol/daemon-endpoints";
import { OfferStore } from "./pairing/offer-store.js";
import { DeviceRegistry } from "./pairing/device-registry.js";
import { RelayDeviceGate } from "./pairing/relay-device-gate.js";
import type pino from "pino";
import type { KeyPair } from "@getpaseo/relay/e2ee";
import type { ExternalSocketMetadata } from "./websocket-server.js";
import {
  startRelayTransport,
  type RelaySocketLike,
  type RelayTransportController,
} from "./relay-transport.js";

export interface RelayRuntimeConfig {
  pairingOfferTtlSeconds?: number;
  enabled: boolean;
  endpoint: string;
  publicEndpoint: string;
  useTls: boolean;
  publicUseTls: boolean;
}

interface RelayRuntimeOptions {
  config: RelayRuntimeConfig;
  paseoHome: string;
  logger: pino.Logger;
  attachSocket(ws: RelaySocketLike, metadata?: ExternalSocketMetadata): Promise<void>;
  serverId: string;
  daemonKeyPair: KeyPair;
  startTransport?: typeof startRelayTransport;
}

export interface RelayRuntime {
  getConfig(): RelayRuntimeConfig;
  setEnabled(enabled: boolean): void;
  setEndpoint(endpoint: string | null, useTls: boolean): Promise<void>;
  stop(): Promise<void>;
}

function relayState(config: { endpoint: string | null; enabled: boolean }) {
  if (!config.endpoint) return "unconfigured";
  return config.enabled ? "enabled" : "disabled";
}

export function createRelayRuntime(options: RelayRuntimeOptions): RelayRuntime {
  const startTransport = options.startTransport ?? startRelayTransport;
  let config = options.config;
  let transport: RelayTransportController | null = null;

  function start(): void {
    if (transport || !config.endpoint) return;
    transport = startTransport({
      logger: options.logger,
      attachSocket: options.attachSocket,
      relayEndpoint: config.endpoint,
      relayUseTls: config.useTls,
      serverId: options.serverId,
      daemonKeyPair: options.daemonKeyPair,
      deviceGate: new RelayDeviceGate(
        new OfferStore(options.paseoHome),
        new DeviceRegistry(options.paseoHome),
      ),
    });
  }

  function setEnabled(enabled: boolean): void {
    if (config.enabled === enabled) return;
    if (enabled) {
      start();
      config = { ...config, enabled: true };
      return;
    }
    config = { ...config, enabled: false };
    const current = transport;
    transport = null;
    void current?.stop().catch((error) => {
      options.logger.warn({ err: error }, "Failed to stop relay transport");
    });
  }

  let endpointChange = Promise.resolve();
  async function applyEndpoint(endpoint: string | null, useTls: boolean): Promise<void> {
    await stop();
    config = {
      ...config,
      endpoint: endpoint ?? DEFAULT_RELAY_ENDPOINT,
      publicEndpoint: endpoint ?? DEFAULT_RELAY_ENDPOINT,
      useTls,
      publicUseTls: useTls,
    };
    if (config.enabled) start();
  }
  function setEndpoint(endpoint: string | null, useTls: boolean): Promise<void> {
    endpointChange = endpointChange.then(() => applyEndpoint(endpoint, useTls));
    return endpointChange;
  }

  async function stop(): Promise<void> {
    const current = transport;
    transport = null;
    await current?.stop();
  }

  if (config.enabled) start();

  return {
    getConfig: () => ({
      ...config,
      state: relayState(config),
    }),
    setEndpoint,
    setEnabled,
    stop,
  };
}
