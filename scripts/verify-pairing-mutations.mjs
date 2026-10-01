import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const cases = [
  [
    "m1",
    "packages/server/src/server/pairing/offer-store.ts",
    /found\.expiresAt\s*<=\s*now\s*\|\|\s*/,
    "",
    "packages/server/src/server/pairing/offer-store.test.ts",
  ],
  [
    "m2",
    "packages/server/src/server/pairing/offer-store.ts",
    /offers\.filter\(\(?o\)?\s*=>\s*o\.id\s*!==\s*id\)/,
    "offers",
    "packages/server/src/server/pairing/offer-store.test.ts",
  ],
  [
    "m3",
    "packages/server/src/server/authorization/index.ts",
    ' && p !== "access.manage"',
    "",
    "packages/server/src/server/pairing/relay-device-gate.test.ts",
  ],
  [
    "m4",
    "packages/server/src/server/websocket-server.ts",
    /void this\.detachSocket\(ws,\s*\{\s*code,\s*reason\s*\}\);\s*ws\.close\(code,\s*reason\);/,
    "      continue;",
    "packages/server/src/server/websocket-server.relay-reconnect.test.ts",
    "revocation immediately",
  ],
  [
    "m5",
    "packages/client/src/relay-v3/encrypted-channel.ts",
    "new DataView(framed).getBigUint64(0) !== this.receivedCounter + 1n",
    "false",
    "packages/client/src/relay-v3/pairing-v3.test.ts",
  ],
  [
    "m6",
    "packages/app/src/runtime/host-runtime.ts",
    'throw new Error("This host\'s identity changed. Remove it, then pair again.");',
    "return;",
    "src/runtime/host-runtime.test.ts",
    "relay host identity pin",
    "packages/app",
  ],
  [
    "m7",
    "packages/server/src/server/pairing/relay-device-gate.ts",
    "let record = this.registry.find(devicePublicKeyB64);",
    'let record = this.registry.find(devicePublicKeyB64); if (!record) return { claimed: false, admission: { principalId: "device:unknown", deviceId: "unknown", permissions: [] } };',
    "packages/server/src/server/pairing/relay-device-gate.test.ts",
    "refuses anonymous",
  ],
  [
    "m8",
    "packages/server/src/server/authorization/index.ts",
    'p !== "command-centre.manage" && ',
    "",
    "packages/server/src/server/pairing/relay-device-gate.test.ts",
    "refuses anonymous",
  ],
];
const requested = process.argv.slice(2);
if (requested.some((name) => !cases.some(([candidate]) => candidate === name)))
  throw new Error("Unknown mutation; choose m1–m8");
const selected = requested.length ? cases.filter(([name]) => requested.includes(name)) : cases;
function restoreMutation(name, file, before) {
  writeFileSync(file, before);
  if (readFileSync(file, "utf8") !== before) throw new Error(`${name}: restore failed`);
}
let failures = 0;
for (const [name, file, original, replacement, test, pattern, cwd] of selected) {
  const before = readFileSync(file, "utf8");
  if (!(original instanceof RegExp ? original.test(before) : before.includes(original)))
    throw new Error(`${name}: mutation anchor missing`);
  try {
    writeFileSync(
      file,
      original instanceof RegExp
        ? before.replace(original, replacement)
        : before.split(original).join(replacement),
    );
    const args = [
      "vitest",
      "run",
      test,
      "--maxWorkers=4",
      "--bail=1",
      ...(pattern ? ["-t", pattern] : []),
    ];
    const result = spawnSync("npx", args, { cwd: cwd ?? ".", encoding: "utf8", timeout: 120000 });
    const output = (result.stdout ?? "") + (result.stderr ?? "");
    // A loader failure is not a killed behavioural mutation.
    const killed = result.status !== 0 && /AssertionError/.test(output);
    console.log(`${name}: ${killed ? "KILLED" : "NOT PROVEN"} (exit ${result.status})`);
    const assertion = output.indexOf("AssertionError");
    console.log(
      assertion >= 0
        ? output.slice(Math.max(0, assertion - 300), assertion + 2300)
        : output.slice(-2600),
    );
    if (!killed) failures++;
  } catch (error) {
    // Restore before surfacing the failure; a failed restore still wins, as the former finally did.
    restoreMutation(name, file, before);
    throw error;
  }
  restoreMutation(name, file, before);
}
process.exitCode = failures ? 1 : 0;
