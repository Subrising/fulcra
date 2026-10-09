import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n/i18next";

// L46: one host whose active connection each test sets; the runtime looks it up by client.
const host = vi.hoisted(() => ({
  client: null as unknown,
  connection: null as null | { type: string },
}));
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({
    getHosts: () => [{ serverId: "srv_mini" }],
    getSnapshot: (serverId: string) =>
      serverId === "srv_mini" ? { client: host.client, activeConnection: host.connection } : null,
  }),
}));

const { createPluginSurfaceRuntime } = await import("./surface-runtime");
const { CommandCentreNeedsDirectConnectionError, COMMAND_CENTRE_PLUGIN_ID, needsDirectConnection } =
  await import("./command-centre-connection");

function fakeClient() {
  const invokePluginRpc = vi.fn(async () => ({ roles: {} }));
  const client = { invokePluginRpc } as unknown as DaemonClient;
  host.client = client;
  return { client, invokePluginRpc };
}
const plugin = (id: string) => ({ id, lifetime: new AbortController() });

describe("L46: Command Centre over the relay", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("relay-only: the read is refused locally with the plain message and nothing is sent", async () => {
    const { client, invokePluginRpc } = fakeClient();
    host.connection = { type: "relay" };
    const runtime = createPluginSurfaceRuntime(client, plugin(COMMAND_CENTRE_PLUGIN_ID))!;
    const read = runtime.invoke("organization.session-defaults", {});
    await expect(read).rejects.toBeInstanceOf(CommandCentreNeedsDirectConnectionError);
    await expect(read).rejects.toThrow(
      "Command Centre is off for this device. On the Mac, turn on Allow Command Centre for it",
    );
    await expect(read).rejects.not.toThrow(/Management unavailable/);
    expect(invokePluginRpc).not.toHaveBeenCalled();
  });

  it("direct: the read goes to the host", async () => {
    const { client, invokePluginRpc } = fakeClient();
    host.connection = { type: "directTcp" };
    const runtime = createPluginSurfaceRuntime(client, plugin(COMMAND_CENTRE_PLUGIN_ID))!;
    await expect(runtime.invoke("organization.session-defaults", {})).resolves.toEqual({
      roles: {},
    });
    expect(invokePluginRpc).toHaveBeenCalledWith(
      COMMAND_CENTRE_PLUGIN_ID,
      "organization.session-defaults",
      {},
    );
  });

  it("the check is per call: once the host is on a direct connection the same runtime reads", async () => {
    const { client, invokePluginRpc } = fakeClient();
    host.connection = { type: "relay" };
    const runtime = createPluginSurfaceRuntime(client, plugin(COMMAND_CENTRE_PLUGIN_ID))!;
    await expect(runtime.invoke("organization.session-defaults", {})).rejects.toThrow();
    host.connection = { type: "directTcp" };
    await expect(runtime.invoke("organization.session-defaults", {})).resolves.toBeTruthy();
    expect(invokePluginRpc).toHaveBeenCalledTimes(1);
  });

  it("other plugins still use the relay", async () => {
    const { client, invokePluginRpc } = fakeClient();
    host.connection = { type: "relay" };
    const runtime = createPluginSurfaceRuntime(client, plugin("workspace-plugin"))!;
    await runtime.invoke("anything", {});
    expect(invokePluginRpc).toHaveBeenCalledTimes(1);
  });

  it("needsDirectConnection: only Command Centre, only over the relay", () => {
    expect(needsDirectConnection(COMMAND_CENTRE_PLUGIN_ID, { type: "relay" })).toBe(true);
    for (const type of ["directTcp", "directSocket", "directPipe", "remoteSsh"] as const)
      expect(needsDirectConnection(COMMAND_CENTRE_PLUGIN_ID, { type })).toBe(false);
    expect(needsDirectConnection(COMMAND_CENTRE_PLUGIN_ID, null)).toBe(false);
    expect(needsDirectConnection("workspace-plugin", { type: "relay" })).toBe(false);
  });

  // L46 option 5: a device this Mac's owner granted Command Centre is authenticated per socket over the relay.
  it("relay with the owner's grant on this socket: the read goes to the host", async () => {
    const { client, invokePluginRpc } = fakeClient();
    Object.assign(client, {
      getLastServerInfoMessage: () => ({ permissions: ["daemon.manage", "command-centre.manage"] }),
    });
    host.connection = { type: "relay" };
    const runtime = createPluginSurfaceRuntime(client, plugin(COMMAND_CENTRE_PLUGIN_ID))!;
    await expect(runtime.invoke("organization.session-defaults", {})).resolves.toEqual({
      roles: {},
    });
    expect(invokePluginRpc).toHaveBeenCalledTimes(1);
  });

  // D13: a read-only device holds daemon.read without daemon.manage on a host with the read tier; the host serves its
  // Command Centre reads (and refuses every write), so the app sends them.
  it("relay as a read-only device on a host with the read tier: reads go to the host", () => {
    const readTier = {
      getLastServerInfoMessage: () => ({
        permissions: ["workspace.read", "daemon.read"],
        features: { deviceReadOnlyTier: true },
      }),
    };
    const oldHost = {
      getLastServerInfoMessage: () => ({ permissions: ["workspace.read", "daemon.read"] }),
    };
    const managesWithoutGrant = {
      getLastServerInfoMessage: () => ({
        permissions: ["daemon.read", "daemon.manage"],
        features: { deviceReadOnlyTier: true },
      }),
    };
    const relay = { type: "relay" } as const;
    expect(needsDirectConnection(COMMAND_CENTRE_PLUGIN_ID, relay, readTier as never)).toBe(false);
    expect(needsDirectConnection(COMMAND_CENTRE_PLUGIN_ID, relay, oldHost as never)).toBe(true);
    expect(
      needsDirectConnection(COMMAND_CENTRE_PLUGIN_ID, relay, managesWithoutGrant as never),
    ).toBe(true);
  });

  it("relay without the grant on this socket stays refused, even with other permissions", () => {
    const granted = {
      getLastServerInfoMessage: () => ({ permissions: ["command-centre.manage"] }),
    };
    const plain = { getLastServerInfoMessage: () => ({ permissions: ["daemon.manage"] }) };
    expect(needsDirectConnection(COMMAND_CENTRE_PLUGIN_ID, { type: "relay" }, plain as never)).toBe(
      true,
    );
    expect(
      needsDirectConnection(COMMAND_CENTRE_PLUGIN_ID, { type: "relay" }, granted as never),
    ).toBe(false);
  });
});
