import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withCleanupAdmission } from "../packages/server/src/utils/cleanup-admission.ts";

const noop = async () => {};

test("admission blocks deletion and refuses an active deletion", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fu340-admission-")));
  try {
    await withCleanupAdmission(async () => {
      assert.equal(readdirSync(join(root, "admissions")).length, 1);
      await withCleanupAdmission(async () => {
        assert.equal(readdirSync(join(root, "admissions")).length, 1);
      }, root);
    }, root);
    assert.equal(readdirSync(join(root, "admissions")).length, 0);
    mkdirSync(join(root, "deletion"));
    let invoked = false;
    await assert.rejects(
      withCleanupAdmission(async () => {
        invoked = true;
      }, root),
      /Cleanup is in progress/,
    );
    assert.equal(invoked, false);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("an inherited async context cannot reuse an ended lease", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fu340-late-admission-")));
  let invoke = () => {};
  const delayed = new Promise((resolve) => {
    invoke = resolve;
  });
  let late;
  try {
    await withCleanupAdmission(async () => {
      late = delayed.then(() =>
        assert.rejects(withCleanupAdmission(noop, root), /Cleanup is in progress/),
      );
    }, root);
    mkdirSync(join(root, "deletion"));
    invoke();
    await late;
  } finally {
    rmSync(root, { recursive: true });
  }
});
