import { DEFAULT_RELAY_ENDPOINT } from "@getpaseo/protocol/daemon-endpoints";
import type { HostRuntimeConnectionStatus } from "@/runtime/host-runtime";

/**
 * L42: what the pairing modal shows, from the host's REAL connection state and whether the offer request is actually
 * running. A disabled query reports `isPending` for as long as it stays disabled, so "loading" is only ever the offer
 * request in flight: a host that is connecting (or idle) shows that, with a way to reconnect, never "Loading".
 */
export type PairingBodyState =
  | "connecting" // idle / connecting: "Connecting to this Mac…" + Reconnect
  | "disconnected" // offline / error: the existing host-disconnected error + Retry
  | "loading" // online and the offer request is in flight
  | "error" // the request failed or timed out: its message + Retry
  | "offer"; // online and an answer arrived (relay consent, unavailable or the offer itself)

export function pairingBodyState(input: {
  connectionStatus: HostRuntimeConnectionStatus | undefined;
  isFetching: boolean;
  hasAnswer: boolean;
  error: Error | null;
}): PairingBodyState {
  const { connectionStatus } = input;
  if (connectionStatus === "offline" || connectionStatus === "error") return "disconnected";
  if (connectionStatus !== "online") return "connecting";
  if (input.isFetching && !input.hasAnswer) return "loading";
  if (input.error) return "error";
  return "offer";
}

export const PAIRING_OFFER_TIMEOUT_MS = 15_000;

/** The offer request, bounded: a host that never answers becomes a plain error the modal can retry. */
export function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/**
 * What the relay address field starts with: empty for the default relay (shown as "Default relay", never its raw
 * address), else the configured address. Saving the field empty sends null, which keeps the default.
 */
export function relayAddressFieldValue(endpoint: string | null | undefined): string {
  if (!endpoint || endpoint === DEFAULT_RELAY_ENDPOINT) return "";
  return endpoint;
}
