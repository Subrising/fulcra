// Run under the build scheduler after packaging, before any app replacement.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { listPackage, statFile } from "@electron/asar";

const app = path.resolve(process.argv[2] ?? "");
const models = process.argv[3];
assert(
  process.argv[2] && models,
  "Usage: node scripts/packaged-runtime-gate.mjs <Fulcra.app> <cached-local-speech-models>",
);
const resources = path.join(app, "Contents/Resources");
const archive = path.join(resources, "app.asar");
const members = listPackage(archive);
assert(members.length >= 10271, `ASAR entries ${members.length} below 157e baseline 10271`);
assert(members.includes("/node_modules/@clack/core/package.json"), "Missing @clack/core");
const native = `node_modules/sherpa-onnx-darwin-${process.arch}`;
for (const file of [
  "README.md",
  "index.js",
  "package.json",
  "sherpa-onnx.node",
  "libsherpa-onnx-c-api.dylib",
  "libsherpa-onnx-cxx-api.dylib",
  "libonnxruntime.1.23.2.dylib",
  "libonnxruntime.dylib",
]) {
  assert(
    statFile(archive, `${native}/${file}`).unpacked,
    `Sherpa member must be unpacked: ${file}`,
  );
  assert(
    fs.existsSync(path.join(resources, "app.asar.unpacked", native, file)),
    `Missing physical Sherpa member: ${file}`,
  );
}
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "fulcra-packaged-gate-"));
const home = path.join(scratch, "home");
fs.mkdirSync(home, { mode: 0o700 });
fs.writeFileSync(
  path.join(home, "config.json"),
  JSON.stringify({
    version: 1,
    daemon: {
      listen: "127.0.0.1:0",
      relay: { enabled: false },
      mcp: { enabled: false, injectIntoAgents: false },
    },
  }),
  { mode: 0o600 },
);
const cli = path.join(resources, "bin/paseo");
const env = {
  ...process.env,
  PASEO_HOME: home,
  PASEO_PASSWORD: "",
  PASEO_HOST: "",
  PASEO_LISTEN: "127.0.0.1:0",
  NODE_PATH: "",
  NODE_OPTIONS: "",
};
const run = (...args) =>
  execFileSync(cli, ["--home", home, ...args], {
    env,
    timeout: 90000,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
let started = false;
try {
  run("daemon", "status", "--json");
  started = true;
  run("daemon", "start", "--timeout", "60", "--json");
  const status = JSON.parse(run("daemon", "status", "--json"));
  const agents = JSON.parse(run("ls", "--json"));
  assert(
    Array.isArray(agents) && agents.length === 0,
    "Temporary daemon must have no saved agents",
  );
  const helper = path.join(
    app,
    `Contents/Frameworks/Fulcra Helper.app/Contents/MacOS/Fulcra Helper`,
  );
  const runner = path.join(resources, "app.asar.unpacked/dist/daemon/node-entrypoint-runner.js");
  const speech = fileURLToPath(new URL("./packaged-speech-gate.cjs", import.meta.url));
  execFileSync(helper, [runner, "node-script", speech, archive, path.resolve(models)], {
    env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
    timeout: 180000,
    stdio: "inherit",
  });
  console.log(
    JSON.stringify({
      result: "PASS",
      asarEntries: members.length,
      clackCore: true,
      packagedDaemon: true,
      packagedCliStatus: true,
      packagedCliLs: true,
      speechModels: ["parakeet", "kokoro", "silero"],
      home,
      status,
    }),
  );
} finally {
  if (started) run("daemon", "stop", "--json");
  fs.rmSync(scratch, { recursive: true, force: true });
}
