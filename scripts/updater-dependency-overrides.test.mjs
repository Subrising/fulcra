import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import path from "node:path";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
const fixture = process.env.PASEO_UPDATER_FIXTURE;
const require = createRequire(fixture ? path.join(fixture, "package.json") : import.meta.url);
const updaterRequire = createRequire(require.resolve("electron-updater/package.json"));
const { HttpExecutor, CancellationToken } = updaterRequire("builder-util-runtime");

const yamlRoot = fixture ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const yamlPackages = Object.entries(
  JSON.parse(readFileSync(path.join(yamlRoot, "package-lock.json"), "utf8")).packages,
).filter(([name]) => name.endsWith("node_modules/js-yaml"));
assert(yamlPackages.length > 0, "the lockfile must enumerate the YAML parsers under test");

for (const [location, metadata] of yamlPackages) {
  test(`YAML ${location}: ordinary metadata and bounded empty merge-source work`, () => {
    const modulePath = path.join(yamlRoot, location);
    const yaml = require(modulePath);
    assert.deepEqual(
      yaml.load("version: 1.2.3\nfiles:\n  - url: Fulcra.zip\n    sha512: fixture\n"),
      { version: "1.2.3", files: [{ url: "Fulcra.zip", sha512: "fixture" }] },
    );
    assert.deepEqual(
      yaml.load("defaults: &defaults {enabled: true}\napp: {<<: *defaults, name: Fulcra}\n"),
      { defaults: { enabled: true }, app: { enabled: true, name: "Fulcra" } },
    );
    // Both upstream majors default to 10,000 units of merge work. Keep each
    // sequence below the separate 100-element guard and exceed the work budget.
    const width = metadata.version.startsWith("3.") ? 90 : 80;
    const source =
      `arr: &arr [${Array(width).fill("{}").join(",")}]\ntargets:\n` + "  - <<: *arr\n".repeat(200);
    const child = spawnSync(
      process.execPath,
      [
        "-e",
        `const assert=require('node:assert/strict');const fs=require('node:fs');
         const yaml=require(process.argv[1]);
         assert.throws(()=>yaml.load(fs.readFileSync(0,'utf8')),/maxTotalMergeKeys/);`,
        modulePath,
      ],
      { input: source, encoding: "utf8", timeout: 3000, killSignal: "SIGKILL" },
    );
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr);
  });
}

test("YAML updater call site retains valid channel metadata and refuses excessive merge work", () => {
  const { parseUpdateInfo } = updaterRequire("./out/providers/Provider.js");
  const url = new URL("https://example.invalid/latest-mac.yml");
  assert.deepEqual(parseUpdateInfo("version: 1.2.3\npath: Fulcra.zip\n", "latest", url), {
    version: "1.2.3",
    path: "Fulcra.zip",
  });
  const source =
    `arr: &arr [${Array(80).fill("{}").join(",")}]\ntargets:\n` + "  - <<: *arr\n".repeat(200);
  assert.throws(() => parseUpdateInfo(source, "latest", url), /maxTotalMergeKeys/);
});

test("YAML native packaging configuration retains app identity and disabled publishing", () => {
  const yaml = require(path.join(yamlRoot, "node_modules/js-yaml"));
  const config = yaml.load(
    readFileSync(path.join(yamlRoot, "packages/desktop/electron-builder.yml"), "utf8"),
  );
  assert.equal(config.appId, "app.fulcra.desktop");
  const windowsShim = readFileSync(path.join(yamlRoot, "packages/desktop/bin/paseo.cmd"), "utf8");
  assert(
    windowsShim.includes(`\\${config.executableName}.exe`),
    "Windows CLI must launch the packaged executable",
  );
  assert.equal(config.publish, null);
  assert.equal(config.mac.minimumSystemVersion, "13.0.0");
  assert.deepEqual(config.protocols, [
    { name: "Fulcra conversation link", schemes: ["orca"] },
    { name: "Fulcra sign-in link", schemes: ["fulcra"] },
  ]);
});

