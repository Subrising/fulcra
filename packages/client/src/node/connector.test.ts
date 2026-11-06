import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, expect, test } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import { createHostTransportFactory, HostTransportBudget } from "./index.js";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});
async function endpoint() {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(async () => {
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => server.close(() => resolve())));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  return { wss, url: `ws://127.0.0.1:${address.port}/ws` };
}
test("connector retains per-attempt headers and WebSocket subprotocols", async () => {
  const server = await endpoint();
  const connected = once(server.wss, "connection");
  const transport = createHostTransportFactory(server.url)({
    url: server.url,
    headers: { Authorization: "Bearer example" },
    protocols: ["paseo-test"],
  });
  cleanup.push(async () => transport.close());
  const [socket, request] = (await connected) as [WebSocket, import("node:http").IncomingMessage];
  expect(request.headers.authorization).toBe("Bearer example");
  expect(socket.protocol).toBe("paseo-test");
});
test("a slow consumer cannot exceed the shared byte budget and close releases reserved bytes", async () => {
  const server = await endpoint();
  const budget = new HostTransportBudget(4 * 1024 * 1024);
  const connected = once(server.wss, "connection");
  const transport = createHostTransportFactory(server.url, budget)({ url: server.url });
  cleanup.push(async () => transport.close());
  const ready = new Promise<void>((resolve) => transport.onOpen(resolve));
  const [socket] = (await connected) as [WebSocket];
  socket.pause();
  await ready;
  const frame = new Uint8Array(1024 * 1024);
  const writes = Array.from({ length: 4 }, () => transport.send(frame));
  const drained = Promise.allSettled(writes);
  expect(budget.bufferedBytes).toBe(4 * 1024 * 1024);
  expect(() => transport.send(frame)).toThrow("Connected host buffer limit reached");
  expect(budget.bufferedBytes).toBeLessThanOrEqual(budget.limit);
  transport.close();
  await expect.poll(() => budget.bufferedBytes).toBe(0);
  await drained;
});
test("direct connector preserves 25 MiB binary frames in both directions", async () => {
  const server = await endpoint();
  const connected = once(server.wss, "connection");
  const transport = createHostTransportFactory(server.url)({ url: server.url });
  cleanup.push(async () => transport.close());
  const ready = new Promise<void>((resolve) => transport.onOpen(resolve));
  const received = new Promise<Uint8Array>((resolve, reject) => {
    transport.onMessage((bytes, binary) => binary && resolve(bytes as Uint8Array));
    transport.onError(reject);
  });
  const [socket] = (await connected) as [WebSocket];
  await ready;
  const bytes = new Uint8Array(25 * 1024 * 1024).fill(173);
  const echoed = once(socket, "message");
  const sending = transport.send(bytes);
  const [sent, binary] = await echoed;
  expect(binary).toBe(true);
  expect(Buffer.from(sent as Uint8Array).equals(bytes)).toBe(true);
  socket.send(bytes);
  expect(Buffer.from(await received).equals(bytes)).toBe(true);
  await sending;
});

