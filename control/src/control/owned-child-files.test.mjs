import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureOwnedFiles, recoverOwnedFiles } from "./owned-child-files.mjs";

test("only the exited child with the exact lock identity may recover its files", () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "owned-child-")));
  try {
    const lock = path.join(home, "process.lock");
    fs.writeFileSync(lock, JSON.stringify({ pid: 101, epoch: "owned-epoch" }), { mode: 0o600 });
    const owner = captureOwnedFiles(home, { pid: 101, epoch: "owned-epoch" });
    assert.throws(() => recoverOwnedFiles(owner, { exited: false }));
    assert.equal(fs.existsSync(lock), true);
    fs.renameSync(lock, lock + ".saved");
    fs.writeFileSync(lock, JSON.stringify({ pid: 102, epoch: "other-epoch" }), { mode: 0o600 });
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
    fs.writeFileSync(lock, JSON.stringify({ pid: 101, epoch: "owned-epoch" }), { mode: 0o600 });
    const owner = captureOwnedFiles(home, { pid: 101, epoch: "owned-epoch" });
    fs.writeFileSync(socket, "foreign");
    assert.throws(() => recoverOwnedFiles(owner, { exited: true }));
    assert.equal(fs.existsSync(lock), true);
    assert.equal(fs.readFileSync(socket, "utf8"), "foreign");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
