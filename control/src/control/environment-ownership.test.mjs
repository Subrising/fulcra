import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { firstRun } from "../config.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as runner from "./environment-runner.mjs";
test("PF-3: a reused live group is never killed from a mismatched or missing receipt", async (t) => {
  const child = spawn("/bin/sleep", ["60"], { detached: true, stdio: "ignore" });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  t.after(async () => {
    try {
      child.kill("SIGKILL");
    } catch {}
    await exited;
  });
  const owned = runner.captureGroupOwner(child.pid);
  assert.equal(owned.pid, child.pid);
  assert.equal(
    runner.recoverOwnedGroup(child.pid, { ...owned, startedAt: "different process lifetime" }),
    "unverified",
  );
  assert.equal(runner.recoverOwnedGroup(child.pid, null), "unverified");
  assert.equal(runner.groupAlive(child.pid), true, "unrelated live group survives recovery");
});
test("PF-3: only the exact group leader lifetime permits recovery", () => {
  const owner = { pid: 41, pgid: 41, uid: 501, startedAt: "stable-start" };
  let kills = 0;
  const options = {
    inspect: () => ({ ...owner }),
    kill: () => {
      kills++;
      return "killed";
    },
  };
  assert.equal(runner.recoverOwnedGroup(41, owner, options), "killed");
  for (const change of [{ pid: 42 }, { pgid: 42 }, { uid: 502 }, { startedAt: "reused" }]) {
    assert.equal(
      runner.recoverOwnedGroup(41, owner, { ...options, inspect: () => ({ ...owner, ...change }) }),
      "unverified",
    );
  }
  assert.equal(
    runner.recoverOwnedGroup(41, owner, { ...options, inspect: () => null }),
    "unverified",
  );
  assert.equal(kills, 1);
});

test("PF-3 mechanical repro: recoverGroup leaves a live group without an owner receipt untouched", async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cc-pf3-"))),
    previous = process.env.ORCA_HOME;
  firstRun({ ORCA_HOME: home });
  process.env.ORCA_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.ORCA_HOME;
    else process.env.ORCA_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const { Environments } = await import("./environments.mjs");
  const child = spawn("/bin/sleep", ["60"], { detached: true, stdio: "ignore" });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  t.after(async () => {
    try {
      child.kill("SIGKILL");
    } catch {}
    await exited;
  });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  const note = Environments.prototype.recoverGroup({
    pgid: child.pid,
    step: "deploy",
    bootAt: Math.round(Date.now() / 1000 - os.uptime()),
  });
  assert.match(note, /unverified process owner/);
  assert.equal(runner.groupAlive(child.pid), true);
});
