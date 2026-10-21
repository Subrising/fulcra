import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createDistribution } from "./distribution-host.mjs";

// FU-466: the controller child must start with the inspector flags that the daemon passes (FU-79).
async function controllerExecArgv(hostFlags) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dc-flags-")));
  const bundle = path.join(root, "bundle");
  fs.mkdirSync(bundle, { mode: 0o700 });
  const out = path.join(root, "execargv.json");
  fs.writeFileSync(
    path.join(bundle, "controller.mjs"),
    `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.execArgv)); setTimeout(() => {}, 60000);\n`,
    { mode: 0o600 },
  );
  const distribution = createDistribution({
    home: path.join(root, "home"),
    bundleDirectory: bundle,
  });
  // setup() only needs to record the provenance minter; every other server hook is a no-op here.
  const noop = () => new Proxy(function () {}, { get: noop, apply: noop });
  const server = new Proxy({}, { get: noop });
  distribution.setup(server);
  const host = {
    boot: "test-boot",
    consumeManagement() {},
    createChannel: () => ({ epoch: 1, serviceReady() {}, close() {} }),
  };
  if (hostFlags !== undefined) host.nodeFlags = hostFlags;
  try {
    distribution.start(host);
    for (let i = 0; i < 100 && !fs.existsSync(out); i += 1)
      await new Promise((r) => setTimeout(r, 100));
    return JSON.parse(fs.readFileSync(out, "utf8"));
  } finally {
    await distribution.stop().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("controller child starts with the flags the daemon passes", async () => {
  assert.deepEqual(await controllerExecArgv(["--disable-sigusr1"]), ["--disable-sigusr1"]);
});

test("controller child fails closed when the daemon passes no flags field", async () => {
  assert.deepEqual(await controllerExecArgv(undefined), ["--disable-sigusr1"]);
});

test("controller child gets no flag when the gate flavour passes an empty list", async () => {
  assert.deepEqual(await controllerExecArgv([]), []);
});
