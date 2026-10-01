// Cutover A2: the plugin side of organization.operator-invoke. Registered with `handle` (never handleRead), so every call runs in
// withManagementInvocation(ctx, false); the handler adds only the 9-method allowlist and classifies what may have run.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { withManagementInvocation } from "./management-context.mjs";
import { operatorInvoke } from "./operator-invoke.mjs";
const S = "11111111-1111-4111-8111-111111111111",
  takeover = { method: "takeover", input: { sessionId: S, reason: "Plugin acceptance takeover" } };
const run = (invoke, input = takeover) =>
  withManagementInvocation({ management: { invoke } }, false, () => operatorInvoke(input));

test("registered as a write RPC through the per-call management wrapper", () => {
  const source = fs.readFileSync(new URL("../index.server.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /handle\(operatorInvokeRpc, input => authError \? \{ ok: false, code: "management_unavailable", dispatched: false, message: authError \} : operatorInvoke\(input\)\);/,
  );
  assert.doesNotMatch(source, /handleRead\(operatorInvokeRpc/);
  assert.match(
    source,
    /withManagementInvocation\(context, readOnly, \(\) => handler\(input, context\)\)/,
  );
});

test("outside a management invocation nothing is dispatched", async () => {
  assert.deepEqual(await operatorInvoke(takeover).then((r) => [r.ok, r.code, r.dispatched]), [
    false,
    "management_unavailable",
    false,
  ]);
});

test("the host's post-dispatch codes: only a proven non-delivery is a refusal; everything else is uncertain", async () => {
  for (const code of ["invalid", "expired", "unauthorised", "unavailable"])
    assert.deepEqual(
      await run(async () => {
        throw Object.assign(Error("host " + code), { code });
      }).then((r) => [r.code, r.dispatched]),
      [code, false],
      code,
    );
  for (const error of [
    Object.assign(Error("x"), { code: "uncertain" }),
    Error("lost reply"),
    Object.assign(Error("y"), { code: "weird" }),
  ])
    assert.deepEqual(
      await run(async () => {
        throw error;
      }).then((r) => [r.code, r.dispatched]),
      ["uncertain", true],
    );
});

test("the input is not shaped by the plugin: the controller command parser (shared with the controller) refuses before dispatch", async () => {
  let invoked = 0;
  const reply = await run(
    async () => {
      invoked++;
    },
    { method: "takeover", input: { sessionId: S, reason: "short" } },
  );
  assert.deepEqual([reply.ok, reply.code, reply.dispatched, invoked], [false, "refused", false, 0]);
});

test("explicit native queue remains a write, strictly parsed in the original management invocation", async () => {
  const input = { sessionId: S, messageId: S, text: "Bounded instruction", expectedGeneration: 2 };
  let received;
  const invoke = async (command) => {
    received = command;
    return { retained: true };
  };
  assert.deepEqual(await run(invoke, { method: "operator-native-queue", input }), {
    ok: true,
    result: { retained: true },
  });
  assert.deepEqual(received, { method: "operator-native-queue", input });
  received = undefined;
  for (const invalid of [
    { ...input, nativeQueue: true },
    { ...input, messageId: "not-uuid" },
    { ...input, expectedGeneration: -1 },
  ]) {
    const reply = await run(invoke, { method: "operator-native-queue", input: invalid });
    assert.equal(reply.ok, false);
    assert.equal(reply.dispatched, false);
    assert.equal(received, undefined);
  }
  const readReply = await withManagementInvocation({ management: { invoke } }, true, () =>
    operatorInvoke({ method: "operator-native-queue", input }),
  );
  assert.equal(readReply.ok, false);
  assert.equal(readReply.dispatched, false);
  assert.equal(received, undefined);
});
