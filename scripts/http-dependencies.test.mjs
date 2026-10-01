import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";

const require = createRequire(
  process.env.PASEO_HTTP_DEPENDENCY_ROOT
    ? path.join(process.env.PASEO_HTTP_DEPENDENCY_ROOT, "package.json")
    : import.meta.url,
);
const express = require("express");

test("native IP parsing rejects ambiguous leading-zero hosts and preserves ordinary addresses", () => {
  const { Address4 } = require("ip-address");
  for (const host of ["012.0.0.1", "012.012.012.012", "010.0.0.1"]) {
    assert.equal(Address4.isValid(host), false);
    assert.throws(() => new Address4(host), /zero|invalid/i);
  }
  assert.equal(new Address4("10.0.0.1").isPrivate(), true);
  assert.equal(new Address4("10.0.0.1/0").isPrivate(), true);
  assert.equal(new Address4("192.0.2.1").correctForm(), "192.0.2.1");
});

test("native URI parsing rejects malformed IPv6 instead of rewriting its destination", () => {
  const uri = require("fast-uri");
  for (const host of ["::not-valid", "fc00::not-hex", "fe80::not-hex"]) {
    assert.match(uri.parse(`http://[${host}]/private`).error, /host|IPv6/i);
  }
  assert.equal(uri.parse("https://[::1]:8443/path").host, "::1");
  assert.equal(
    uri.resolve("https://example.com/base/", "../next?q=1"),
    "https://example.com/next?q=1",
  );
});

test("Express parsers reject an invalid size limit instead of accepting unbounded input", () => {
  for (const parser of [express.json, express.raw, express.text, express.urlencoded]) {
    for (const limit of ["invalid", NaN]) {
      assert.throws(() => parser({ limit, extended: true }), TypeError);
    }
  }
});

test("untrusted query objects can be serialized without calling an input-supplied isBuffer", () => {
  const qs = require("qs");
  const query = "x%5Bconstructor%5D%5BisBuffer%5D=y";
  for (const options of [{ plainObjects: true }, { allowPrototypes: true }]) {
    assert.equal(qs.stringify(qs.parse(query, options)), query);
  }
  assert.equal(qs.stringify({ value: Buffer.from("hello") }), "value=hello");
});

test("Hono rejects excessive form nesting but preserves ordinary nested fields", async () => {
  const { parseBody } = require("hono/utils/body");
  const request = (key) =>
    new Request("http://localhost/", {
      method: "POST",
      body: new URLSearchParams([[key, "value"]]),
    });
  const normal = await parseBody(request("user.name"), { dot: true });
  assert.equal(normal.user.name, "value");
  await assert.rejects(
    parseBody(request(Array(128).fill("a").join(".")), { dot: true }),
    /Nesting limit exceeded/,
  );
});

async function withHttp(app, check) {
  const server = http.createServer(app);
  server.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    await check(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test(
  "Express JSON accepts normal input and refuses malformed and oversized requests",
  { timeout: 5000 },
  async () => {
    const app = express();
    app.use(express.json()); // Same default parser as Paseo bootstrap.
    app.post("/json", (req, res) => res.json(req.body));
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ type: err.type }));
    await withHttp(app, async (base) => {
      const send = (body) =>
        fetch(base + "/json", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(2000),
        });
      const valid = await send(JSON.stringify({ message: "hello 🌊", rows: [1, 2] }));
      assert.equal(valid.status, 200);
      assert.deepEqual(await valid.json(), { message: "hello 🌊", rows: [1, 2] });
      const malformed = await send('{"unfinished":');
      assert.equal(malformed.status, 400);
      assert.deepEqual(await malformed.json(), { type: "entity.parse.failed" });
      const oversized = await send(JSON.stringify({ value: "x".repeat(103000) }));
      assert.equal(oversized.status, 413);
      assert.deepEqual(await oversized.json(), { type: "entity.too.large" });
    });
  },
);

test("Express query and form parsing preserve nested fields and repeated values", async () => {
  const app = express();
  app.get("/query", (req, res) => res.json(req.query));
  app.post("/form", express.urlencoded({ extended: true }), (req, res) => res.json(req.body));
  await withHttp(app, async (base) => {
    const input = "user[name]=the owner&roles[]=reader&roles[]=writer";
    const expected = { user: { name: "The owner" }, roles: ["reader", "writer"] };
    const query = await fetch(base + "/query?" + input, { signal: AbortSignal.timeout(2000) });
    assert.equal(query.status, 200);
    assert.deepEqual(await query.json(), expected);
    const form = await fetch(base + "/form", {
      method: "POST",
      body: input,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(2000),
    });
    assert.equal(form.status, 200);
    assert.deepEqual(await form.json(), expected);
  });
});

test(
  "SDK node adapter completes stateless MCP initialization and tool exchange",
  { timeout: 10000 },
  async () => {
    const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
    const {
      StreamableHTTPServerTransport,
    } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
    const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
    const {
      StreamableHTTPClientTransport,
    } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const app = express();
    app.use(express.json());
    const sessions = new Set();
    async function handleMcp(req, res) {
      try {
        const mcp = new McpServer({ name: "dependency-canary", version: "1" });
        sessions.add(mcp);
        mcp.registerTool("canary", {}, async () => ({
          content: [{ type: "text", text: "parsed-and-delivered" }],
        }));
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => {
          void mcp.close();
        });
        await mcp.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    }
    app.post("/mcp", (req, res) => {
      void handleMcp(req, res);
    });
    try {
      await withHttp(app, async (base) => {
        const client = new Client({ name: "dependency-test", version: "1" });
        try {
          await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp")));
          assert.equal(client.getServerVersion().name, "dependency-canary");
          assert.deepEqual(
            (await client.listTools()).tools.map((t) => t.name),
            ["canary"],
          );
          assert.deepEqual((await client.callTool({ name: "canary", arguments: {} })).content, [
            { type: "text", text: "parsed-and-delivered" },
          ]);
        } finally {
          await client.close();
        }
      });
    } finally {
      await Promise.all([...sessions].map((mcp) => mcp.close()));
    }
  },
);
