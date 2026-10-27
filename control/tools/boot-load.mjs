// FU-423 boot load test runner. Not part of CI (it takes minutes and a few hundred MB of scratch space).
// 1. Seeds a scratch daemon home once (default 720 archived + 30 live sessions with real-size journals).
// 2. Copies the seed, starts the real daemon on the copy (fake providers; optional CPU profile of the boot).
// 3. Runs the real controller from --control against it for --minutes of fake time (timers SCALE times faster).
// 4. Reports, per fake 10-minute window, the agent requests by type (controller side), the daemon's request
//    counts and event loop delay (ws_runtime_metrics) and slow requests over 1 s (ws_slow_request).
//
//   node control/tools/boot-load.mjs --scratch E:/scratch/boot --label after [--control control] [--profile]
//        [--minutes 40] [--scale 8] [--live 30] [--archived 720]
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const scratch = path.resolve(arg("scratch"));
const label = arg("label", "run"),
  controlDir = path.resolve(repo, arg("control", "control")),
  minutes = Number(arg("minutes", "40")),
  scale = Number(arg("scale", "8")),
  live = arg("live", "30"),
  archived = arg("archived", "720"),
  port = Number(arg("port", "47423")),
  profile = args.includes("--profile");
const seed = path.join(scratch, "seed"),
  run = path.join(scratch, label);
const tsx = path.join(repo, "node_modules/tsx/dist/esm/index.mjs");
const daemonScript = path.join(repo, "packages/server/scripts/boot-load-daemon.ts");

function waitExit(child) {
  return new Promise((resolve) => child.on("exit", (code) => resolve(code)));
}
if (!fs.existsSync(path.join(seed, "sessions.json"))) {
  fs.rmSync(seed, { recursive: true, force: true });
  const s = spawn(
    process.execPath,
    [
      "--import",
      tsx,
      daemonScript,
      "--home",
      seed,
      "--seed",
      "--live",
      live,
      "--archived",
      archived,
    ],
    { cwd: path.join(repo, "packages/server"), stdio: "inherit" },
  );
  if ((await waitExit(s)) !== 0) throw Error("Seeding failed");
}
fs.rmSync(run, { recursive: true, force: true });
fs.cpSync(seed, run, { recursive: true });
// Absolute working folders in the records point into the seed; give the copy its own.
for (const dir of fs.readdirSync(path.join(run, ".paseo/agents"))) {
  const full = path.join(run, ".paseo/agents", dir);
  for (const f of fs.readdirSync(full)) {
    const file = path.join(full, f),
      record = JSON.parse(fs.readFileSync(file, "utf8"));
    record.cwd = record.cwd.replace(seed, run);
    fs.writeFileSync(file, JSON.stringify(record, null, 2));
  }
}

// Project ledgers, as on a host that uses the ledger command: every session snapshot reports archive protection
// from them. 12 projects of 40 open rows each.
const ledgers = path.join(run, "ledgers");
for (let p = 0; p < 12; p++) {
  fs.mkdirSync(path.join(ledgers, `project-${p}`), { recursive: true });
  const rows = Array.from(
    { length: 40 },
    (_, i) => `| P${p}-${i} | Load item ${i} | FIX | lead-${p} | OPEN | — | load |`,
  );
  fs.writeFileSync(
    path.join(ledgers, `project-${p}`, "OPEN-ITEMS.md"),
    [
      "| id | item | kind | owner | status | evidence | source |",
      "|---|---|---|---|---|---|---|",
      ...rows,
      "",
    ].join(String.fromCharCode(10)),
  );
}

const daemonLog = path.join(run, "daemon.log");
const daemon = spawn(
  process.execPath,
  [
    ...(profile ? ["--cpu-prof", "--cpu-prof-dir", path.join(run, "profile")] : []),
    "--import",
    tsx,
    daemonScript,
    "--home",
    run,
    "--port",
    String(port),
    "--log",
    daemonLog,
  ],
  {
    cwd: path.join(repo, "packages/server"),
    stdio: ["ignore", "pipe", "inherit", "ipc"],
    env: { ...process.env, FULCRA_LEDGER_DIR: ledgers },
  },
);
const bootStarted = Date.now();
await new Promise((resolve, reject) => {
  let out = "";
  daemon.stdout.on("data", (d) => {
    out += d;
    if (out.includes('"ready":true')) resolve();
  });
  daemon.on("exit", (code) => reject(Error(`daemon exited ${code}`)));
});
const daemonReadyMs = Date.now() - bootStarted;

const driverStart = Date.now();
const out = path.join(run, "controller.json");
const driver = spawn(
  process.execPath,
  ["--experimental-test-module-mocks", path.join(repo, "control/tools/boot-load-driver.mjs")],
  {
    cwd: repo,
    stdio: "inherit",
    env: {
      ...process.env,
      CONTROL_DIR: controlDir,
      ORCA_HOME: path.join(run, "orca-home"),
      DAEMON_PORT: String(port),
      SESSIONS: path.join(run, "sessions.json"),
      SCALE: String(scale),
      FAKE_MINUTES: String(minutes),
      OUT: out,
    },
  },
);
await waitExit(driver);
daemon.send("stop");
await Promise.race([waitExit(daemon), new Promise((r) => setTimeout(r, 30000))]);
daemon.kill();

// Daemon side: fake 10-minute windows from the driver start.
const windowOf = (time) => {
  const m = Math.floor(((time - driverStart) * scale) / 60000);
  return m < 0 ? "boot" : `${Math.floor(m / 10) * 10}-${Math.floor(m / 10) * 10 + 10} min`;
};
const daemonWindows = {};
const loopDelays = [];
for (const line of fs.readFileSync(daemonLog, "utf8").split("\n")) {
  if (!line.includes("ws_runtime_metrics") && !line.includes("ws_slow_request")) continue;
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    continue;
  }
  const w = (daemonWindows[windowOf(e.time)] ??= {
    requests: {},
    slowOver1s: {},
    loopP99Max: 0,
    loopMax: 0,
  });
  if (e.msg === "ws_slow_request" && e.durationMs > 1000)
    w.slowOver1s[e.requestType] = (w.slowOver1s[e.requestType] ?? 0) + 1;
  if (e.msg === "ws_runtime_metrics") {
    for (const t of e.inboundSessionRequestTypesTop ?? []) {
      const [type, count] = Array.isArray(t) ? t : [t.type ?? t.key, t.count];
      if (/agent/.test(type)) w.requests[type] = (w.requests[type] ?? 0) + count;
    }
    if (e.eventLoopDelay) {
      w.loopP99Max = Math.max(w.loopP99Max, e.eventLoopDelay.p99Ms);
      w.loopMax = Math.max(w.loopMax, e.eventLoopDelay.maxMs);
      loopDelays.push(e.eventLoopDelay);
    }
  }
}
const controller = JSON.parse(fs.readFileSync(out, "utf8"));
const report = {
  label,
  controlDir,
  sessions: { live: Number(live), archived: Number(archived) },
  daemonReadyMs,
  controllerStartMs: controller.startMs,
  fakeMinutes: minutes,
  scale,
  controller: { byType: controller.byType, windows: controller.windows },
  daemon: {
    windows: daemonWindows,
    eventLoopP99MaxMs: Math.max(0, ...loopDelays.map((d) => d.p99Ms)),
    eventLoopMaxMs: Math.max(0, ...loopDelays.map((d) => d.maxMs)),
  },
};
fs.writeFileSync(path.join(run, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
