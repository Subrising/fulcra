import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { socketLocation, pipeName, createPipeEndpoint, readPipeName, PIPE_FILE } from "./socket-location.mjs";
import { pipeDaclIsPrivate, restrictPipeToUser, gateConnections } from "./pipe-acl.mjs";
import { captureGroupOwner, runScript } from "./environment-runner.mjs";
import { EnvironmentRefused } from "../../orca-organization/shared/cc/environment-rules.mjs";
import { macHeldNotifier, macLimitNotifier } from "./held-notifier.mjs";

const ME = "S-1-5-21-1-2-3-1006";

test("pipe name: random per start, user part cleaned, 128-bit hex suffix, not derivable from the home", () => {
  assert.equal(pipeName("dz gra!", "a".repeat(32)), pipeName("dz_gra_", "a".repeat(32)));
  const one = pipeName("someuser"),
    two = pipeName("someuser");
  assert.match(one, /^\\\\\.\\pipe\\fulcra-someuser-[a-f0-9]{32}$/);
  assert.notEqual(one, two);
});
test("win32 location names no socket: the name comes only from the private pipe file", () => {
  const location = socketLocation("C:\\Users\\a\\.paseo\\command-centre", "win32");
  assert.equal(location.pipe, true);
  assert.equal(location.external, false);
  assert.equal(location.socket, null);
  assert.match(location.pipeFile, /control\.pipe$/);
});
test("posix location is unchanged: a socket file in the home", { skip: process.platform === "win32" }, () => {
  assert.deepEqual(socketLocation("/tmp/h", "darwin"), {
    socket: "/tmp/h/control.sock",
    directory: "/tmp/h",
    external: false,
  });
});
test("pipe DACL: only SYSTEM, Administrators and this user, protected", () => {
  assert.equal(pipeDaclIsPrivate(`D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;${ME})`, ME), true);
  assert.equal(pipeDaclIsPrivate("D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;WD)", ME), false);
  assert.equal(pipeDaclIsPrivate("D:P(A;;FA;;;SY)(A;;FA;;;AN)", ME), false);
  assert.equal(pipeDaclIsPrivate("D:P(A;;FA;;;SY)(A;;FA;;;S-1-5-21-9-9-9-1)", ME), false);
  assert.equal(pipeDaclIsPrivate(`D:(A;;FA;;;SY)(A;;FA;;;${ME})`, ME), false, "must be protected");
  assert.equal(pipeDaclIsPrivate("D:P", ME), false);
  assert.equal(pipeDaclIsPrivate("", ME), false);
});
test("restrictPipeToUser passes a private read-back and rejects otherwise", async () => {
  const good = async () => `ME=${ME}\nSDDL=D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;${ME})\n`;
  await restrictPipeToUser("\\\\.\\pipe\\x", { run: good });
  await assert.rejects(
    restrictPipeToUser("p", { run: async () => `ME=${ME}\nSDDL=D:P(A;;FA;;;SY)(A;;FR;;;WD)\n` }),
    /not private/,
  );
  await assert.rejects(restrictPipeToUser("p", { run: async () => "garbage" }), /not private/);
  await assert.rejects(
    restrictPipeToUser("p", {
      run: async () => {
        throw Error("powershell failed");
      },
    }),
    /could not be secured/,
  );
});
test("no connection is served before the pipe is locked: it is destroyed, not handled", () => {
  const served = [],
    destroyed = [];
  const gate = gateConnections((c) => served.push(c));
  const early = { destroy: () => destroyed.push("early") };
  gate.handler(early);
  assert.equal(served.length, 0);
  assert.deepEqual(destroyed, ["early"]);
  gate.open();
  const late = { destroy: () => destroyed.push("late") };
  gate.handler(late);
  assert.deepEqual(served, [late]);
  assert.deepEqual(destroyed, ["early"]);
  const open = gateConnections((c) => served.push(c), { startOpen: true });
  open.handler(late);
  assert.equal(served.length, 2);
});
test("environment scripts and process-group identity are refused on win32, with the reason", () => {
  assert.equal(captureGroupOwner(1234, "win32"), null);
  assert.throws(
    () => runScript({ checkout: "C:\\c", script: "run.sh", args: [], timeoutS: 1, platform: "win32" }),
    (e) => e instanceof EnvironmentRefused && /not available on Windows/.test(e.message),
  );
});
test("the macOS notification is a silent no-op on win32 and still runs elsewhere", async () => {
  const calls = [];
  const run = (...a) => (calls.push(a), Promise.resolve());
  await macHeldNotifier(run, "win32")({ seat: "p", fromSeats: ["a"], count: 1, waiting: 1 });
  await macLimitNotifier(run, "win32")({});
  assert.equal(calls.length, 0);
  await macHeldNotifier(run, "darwin")({ seat: "p", fromSeats: ["a"], count: 1, waiting: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "/usr/bin/osascript");
});

// The pipe file, on a real folder. POSIX checks apply here (mode 0700 folder), which is the same rule the helper
// applies; the Windows ACL form of the same file check is exercised in win32.integration.test.mjs.
const posix = { skip: process.platform === "win32" };
function privateHome() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pipe-file-")));
  fs.chmodSync(home, 0o700);
  return home;
}
test("controller writes a random pipe name to a private file; clients read it back", posix, () => {
  const home = privateHome();
  try {
    const name = createPipeEndpoint(home, { username: "someuser", suffix: "c".repeat(32) });
    assert.equal(readPipeName(home), name);
    assert.equal(fs.statSync(path.join(home, PIPE_FILE)).mode & 0o077, 0);
    const next = createPipeEndpoint(home, { username: "someuser" });
    assert.notEqual(next, name, "each start picks a new name");
    assert.equal(readPipeName(home), next);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
test("clients refuse a pipe file that is missing, wide, malformed or a link", posix, () => {
  const home = privateHome();
  try {
    assert.throws(() => readPipeName(home), /not running/);
    const file = path.join(home, PIPE_FILE);
    fs.writeFileSync(file, pipeName("someuser") + "\n", { mode: 0o666 });
    fs.chmodSync(file, 0o666);
    assert.throws(() => readPipeName(home), /Private owned/);
    fs.chmodSync(file, 0o600);
    fs.writeFileSync(file, "\\\\.\\pipe\\fulcra-guessable\n");
    assert.throws(() => readPipeName(home), /Invalid controller pipe name/);
    fs.rmSync(file);
    fs.writeFileSync(path.join(home, "other"), pipeName("someuser") + "\n", { mode: 0o600 });
    fs.symlinkSync(path.join(home, "other"), file);
    assert.throws(() => readPipeName(home), /Private owned/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
