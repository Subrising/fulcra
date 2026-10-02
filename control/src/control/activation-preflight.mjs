// Read-only go/no-go check to run IMMEDIATELY before activating the controller on role source.
// It starts nothing, restarts nothing, writes nothing and creates no session. Every controller probe is a
// pure read; the journal is opened readOnly; the daemon is never contacted. Exits non-zero if any gate fails.
//
//   node src/control/activation-preflight.mjs [--expect=before|after]
//
// --expect=before (default) asserts the OLD source is running, which is the pre-activation gate.
// --expect=after  asserts the NEW source is running, to confirm activation actually took.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_CONTROL_HOME } from "./home.mjs";
import { verifyActivationAt } from "./activation.mjs";
import { sessionDefaults } from "./provider-mode.mjs";
import { portable } from "../portable-config.mjs";

const HOME = process.env.ORCA_CONTROLLER_HOME ?? portable?.controller ?? DEFAULT_CONTROL_HOME;
const PORT = portable?.daemon.port ?? 6791;
const expect = (process.argv.find((a) => a.startsWith("--expect=")) ?? "--expect=before").slice(9);
if (!["before", "after"].includes(expect)) {
  console.error("--expect must be before or after");
  process.exit(2);
}

const results = [];
const record = (state, name, detail) => {
  results.push({ state, name, detail });
};
const pass = (n, d) => record("PASS", n, d),
  fail = (n, d) => record("FAIL", n, d),
  skip = (n, d) => record("SKIP", n, d);

// A single pure-read request over the control socket. One connection, one line, no retry.
function ask(method, operator, input) {
  return new Promise((resolve) => {
    const socket = path.join(HOME, "control.sock");
    const client = net.createConnection(socket);
    let bytes = "";
    client.setEncoding("utf8");
    const done = (value) => {
      try {
        client.destroy();
      } catch {
        /* already closed */
      }
      resolve(value);
    };
    client.setTimeout(10000, () => done({ error: "timed out after 10s" }));
    client.on("error", (e) => done({ error: e.message }));
    client.on("connect", () =>
      client.write(
        JSON.stringify({ method, operator, ...(input === undefined ? {} : { input }) }) + "\n",
      ),
    );
    client.on("data", (chunk) => {
      bytes += chunk;
    });
    client.on("end", () => {
      try {
        done(JSON.parse(bytes));
      } catch {
        done({ error: "unparseable response" });
      }
    });
  });
}
function readJournal(fn) {
  const file = path.join(HOME, "journal.sqlite");
  if (!fs.existsSync(file)) return { error: "journal.sqlite not found at " + file };
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    return fn(db);
  } catch (e) {
    return { error: e.message };
  } finally {
    try {
      db?.close();
    } catch {
      /* nothing to close */
    }
  }
}

// 1 - the socket exists and is a socket, not a leftover regular file
try {
  const socket = path.join(HOME, "control.sock");
  const stat = fs.lstatSync(socket);
  if (stat.isSocket()) pass("control socket", socket);
  else fail("control socket", `${socket} exists but is not a socket; a stale file blocks startup`);
} catch (e) {
  fail(
    "control socket",
    `${path.join(HOME, "control.sock")} is absent (${e.code ?? e.message}); no controller is listening`,
  );
}

// 2 - the controller answers a pure read
let operator = null;
try {
  operator = fs.readFileSync(path.join(HOME, "operator.secret"), "utf8");
  if (!/^[A-Za-z0-9_-]{43}$/.test(operator)) {
    fail("operator credential", "operator.secret is not a valid credential");
    operator = null;
  } else pass("operator credential", "present and well formed");
} catch (e) {
  fail("operator credential", `cannot read operator.secret (${e.code ?? e.message})`);
}

if (operator) {
  const index = await ask("task-index", operator);
  if (index.error) fail("controller answering", `task-index failed: ${index.error}`);
  else
    pass(
      "controller answering",
      `task-index returned ${index.result?.taskIds?.length ?? 0} task ids, partial=${index.result?.partial}`,
    );

  // 3 - which source is actually running. bindings-status exists only on role source, so the answer is
  // definitive in both directions rather than inferred from a path or an mtime.
  const probe = await ask("bindings-status", operator);
  const isOld = /Unknown controller method/.test(probe.error ?? "");
  const isNew = !probe.error && Array.isArray(probe.result?.bindings);
  if (expect === "before" && isOld)
    pass(
      "running source",
      "pre-role source: bindings-status is not served, as expected before activation",
    );
  else if (expect === "after" && isNew)
    pass(
      "running source",
      `role source: bindings-status served ${probe.result.bindings.length} bindings`,
    );
  else if (isOld)
    fail("running source", "pre-role source is still running; activation has not taken");
  else if (isNew) fail("running source", "role source is ALREADY running; do not activate again");
  else
    fail(
      "running source",
      `could not identify the running source: ${probe.error ?? "unexpected response shape"}`,
    );
} else skip("controller answering", "no operator credential; cannot probe the socket");

