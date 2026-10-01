// Run ONLY by the staged gate under the staged Electron binary, with a scratch HOME.
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const root = process.argv[2];
const load = (name) => require(path.join(root, "dist/daemon", name + ".js"));
const checks = [];
(async () => {
  const { createCommandCentreKeychain } = load("command-centre-keychain");
  const { commandCentreCredential } = load("command-centre-auth");
  const { restartManagedDaemon } = load("managed-restart");
  const service = "ai.fulcra.command-centre." + "a".repeat(64);
  const calls = [];
  const keychain = createCommandCentreKeychain(async (args, input) => {
    calls.push({ args, input });
    return {
      code: 0,
      stdout: "",
      stderr: "security> User interaction is not allowed. fake-sensitive-value",
    };
  }, "darwin");
  await assert.rejects(
    keychain.set(service, "b".repeat(64)),
    (error) =>
      /interaction-not-allowed/.test(error.message) &&
      !/fake-sensitive-value/.test(error.message) &&
      !error.cause,
  );
  assert.deepEqual(calls[0].args, ["-i"]);
  assert.equal(calls.length, 1);
  checks.push({ name: "packaged Keychain secret-free failure", ok: true });
  const fake = {
    async get() {
      return null;
    },
    async set() {},
  };
  await assert.rejects(
    commandCentreCredential({ enabled: true, home: "/fake-readback", keychain: fake }),
    /not-found-after-write/,
  );
  checks.push({ name: "packaged readback failure", ok: true });
  let effects = 0;
  await assert.rejects(
    restartManagedDaemon({
      async status() {
        return { status: "running", ownedByDesktop: false };
      },
      async stopOwned() {
        effects++;
        return { status: "stopped", ownedByDesktop: false };
      },
      async startManaged() {
        effects++;
        return { status: "running", ownedByDesktop: true };
      },
    }),
    /authenticated owner adoption/,
  );
  assert.equal(effects, 0);
  const order = [];
  await restartManagedDaemon({
    async status() {
      return { status: "running", ownedByDesktop: true };
    },
    async stopOwned() {
      order.push("stop");
      return { status: "stopped", ownedByDesktop: false };
    },
    async startManaged() {
      order.push("app-launch");
      return { status: "running", ownedByDesktop: true };
    },
  });
  assert.deepEqual(order, ["stop", "app-launch"]);
  checks.push({ name: "packaged restart ownership and app launcher", ok: true });
  const hashes = Object.fromEntries(
    ["command-centre-keychain", "command-centre-auth", "managed-restart"].map((name) => [
      name,
      crypto
        .createHash("sha256")
        .update(fs.readFileSync(path.join(root, "dist/daemon", name + ".js")))
        .digest("hex"),
    ]),
  );
  process.stdout.write(JSON.stringify({ checks, hashes }) + "\n");
})().catch(() => {
  // Never print raw exceptions from imported code or a credential adapter.
  process.stdout.write(JSON.stringify({ checks, failed: true }) + "\n");
  process.exitCode = 1;
});