async function withServers(check) {
  const signal = AbortSignal.timeout(2000);
  const servers = [];
  try {
    const target = http.createServer((req, res) => res.end(JSON.stringify(req.headers)));
    servers.push(target);
    target.listen(0, "127.0.0.1");
    await once(target, "listening", { signal });
    const targetAddress = target.address();
    assert(targetAddress && typeof targetAddress !== "string");
    const destination = `http://127.0.0.1:${targetAddress.port}`;
    let loopRequests = 0;
    const source = http.createServer((req, res) => {
      if (req.url === "/stall") return;
      if (req.url.startsWith("/chain/")) {
        loopRequests++;
        const hop = Number(req.url.split("/").at(-1));
        if (hop === 10) return res.end("chain complete");
        res.writeHead(302, { Location: `${origin}/chain/${hop + 1}` });
        res.end();
        return;
      }
      if (req.url === "/binary") return res.end(Buffer.from("synthetic artifact"));
      if (req.url === "/loop") {
        loopRequests++;
        if (loopRequests === 13) {
          res.writeHead(503);
          res.end("external test ceiling");
          return;
        }
        res.writeHead(302, { Location: `${origin}/loop` });
        res.end();
        return;
      }
      if (req.url === "/echo") return res.end(JSON.stringify(req.headers));
      res.writeHead(302, {
        Location: req.url === "/same" ? `${origin}/echo` : `${destination}/echo`,
      });
      res.end();
    });
    servers.push(source);
    source.listen(0, "127.0.0.1");
    await once(source, "listening", { signal });
    const sourceAddress = source.address();
    assert(sourceAddress && typeof sourceAddress !== "string");
    const origin = `http://127.0.0.1:${sourceAddress.port}`;
    class NodeExecutor extends HttpExecutor {
      createRequest(options, callback) {
        return http.request({ ...options, agent: false, signal }, callback);
      }
    }
    await check(new NodeExecutor(), origin, () => loopRequests, source, signal);
  } finally {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }
}

for (const name of [
  "authorization",
  "Authorization",
  "AUTHORIZATION",
  "PRIVATE-TOKEN",
  "Private_Token",
  "X-Api-Key",
  "Cookie",
]) {
  test(
    `${name}: retained on same origin, stripped on cross-origin redirect`,
    { timeout: 2500 },
    async () => {
      await withServers(async (executor, origin) => {
        const headers = { [name]: "synthetic-test-value", "X-Ordinary": "preserved" };
        const request = (route) => {
          const url = new URL(origin + route);
          return executor.request({
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            headers,
            timeout: 1000,
          });
        };
        const same = JSON.parse(await request("/same"));
        assert.equal(same[name.toLowerCase()], "synthetic-test-value");
        const cross = JSON.parse(await request("/cross"));
        assert.equal(cross[name.toLowerCase()], undefined);
        assert.equal(cross["x-ordinary"], "preserved");
        assert.deepEqual(headers, { [name]: "synthetic-test-value", "X-Ordinary": "preserved" });
      });
    },
  );
}

for (const method of ["request", "downloadToBuffer"]) {
  test(`${method}: redirect loop stops at the library limit`, { timeout: 2500 }, async () => {
    await withServers(async (executor, origin, count) => {
      const token = new CancellationToken();
      const url = new URL(origin + "/loop");
      const pending =
        method === "request"
          ? executor.request(
              {
                protocol: url.protocol,
                hostname: url.hostname,
                port: url.port,
                path: url.pathname,
                timeout: 1000,
              },
              token,
            )
          : executor.downloadToBuffer(url, { cancellationToken: token });
      await assert.rejects(pending, /Too many redirects/);
      assert.equal(count(), 11);
      assert.equal(token.listenerCount("cancel"), 0);
    });
  });
}

test("downloadToBuffer preserves ordinary artifact bytes", { timeout: 2500 }, async () => {
  await withServers(async (executor, origin) => {
    const bytes = await executor.downloadToBuffer(new URL(origin + "/binary"), {
      cancellationToken: new CancellationToken(),
    });
    assert.deepEqual(bytes, Buffer.from("synthetic artifact"));
  });
});

for (const method of ["request", "downloadToBuffer"]) {
  test(`${method}: exactly ten redirects succeed`, { timeout: 2500 }, async () => {
    await withServers(async (executor, origin, count) => {
      const token = new CancellationToken();
      const url = new URL(origin + "/chain/0");
      const result =
        method === "request"
          ? await executor.request(
              {
                protocol: url.protocol,
                hostname: url.hostname,
                port: url.port,
                path: url.pathname,
                timeout: 1000,
              },
              token,
            )
          : await executor.downloadToBuffer(url, { cancellationToken: token });
      assert.equal(String(result), "chain complete");
      assert.equal(count(), 11);
      assert.equal(token.listenerCount("cancel"), 0);
    });
  });
  test(`${method}: cancellation rejects and releases listeners`, { timeout: 2500 }, async () => {
    await withServers(async (executor, origin, _count, server, signal) => {
      const token = new CancellationToken();
      const received = once(server, "request", { signal });
      const url = new URL(origin + "/stall");
      const pending =
        method === "request"
          ? executor.request(
              {
                protocol: url.protocol,
                hostname: url.hostname,
                port: url.port,
                path: url.pathname,
                timeout: 1000,
              },
              token,
            )
          : executor.downloadToBuffer(url, { cancellationToken: token });
      const rejected = assert.rejects(pending, /cancelled/);
      await received;
      token.cancel();
      await rejected;
      assert.equal(token.listenerCount("cancel"), 0);
    });
  });
}
