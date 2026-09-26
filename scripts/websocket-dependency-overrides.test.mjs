import assert from "node:assert/strict";
import { once } from "node:events";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";

const fixture = process.env.PASEO_WS_FIXTURE;
const require = createRequire(fixture ? path.join(fixture, "package.json") : import.meta.url);
const sources = fixture
  ? ["ws6", "ws7", "ws8"].map((name) => ({ name, resolve: require, dependency: name }))
  : [
      { name: "root", resolve: require, dependency: "ws" },
      {
        name: "react-native",
        resolve: createRequire(require.resolve("react-native/package.json")),
        dependency: "ws",
      },
      {
        name: "metro",
        resolve: createRequire(require.resolve("metro/package.json")),
        dependency: "ws",
      },
    ];

async function loopback(WebSocket, options, check) {
  const server = new WebSocket.Server({
    host: "127.0.0.1",
    port: 0,
    perMessageDeflate: false,
    ...options,
  });
  const signal = AbortSignal.timeout(2500);
  let client;
  try {
    await once(server, "listening", { signal });
    server.on("connection", (socket) => socket.on("error", () => {}));
    const accepted = once(server, "connection", { signal });
    client = new WebSocket(`ws://127.0.0.1:${server.address().port}`, { perMessageDeflate: false });
    client.on("error", () => {});
    const [, [socket]] = await Promise.all([once(client, "open", { signal }), accepted]);
    await check(client, socket, signal);
  } finally {
    client?.terminate();
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  }
}

for (const { name: alias, resolve, dependency } of sources) {
  const WebSocket = resolve(dependency);
  const major = Number(resolve(`${dependency}/package.json`).version.split(".")[0]);
  test(
    `${alias}: ordinary fragmented text, binary, ping/pong and close`,
    { timeout: 3000 },
    async () => {
      await loopback(
        WebSocket,
        { maxFragments: 4, maxPayload: 128 },
        async (client, socket, signal) => {
          socket.on("message", (data, binary) =>
            socket.send(data, {
              binary: typeof binary === "boolean" ? binary : typeof data !== "string",
            }),
          );
          let received = once(client, "message", { signal });
          client.send("hel", { fin: false });
          client.send("lo", { fin: true });
          assert.equal(String((await received)[0]), "hello");
          received = once(client, "message", { signal });
          const bytes = Buffer.from([0, 1, 255]);
          client.send(bytes);
          assert.deepEqual((await received)[0], bytes);
          const pong = once(client, "pong", { signal });
          client.ping("alive");
          assert.equal(String((await pong)[0]), "alive");
          const closed = once(client, "close", { signal });
          client.close(1000, "done");
          const [code, reason] = await closed;
          assert.equal(code, 1000);
          assert.equal(String(reason), "done");
        },
      );
    },
  );

  test(
    `${alias}: default limits accept 64 ordinary 32KiB fragments`,
    { timeout: 3000 },
    async () => {
      await loopback(WebSocket, {}, async (client, socket, signal) => {
        const received = once(socket, "message", { signal });
        const chunk = Buffer.alloc(32 * 1024, 42);
        for (let i = 0; i < 64; i++) client.send(chunk, { fin: i === 63 });
        assert.deepEqual((await received)[0], Buffer.alloc(2 * 1024 * 1024, 42));
        const closed = once(client, "close", { signal });
        client.close(1000, "done");
        assert.equal((await closed)[0], 1000);
      });
    },
  );

  test(
    `${alias}: bounded five-fragment message exceeds four-fragment limit`,
    { timeout: 3000 },
    async () => {
      await loopback(
        WebSocket,
        { maxFragments: 4, maxPayload: 128 },
        async (client, socket, signal) => {
          let rejection;
          socket.once("error", (error) => {
            rejection = error.message;
          });
          socket.once("message", () => socket.close(1000, "accepted"));
          const closed = once(client, "close", { signal });
          for (let i = 0; i < 5; i++) client.send("x", { fin: i === 4 });
          assert.equal((await closed)[0], major === 6 ? 1006 : 1008);
          assert.equal(rejection, "Too many message fragments");
        },
      );
    },
  );

  test(
    `${alias}: existing payload bound rejects a nine-byte message`,
    { timeout: 3000 },
    async () => {
      await loopback(WebSocket, { maxPayload: 8 }, async (client, _socket, signal) => {
        const closed = once(client, "close", { signal });
        client.send(Buffer.alloc(9));
        assert.equal((await closed)[0], major === 6 ? 1006 : 1009);
      });
    },
  );
}
