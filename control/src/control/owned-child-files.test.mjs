import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  captureOwnedFiles,
  recoverOwnedFiles,
  recoverStaleProcessLock,
  pidStartMs,
  pidIsAlive,
} from "./owned-child-files.mjs";

test("only the exited child with the exact lock identity may recover its files", () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "owned-child-")));
  try {
    const lock = path.join(home, "process.lock");
    fs.writeFileSync(lock, JSON.stringify({ pid: 101, epoch: "owned-epoch" }), {
      mode: 0o600,
    });
    const owner = captureOwnedFiles(home, { pid: 101, epoch: "owned-epoch" });
    assert.throws(() => recoverOwnedFiles(owner, { exited: false }));
    assert.equal(fs.existsSync(lock), true);
    fs.renameSync(lock, lock + ".saved");
    fs.writeFileSync(lock, JSON.stringify({ pid: 102, epoch: "other-epoch" }), {
      mode: 0o600,
    });
    assert.throws(() => recoverOwnedFiles(owner, { exited: true }));
    assert.equal(fs.existsSync(lock), true);
    assert.throws(() => captureOwnedFiles(home, { pid: 101, epoch: "owned-epoch" }));
    fs.unlinkSync(lock);
    fs.renameSync(lock + ".saved", lock);
    recoverOwnedFiles(owner, { exited: true });
    assert.equal(fs.existsSync(lock), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("foreign, symlink and partial-startup files are preserved", () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "owned-child-")));
  try {
    fs.writeFileSync(path.join(home, "process.lock"), JSON.stringify({ pid: 101 }), {
      mode: 0o600,
    });
    assert.throws(() => captureOwnedFiles(home, { pid: 101, epoch: "new" }));
    assert.equal(fs.existsSync(path.join(home, "process.lock")), true);
    fs.unlinkSync(path.join(home, "process.lock"));
    fs.writeFileSync(path.join(home, "target"), "{}");
    fs.symlinkSync("target", path.join(home, "process.lock"));
    assert.throws(() => captureOwnedFiles(home, { pid: 101, epoch: "new" }));
    assert.equal(fs.lstatSync(path.join(home, "process.lock")).isSymbolicLink(), true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a foreign socket is never deleted alongside an owned lock", () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "owned-child-")));
  try {
    const lock = path.join(home, "process.lock"),
      socket = path.join(home, "control.sock");
    fs.writeFileSync(lock, JSON.stringify({ pid: 101, epoch: "owned-epoch" }), {
      mode: 0o600,
    });
    const owner = captureOwnedFiles(home, { pid: 101, epoch: "owned-epoch" });
    fs.writeFileSync(socket, "foreign");
    assert.throws(() => recoverOwnedFiles(owner, { exited: true }));
    assert.equal(fs.existsSync(lock), true);
    assert.equal(fs.readFileSync(socket, "utf8"), "foreign");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// Fulcra 0.2.9: after the Mac mini restarted, the killed controller's lock stayed and no controller could start.
test("dead locks from this boot and before boot are recovered", () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "owned-child-")));
  try {
    const lock = path.join(home, "process.lock");
    const bootMs = Date.now() - 60_000;
    fs.writeFileSync(lock, JSON.stringify({ pid: 44726, epoch: "pre-boot-epoch" }), {
      mode: 0o600,
    });
    // A dead controller from this boot must not block the next one.
    assert.equal(recoverStaleProcessLock(home, { isAlive: () => false }), true);
    assert.equal(fs.existsSync(lock), false);
    fs.writeFileSync(lock, JSON.stringify({ pid: 44726, epoch: "pre-boot-epoch" }), {
      mode: 0o600,
    });
    // Written before the restart: no controller of that boot runs now.
    const before = new Date(bootMs - 5 * 60_000);
    fs.utimesSync(lock, before, before);
    assert.equal(recoverStaleProcessLock(home, { isAlive: () => false }), true);
    assert.equal(fs.existsSync(lock), false);
    assert.equal(
      recoverStaleProcessLock(home, { isAlive: () => false }),
      false,
      "no lock: nothing to do",
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a lock from before the restart without a full owner identity is kept", () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "owned-child-")));
  try {
    const lock = path.join(home, "process.lock");
    const bootMs = Date.now() - 60_000;
    const before = new Date(bootMs - 5 * 60_000);
    for (const content of [JSON.stringify({ pid: 44726 }), "not json"]) {
      fs.writeFileSync(lock, content, { mode: 0o600 });
      fs.utimesSync(lock, before, before);
      assert.throws(() => recoverStaleProcessLock(home, { isAlive: () => false }));
      assert.equal(fs.existsSync(lock), true);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// Fulcra 0.2.11: the wall clock can be wrong, so a live pid in an old lock blocks recovery.
test("a lock from before the restart is kept when its pid is alive", () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "owned-child-")));
  try {
    const lock = path.join(home, "process.lock");
    const bootMs = Date.now() - 60_000;
    const before = new Date(bootMs - 5 * 60_000);
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, epoch: "live-epoch" }), {
      mode: 0o600,
    });
    fs.utimesSync(lock, before, before);
    assert.throws(
      () => recoverStaleProcessLock(home, { startMs: () => before.getTime() - 1000 }),
      /still running/,
    );
    assert.throws(
      () => recoverStaleProcessLock(home, { isAlive: () => true, startMs: () => null }),
      /still running/,
    );
    assert.equal(fs.existsSync(lock), true);
    assert.equal(recoverStaleProcessLock(home, { isAlive: () => false }), true);
    assert.equal(fs.existsSync(lock), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// Fulcra 0.2.12: after a restart the system can give the old controller's pid to another process.
test("a pid reused after the restart does not keep the old lock", () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "owned-child-")));
  try {
    const lock = path.join(home, "process.lock");
    const bootMs = Date.now() - 60_000;
    const before = new Date(bootMs - 5 * 60_000);
    const write = () => {
      fs.writeFileSync(lock, JSON.stringify({ pid: 4242, epoch: "reused-epoch" }), { mode: 0o600 });
      fs.utimesSync(lock, before, before);
    };
    const alive = { isAlive: () => true };
    write();
    // The pid started after the lock was written: another process.
    assert.equal(recoverStaleProcessLock(home, { ...alive, startMs: () => bootMs + 1000 }), true);
    assert.equal(fs.existsSync(lock), false);
    // The pid started before the lock was written: the same controller still runs.
    write();
    assert.throws(
      () => recoverStaleProcessLock(home, { ...alive, startMs: () => before.getTime() - 1000 }),
      /still running/,
    );
    // Start time unknown: refuse.
    assert.throws(
      () => recoverStaleProcessLock(home, { ...alive, startMs: () => null }),
      /still running/,
    );
    assert.equal(fs.existsSync(lock), true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("pidStartMs reads this process start time", () => {
  const started = pidStartMs(process.pid);
  assert.ok(started !== null && started <= Date.now() && started > Date.now() - 86_400_000 * 365);
  assert.equal(pidStartMs(2 ** 22 + 12345), null);
});

test("a crashed controller from this boot does not block its replacement", () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "owned-child-")));
  try {
    const saved = path.join(home, "saved-user-data.json");
    fs.writeFileSync(saved, '{"saved":true}', { mode: 0o600 });
    const module = new URL("./process-lock.mjs", import.meta.url).href;
    const child = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      `import { acquireProcessLock } from ${JSON.stringify(module)};
       acquireProcessLock(${JSON.stringify(home)}, {epoch:"10000000-0000-4000-8000-000000000001"});`,
    ]);
    assert.equal(child.status, 0, child.stderr?.toString());
    assert.equal(fs.existsSync(path.join(home, "process.lock")), true);
    assert.equal(recoverStaleProcessLock(home), true);
    assert.equal(fs.existsSync(path.join(home, "process.lock")), false);
    assert.equal(fs.readFileSync(saved, "utf8"), '{"saved":true}');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a live or unknown same-boot owner is preserved; a proved reused pid is recovered", () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "owned-child-")));
  try {
    const lock = path.join(home, "process.lock");
    fs.writeFileSync(lock, JSON.stringify({ pid: 4242, epoch: "same-boot-epoch" }), {
      mode: 0o600,
    });
    const written = fs.statSync(lock).mtimeMs;
    for (const started of [written - 1000, null, NaN, undefined]) {
      assert.throws(
        () => recoverStaleProcessLock(home, { isAlive: () => true, startMs: () => started }),
        /still running/,
      );
      assert.equal(fs.existsSync(lock), true);
    }
    assert.equal(
      recoverStaleProcessLock(home, { isAlive: () => true, startMs: () => written + 6000 }),
      true,
    );
    assert.equal(fs.existsSync(lock), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a replacement lock with the same owner bytes is preserved during a liveness probe", () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "owned-child-")));
  try {
    const lock = path.join(home, "process.lock");
    const content = JSON.stringify({ pid: 4242, epoch: "same-epoch" });
    fs.writeFileSync(lock, content, { mode: 0o600 });
    assert.throws(
      () =>
        recoverStaleProcessLock(home, {
          isAlive: () => {
            fs.renameSync(lock, lock + ".saved");
            fs.writeFileSync(lock, content, { mode: 0o600 });
            return false;
          },
        }),
      /ownership changed/,
    );
    assert.equal(fs.readFileSync(lock, "utf8"), content);
    assert.equal(fs.readFileSync(lock + ".saved", "utf8"), content);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("only ESRCH proves a controller pid is absent", () => {
  for (const code of ["EPERM", "EACCES", "UNKNOWN", undefined]) {
    assert.equal(
      pidIsAlive(4242, {
        kill: () => {
          throw Object.assign(Error("probe failed"), { code });
        },
      }),
      true,
    );
  }
  assert.equal(
    pidIsAlive(4242, {
      kill: () => {
        throw Object.assign(Error("gone"), { code: "ESRCH" });
      },
    }),
    false,
  );
});

test("pidStartMs uses a bounded absolute Windows probe and validates its result", () => {
  let calls = 0;
  const run = (command, args, options) => {
    calls++;
    assert.match(
      command,
      /^[A-Za-z]:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i,
    );
    assert.equal(args[0], "-NoProfile");
    assert.equal(args[1], "-NonInteractive");
    assert.equal(options.env.FULCRA_LOCK_PID, "4242");
    assert.equal(options.timeout, 5000);
    assert.equal(options.windowsHide, true);
    return "1792300460000\r\n";
  };
  assert.equal(pidStartMs(4242, { platform: "win32", run }), 1792300460000);
  assert.equal(calls, 1);
  assert.equal(pidStartMs(-1, { platform: "win32", run }), null);
  assert.equal(calls, 1);
  for (const text of ["", "not a time", "0", "Infinity"]) {
    assert.equal(pidStartMs(4242, { platform: "win32", run: () => text }), null);
  }
  assert.equal(
    pidStartMs(4242, {
      platform: "win32",
      run: () => {
        throw Error("access denied");
      },
    }),
    null,
  );
});
