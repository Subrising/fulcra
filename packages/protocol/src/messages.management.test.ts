import { expect, test } from "vitest";
import {
  DAEMON_PERMISSIONS,
  DaemonPermissionSchema,
  PluginRpcInvokeRequestSchema,
} from "./messages.js";
test("management permission is explicit, and external principal/context fields refuse", () => {
  expect(DAEMON_PERMISSIONS).toContain("command-centre.manage");
  expect(DaemonPermissionSchema.parse("command-centre.manage")).toBe("command-centre.manage");
  const frame = {
    type: "plugin.rpc.invoke.request",
    requestId: "request",
    pluginId: "orca-organization-next",
    method: "manage",
    input: {},
  };
  for (const key of ["principal", "management", "invocationId", "authentication", "context"])
    expect(PluginRpcInvokeRequestSchema.safeParse({ ...frame, [key]: "forged" }).success).toBe(
      false,
    );
});
