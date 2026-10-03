import { describe, expect, test } from "vitest";

import {
  buildDaemonWebSocketUrl,
  buildRelayWebSocketUrl,
  CURRENT_RELAY_PROTOCOL_VERSION,
  extractHostPortFromWebSocketUrl,
  normalizeRelayProtocolVersion,
  parseConnectionUri,
  parseRelayConnectionUri,
  serializeRelayConnectionUri,
  serializeConnectionUri,
  serializeConnectionUriForStorage,
  shouldUseTlsForDefaultHostedRelay,
} from "./daemon-endpoints.js";

describe("connection URI parsing", () => {
  test("round-trips a tcp host and port", () => {
    const parsed = parseConnectionUri("tcp://localhost:6767");

    expect(parsed).toEqual({
      host: "localhost",
      port: 6767,
      isIpv6: false,
      useTls: false,
    });
    expect(serializeConnectionUri(parsed)).toBe("tcp://localhost:6767");
  });

  test("round-trips an SSL-enabled tcp host and port", () => {
    const parsed = parseConnectionUri("tcp://example.com:443?ssl=true");

    expect(parsed).toEqual({
      host: "example.com",
      port: 443,
      isIpv6: false,
      useTls: true,
    });
    expect(serializeConnectionUri(parsed)).toBe("tcp://example.com:443?ssl=true");
  });

  test("round-trips an IPv6 host", () => {
    const parsed = parseConnectionUri("tcp://[::1]:6767?ssl=true");

    expect(parsed).toEqual({
      host: "::1",
      port: 6767,
      isIpv6: true,
      useTls: true,
    });
    expect(serializeConnectionUri(parsed)).toBe("tcp://[::1]:6767?ssl=true");
  });

  test("rejects a missing port", () => {
    expect(() => parseConnectionUri("tcp://localhost")).toThrow("Connection URI port is required");
  });

  test("rejects an invalid scheme", () => {
    expect(() => parseConnectionUri("http://localhost:6767")).toThrow(
      "Connection URI protocol must be tcp:",
    );
  });

  test("parses password without including it in the public serializer", () => {
    const parsed = parseConnectionUri("tcp://localhost:6767?ssl=true&password=secret");

    expect(parsed).toEqual({
      host: "localhost",
      port: 6767,
      isIpv6: false,
      useTls: true,
      password: "secret",
    });
    expect(serializeConnectionUri(parsed)).toBe("tcp://localhost:6767?ssl=true");
    expect(serializeConnectionUriForStorage(parsed)).toBe(
      "tcp://localhost:6767?ssl=true&password=secret",
    );
  });

  test("rejects userinfo passwords", () => {
    expect(() => parseConnectionUri("tcp://:secret@localhost:6767?ssl=true")).toThrow(
      "Connection URI userinfo is not supported",
    );
  });
});

describe("daemon websocket URLs", () => {
  test("uses ws for port 443 when TLS is disabled", () => {
    expect(buildDaemonWebSocketUrl("example.com:443", { useTls: false })).toBe(
      "ws://example.com:443/ws",
    );
  });

  test("uses wss for non-443 ports when TLS is enabled", () => {
    expect(buildDaemonWebSocketUrl("example.com:6767", { useTls: true })).toBe(
      "wss://example.com:6767/ws",
    );
  });
});

describe("relay websocket URL versioning", () => {
  test("defaults relay URLs to v2", () => {
    const url = new URL(
      buildRelayWebSocketUrl({
        endpoint: "relay.paseo.sh:443",
        useTls: true,
        serverId: "srv_test",
        role: "client",
      }),
    );

    expect(url.searchParams.get("v")).toBe(CURRENT_RELAY_PROTOCOL_VERSION);
    expect(url.searchParams.has("connectionId")).toBe(false);
  });

  test("includes connectionId when provided (server data sockets)", () => {
    const url = new URL(
      buildRelayWebSocketUrl({
        endpoint: "relay.paseo.sh:443",
        useTls: true,
        serverId: "srv_test",
        role: "server",
        connectionId: "conn_abc123",
      }),
    );

    expect(url.searchParams.get("connectionId")).toBe("conn_abc123");
  });

  test("allows explicitly requesting v1 relay URLs", () => {
    const url = new URL(
      buildRelayWebSocketUrl({
        endpoint: "relay.paseo.sh:443",
        useTls: true,
        serverId: "srv_test",
        role: "server",
        version: "1",
      }),
    );

    expect(url.searchParams.get("v")).toBe("1");
  });

  test("normalizes numeric relay versions", () => {
    expect(normalizeRelayProtocolVersion(2)).toBe("2");
    expect(normalizeRelayProtocolVersion(1)).toBe("1");
  });

  test("rejects unsupported relay versions", () => {
    expect(() => normalizeRelayProtocolVersion("3")).toThrow('Relay version must be "1" or "2"');
  });
});

