// Real launch of the packaged desktop app in an isolated userData dir and daemon home.
// Passes only when the main process loads the renderer and reaches the daemon start
// path, so a build that loads but stalls (as 0.2.3 did on the Book) cannot pass.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";

const app = path.resolve(process.argv[2] ?? "");
assert(process.argv[2], "Usage: node scripts/packaged-desktop-launch-gate.mjs <Fulcra.app>");
const timeoutMs = Number(process.env.FULCRA_DESKTOP_LAUNCH_TIMEOUT_MS ?? 60000);
const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "fulcra-desktop-launch-"));
const userData = path.join(scratch, "userData");
const home = path.join(scratch, "home");
fs.mkdirSync(userData);
fs.mkdirSync(home);
fs.writeFileSync(
  path.join(userData, "desktop-settings.json"),
  JSON.stringify({
    version: 1,
    settings: {
      releaseChannel: "stable",
      daemon: {
        commandCentreEnabled: true,
        manageBuiltInDaemon: false,
        keepRunningAfterQuit: false,
      },
    },
  }),
);
// FULCRA_GATE_SEED_USERDATA: an existing userData dir (e.g. the live one). Its encrypted state makes
// the app read the "Orca Safe Storage" Keychain item, so an untrusted build shows a prompt and fails.
const seed = process.env.FULCRA_GATE_SEED_USERDATA;
if (seed) {
  for (const entry of [
    "Preferences",
    "Local State",
    "Local Storage",
    "IndexedDB",
    "Session Storage",
    "relay-device-identity.json",
    "WebStorage",
  ])
    if (fs.existsSync(path.join(seed, entry)))
      fs.cpSync(path.join(seed, entry), path.join(userData, entry), { recursive: true });
}
const logPath = path.join(scratch, "stdout.log");
const log = fs.openSync(logPath, "w");
const port = 20000 + Math.floor(Math.random() * 20000);
const child = spawn(path.join(app, "Contents/MacOS/Fulcra"), [], {
  env: {
    ...process.env,
    PASEO_ELECTRON_USER_DATA_DIR: userData,
    PASEO_HOME: home,
    PASEO_LISTEN: `127.0.0.1:${port}`,
    ELECTRON_ENABLE_LOGGING: "1",
  },
  stdio: ["ignore", log, log],
});
let exited = null;
child.on("exit", (code) => {
  exited = code;
});
const securityAgents = () => {
  try {
    return execFileSync("/usr/bin/pgrep", ["-x", "SecurityAgent"], {
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
};
const agentsBefore = new Set(securityAgents());
const read = () => fs.readFileSync(logPath, "utf8");
const markers = [
  "[open-project] renderer requested pending path",
  "[desktop daemon] initial status check before start",
];
const stillRunning = () => exited === null;
try {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && stillRunning() && !markers.every((m) => read().includes(m)))
    await new Promise((resolve) => setTimeout(resolve, 500));
  const text = read();
  const promptAppeared = securityAgents().some((pid) => !agentsBefore.has(pid));
  assert(
    exited === null,
    `Packaged desktop exited with code ${exited} before reaching the daemon start path`,
  );
  assert(
    !promptAppeared,
    "A macOS Keychain trust prompt appeared; the build is not trusted by an existing Keychain item",
  );
  for (const marker of markers)
    assert(text.includes(marker), `Desktop launch stalled: missing '${marker}'`);
  console.log(
    JSON.stringify({
      result: "PASS",
      desktopLaunch: true,
      scratch: path.basename(scratch),
    }),
  );
} finally {
  child.kill("SIGTERM");
  const killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
  // The app and its helpers keep writing userData while they quit; wait for exit before removing it.
  for (let waited = 0; stillRunning() && waited < 15000; waited += 250)
    await new Promise((resolve) => setTimeout(resolve, 250));
  clearTimeout(killTimer);
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
}
