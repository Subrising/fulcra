import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { generateScaleFixture } from "./real-scale-fixture.mjs";
test("two synthetic hosts carry real native enrollment and settled history, privately and without overwrites", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scale-")));
  try {
    const target = path.join(root, "fixture");
    const receipt = generateScaleFixture(target);
    assert.equal(receipt.hosts.length, 2);
    assert.equal(receipt.sessions, 280);
    assert.equal(receipt.deliveries, 5600);
    for (const host of receipt.hosts) {
      assert.equal(fs.readdirSync(path.join(host.paseoHome, "agents")).length, 140);
      const db = new DatabaseSync(path.join(host.controlHome, "journal.sqlite"), {
        readOnly: true,
      });
      try {
        assert.equal(db.prepare("SELECT count(*) n FROM sessions").get().n, 140);
        assert.equal(db.prepare("SELECT count(*) n FROM deliveries").get().n, 2800);
        assert.equal(
          db.prepare("SELECT count(*) n FROM deliveries WHERE state!='delivered'").get().n,
          0,
        );
      } finally {
        db.close();
      }
      assert.equal(fs.statSync(host.paseoHome).mode & 0o777, 0o700);
      assert.equal(fs.statSync(path.join(host.controlHome, "journal.sqlite")).mode & 0o777, 0o600);
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(host.controlHome, "tasks.json"))).projects.length,
        14,
      );
    }
    assert.throws(() => generateScaleFixture(target), /exist/);
    const alias = path.join(root, "alias");
    fs.symlinkSync(target, alias);
    assert.throws(() => generateScaleFixture(alias));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("synthetic native history is present for every session as well as the controller journal", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scale-history-")));
  try {
    const receipt = generateScaleFixture(path.join(root, "fixture"));
    for (const host of receipt.hosts) {
      const entries = fs.readdirSync(path.join(host.paseoHome, "native-timeline-journal"));
      assert.equal(entries.length, 140);
      for (const file of entries) {
        const lines = fs
          .readFileSync(path.join(host.paseoHome, "native-timeline-journal", file), "utf8")
          .trim()
          .split("\n");
        assert.equal(JSON.parse(lines[0]).version, 1);
        assert.equal(JSON.parse(lines[1]).rows.length, 20);
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
