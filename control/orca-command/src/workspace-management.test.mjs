// Cutover A2: /orca delegate (handback) goes ONLY through the supplied management-route writer; /orca sessions stays on the read
// lane. Without a writer (the default, unless the gateway selects the owned child) the legacy operator lane is unchanged.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createWorkspace } from "./workspace.mjs";
import { commandOrigin } from "./command.mjs";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-command-management-")));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
fs.writeFileSync(path.join(root, ["operator", "secret"].join(".")), "a".repeat(43), {
  mode: 0o600,
});
const config = {
  bindingsDir: path.join(root, "bindings"),
  accountId: "default",
  conversationId: "123",
  senderId: "456",
  sessionId: randomUUID(),
};
const S = randomUUID();

test("with the management route selected, delegate uses only the writer; an uncertain outcome is not retried anywhere", async () => {
  const requests = [],
    writes = [];
  const request = async (envelope) => {
    requests.push(envelope.method);
    return envelope.method === "list" ? [] : null;
  };
  const write = async (method, input) => {
    writes.push([method, input]);
    throw Object.assign(Error("Management outcome uncertain; Do not replay."), {
      code: "uncertain",
      doNotReplay: true,
    });
  };
  const workspace = createWorkspace({
    config,
    baseOrigin: commandOrigin(config),
    request,
    runtimeHome: root,
    write,
  });
  await assert.rejects(
    workspace.run({ action: "delegate", sessionId: S, generation: 1 }, () => {}),
    (e) => e.code === "uncertain",
  );
  assert.deepEqual(
    writes.map(([m]) => m),
    ["handback"],
  );
  assert.equal(writes[0][1].sessionId, S);
  assert.deepEqual(requests, [], "no socket write, no fallback");
  await workspace.run({ action: "sessions", page: 1 }, () => {});
  assert.deepEqual(requests, ["list"]);
  assert.equal(writes.length, 1);
});

test("without a writer, delegate keeps the legacy operator lane (today's behaviour)", async () => {
  const envelopes = [];
  const request = async (envelope) => {
    envelopes.push(envelope);
    throw Error("stop here");
  };
  const workspace = createWorkspace({
    config,
    baseOrigin: commandOrigin(config),
    request,
    runtimeHome: root,
  });
  await assert.rejects(
    workspace.run({ action: "delegate", sessionId: S, generation: 1 }, () => {}),
    /stop here/,
  );
  assert.equal(envelopes[0].method, "handback");
  assert.equal(envelopes[0].operator, "a".repeat(43));
});
