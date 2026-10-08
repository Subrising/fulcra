// With no profile at <ORCA_HOME>/book-transport.json the controller is local-only and says the Book transport is
// retired; a Book creation is refused cleanly and records no route. Any profile is ignored without being read.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CONTROLLER_HOME } from "./installation-settings.mjs";
import { startWithBookFixture } from "../../tools/test-support.book-startup.mjs";

assert.equal(fs.existsSync(path.join(CONTROLLER_HOME, "book-transport.json")), false);
const fixture = await startWithBookFixture();
test.after(() => fixture.stop());

test('absent profile: explicit "Book transport retired", not null, on the controller and over events-status', async () => {
  assert.deepEqual(fixture.control.native.bookStatus(), {
    configured: false,
    status: "Book transport retired",
  });
  const status = await fixture.operatorRead("events-status");
  assert.deepEqual(status.book, { configured: false, status: "Book transport retired" });
});

test("absent profile: a Book creation is refused before any route is written; local creation still works", async () => {
  const native = fixture.control.native,
    messageId = randomUUID(),
    taskId = randomUUID();
  await assert.rejects(
    native.create({ host: "macbook", provider: "codex", messageId, taskId, title: "Book fixture" }),
    /Book receiver transport is not configured/,
  );
  assert.equal(native.db.prepare("SELECT count(*) n FROM host_routes").get().n, 0);
  const local = await native.create({
    provider: "codex",
    messageId: randomUUID(),
    taskId,
    title: "Local fixture",
  });
  assert.equal(native.route(local.id), undefined);
});

test("any profile, valid or not, is ignored without being read", async () => {
  const { bookTransport } = await import("./server.mjs");
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "book-retired-")));
  fs.writeFileSync(path.join(dir, "book-transport.json"), "{}");
  fs.chmodSync(path.join(dir, "book-transport.json"), 0o644);
  const out = bookTransport(dir);
  assert.equal(out.book, undefined);
  assert.deepEqual(out.bookStatus, { configured: false, status: "Book transport retired" });
  fs.rmSync(dir, { recursive: true, force: true });
});
