import test from "node:test";
import assert from "node:assert/strict";
import wire from "./trial/wire.cjs";
test("trial reads the real protocol response payload, never an invented flat response", () => {
  const payload = { requestId: "fixture", output: { status: "observed" } };
  assert.deepEqual(
    wire.rpcResponse({ type: "session", message: { type: "plugin.rpc.invoke.response", payload } }),
    payload,
  );
  assert.equal(
    wire.rpcResponse({
      type: "session",
      message: { type: "plugin.rpc.invoke.response", ...payload },
    }),
    null,
  );
  assert.equal(wire.rpcResponse({ type: "session", message: { type: "other", payload } }), null);
});
test("void native commands still produce valid JSON receipts", () => {
  assert.equal(JSON.parse(wire.jsonReceipt(undefined)), null);
  assert.deepEqual(JSON.parse(wire.jsonReceipt({ stopped: true })), { stopped: true });
});
