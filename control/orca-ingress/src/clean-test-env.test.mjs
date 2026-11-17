import assert from "node:assert/strict";
import test from "node:test";

test("test run does not inherit FULCRA_* or live daemon values from the shell", () => {
  const leaked = Object.keys(process.env).filter(
    (name) => name.startsWith("FULCRA_") && !name.startsWith("FULCRA_TEST_"),
  );
  assert.deepEqual(leaked, []);
  assert.equal(process.env.PASEO_DAEMON_SERVER_ID, undefined);
});
