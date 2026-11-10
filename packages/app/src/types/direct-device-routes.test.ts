import { describe, expect, it } from "vitest";
import { defaultHostAppearance } from "@/hosts/appearance";
import { selectBestConnection } from "@/utils/connection-selection";
import {
  canLearnDirectRoutesFrom,
  isDirectDeviceConnection,
  normalizeStoredHostProfile,
  withLearnedDirectDeviceRoutes,
  type HostConnection,
  type HostProfile,
} from "./host-connection";

const KEY = "A".repeat(43) + "=";
const relay: HostConnection = {
  id: "relay:wss:relay.example:443",
  type: "relay",
  relayEndpoint: "relay.example:443",
  useTls: true,
  daemonPublicKeyB64: KEY,
  deviceId: "dev_1",
};

function host(connections: HostConnection[]): HostProfile {
  return {
    serverId: "srv",
    label: "Mac",
    appearance: defaultHostAppearance(),
    lifecycle: {},
    connections,
    preferredConnectionId: connections[0]?.id ?? null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("withLearnedDirectDeviceRoutes", () => {
  it("adds Tailscale and LAN routes that sign in with the device key, keeps the relay", () => {
    const next = withLearnedDirectDeviceRoutes(
      host([relay]),
      [{ endpoint: "100.101.102.103:6767" }, { endpoint: "192.168.1.20:6767" }],
      true,
    );
    expect(next.connections).toHaveLength(3);
    expect(next.connections[0]).toEqual(relay);
    const direct = next.connections.filter(isDirectDeviceConnection);
    expect(direct.map((c) => c.type === "directTcp" && c.endpoint)).toEqual([
      "100.101.102.103:6767",
      "192.168.1.20:6767",
    ]);
    for (const c of direct) {
      expect(c).toMatchObject({ daemonPublicKeyB64: KEY, useTls: false });
      expect(JSON.stringify(c)).not.toContain("password");
    }
    expect(next.preferredConnectionId).toBe(relay.id);
  });
  it("does nothing without Tailscale: the host lists no routes", () => {
    const h = host([relay]);
    expect(withLearnedDirectDeviceRoutes(h, [], true)).toBe(h);
    expect(withLearnedDirectDeviceRoutes(h, undefined, true)).toBe(h);
  });
  it("keeps LAN only when only LAN is listed", () => {
    const next = withLearnedDirectDeviceRoutes(host([relay]), [{ endpoint: "10.0.0.5:1" }], true);
    expect(next.connections.map((c) => c.id)).toEqual([relay.id, "directDevice:10.0.0.5:1"]);
  });
  it("adds nothing from an old host that lacks device login (old server)", () => {
    const h = host([relay]);
    expect(withLearnedDirectDeviceRoutes(h, [{ endpoint: "10.0.0.5:1" }], false)).toBe(h);
  });
  it("adds nothing when this device has no paired relay route (no device key)", () => {
    const unpaired = host([{ ...relay, deviceId: undefined }]);
    expect(withLearnedDirectDeviceRoutes(unpaired, [{ endpoint: "10.0.0.5:1" }], true)).toBe(
      unpaired,
    );
  });
  it("drops public, malformed and excess endpoints", () => {
    const routes = [
      { endpoint: "8.8.8.8:6767" },
      { endpoint: "evil.example.com:6767" },
      { endpoint: "100.63.0.1:6767" },
      { endpoint: "999.1.1.1:1" },
      { endpoint: "10.0.0.5" },
    ];
    const h = host([relay]);
    expect(withLearnedDirectDeviceRoutes(h, routes, true)).toBe(h);
  });
  it("is idempotent and replaces stale routes", () => {
    const once = withLearnedDirectDeviceRoutes(host([relay]), [{ endpoint: "10.0.0.5:1" }], true);
    expect(withLearnedDirectDeviceRoutes(once, [{ endpoint: "10.0.0.5:1" }], true)).toBe(once);
    const moved = withLearnedDirectDeviceRoutes(once, [{ endpoint: "10.0.0.9:1" }], true);
    expect(moved.connections.map((c) => c.id)).toEqual([relay.id, "directDevice:10.0.0.9:1"]);
  });
  it("survives a save and load", () => {
    const next = withLearnedDirectDeviceRoutes(host([relay]), [{ endpoint: "10.0.0.5:1" }], true);
    const loaded = normalizeStoredHostProfile(JSON.parse(JSON.stringify(next)));
    expect(loaded?.connections.filter(isDirectDeviceConnection)).toHaveLength(1);
  });
});

describe("D6: a phone paired through a device route stores no host password", () => {
  it("the saved host profile, after learning routes and a reload, has no password or secret field", () => {
    const next = withLearnedDirectDeviceRoutes(
      host([relay]),
      [{ endpoint: "100.101.102.103:6767" }, { endpoint: "192.168.1.20:6767" }],
      true,
    );
    const stored = JSON.stringify(normalizeStoredHostProfile(JSON.parse(JSON.stringify(next))));
    for (const word of ["password", "secret", "token", "credential"]) {
      expect(stored.toLowerCase()).not.toContain(word);
    }
    // Every route that signs in with the device key has the host key and no password field.
    for (const c of next.connections.filter(isDirectDeviceConnection)) {
      expect(Object.keys(c)).not.toContain("password");
    }
  });
});

describe("route order: direct first, relay as fallback", () => {
  const next = withLearnedDirectDeviceRoutes(host([relay]), [{ endpoint: "10.0.0.5:1" }], true);
  const candidates = next.connections.map((connection) => ({
    connectionId: connection.id,
    connection,
  }));
  it("picks the direct route even when the relay answers faster", () => {
    const probes = new Map([
      [relay.id, { status: "available" as const, latencyMs: 5 }],
      ["directDevice:10.0.0.5:1", { status: "available" as const, latencyMs: 400 }],
    ]);
    expect(selectBestConnection({ candidates, probeByConnectionId: probes })).toBe(
      "directDevice:10.0.0.5:1",
    );
  });
  it("falls back to the relay when the direct route is unreachable", () => {
    const probes = new Map([
      [relay.id, { status: "available" as const, latencyMs: 240 }],
      ["directDevice:10.0.0.5:1", { status: "unavailable" as const, latencyMs: null }],
    ]);
    expect(selectBestConnection({ candidates, probeByConnectionId: probes })).toBe(relay.id);
  });
});

describe("L2: learn routes only from a connection that proved the host key", () => {
  const typed: HostConnection = { id: "direct:evil:1", type: "directTcp", endpoint: "evil:1" };
  const learned = withLearnedDirectDeviceRoutes(
    host([relay, typed]),
    [{ endpoint: "10.0.0.5:1" }],
    true,
  );
  it("accepts the relay and a device route", () => {
    expect(canLearnDirectRoutesFrom(learned, relay.id)).toBe(true);
    expect(canLearnDirectRoutesFrom(learned, "directDevice:10.0.0.5:1")).toBe(true);
  });
  it("refuses a password route, a socket, an unknown id and no active route", () => {
    expect(canLearnDirectRoutesFrom(learned, typed.id)).toBe(false);
    expect(canLearnDirectRoutesFrom(learned, "nope")).toBe(false);
    expect(canLearnDirectRoutesFrom(learned, null)).toBe(false);
    const socket: HostConnection = { id: "socket:/tmp/x", type: "directSocket", path: "/tmp/x" };
    expect(canLearnDirectRoutesFrom(host([relay, socket]), socket.id)).toBe(false);
  });
});
