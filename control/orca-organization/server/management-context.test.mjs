import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  withManagementInvocation,
  invokeManagement,
  ManagementUnavailableError,
  invocationReadOnly,
} from "./management-context.mjs";
test("missing management refuses before a handler proceeds (q)", async () => {
  let proceeded = false;
  assert.throws(
    () =>
      withManagementInvocation({}, false, () => {
        proceeded = true;
      }),
    ManagementUnavailableError,
  );
  assert.equal(proceeded, false);
  assert.throws(() => invokeManagement("list"), ManagementUnavailableError);
});
test("management uses the current invocation and cannot outlive it", async () => {
  const seen = [];
  let retained;
  for (const id of [1, 2])
    await withManagementInvocation(
      {
        management: {
          invoke: async (command) => {
            seen.push([id, command.method]);
          },
        },
      },
      false,
      async () => {
        await invokeManagement("list");
        retained = () => invokeManagement("list");
      },
    );
  assert.deepEqual(seen, [
    [1, "list"],
    [2, "list"],
  ]);
  assert.throws(retained, ManagementUnavailableError);
});
test("read-only handlers invoke only authenticated read methods; absent authority is unavailable", async () => {
  const seen = [];
  assert.throws(() => withManagementInvocation({}, true, () => {}), ManagementUnavailableError);
  await withManagementInvocation(
    { management: { invoke: (command) => seen.push(command.method) } },
    true,
    async () => {
      await invokeManagement("list");
      assert.throws(
        () => invokeManagement("takeover", { sessionId: "x", reason: "forged mutation" }),
        ManagementUnavailableError,
      );
    },
  );
  assert.deepEqual(seen, ["list"]);
});
test("B3: a host-read handler (manage) run for a read-only device refuses writes in the plugin too, before the host", async () => {
  const seen = [],
    context = { management: { readOnly: true, invoke: (command) => seen.push(command.method) } };
  assert.equal(invocationReadOnly(false, context), true);
  assert.equal(invocationReadOnly(false, { management: { invoke() {} } }), false);
  assert.equal(invocationReadOnly(true, {}), true);
  await withManagementInvocation(context, invocationReadOnly(false, context), async () => {
    await invokeManagement("list");
    assert.throws(
      () => invokeManagement("takeover", { sessionId: "x", reason: "a read-only device write" }),
      ManagementUnavailableError,
    );
  });
  assert.deepEqual(seen, ["list"]);
});
test("overlapping invocations do not share management capabilities", async () => {
  const calls = [];
  await Promise.all(
    [1, 2].map((id) =>
      withManagementInvocation(
        { management: { invoke: () => calls.push(id) } },
        false,
        async () => {
          await new Promise((resolve) => setImmediate(resolve));
          invokeManagement("list");
        },
      ),
    ),
  );
  assert.deepEqual(calls.sort(), [1, 2]);
});
test("management module has no credential reader or startup-wide authentication seam", () => {
  const source = fs.readFileSync(new URL("./management.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /operator\.secret|readFileSync|assertManagementAuthentication/);
});
