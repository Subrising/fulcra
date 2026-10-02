import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { withManagementInvocation, invokeManagement } from "./management-context.mjs";
import { parseControllerCommand } from "../shared/command-parser.mjs";

// Run with FULCRA_TEST_PRODUCT pointing at a built Fulcra checkout; no copied host stub.
test(
  "argument-free plugin reads satisfy the real host management envelope",
  {
    skip:
      !process.env.FULCRA_TEST_PRODUCT && "Requires built product checkout (FULCRA_TEST_PRODUCT)",
  },
  async () => {
    const { ManagementAuthority, consumeManagementDispatch } = await import(
      pathToFileURL(
        path.join(
          process.env.FULCRA_TEST_PRODUCT,
          "packages/server/dist/server/server/plugins/management.js",
        ),
      )
    );
    const seen = [];
    const authority = new ManagementAuthority({
      enabled: () => true,
      validate: parseControllerCommand,
    });
    authority.register("orca-organization-next", async (command, principal) => {
      consumeManagementDispatch(command, principal);
      seen.push(command);
      return [];
    });
    const target = {
      pluginId: "orca-organization-next",
      bundleDirectory: "/fixture/bundled-plugin",
      isCurrent: () => true,
    };
    const invocation = authority.open(target, () => ({
      id: "owner",
      authentication: "daemon-password",
      deviceId: null,
      permissions: ["daemon.manage", "command-centre.manage"],
    }));
    try {
      await withManagementInvocation(
        { management: { invoke: (command) => invocation.invoke(randomUUID(), command) } },
        true,
        async () => {
          assert.deepEqual(await invokeManagement("list"), []);
          assert.deepEqual(await invokeManagement("bindings-status"), []);
          const id = "11111111-1111-4111-8111-111111111111";
          assert.deepEqual(await invokeManagement("history", id), []);
        },
      );
      assert.deepEqual(seen, [
        { method: "list", input: null },
        { method: "bindings-status", input: null },
        { method: "history", input: "11111111-1111-4111-8111-111111111111" },
      ]);
    } finally {
      invocation.close();
      authority.close();
    }
  },
);
