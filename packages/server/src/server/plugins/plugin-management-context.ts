import { randomUUID } from "node:crypto";
import type { PluginManagementContextV11, ManagementPrincipalV11 } from "@getpaseo/plugin/server";
import type { JsonValue } from "@getpaseo/protocol/trusted-input";

/** Only plugin-process's validated host invoke branch constructs this closure. */
export function createManagementContext(
  admission: {
    invocationId: string;
    principal: ManagementPrincipalV11;
    readOnly?: boolean;
    accountsManage?: boolean;
  },
  send: (callId: string, invocationId: string, command: unknown) => Promise<unknown>,
  // U7: the host audits a remote account action against this invocation (it adds the device and time itself).
  audit: (invocationId: string, entry: unknown) => Promise<unknown> = async () => {
    throw new Error("The account audit is unavailable");
  },
): { context: PluginManagementContextV11; close(): void } {
  let live = true;
  let calls = 0;
  const expires = Date.now() + 30_000;
  const context: PluginManagementContextV11 = Object.freeze({
    contract: "1.1",
    principal: Object.freeze({
      ...admission.principal,
      permissions: Object.freeze([...admission.principal.permissions]),
    }),
    ...(admission.readOnly === true ? { readOnly: true } : {}),
    // U7: never together with readOnly (the host does not set both; this keeps it so).
    ...(admission.accountsManage === true && admission.readOnly !== true
      ? { accountsManage: true }
      : {}),
    async recordAccountAction(
      entry: Parameters<PluginManagementContextV11["recordAccountAction"]>[0],
    ) {
      if (!live || Date.now() >= expires) throw new Error("Management invocation expired");
      const result = (await audit(admission.invocationId, entry)) as { recorded?: unknown } | null;
      return { recorded: result?.recorded === true };
    },
    async invoke(command: Parameters<PluginManagementContextV11["invoke"]>[0]) {
      if (!live || Date.now() >= expires || calls++ >= 32)
        throw new Error("Management invocation expired");
      return (await send(randomUUID(), admission.invocationId, command)) as JsonValue;
    },
  });
  return {
    context,
    close() {
      live = false;
    },
  };
}
