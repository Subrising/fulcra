// REVIEW-H6 F2: RPC_METHODS is exactly the set of methods rpc.mjs dispatches (the metrics log's closed set).
import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { RPC_METHODS } from "./rpc.mjs";

test("RPC_METHODS equals every method literal the dispatcher answers, and nothing else (static)", () => {
  const src = fs.readFileSync(new URL("./rpc.mjs", import.meta.url), "utf8"),
    body = src.slice(src.indexOf("export function rpc("));
  const literal = new Set(
    [
      ...body.matchAll(/request\.method === '([a-z0-9-]+)'/g),
      ...body.matchAll(/case '([a-z0-9-]+)':/g),
    ].map((m) => m[1]),
  );
  const notify = /const notificationMethods = \{([^}]*)\}/.exec(body)?.[1] ?? "";
  for (const m of notify.matchAll(/'([a-z0-9-]+)':/g)) literal.add(m[1]);
  assert.deepEqual([...RPC_METHODS].sort(), [...literal].sort());
  assert.ok(RPC_METHODS.size > 90);
});
