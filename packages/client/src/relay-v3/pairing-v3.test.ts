import { expect, it, vi } from "vitest";
import { createClientChannel, createDaemonChannel, type Transport } from "./encrypted-channel.js";
import { generateKeyPair, exportPublicKey } from "./crypto.js";

it("closes a replayed encrypted frame instead of delivering it twice", async () => {
  const received: unknown[] = [];
  const close = vi.fn();
  let wire: string | ArrayBuffer = "";
  const server: Transport = {
    send: (d) => {
      queueMicrotask(() => client.onmessage?.({ data: d, isBinary: d instanceof ArrayBuffer }));
    },
    close,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  const client: Transport = {
    send: (d) => {
      wire = d;
      queueMicrotask(() => server.onmessage?.({ data: d, isBinary: d instanceof ArrayBuffer }));
    },
    close: vi.fn(),
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  const host = generateKeyPair();
  const daemon = createDaemonChannel(server, host, { onmessage: (d) => received.push(d) });
  const app = await createClientChannel(client, exportPublicKey(host.publicKey));
  await daemon;
  await app.send("sensitive operation");
  await new Promise((resolve) => setTimeout(resolve, 10));
  server.onmessage?.({ data: wire, isBinary: wire instanceof ArrayBuffer });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(received).toEqual(["sensitive operation"]);
  expect(close).toHaveBeenCalledWith(4409, "E2EE sequence error");
  app.close();
});

it("rejects reflected ciphertext and a captured session replay", async () => {
  const host = generateKeyPair();
  const frames: Array<string | ArrayBuffer> = [];
  const close = vi.fn();
  const server: Transport = {
    send: (d) => {
      queueMicrotask(() => client.onmessage?.({ data: d, isBinary: d instanceof ArrayBuffer }));
    },
    close,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  const client: Transport = {
    send: (d) => {
      frames.push(d);
      queueMicrotask(() => server.onmessage?.({ data: d, isBinary: d instanceof ArrayBuffer }));
    },
    close: vi.fn(),
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  const daemon = createDaemonChannel(server, host);
  const app = await createClientChannel(client, exportPublicKey(host.publicKey));
  await daemon;
  await app.send("command");
  await new Promise((resolve) => setTimeout(resolve, 10));
  client.onmessage?.({ data: frames[1], isBinary: frames[1] instanceof ArrayBuffer });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(client.close).toHaveBeenCalledWith(4409, "E2EE sequence error");
  const replay: Transport = {
    send: vi.fn(),
    close: vi.fn(),
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  const received = vi.fn();
  const newSession = createDaemonChannel(replay, host, { onmessage: received });
  replay.onmessage?.({ data: frames[0], isBinary: false });
  await newSession;
  replay.onmessage?.({ data: frames[1], isBinary: false });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(received).not.toHaveBeenCalled();
  expect(replay.close).toHaveBeenCalledWith(4409, "E2EE sequence error");
  app.close();
});
