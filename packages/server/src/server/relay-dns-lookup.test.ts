import { pbkdf2 } from "node:crypto";
import dns from "node:dns";
import type { AddressInfo } from "node:net";
import type { LookupFunction } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import type pino from "pino";
import { WebSocket, WebSocketServer } from "ws";
import { createRelayDnsLookup, type RelayDnsResolver } from "./relay-dns-lookup.js";
import { startRelayTransport } from "./relay-transport.js";

function createResolver(answers: { v4?: string[]; v6?: string[] }): RelayDnsResolver {
  const answer =
    (addresses: string[] | undefined) =>
    (_hostname: string, callback: (error: NodeJS.ErrnoException | null, a: string[]) => void) => {
      // c-ares answers on the event loop, not on the libuv thread pool.
      setImmediate(() => {
        if (addresses) callback(null, addresses);
        else callback(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }), []);
      });
    };
  return { resolve4: answer(answers.v4), resolve6: answer(answers.v6) };
}

function lookupOnce(
  lookup: LookupFunction,
  options: dns.LookupOptions,
): Promise<{ address: unknown; family: unknown }> {
  return new Promise((resolve, reject) => {
    lookup("relay.example.test", options, (error, address, family) => {
      if (error) reject(error);
      else resolve({ address, family });
    });
  });
}

describe("relay DNS lookup", () => {
  test("returns IPv4 before IPv6 when all addresses are requested", async () => {
    const lookup = createRelayDnsLookup({
      createResolver: () => createResolver({ v4: ["192.0.2.10"], v6: ["2001:db8::10"] }),
    });

    await expect(lookupOnce(lookup, { all: true })).resolves.toEqual({
      address: [
        { address: "192.0.2.10", family: 4 },
        { address: "2001:db8::10", family: 6 },
      ],
      family: undefined,
    });
  });

  test("honours the requested family", async () => {
    const lookup = createRelayDnsLookup({
      createResolver: () => createResolver({ v4: ["192.0.2.10"], v6: ["2001:db8::10"] }),
    });

    await expect(lookupOnce(lookup, { family: 6 })).resolves.toEqual({
      address: "2001:db8::10",
      family: 6,
    });
  });

  test("falls back to the system lookup when DNS has no answer", async () => {
    const fallbackCalls: string[] = [];
    const fallbackLookup = ((hostname, _options, callback) => {
      fallbackCalls.push(hostname);
      callback(null, "127.0.0.1", 4);
    }) as LookupFunction;
    const lookup = createRelayDnsLookup({
      createResolver: () => createResolver({}),
      fallbackLookup,
    });

    await expect(lookupOnce(lookup, {})).resolves.toEqual({ address: "127.0.0.1", family: 4 });
    expect(fallbackCalls).toEqual(["relay.example.test"]);
  });
});

// Reproduces the Mini fault of 9 Oct 2026: the daemon's libuv thread pool was full of slow
// file work, so getaddrinfo never ran and every relay handshake timed out. Local requests,
// MacBook sends over Tailscale and relay sockets all waited on the same pool.
describe("relay control recovery while the libuv thread pool is full", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
  });

  async function startFakeRelay(): Promise<number> {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.on("connection", (socket) => {
      socket.send(JSON.stringify({ type: "sync", connectionIds: [] }));
    });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          for (const client of server.clients) client.terminate();
          server.close(() => resolve());
        }),
    );
    return (server.address() as AddressInfo).port;
  }

  // Each task holds one pool thread for a few seconds. Callers must await the result.
  function fillThreadPool(): Promise<void> {
    const size = Number(process.env.UV_THREADPOOL_SIZE ?? 4);
    const tasks = Array.from(
      { length: size },
      () =>
        new Promise<void>((resolve) => {
          pbkdf2("relay", "starved", 15_000_000, 32, "sha512", () => resolve());
        }),
    );
    return Promise.all(tasks).then(() => undefined);
  }

  function createLogger() {
    const messages: string[] = [];
    const logger = {
      child: () => logger,
      debug: () => undefined,
      info: (_fields: unknown, message: string) => messages.push(message),
      warn: (_fields: unknown, message: string) => messages.push(message),
      error: (_fields: unknown, message: string) => messages.push(message),
    };
    return { logger, messages };
  }

  test("the control channel connects before a thread-pool lookup can finish", async () => {
    const port = await startFakeRelay();
    const lookup = createRelayDnsLookup({
      createResolver: () => createResolver({ v4: ["127.0.0.1"] }),
    });
    const { logger, messages } = createLogger();

    const poolDrained = fillThreadPool();
    let systemLookupDone = false;
    dns.lookup("localhost", () => {
      systemLookupDone = true;
    });

    const controller = startRelayTransport({
      logger: logger as unknown as pino.Logger,
      attachSocket: async () => {},
      relayEndpoint: `relay.starved.test:${port}`,
      relayUseTls: false,
      serverId: "srv_test",
      createWebSocket: (url) =>
        new WebSocket(url, { handshakeTimeout: 2_000, perMessageDeflate: false, lookup }),
    });
    cleanups.push(async () => {
      await controller.stop();
      await poolDrained;
    });

    await expect
      .poll(() => messages.includes("relay_control_connected"), { timeout: 2_000 })
      .toBe(true);
    // Proves the pool was still full when the control channel connected.
    expect(systemLookupDone).toBe(false);
  }, 30_000);
});
