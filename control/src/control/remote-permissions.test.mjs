import test from "node:test";
import assert from "node:assert/strict";
import { RemotePermissions } from "./remote-permissions.mjs";
import { canonical, digest } from "./permission-policy.mjs";
const hash = (x) => digest(canonical(x));
test("remote automatic completion binds identity and accepts no file-proof fiction", async () => {
  const proof = {
    kind: "automatic-tool",
    modeId: "auto",
    root: "/remote/task",
    inputHash: hash({}),
  };
  const body = {
    proof,
    generation: 2,
    nativeId: "native",
    origin: "origin",
    grantEpoch: "epoch",
    expectedLastUserAt: null,
    requestId: "request",
    requestDigest: "request-hash",
    toolUseId: "call",
  };
  const route = { agent: "agent", binding: JSON.stringify({ boot: "boot" }), generation: 2 };
  let output = { toolCompleted: true };
  const native = {
    db: { prepare: () => ({ get: () => ({ body: JSON.stringify(body) }) }) },
    route: () => route,
    call: async () => ({
      identity: {
        sessionId: "session",
        intentId: "intent",
        agentId: "agent",
        generation: 2,
        nativeId: "native",
        boot: "boot",
        origin: "origin",
        requestDigest: "request-hash",
        proofDigest: hash(proof),
      },
      tool: { state: "completed", callId: "call" },
      output,
    }),
  };
  const r = new RemotePermissions(native);
  assert.equal((await r.result("session", "intent")).output.toolCompleted, true);
  output = { toolCompleted: false };
  await assert.rejects(r.result("session", "intent"));
});
