// The controller socket's one-request protocol (operator-connection.mjs), on a real unix socket with small timeouts.
// P1 discovery (26 Sep): the 30 s idle timeout also ran while the handler worked, so a slow RPC (a Book observe during
// an event-loop stall) completed with ok:true while its client got an empty reply.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { operatorConnection, MAX_REQUEST_BYTES } from "./operator-connection.mjs";

async function serve(t, dispatch, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orca-opconn-")),
    socket = path.join(dir, "s.sock"),
    operations = new Set();
  const server = net.createServer(
    operatorConnection({ dispatch, operations, requestTimeoutMs: 100, ...options }),
  );
  await new Promise((resolve) => server.listen(socket, resolve));
  t.after(
    () =>
      new Promise((resolve) =>
        server.close(() => {
          fs.rmSync(dir, { recursive: true, force: true });
          resolve();
        }),
      ),
  );
  return { socket, operations };
}
// Returns the raw reply text ('' when the server closed without replying) and whether the socket was reset.
function exchange(socket, write, giveUpMs = 10000) {
  return new Promise((resolve) => {
    const c = net.connect(socket);
    let b = "";
    // The client's own deadline: if the SERVER never closes, the test fails instead of hanging.
    const guard = setTimeout(() => {
      c.destroy();
      resolve({ reply: b, reset: false, clientGaveUp: true });
    }, giveUpMs);
    const done = (reset) => {
      clearTimeout(guard);
      resolve({ reply: b, reset, clientGaveUp: false });
    };
    c.on("data", (d) => {
      b += d;
    });
    c.on("error", () => done(true));
    c.on("close", () => done(false));
    write(c);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("a handler slower than the request timeout still delivers its reply (the P1 7507b1c3 case)", async (t) => {
  let finished = false;
  const { socket } = await serve(t, async (req) => {
    await sleep(400);
    finished = true;
    return { echoed: req.method };
  });
  const { reply } = await exchange(socket, (c) =>
    c.write(JSON.stringify({ method: "observe" }) + "\n"),
  );
  assert.equal(finished, true);
  assert.deepEqual(
    JSON.parse(reply),
    { result: { echoed: "observe" } },
    "the reply reached the client after 4x the request timeout",
  );
});

test("a client that never finishes its request line is still dropped at the request timeout, and nothing is dispatched", async (t) => {
  let dispatched = 0;
  const { socket } = await serve(t, async () => {
    dispatched++;
    return {};
  });
  const t0 = performance.now();
  const { reply, clientGaveUp } = await exchange(socket, (c) => c.write('{"method":"list"'), 1000); // no newline, then silence
  assert.equal(
    clientGaveUp,
    false,
    "the server dropped the half-sent request; the client did not have to",
  );
  assert.equal(reply, "");
  assert.equal(dispatched, 0);
  assert(performance.now() - t0 < 2000, "dropped by the request timeout, not left open");
});

test("the protocol is otherwise unchanged: errors carry errorFields, one request per connection, bounded size, operations tracked", async (t) => {
  class Coded extends Error {
    code = "X_CODE";
  }
  const { socket, operations } = await serve(
    t,
    async (req) => {
      if (req.method === "slow") await sleep(150);
      if (req.method === "fail") throw new Coded("refused");
      return 1;
    },
    { errorFields: (e) => (e instanceof Coded ? { code: e.code } : {}) },
  );
  assert.deepEqual(
    JSON.parse((await exchange(socket, (c) => c.write('{"method":"fail"}\n'))).reply),
    { error: "refused", code: "X_CODE" },
  );
  assert.deepEqual(
    JSON.parse((await exchange(socket, (c) => c.write('{"method":"a"}\n{"method":"b"}\n'))).reply),
    { error: "One request per connection" },
  );
  assert.equal(
    (await exchange(socket, (c) => c.write("x".repeat(MAX_REQUEST_BYTES + 10)))).reply,
    "",
  );
  const slow = exchange(socket, (c) => c.write('{"method":"slow"}\n'));
  await sleep(50);
  assert.equal(operations.size, 1, "a running operation is tracked (stop() awaits it)");
  assert.deepEqual(JSON.parse((await slow).reply), { result: 1 });
  await sleep(10);
  assert.equal(operations.size, 0, "and released when it settles");
});

test("server.mjs serves the socket through operatorConnection and sets no timeout of its own (static)", () => {
  const src = fs.readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
  assert.match(
    src,
    /net\.createServer\(operatorConnection\(\{ dispatch, operations, errorFields: e => e instanceof InstructionAllowanceExhausted \? \{ code: e\.code \} : \{\} \}\)\)/,
  );
  assert.equal(
    /\.setTimeout\(\s*\d/.test(
      src.slice(
        src.indexOf("const server ="),
        src.indexOf("await new Promise((resolve, reject) => { server.once"),
      ),
    ),
    false,
  );
});
