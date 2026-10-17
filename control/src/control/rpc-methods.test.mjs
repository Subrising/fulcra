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
      ...body.matchAll(/request\.method === ['"]([a-z0-9-]+)['"]/g),
      ...body.matchAll(/case ['"]([a-z0-9-]+)['"]:/g),
    ].map((m) => m[1]),
  );
  const notify = /const notificationMethods = \{([^}]*)\}/.exec(body)?.[1] ?? "";
  for (const m of notify.matchAll(/['"]([a-z0-9-]+)['"]:/g)) literal.add(m[1]);
  assert.deepEqual([...RPC_METHODS].sort(), [...literal].sort());
  assert.ok(RPC_METHODS.size > 90);
});

test("scoped phone management accepts only the exact manual account switch", async () => {
  const { requireManagementPrincipal } = await import("./management-principal.mjs");
  const session = "11111111-1111-4111-8111-111111111111";
  const principal = {
    id: "device:phone",
    deviceId: "phone",
    authentication: "paired-device",
    permissions: ["daemon.read", "workspace.read", "workspace.write"],
    accountSessionId: session,
  };
  assert.equal(
    requireManagementPrincipal(principal, {
      method: "session-takeover",
      input: { session, reason: "manual" },
    }),
    principal,
  );
  for (const command of [
    { method: "create", input: {} },
    { method: "list", input: null },
    { method: "session-takeover", input: { session: "other", reason: "manual" } },
    { method: "session-takeover", input: { session, reason: "limit" } },
  ])
    assert.throws(() => requireManagementPrincipal(principal, command), /viewed session/);
});