// 4 - role tables absent, re-checked now rather than trusted from earlier
const ROLE_TABLES = [
  "role_bindings",
  "role_binding_history",
  "role_credentials",
  "role_channels",
  "role_channel_messages",
  "role_channel_requests",
  "role_session_allowances",
  "session_ownership",
  "session_adoptions",
  "role_session_requests",
];
const tables = readJournal((db) =>
  db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${ROLE_TABLES.map(() => "?").join(",")})`,
    )
    .all(...ROLE_TABLES)
    .map((r) => r.name),
);
if (tables?.error) fail("role tables", tables.error);
else if (expect === "before" && tables.length === 0)
  pass(
    "role tables",
    "none present; the schema guards will create all ten fresh and no migration is required",
  );
else if (expect === "after" && tables.length === ROLE_TABLES.length)
  pass("role tables", "all ten present");
else
  fail(
    "role tables",
    `${tables.length} of ${ROLE_TABLES.length} present (${tables.join(", ") || "none"}); a partial set means an EXPLICIT MIGRATION is required before startup — do not activate`,
  );

// 5 - the takeover analysis depends on this intersection being empty
// attach has TWO branches. The takeover branch needs a delegated session on a delegating/human route; the
// beginRevoke branch needs a DELEGATING route whose session is NOT delegated, which no intersection of
// delegated sessions can ever flag. Both are checked, and each label states only what its query proves.
const routing = readJournal((db) => ({
  delegated: db
    .prepare("SELECT id FROM sessions WHERE mode='delegated' ORDER BY rowid")
    .all()
    .map((r) => r.id),
  routes: db.prepare("SELECT id,phase FROM host_routes ORDER BY rowid").all(),
  // Deliberately unfiltered by phase: a superset of attach's takeover condition, so empty is conclusive.
  both: db
    .prepare("SELECT s.id FROM sessions s JOIN host_routes r ON r.id=s.id WHERE s.mode='delegated'")
    .all()
    .map((r) => r.id),
  revoking: db
    .prepare(
      "SELECT r.id FROM host_routes r JOIN sessions s ON s.id=r.id WHERE r.phase='delegating' AND s.mode!='delegated'",
    )
    .all()
    .map((r) => r.id),
}));
if (routing?.error) fail("delegated vs host routes", routing.error);
else {
  const phases = routing.routes.reduce((a, r) => ({ ...a, [r.phase]: (a[r.phase] ?? 0) + 1 }), {});
  const detail = `${routing.delegated.length} delegated [${routing.delegated.map((i) => i.slice(0, 8)).join(" ")}], ${routing.routes.length} host routes ${JSON.stringify(phases)}`;
  if (routing.both.length === 0)
    pass(
      "attach takeover branch",
      `${detail}; no delegated session carries a host route (checked without a phase filter, so this is a superset of attach's condition) — nothing can be taken over`,
    );
  else
    fail(
      "attach takeover branch",
      `${detail}; ${routing.both.map((i) => i.slice(0, 8)).join(" ")} are delegated AND routed — attach may take them over at startup`,
    );
  if (routing.revoking.length === 0)
    pass(
      "attach beginRevoke branch",
      "no host route is in phase 'delegating' with a non-delegated session — attach will not begin a revocation",
    );
  else
    fail(
      "attach beginRevoke branch",
      `${routing.revoking.map((i) => i.slice(0, 8)).join(" ")} are 'delegating' with a non-delegated session — attach WILL call beginRevoke on them`,
    );
}

// 6 - the boot id the whole safety argument rests on. Read-only: files, lsof -t and ps only.
try {
  const boot = verifyActivationAt(HOME, PORT);
  const pinned = readJournal((db) =>
    db
      .prepare("SELECT DISTINCT boot FROM sessions WHERE mode='delegated' AND boot IS NOT NULL")
      .all()
      .map((r) => r.boot),
  );
  // [].every() is true, so an empty pinned set would pass vacuously. Say which case this is.
  const list = Array.isArray(pinned) ? pinned : [];
  const detail = `daemon boot ${boot}; delegated sessions pinned to ${Array.isArray(pinned) ? pinned.join(", ") || "none" : pinned.error}`;
  if (!Array.isArray(pinned)) fail("boot fence", `${detail} — the journal could not be read`);
  else if (list.length === 0)
    pass(
      "boot fence",
      `${detail} — VACUOUS: no delegated session is boot-pinned, so this proves the daemon is readable and nothing else. DO NOT RESTART THE DAEMON in this window.`,
    );
  else if (list.every((b) => b === boot))
    pass(
      "boot fence",
      `${detail} — all ${list.length} pinned value(s) match, so a controller-only restart preserves them. DO NOT RESTART THE DAEMON in this window.`,
    );
  else
    fail(
      "boot fence",
      `${detail} — a mismatch means those sessions are already taken over on next inspect`,
    );
} catch (e) {
  fail("boot fence", `verifyActivationAt refused: ${e.message}`);
}

