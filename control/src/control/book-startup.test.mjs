// 0.2.7: the SSH Book transport is retired. Even with a leftover <ORCA_HOME>/book-transport.json, the real
// startController (tools/test-support.book-startup.mjs) reports "retired", refuses Book creations and never starts
// a remote process.
import "./state-root.fixture.mjs";
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

const RETIRED = { configured: false, status: "Book transport retired" };
const remote = () =>
  fixture.processes.filter(
    (p) => /(^|\/)ssh$/.test(p.command) || p.args.some((a) => /receiver-cli/.test(String(a))),
  );

test("a leftover profile is ignored: the controller reports the Book transport as retired", async () => {
  assert.deepEqual(fixture.control.native.bookStatus(), RETIRED);
  const status = await fixture.operatorRead("events-status");
  assert.deepEqual(status.book, RETIRED);
});

test("N Book creations are refused, write no route and start no remote process; local creation still works", async () => {
  const native = fixture.control.native,
    taskId = randomUUID();
  for (let i = 0; i < 5; i++)
    await assert.rejects(
      native.create({
        host: "macbook",
        provider: "codex",
        messageId: randomUUID(),
        taskId,
        title: "Book fixture",
      }),
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
  assert.ok(fixture.calls.some((c) => c.local === "create"));
  assert.deepEqual(remote(), []);
});

test("the process recorder sees processes started through node:child_process", async () => {
  const { spawnSync } = await import("node:child_process");
  spawnSync("/usr/bin/ssh", ["-V"]);
  assert.equal(remote().length, 1);
  fixture.processes.length = 0;
});
