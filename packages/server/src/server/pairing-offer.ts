import os from "node:os";
import { OfferStore } from "./pairing/offer-store.js";
import { DEFAULT_RELAY_ENDPOINT, relayUsesTls } from "@getpaseo/protocol/daemon-endpoints";
import type { Logger } from "pino";

import { createConnectionOfferV3, encodeOfferToFragmentUrl } from "./connection-offer.js";
import { loadOrCreateDaemonKeyPair } from "./daemon-keypair.js";
import { renderPairingQr } from "./pairing-qr.js";
import { getOrCreateServerId } from "./server-id.js";

export interface LocalPairingOffer {
  reason?: "relay_unconfigured";
  relayEnabled: boolean;
  url: string | null;
  qr: string | null;
}

export async function generateLocalPairingOffer(args: {
  paseoHome: string;
  relayEnabled?: boolean;
  relayEndpoint?: string;
  relayPublicEndpoint?: string;
  relayUseTls?: boolean;
  relayPublicUseTls?: boolean;
  appBaseUrl?: string | null;
  pairingOfferTtlSeconds?: number;
  includeQr?: boolean;
  logger?: Logger;
}): Promise<LocalPairingOffer> {
  const relayEnabled = args.relayEnabled ?? true;
  if (!relayEnabled) {
    return {
      relayEnabled: false,
      url: null,
      qr: null,
    };
  }

  const relayEndpoint = args.relayEndpoint ?? DEFAULT_RELAY_ENDPOINT;
  if (!relayEndpoint)
    return { relayEnabled: false, reason: "relay_unconfigured", url: null, qr: null };
  const relayPublicEndpoint = args.relayPublicEndpoint ?? relayEndpoint;
  const relayUseTls = relayUsesTls(relayEndpoint, args.relayUseTls);
  const relayPublicUseTls = args.relayPublicUseTls ?? relayUseTls;
  const appBaseUrl = "fulcra://pair";
  const serverId = getOrCreateServerId(args.paseoHome, { logger: args.logger });
  const daemonKeyPair = await loadOrCreateDaemonKeyPair(args.paseoHome, args.logger);
  const offer = await createConnectionOfferV3({
    serverId,
    pairing: new OfferStore(args.paseoHome).mint(args.pairingOfferTtlSeconds),
    hostLabel: os.hostname().slice(0, 64),
    daemonPublicKeyB64: daemonKeyPair.publicKeyB64,
    relay: { endpoint: relayPublicEndpoint, useTls: relayPublicUseTls },
  });
  const url = encodeOfferToFragmentUrl({ offer, appBaseUrl });

  if (args.includeQr === false) {
    return {
      relayEnabled: true,
      url,
      qr: null,
    };
  }

  let qr: string | null = null;
  try {
    qr = await renderPairingQr(url);
  } catch {
    args.logger?.debug("Failed to render pairing QR");
  }

  return {
    relayEnabled: true,
    url,
    qr,
  };
}

export { rotateOfflineRelayIdentity } from "./pairing/rotate-identity.js";

export { revokeOfflineDevice } from "./pairing/revoke-offline.js";