describe("relay websocket URLs", () => {
  test("uses ws for port 443 when TLS is disabled", () => {
    const url = new URL(
      buildRelayWebSocketUrl({
        endpoint: "relay.paseo.sh:443",
        useTls: false,
        serverId: "srv_test",
        role: "client",
      }),
    );

    expect(url.protocol).toBe("ws:");
  });

  test("uses wss for non-443 ports when TLS is enabled", () => {
    const url = new URL(
      buildRelayWebSocketUrl({
        endpoint: "relay.paseo.sh:6767",
        useTls: true,
        serverId: "srv_test",
        role: "client",
      }),
    );

    expect(url.protocol).toBe("wss:");
  });

  test("round-trips IPv6 relay endpoints with TLS enabled", () => {
    const wsUrl = buildRelayWebSocketUrl({
      endpoint: "[::1]:443",
      useTls: true,
      serverId: "srv_test",
      role: "client",
    });
    const url = new URL(wsUrl);

    expect(url.protocol).toBe("wss:");
    expect(extractHostPortFromWebSocketUrl(wsUrl)).toBe("[::1]:443");
  });
});

describe("shouldUseTlsForDefaultHostedRelay", () => {
  test("returns true for the hosted Paseo relay on port 443", () => {
    expect(shouldUseTlsForDefaultHostedRelay("relay.paseo.sh:443")).toBe(true);
  });

  test("returns true for any self-hosted relay on port 443", () => {
    expect(shouldUseTlsForDefaultHostedRelay("relay.example.com:443")).toBe(true);
  });

  test("returns true for an IPv6 relay on port 443", () => {
    expect(shouldUseTlsForDefaultHostedRelay("[::1]:443")).toBe(true);
  });

  test("returns false for a relay on a non-443 port", () => {
    expect(shouldUseTlsForDefaultHostedRelay("relay.example.com:8080")).toBe(false);
  });

  test("returns false for malformed endpoints", () => {
    expect(shouldUseTlsForDefaultHostedRelay("not-an-endpoint")).toBe(false);
  });
});

describe("relay connection URI", () => {
<<<<<<< HEAD
  test("refuses legacy relay URI rather than upgrading missing pairing authority", () => {
    expect(() =>
      parseRelayConnectionUri("relay://relay.paseo.sh:443/srv_test?key=legacy&ssl=true"),
    ).toThrow("Update Fulcra to pair");
    expect(() =>
      parseRelayConnectionUri("relay://relay.paseo.sh:443/srv_test?v=2&key=legacy&ssl=true"),
    ).toThrow("Update Fulcra to pair");
  });

  test("refuses missing or malformed V3 pairing credentials without exposing them", () => {
    const valid = new URL("relay://relay.paseo.sh:443/srv_test");
    valid.searchParams.set("v", "3");
    valid.searchParams.set("ssl", "true");
    valid.searchParams.set("key", Buffer.alloc(32, 1).toString("base64"));
    valid.searchParams.set("pairingId", "A".repeat(22));
    valid.searchParams.set("pairingSecret", "B".repeat(43));
    valid.searchParams.set("pairingExpiresAt", "2099-01-01T00:00:00.000Z");
    for (const field of ["pairingId", "pairingSecret", "pairingExpiresAt"]) {
      const missing = new URL(valid);
      missing.searchParams.delete(field);
      expect(() => parseRelayConnectionUri(missing.toString())).toThrow("Invalid pairing offer");
    }
    valid.searchParams.set("pairingSecret", "PRIVATE_PAIRING_SENTINEL");
    valid.searchParams.set("pairingExpiresAt", "not-an-expiry");
    expect(() => parseRelayConnectionUri(valid.toString())).toThrow("Invalid pairing offer");
  });

  test("preserves strict V3 public relay TLS refusal", () => {
    const uri =
      "relay://relay.paseo.sh:443/srv_test?v=3&key=" +
      encodeURIComponent(Buffer.alloc(32, 1).toString("base64")) +
      "&pairingId=" +
      "A".repeat(22) +
      "&pairingSecret=" +
      "B".repeat(43) +
      "&pairingExpiresAt=2099-01-01T00%3A00%3A00.000Z";
    expect(() => parseRelayConnectionUri(uri)).toThrow("secure connection");
  });

  test("round-trips the offer and password through a direct URI and connect wrapper", () => {
    const parts = {
      offer: {
        v: 3 as const,
        serverId: "srv_test",
        daemonPublicKeyB64: Buffer.alloc(32, 1).toString("base64"),
        pairing: {
          id: "A".repeat(22),
          secret: "B".repeat(43),
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
        hostLabel: "Test host",
=======
  test("round-trips the offer and password through a direct URI and connect wrapper", () => {
    const parts = {
      offer: {
        v: 2 as const,
        serverId: "srv_test",
        daemonPublicKeyB64: "abc+/=",
>>>>>>> refs/tags/v0.10.3
        relay: { endpoint: "relay.paseo.sh:443", useTls: true },
      },
      password: "two words",
    };
    const uri = serializeRelayConnectionUri(parts);
    expect(parseRelayConnectionUri(uri)).toEqual(parts);
    expect(
      parseRelayConnectionUri(`https://app.paseo.sh/#connect=${encodeURIComponent(uri)}`),
    ).toEqual(parts);
  });
});
