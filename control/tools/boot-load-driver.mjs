// FU-423 boot load test, controller side. Not part of CI: control/tools/boot-load.mjs runs it.
// Runs the REAL startController and REAL connectNative from CONTROL_DIR over a REAL DaemonClient connected to the
// scratch daemon. Only the owned-channel pieces the scratch daemon cannot provide are replaced (catalog activation,
// the permission channel, provenance-bound input), as in native-roles.test.mjs. Periodic timers and the clock run
// SCALE times faster, so a few real minutes cover the first 40 minutes after a boot. Every agent request is counted
// per type and per fake 10-minute window, with its client-side duration.
//
//   node --experimental-test-module-mocks control/tools/boot-load-driver.mjs
//   env: CONTROL_DIR, ORCA_HOME, DAEMON_PORT, SESSIONS (sessions.json), SCALE, FAKE_MINUTES, OUT
import { mock } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const SCALE = Number(process.env.SCALE ?? 8),
  FAKE_MINUTES = Number(process.env.FAKE_MINUTES ?? 40);
const controlDir = path.resolve(process.env.CONTROL_DIR);
const at = (rel) => pathToFileURL(path.join(controlDir, rel)).href;

// Fake time: periodic timers and the clock (Date.now and new Date()) run SCALE times faster. One-shot timers keep
// real time, so request timeouts and the startup pacing are not shortened.
const RealDate = Date,
  realNow = RealDate.now.bind(RealDate),
  start = realNow();
const fakeNow = () => start + (realNow() - start) * SCALE;
globalThis.Date = class extends RealDate {
  constructor(...a) {
    super(...(a.length ? a : [fakeNow()]));
  }
  static now() {
    return fakeNow();
  }
};
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...rest) =>
  realSetInterval(fn, ms >= 10000 ? Math.max(1, Math.round(ms / SCALE)) : ms, ...rest);
const fakeMinute = () => Math.floor((Date.now() - start) / 60000);

const { firstRun } = await import(at("src/config.mjs"));
fs.mkdirSync(process.env.ORCA_HOME, { recursive: true, mode: 0o700 });
firstRun({ ORCA_HOME: fs.realpathSync(process.env.ORCA_HOME) });

const realInput = await import(at("src/control/trusted-native-input.mjs") + "?real"),
  realPermission = await import(at("src/control/permission-channel.mjs") + "?real");
mock.module(at("src/control/catalog-activation.mjs"), {
  namedExports: {
    catalogActivation: () => ({ refresh: async () => {}, require: () => "load-boot", close() {} }),
  },
});
mock.module(at("src/control/trusted-native-input.mjs"), {
  namedExports: { ...realInput, boundNativeInputs: () => ({}) },
});
mock.module(at("src/control/permission-channel.mjs"), {
  namedExports: {
    ...realPermission,
    permissionChannel: () => ({ ready: async () => {}, close: async () => {} }),
  },
});

const { DaemonClient } = await import("@getpaseo/client/internal/daemon-client");
const requests = [];
for (const method of [
  "fetchAgent",
  "fetchAgentTimeline",
  "fetchAgents",
  "fetchAgentHistory",
  "fetchWorkspaces",
  "getAgentMcpRefreshState",
  "refreshAgentMcp",
]) {
  const original = DaemonClient.prototype[method];
  DaemonClient.prototype[method] = async function (...a) {
    const t0 = realNow(),
      row = { type: method, minute: fakeMinute(), ms: 0, ok: true };
    row.id = typeof a[0] === "string" ? a[0] : (a[0]?.agentId ?? null);
    // The first controller frame outside the native adapter names the caller.
    const frame = String(new Error().stack)
      .split(/\r?\n/)
      .map((line) => line.match(/\/src\/(?:control\/)?([\w.-]+\.mjs):(\d+)/))
      .find((m) => m && !["native.mjs", "host-native.mjs", "client-sdk.mjs"].includes(m[1]));
    row.site = frame ? `${frame[1]}:${frame[2]}` : "other";
    requests.push(row);
    try {
      return await original.apply(this, a);
    } catch (error) {
      row.ok = false;
      throw error;
    } finally {
      row.ms = realNow() - t0;
    }
  };
}
const daemon = new DaemonClient({
  url: `ws://127.0.0.1:${process.env.DAEMON_PORT}/ws`,
  appVersion: "0.11.4",
  clientId: `boot-load-${randomUUID()}`,
});
await daemon.connect();

// The controller journal knows every session, as on a long-lived host. The scratch boot differs from the boot
// they were delegated under, as after a daemon restart.
const sessions = JSON.parse(fs.readFileSync(process.env.SESSIONS, "utf8"));
const { CONTROLLER_HOME } = await import(at("src/control/installation-settings.mjs"));
const { ControlStore } = await import(at("src/control/store.mjs"));
{
  const store = new ControlStore(`${CONTROLLER_HOME}/journal.sqlite`);
  const insert = store.db.prepare(
    "INSERT OR IGNORE INTO sessions(id,task,cwd,mode,generation,boot) VALUES (?,?,?,'delegated',1,'old-boot')",
  );
  for (const s of sessions) insert.run(s.id, "load-task", `/tmp/load/${s.id}`);
  store.close();
}

const { startController } = await import(at("src/control/server.mjs"));
process.exit = (code) => {
  throw Error(`controller asked to exit (${code})`);
};
const t0 = realNow();
await startController({
  daemon,
  issueProvenance: async () => "token",
  registerManagement: () => () => {},
  epoch: randomUUID(),
  getHandshakeBoot: () => "load-boot",
});
const startMs = realNow() - t0;
await new Promise((resolve) => setTimeout(resolve, (FAKE_MINUTES * 60000) / SCALE));

const archived = new Set(sessions.filter((s) => s.archived).map((s) => s.id));
const windows = {};
for (const r of requests) {
  const w = `${Math.floor(r.minute / 10) * 10}-${Math.floor(r.minute / 10) * 10 + 10} min`;
  windows[w] ??= {};
  windows[w][r.type] = (windows[w][r.type] ?? 0) + 1;
}
const byType = {};
for (const r of requests) {
  const t = (byType[r.type] ??= {
    count: 0,
    archived: 0,
    slowOver1s: 0,
    failed: 0,
    maxMs: 0,
    sites: {},
  });
  t.count += 1;
  if (r.id && archived.has(r.id)) t.archived += 1;
  t.sites[r.site] = (t.sites[r.site] ?? 0) + 1;
  if (r.ms > 1000) t.slowOver1s += 1;
  if (!r.ok) t.failed += 1;
  t.maxMs = Math.max(t.maxMs, r.ms);
}
fs.writeFileSync(
  process.env.OUT,
  JSON.stringify(
    {
      controlDir,
      scale: SCALE,
      fakeMinutes: FAKE_MINUTES,
      startMs,
      byType,
      windows,
      archived: archived.size,
    },
    null,
    2,
  ),
);
fs.writeSync(1, `done ${process.env.OUT}\n`);
process.kill(process.pid, "SIGKILL");
