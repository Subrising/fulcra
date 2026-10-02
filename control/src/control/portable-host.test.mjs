import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { firstRun } from "../config.mjs";
import { localNative, configuredHost } from "./portable-host.mjs";
test("named local routing has no legacy transport, configured remotes refuse execution", async () => {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "cc-hosts-")),
    previous = process.env.ORCA_HOME;
  try {
    firstRun({ ORCA_HOME: home });
    const file = path.join(home, "config.json"),
      c = JSON.parse(fs.readFileSync(file));
    c.localHost.name = "Desk";
    c.hosts = [
      { name: "Workshop", serverId: null },
      { name: "Studio", serverId: null, sshTarget: "user@studio.example" },
    ];
    fs.writeFileSync(file, JSON.stringify(c));
    process.env.ORCA_HOME = home;
    assert.ok(configuredHost("Studio"));
    assert.ok(!configuredHost("missing"));
    let calls = 0;
    const adapter = localNative({
      create(a) {
        calls++;
        return a.title;
      },
    });
    assert.equal(adapter.create({ host: "Desk", title: "Local task" }), "Local task");
    assert.throws(() => adapter.create({ host: "Workshop" }), /outside v0.2/);
    assert.equal(calls, 1);
    assert.equal(adapter.project({ id: "a" }).host, "Desk");
    assert.equal(adapter.route("a"), null);
    await adapter.reconcile();
  } finally {
    if (previous === undefined) delete process.env.ORCA_HOME;
    else process.env.ORCA_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
