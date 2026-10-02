import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseControllerCommand } from "./command-parser.mjs";
test("startup is an injected factory with catalog activation and a revalidating child dispatcher", () => {
  const source = fs.readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
  assert.match(source, /export async function startController/);
  assert.match(source, /connectNative\(\{ daemon, issueProvenance, getHandshakeBoot \}\)/);
  assert.match(source, /registerManagement\(managementDispatcher\(control\)\)/);
  assert.doesNotMatch(source, /host-verification|witnessDaemon/);
  assert.deepEqual(parseControllerCommand({ method: "list" }), { method: "list" });
});
