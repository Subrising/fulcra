import test from "node:test";
import assert from "node:assert/strict";
import { socketLocation, pipeName } from "./socket-location.mjs";
import { pipeDaclIsPrivate, restrictPipeToUser } from "./pipe-acl.mjs";
import { captureGroupOwner, runScript } from "./environment-runner.mjs";
import { EnvironmentRefused } from "../../orca-organization/shared/cc/environment-rules.mjs";
import { macHeldNotifier, macLimitNotifier } from "./held-notifier.mjs";

const ME = "S-1-5-21-1-2-3-1006";

test("pipe name: per user and per home, characters cleaned, no file path", () => {
  assert.equal(
    pipeName("C:\\Users\\a\\.paseo\\command-centre", "dz gra!"),
    pipeName("C:\\Users\\a\\.paseo\\command-centre", "dz_gra_"),
  );
  const name = pipeName("C:\\h", "someuser");
  assert.match(name, /^\\\\\.\\pipe\\fulcra-someuser-[a-f0-9]{24}$/);
  assert.notEqual(name, pipeName("C:\\other", "someuser"));
  assert.notEqual(name, pipeName("C:\\h", "someone"));
});
test("win32 location is a pipe and never an external socket directory", () => {
  const location = socketLocation("C:\\Users\\a\\.paseo\\command-centre", "win32");
  assert.equal(location.pipe, true);
  assert.equal(location.external, false);
  assert.match(location.socket, /^\\\\\.\\pipe\\fulcra-/);
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
test("restrictPipeToUser passes a private read-back and fails closed otherwise", () => {
  const good = () => `ME=${ME}\nSDDL=D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;${ME})\n`;
  restrictPipeToUser("\\\\.\\pipe\\x", { run: good });
  assert.throws(
    () => restrictPipeToUser("p", { run: () => `ME=${ME}\nSDDL=D:P(A;;FA;;;SY)(A;;FR;;;WD)\n` }),
    /not private/,
  );
  assert.throws(() => restrictPipeToUser("p", { run: () => "garbage" }), /not private/);
  assert.throws(
    () =>
      restrictPipeToUser("p", {
        run: () => {
          throw Error("powershell failed");
        },
      }),
    /could not be secured/,
  );
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
