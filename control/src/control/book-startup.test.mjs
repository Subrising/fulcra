// Cutover A1: startController wires Book execution from the profile pinned at <ORCA_HOME>/book-transport.json.
// The real startController runs (tools/test-support.book-startup.mjs); only the owned channel and ssh are faked.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CONTROLLER_HOME } from "./installation-settings.mjs";
import { startWithBookFixture } from "../../tools/test-support.book-startup.mjs";

const profile = path.join(CONTROLLER_HOME, "book-transport.json");
fs.mkdirSync(CONTROLLER_HOME, { recursive: true, mode: 0o700 });
fs.writeFileSync(
  profile,
  JSON.stringify({
    host: "macbook",
    sshTarget: "fixture",
    controller: "fixture",
    keyFile: "/nonexistent",
    command: ["/a", "/b", "/c"],
  }),
  { mode: 0o600 },
);
const fixture = await startWithBookFixture();
test.after(() => fixture.stop());

test("the pinned profile is loaded once, through the private-profile checks, and reported as configured", async () => {
  assert.deepEqual(fixture.profiles, [profile]);
  assert.deepEqual(fixture.control.native.bookStatus(), {
    configured: true,
    status: "Book configured",
    profile: "book-transport.json",
  });
  const status = await fixture.operatorRead("events-status");
  assert.deepEqual(status.book, {
    configured: true,
    status: "Book configured",
    profile: "book-transport.json",
  });
});

test("a Book creation is routed to the Book transport and gets a non-null route and status; a local one stays local", async () => {
  const native = fixture.control.native,
    messageId = randomUUID(),
    taskId = randomUUID();
  const created = await native.create({
    host: "macbook",
    provider: "codex",
    messageId,
    taskId,
    title: "Book fixture",
  });
  const sent = fixture.calls.filter((c) => c.book === "create");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].input.messageId, messageId);
  assert.equal(sent[0].input.sessionId, created.id);
  assert.ok(native.route(created.id), "route recorded");
  assert.deepEqual(
    { host: native.status(created.id).host, state: native.status(created.id).state },
    { host: "macbook", state: "human" },
  );
  // The same request is idempotent on its route: one route row, one session identity.
  const again = await native.create({
    host: "macbook",
    provider: "codex",
    messageId,
    taskId,
    title: "Book fixture",
  });
  assert.equal(again.id, created.id);
  assert.equal(native.db.prepare("SELECT count(*) n FROM host_routes").get().n, 1);
  const local = await native.create({
    provider: "codex",
    messageId: randomUUID(),
    taskId,
    title: "Local fixture",
  });
  assert.equal(native.route(local.id), undefined);
  assert.equal(native.status(local.id), undefined);
  assert.ok(fixture.calls.some((c) => c.local === "create"));
});
