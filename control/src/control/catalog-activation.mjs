import { isTrustedCatalogV11 } from "@getpaseo/protocol/trusted-input";
import { PLUGIN_ID as OWN_ID } from "./plugin-identity.mjs";
// Called only by the distribution's authenticated transport adapter. An ordinary
// PaseoApi or caller-provided authentication flag is not that adapter.
export function catalogActivation(connection, { getHandshakeBoot } = {}) {
  if (getHandshakeBoot !== undefined && typeof getHandshakeBoot !== "function")
    throw Error("Invalid handshake boot reader");
  const handshakeBoot = () => {
    const boot = getHandshakeBoot?.();
    if (getHandshakeBoot && (typeof boot !== "string" || !boot))
      throw Error("Authenticated handshake boot unavailable");
    return boot;
  };
  let epoch = 0,
    accepted = null,
    closed = false,
    inFlight = null,
    inFlightEpoch = null;
  const invalidate = () => {
    epoch++;
    accepted = null;
  };
  const unsubscribe = connection.subscribeConnectionStatus((state) => {
    invalidate();
    if (state.status === "connected") void refresh().catch(() => {});
  });
  async function refresh() {
    // DaemonClient immediately reports its current connected state on subscribe.
    // Share that refresh with explicit startup, rather than queueing two full catalogs.
    if (inFlight) {
      if (inFlightEpoch === epoch) return inFlight;
      await inFlight.catch(() => {});
      return refresh();
    }
    invalidate();
    const current = epoch;
    const request = (async () => {
      if (closed || !connection.isConnected)
        throw Error("Authenticated host connection unavailable");
      const catalog = await connection.getPluginCatalog();
      const boot = catalog.trustedHost?.boot;
      if (closed || !connection.isConnected || epoch !== current)
        throw Error("Host connection changed during activation");
      if (!isTrustedCatalogV11(catalog, OWN_ID, handshakeBoot() ?? boot))
        throw Error(
          "Trusted host admission registration requires own V1.1 contribution and all five hooks",
        );
      accepted = { boot, epoch };
      return boot;
    })();
    inFlight = request;
    inFlightEpoch = current;
    try {
      return await request;
    } finally {
      if (inFlight === request) inFlight = null;
    }
  }

  return {
    refresh,
    require(boot = handshakeBoot()) {
      if (
        closed ||
        !connection.isConnected ||
        !accepted ||
        accepted.epoch !== epoch ||
        (boot !== undefined && boot !== accepted.boot)
      ) {
        invalidate();
        throw Error("Trusted host activation unavailable or boot changed");
      }
      return accepted.boot;
    },
    close() {
      closed = true;
      invalidate();
      unsubscribe();
    },
  };
}