// FULCRA(FU-657): Fulcra accepts only v3 pairing offers and keeps the v3 relay channel, so the
// daemon side of these tests is the v3 channel and the relay URI carries a v3 offer.
import {
  createDaemonChannel,
  generateKeyPair,
  exportPublicKey,
  type Transport,
} from "../relay-v3/index.js";
function v3RelayUri(port: string, serverId: string, key: string, extra = ""): string {
  const query = new URLSearchParams({
    key,
    v: "3",
    pairingId: "A".repeat(22),
    pairingSecret: "B".repeat(43),
    pairingExpiresAt: "2099-01-01T00:00:00.000Z",
  });
  return `relay://127.0.0.1:${port}/${serverId}?${query.toString()}${extra}`;
}
test("encrypted connector rejects overload synchronously and preserves the physical link for sibling traffic", async () => {
  const server = await endpoint();
  const keys = generateKeyPair();
  const received: (string | ArrayBuffer)[] = [];
  let peer!: WebSocket;
  let ready!: Promise<unknown>;
  server.wss.on("connection", (socket) => {
    peer = socket;
    const wire: Transport = {
      send: (data) => socket.send(data),
      close: () => socket.close(),
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    socket.on("message", (data, isBinary) => {
      const bytes = Buffer.from(data as Buffer);
      wire.onmessage?.({
        data: isBinary
          ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
          : bytes.toString(),
        isBinary,
      });
    });
    ready = createDaemonChannel(
      wire,
      keys,
      {
        onmessage: (data) => {
          received.push(data);
        },
      },
      "srv_slow",
    );
  });
  const port = new URL(server.url).port;
  const budget = new HostTransportBudget(4 * 1024 * 1024);
  const transport = createHostTransportFactory(
    v3RelayUri(port, "srv_slow", exportPublicKey(keys.publicKey)),
    budget,
  )({ url: server.url });
  cleanup.push(async () => transport.close());
  const errors: unknown[] = [];
  let closed = false;
  transport.onError((error) => errors.push(error));
  transport.onClose(() => {
    closed = true;
  });
  await new Promise<void>((resolve) => transport.onOpen(resolve));
  await ready;
  expect(transport.maxFrameBytes).toBeLessThan(32 * 1024 * 1024);
  peer.pause();
  const frame = new Uint8Array(1024 * 1024).fill(173);
  let rejected: unknown;
  const writes: (void | Promise<void>)[] = [];
  for (let index = 0; index < 8; index++) {
    try {
      writes.push(transport.send(frame));
    } catch (error) {
      rejected = error;
      break;
    }
  }
  const drained = Promise.allSettled(writes);
  expect(rejected).toMatchObject({ code: "resource_limit" });
  expect(budget.bufferedBytes).toBeLessThanOrEqual(budget.limit);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(errors).toEqual([]);
  expect(closed).toBe(false);
  const sibling = transport.send("sibling control");
  peer.resume();
  await drained;
  await sibling;
  await expect.poll(() => received.includes("sibling control")).toBe(true);
  expect(received.filter((data) => data instanceof ArrayBuffer).length).toBeGreaterThan(0);
  expect(
    received
      .filter((data) => data instanceof ArrayBuffer)
      .every((data) => Buffer.from(data).equals(frame)),
  ).toBe(true);
  expect(server.wss.clients.size).toBe(1);
});

// FULCRA(FU-657): upstream latches a negotiated "protected" mode, which the Fulcra v3 channel never
// negotiates. The same refusal is kept at its source: an offer that pins protected security makes
// the connector refuse the v3 channel before any hello, and no frame reaches the daemon.
test("encrypted connector refuses legacy endpoint security on a later attempt once protected was negotiated", async () => {
  const server = await endpoint();
  const keys = generateKeyPair();
  const daemonReceived: unknown[] = [];
  let connections = 0;
  server.wss.on("connection", (socket) => {
    connections += 1;
    const wire: Transport = {
      send: (data) => socket.send(data),
      close: (code, reason) => socket.close(code, reason),
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    socket.on("message", (data, isBinary) => {
      daemonReceived.push(data);
      const bytes = Buffer.from(data as Buffer);
      wire.onmessage?.({
        data: isBinary
          ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
          : bytes.toString(),
        isBinary,
      });
    });
    socket.on("close", (code, reason) => wire.onclose?.(code, reason.toString()));
    void createDaemonChannel(wire, keys, {}, "srv_latch").catch(() => {});
  });
  const port = new URL(server.url).port;
  const factory = createHostTransportFactory(
    v3RelayUri(port, "srv_latch", exportPublicKey(keys.publicKey), "&security=protected"),
  );

  for (let attempt = 0; attempt < 2; attempt++) {
    const transport = factory({ url: server.url });
    cleanup.push(async () => transport.close());
    let opened = false;
    transport.onOpen(() => {
      opened = true;
    });
    await new Promise<unknown>((resolve) => transport.onClose(resolve));
    expect(opened).toBe(false);
  }
  expect(connections).toBeGreaterThan(0);
  expect(daemonReceived).toEqual([]);
});
