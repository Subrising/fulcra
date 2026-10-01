// External packaged-module G1 harness. Run only in the admitted gates-9 batch.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";
const [app, sourceSha, expectedAsar, expectedRunner, output] = process.argv.slice(2);
const hash = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const receipt = {
  scope: "packaged-module G1; not full-daemon paused dispatch",
  sourceSha,
  status: "HOLD",
  graph: [],
  checks: [],
};
let hooks;
try {
  const moduleApi = await import("node:module");
  assert.equal(typeof moduleApi.registerHooks, "function", "Runner lacks registerHooks");
  assert(app && output && /^[a-f0-9]{40}$/.test(sourceSha));
  assert(/^[a-f0-9]{64}$/.test(expectedAsar) && /^[a-f0-9]{64}$/.test(expectedRunner));
  assert(
    !process.env.NODE_OPTIONS && !process.env.NODE_PATH,
    "External loader/dependency environment forbidden",
  );
  const root = fs.realpathSync(app);
  const runner = fs.realpathSync(path.join(root, "Contents/MacOS/Fulcra"));
  assert.equal(
    fs.realpathSync(process.execPath),
    runner,
    "Use sealed candidate Electron Node runner",
  );
  const asar = path.join(root, "Contents/Resources/app.asar");
  const archiveFs = moduleApi.createRequire(import.meta.url)("original-fs");
  assert.equal(
    createHash("sha256").update(archiveFs.readFileSync(asar)).digest("hex"),
    expectedAsar,
  );
  assert.equal(hash(runner), expectedRunner);
  Object.assign(receipt, {
    asarSha256: expectedAsar,
    runnerSha256: expectedRunner,
    runner,
    runtime: process.version,
  });
  const prefix = pathToFileURL(asar + path.sep).href;
  // Observational resolver: never redirects imports or supplies substitute code.
  hooks = moduleApi.registerHooks({
    resolve(specifier, context, next) {
      const resolved = next(specifier, context);
      if (!resolved.url.startsWith("node:")) {
        assert(resolved.url.startsWith(prefix), "Dependency escaped sealed ASAR graph");
        assert(!resolved.url.includes("?"), "Module identity alias forbidden");
        const file = fileURLToPath(resolved.url);
        receipt.graph.push({ file: file.slice(asar.length + 1), sha256: hash(file) });
      }
      return resolved;
    },
  });
  const modules = path.join(asar, "node_modules/@getpaseo/server/dist/server/server/plugins");
  const managementUrl = pathToFileURL(path.join(modules, "management.js")).href;
  const channelFile = path.join(modules, "controller-channel.js");
  assert(
    /from\s*["']\.\/management\.js["']/.test(fs.readFileSync(channelFile, "utf8")),
    "Canonical shared management import missing",
  );
  const { ManagementAuthority } = await import(managementUrl);
  const { ControllerChannel } = await import(pathToFileURL(channelFile).href);
  assert.equal(typeof ManagementAuthority, "function");
  assert.equal(typeof ControllerChannel, "function");
  receipt.status = "FAIL"; // Only verified artifact imports advance beyond preflight HOLD.
  const command = {
    method: "session-takeover",
    input: { session: randomUUID(), accountId: randomUUID() },
  };
  const full = ["daemon.manage", "command-centre.manage", "accounts.manage"];
  const target = {
    pluginId: "orca-organization-next",
    bundleDirectory: modules,
    isCurrent: () => true,
  };
  async function exercise(kind) {
    let permissions = [...full];
    const frames = [];
    let release;
    let entered;
    const barrier = new Promise((resolve) => {
      release = resolve;
    });
    const enteredSignal = new Promise((resolve) => {
      entered = resolve;
    });
    const authority = new ManagementAuthority({ enabled: () => true, validate: (value) => value });
    const channel = new ControllerChannel({
      child: {},
      issue: () => {
        throw Error("Unused");
      },
      revoke: () => {},
      rpc: async () => null,
      send: async (frame) => {
        assert.deepEqual(frame.command, command);
        assert.equal(frame.type, "management");
        assert.equal(frame.principal.authentication, "paired-device");
        assert.deepEqual(frame.principal.permissions, full);
        frames.push(frame);
        return { id: frame.id, epoch: frame.epoch, ok: true, result: { ok: true } };
      },
    });
    authority.register(target.pluginId, async (actual, principal) => {
      if (kind === "final-bridge") {
        entered();
        await barrier;
      }
      return channel.management(actual, principal);
    });
    const invocation = authority.open(target, () => ({
      id: "synthetic-owner-phone",
      deviceId: "synthetic-owner-phone",
      authentication: "paired-device",
      permissions,
    }));
    assert(invocation && invocation.accountsManage);
    const timeout = setTimeout(() => {
      release();
    }, 10000);
    try {
      if (kind === "open-invocation") permissions = full.filter((p) => p !== "accounts.manage");
      const pending = invocation.invoke(randomUUID(), command);
      // Attach rejection handling before awaiting the bridge signal.
      const settled = pending.then(
        (value) => ({ value }),
        () => ({ rejected: true }),
      );
      if (kind === "final-bridge") {
        await Promise.race([
          enteredSignal,
          new Promise((_, reject) => setTimeout(() => reject(Error("Bridge never entered")), 5000)),
        ]);
        permissions = full.filter((p) => p !== "accounts.manage");
        release();
      }
      const result = await settled;
      if (kind === "granted") {
        assert.deepEqual(result.value, { ok: true });
        assert.equal(frames.length, 1);
      } else {
        assert.equal(result.rejected, true);
        assert.equal(frames.length, 0);
        assert.deepEqual(permissions, full.slice(0, 2));
      }
      receipt.checks.push({
        boundary: kind,
        sends: frames.length,
        rejected: result.rejected === true,
        accountsManageOnlyRevoked: kind !== "granted",
      });
    } finally {
      clearTimeout(timeout);
      release();
      invocation.close();
      authority.close();
      channel.close();
    }
  }
  await exercise("granted");
  await exercise("open-invocation");
  await exercise("final-bridge");
  receipt.status = "PASS";
} catch {
  // No raw errors, paths from dependency internals, commands or credentials in receipt.
  receipt.reason =
    receipt.status === "HOLD"
      ? "Candidate runner/ASAR exports/dependency preflight unavailable"
      : "Packaged positive or revocation boundary failed";
} finally {
  hooks?.deregister();
  if (output)
    fs.writeFileSync(
      output,
      JSON.stringify({ ...receipt, harnessSha256: hash(fileURLToPath(import.meta.url)) }, null, 2) +
        "\n",
    );
}
if (receipt.status === "PASS") process.exitCode = 0;
else if (receipt.status === "HOLD") process.exitCode = 3;
else process.exitCode = 1;
