import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { assertTestHome, isTestHome, markTestRoot } from "./test-home.cjs";

test("homes under the temp directory are test homes, also when they do not exist yet", () => {
  const root = mkdtempSync(path.join(tmpdir(), "test-home-"));
  try {
    assert.equal(isTestHome(root), true);
    assert.equal(isTestHome(path.join(root, "worker-0", "home")), true);
    assert.doesNotThrow(() => assertTestHome(root, "an e2e daemon"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the default home, a relative path and the temp directory itself are refused", () => {
  assert.equal(isTestHome(path.join(homedir(), ".paseo")), false);
  assert.equal(isTestHome("relative/home"), false);
  assert.equal(isTestHome(undefined), false);
  assert.equal(isTestHome(tmpdir()), false);
  assert.throws(
    () => assertTestHome(path.join(homedir(), ".paseo"), "the desktop app"),
    /Refusing to start the desktop app: PASEO_HOME .* is not a test home/,
  );
});

test("a symlink from the temp directory to a live home is refused", () => {
  const live = mkdtempSync(path.join(process.cwd(), ".live-home-"));
  const root = mkdtempSync(path.join(tmpdir(), "test-home-link-"));
  try {
    const link = path.join(root, "home");
    symlinkSync(live, link);
    assert.equal(isTestHome(link), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(live, { recursive: true, force: true });
  }
});

test("a marked scratch root outside the temp directory holds test homes", () => {
  const scratch = mkdtempSync(path.join(process.cwd(), ".scratch-"));
  try {
    const home = path.join(scratch, "paseo-home");
    mkdirSync(home);
    assert.equal(isTestHome(home), false);
    markTestRoot(scratch);
    assert.equal(isTestHome(home), true);
    assert.throws(() => markTestRoot(scratch), /EEXIST/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
