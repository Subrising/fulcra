// Source-delivered gate. Packager runs once against the sealed candidate in gates-9.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
if (process.argv.includes("--help")) {
  console.log(
    "Usage: node gate-desktop-enablement.mjs <staged-Fulcra.app> <fresh-evidence-directory> (under heavy lock)",
  );
  process.exit(0);
}
const [appArg, evidenceArg] = process.argv.slice(2);
if (!appArg || !evidenceArg) {
  console.log("FAIL missing staged app/evidence directory");
  process.exit(2);
}
const app = fs.realpathSync(appArg);
if (app.startsWith("/Applications/") || !app.endsWith(".app")) {
  console.log("FAIL staged app required");
  process.exit(2);
}
const evidence = path.resolve(evidenceArg);
fs.mkdirSync(evidence, { mode: 0o700 }); // Fresh receipt only; never overwrite a previous run.
const home = path.join(evidence, "scratch-home");
fs.mkdirSync(home, { mode: 0o700 });
const binary = path.join(app, "Contents/MacOS/Fulcra");
const resources = path.join(app, "Contents/Resources/app.asar");
const probe = fileURLToPath(new URL("./desktop-enablement-probe.cjs", import.meta.url));
const child = spawnSync(binary, [probe, resources], {
  env: {
    ELECTRON_RUN_AS_NODE: "1",
    HOME: home,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    TMPDIR: home,
  },
  encoding: "utf8",
  timeout: 60000,
  maxBuffer: 8192,
});
let result;
try {
  result = JSON.parse(child.stdout);
} catch {
  result = { checks: [], failed: true };
}
const expected = [
  "packaged Keychain secret-free failure",
  "packaged readback failure",
  "packaged restart ownership and app launcher",
];
const modules = ["command-centre-keychain", "command-centre-auth", "managed-restart"];
const hashes = Object.fromEntries(
  modules
    .filter((name) => /^[a-f0-9]{64}$/.test(result.hashes?.[name] ?? ""))
    .map((name) => [name, result.hashes[name]]),
);
const pass =
  child.status === 0 &&
  !result.failed &&
  expected.every((name) => result.checks?.some((c) => c.name === name && c.ok === true)) &&
  Object.keys(hashes).length === 3;
for (const name of expected)
  console.log(
    `${result.checks?.some((c) => c.name === name && c.ok === true) ? "PASS" : "FAIL"} ${name}`,
  );
// Never persist stderr/raw stdout: adapters can put credential attributes in errors.
fs.writeFileSync(
  path.join(evidence, "result.json"),
  JSON.stringify(
    {
      gate: "desktop-enablement",
      app,
      pass,
      checks: expected.map((name) => ({
        name,
        ok: Boolean(result.checks?.some((c) => c.name === name && c.ok === true)),
      })),
      hashes,
      status: child.status,
    },
    null,
    2,
  ) + "\n",
  { flag: "wx", mode: 0o600 },
);
process.exit(pass ? 0 : 1);