// 7 - protocol dist, which has bitten three commits. Not in this tree, so it is a manual gate unless told where.
const protocolRepo = process.env.ORCA_PROTOCOL_REPO;
if (!protocolRepo)
  skip(
    "protocol dist",
    "set ORCA_PROTOCOL_REPO to the fork checkout to check automatically, or run manually: (cd <fork>/packages/protocol && npm run build)",
  );
else {
  const newest = (dir) => {
    let latest = 0;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f);
        else latest = Math.max(latest, fs.statSync(f).mtimeMs);
      }
    };
    try {
      walk(dir);
    } catch {
      return null;
    }
    return latest;
  };
  const src = newest(path.join(protocolRepo, "packages/protocol/src")),
    dist = newest(path.join(protocolRepo, "packages/protocol/dist"));
  if (src === null || dist === null)
    fail("protocol dist", `cannot read packages/protocol src or dist under ${protocolRepo}`);
  else if (dist >= src)
    pass(
      "protocol dist",
      `dist is newer than src (${new Date(dist).toISOString()} >= ${new Date(src).toISOString()})`,
    );
  else
    fail(
      "protocol dist",
      `src is NEWER than dist; run (cd ${protocolRepo}/packages/protocol && npm run build) — the fenced toolPolicy refresh is rejected by a stale built schema`,
    );
}

// 8 - what every newly created session will get, seen before it applies rather than discovered after
try {
  for (const provider of ["claude", "codex"]) {
    const d = sessionDefaults(provider);
    pass(
      `session defaults: ${provider}`,
      `modeId=${d.modeId} thinking=${d.thinkingOptionId} automatic=${d.automatic} options=${JSON.stringify(d.options ?? null)} source=${JSON.stringify(d.source)}`,
    );
    // DESIGN-NEXT-BUILD A4: the role defaults as configured (validated by the same selector). Whether the installed
    // provider offers each pair is checked at creation and reported by the session-defaults read.
    for (const role of ["planning", "orchestration", "implementation"]) {
      const r = sessionDefaults(provider, {}, undefined, role);
      if (r.source.model === "role" || r.source.thinkingOptionId === "role")
        pass(
          `role defaults: ${role} ${provider}`,
          `model=${r.model} thinking=${r.thinkingOptionId} (checked against the installed provider at creation)`,
        );
    }
  }
} catch (e) {
  fail("session defaults", e.message);
}

// 9 - a restart delivers these. notifyPending in particular GENERATES a wake prompt into a seat session.
const queued = readJournal((db) => {
  const has = (t) =>
    Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t));
  return {
    messages: has("role_channel_messages")
      ? db.prepare("SELECT count(*) n FROM role_channel_messages WHERE state='pending'").get().n
      : "table absent",
    requests: has("role_session_requests")
      ? db.prepare("SELECT count(*) n FROM role_session_requests WHERE state='pending'").get().n
      : "table absent",
  };
});
if (queued?.error) fail("queued work", queued.error);
else if (queued.messages === 0 || queued.messages === "table absent") {
  if (queued.requests === 0 || queued.requests === "table absent")
    pass(
      "queued work",
      `pending channel messages: ${queued.messages}; pending session requests: ${queued.requests} — nothing will be delivered or injected at startup`,
    );
  else
    fail(
      "queued work",
      `${queued.requests} pending session requests — notifyPending will GENERATE AND INJECT a wake prompt into those seats shortly after startup`,
    );
} else
  fail("queued work", `${queued.messages} pending channel messages will be redelivered at startup`);

// 10 - unresolved deliveries are not reconciled by a restart
const unresolved = readJournal((db) =>
  db
    .prepare(
      "SELECT state,count(*) n FROM deliveries WHERE state IN ('intent','uncertain','queued','reserved') GROUP BY state",
    )
    .all(),
);
if (unresolved?.error) fail("unresolved deliveries", unresolved.error);
else if (unresolved.length === 0)
  pass("unresolved deliveries", "none; nothing needs reconciling first");
else
  fail(
    "unresolved deliveries",
    `${JSON.stringify(unresolved)} — resolve each before restarting; a restart does not reconcile them`,
  );

const width = Math.max(...results.map((r) => r.name.length));
console.log(
  `\nActivation preflight — home ${HOME}, expecting the ${expect === "before" ? "OLD (pre-role)" : "NEW (role)"} source\n`,
);
for (const r of results)
  console.log(`  ${r.state.padEnd(4)}  ${r.name.padEnd(width)}  ${r.detail}`);
const failed = results.filter((r) => r.state === "FAIL"),
  skipped = results.filter((r) => r.state === "SKIP");
console.log(
  `\n${results.filter((r) => r.state === "PASS").length} pass, ${failed.length} fail, ${skipped.length} skipped`,
);
if (skipped.length)
  console.log("Skipped checks are NOT gates. Carry them out manually before proceeding.");
console.log(
  failed.length
    ? "\nNO-GO — do not activate."
    : "\nGO — every automated gate passes. The skipped checks and the residual risks in activation-preflight.md are still yours to judge.",
);
process.exit(failed.length ? 1 : 0);
