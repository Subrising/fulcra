import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanFiles, trackedScope } from "./no-machine-ties.mjs";
test("tracked portable source has no machine ties", () => {
  assert.deepEqual(scanFiles(new URL("../", import.meta.url).pathname, trackedScope()), []);
});
test("a planted machine path fails, fixture exception is opt-in", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "portable-gate-"));
  try {
    fs.writeFileSync(path.join(root, "planted.mjs"), "export const root = '/Volumes/x';");
    assert.equal(scanFiles(root, ["planted.mjs"]).length, 1);
    fs.renameSync(path.join(root, "planted.mjs"), path.join(root, "planted.fixture.mjs"));
    assert.equal(scanFiles(root, ["planted.fixture.mjs"]).length, 1);
    assert.equal(scanFiles(root, ["planted.fixture.mjs"], { allowFixtures: true }).length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
