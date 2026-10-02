import test from "node:test";
import { shortCanonicalBase, bindable } from "./fixture-socket.mjs";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { request as controllerRequest } from "./client.mjs";
import { request as ingressRequest } from "../../orca-ingress/src/controller-client.mjs";
for (const [label, request] of [
  ["controller", controllerRequest],
  ["ingress", ingressRequest],
])
  test(`${label} preserves Unicode split across socket chunks`, async (t) => {
    const dir = shortCanonicalBase("orca-utf8-"),
      socket = path.join(dir, "test.sock"),
      connect = net.createConnection;
    const server = net.createServer((client) =>
      client.once("data", () => {
        const body = Buffer.from(
            JSON.stringify({ result: { text: "Before 😀 日本語 after" } }) + "\n",
          ),
          cut = body.indexOf(Buffer.from("😀")) + 2;
        client.write(body.subarray(0, cut));
        setTimeout(() => client.end(body.subarray(cut)), 10);
      }),
    );
    await new Promise((resolve) => server.listen(bindable(socket), resolve));
    net.createConnection = () => connect.call(net, socket);
    t.after(async () => {
      net.createConnection = connect;
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    });
    assert.equal((await request({ method: "fixture" })).text, "Before 😀 日本語 after");
  });
