import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { expect, test, vi } from "vitest";
import { Session } from "./session.js";
import { TrustedPlugins } from "./plugins/trusted.js";
import { AccountActionsAudit } from "./plugins/account-actions.js";
import type { ManagementInvocation } from "./plugins/management.js";
import { OWNER_PERMISSIONS, RELAY_DEVICE_DEFAULT_PERMISSIONS } from "./authorization/index.js";
import { DeviceRegistry, WS_CLOSE_ACCESS_CHANGED } from "./pairing/device-registry.js";
import { hashDaemonPassword } from "./auth.js";
import {
  daemonAuthorizationHeader,
  daemonAuthProtocols,
} from "@getpaseo/protocol/daemon-credential";
import { CLIENT_CAPS } from "@getpaseo/protocol/client-capabilities";
import { FrozenServerInfo, FrozenHubStatus } from "./test-utils/frozen-v11a-permissions.js";
import { createStub } from "./test-utils/class-mocks.js";
import { createProviderSnapshotManagerStub } from "./test-utils/session-stubs.js";
vi.mock("ws", () => ({
  WebSocketServer: class {
    on() {
      return this;
    }
    close() {}
  },
}));
vi.mock("./push/index.js", () => ({
  createPushNotifications: () => ({
    renew: () => {},
    revoke: () => {},
    send: async () => {},
  }),
}));
import { VoiceAssistantWebSocketServer } from "./websocket-server.js";
class Socket extends EventEmitter {
  pause() {}
  resume() {}
  readyState = 1;
  bufferedAmount = 0;
  sent: Array<{
    message?: { type: string; payload: Record<string, unknown> };
  }> = [];
  send(data: string, callback?: (error?: Error) => void) {
    this.sent.push(JSON.parse(data));
    callback?.();
  }
  closed: { code?: number; reason?: string } | undefined;
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
    this.readyState = 3;
    this.emit("close", 1000, "");
  }
  hello(capable = false) {
    this.emit(
      "message",
      JSON.stringify({
        type: "hello",
        clientId: "same-client",
        clientType: "mcp",
        protocolVersion: 1,
        capabilities: capable ? { [CLIENT_CAPS.commandCentrePermission]: true } : {},
      }),
    );
  }
}
const hash = "$2b$12$OLxyuuP9uLK30Uzc4wQX0O6liuU/Q1t5P2b0Ebf36mULvpVK3DRZW";
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "cc-connection-"));
  const host = new TrustedPlugins(
    { enabled: () => true, validate: (c) => c },
    { accountActions: new AccountActionsAudit(home) },
  );
  host.initializeKnownAgents([]);
  const bridge = vi.fn(async () => null);
  host.registerV11("orca-organization-next", true, (sdk) => sdk.managementBridge.register(bridge));
  const server = new VoiceAssistantWebSocketServer(
    createStub({}),
    pino({ level: "silent" }),
    "fixture",
    createStub({
      trustedPlugins: host,
      setNativeMessageReceipts: () => {},
      subscribe: () => () => {},
      setAgentAttentionCallback: () => {},
      listAgents: () => [],
      listProviderSubagentActivity: () => [],
      getAgent: () => null,
      getMetricsSnapshot: () => ({
        totalAgents: 0,
        idleAgents: 0,
        runningAgents: 0,
        pendingPermissionAgents: 0,
        erroredAgents: 0,
      }),
    }),
    createStub({ list: async () => [] }),
    createStub({}),
    home,
    createStub({
      onApply: () => () => {},
      onChange: () => () => {},
      get: () => ({ providers: {}, mcp: { injectIntoAgents: false } }),
    }),
    null,
    { allowedOrigins: new Set() },
    createStub({}),
    undefined,
    undefined,
    undefined,
    undefined,
    "0.9.1",
    undefined,
    undefined,
    undefined,
    createStub({}),
    createStub({
      subscribe: () => () => {},
      getMetrics: () => ({}),
      dispose: () => {},
    }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    createProviderSnapshotManagerStub().manager,
  );
  const target = {
    pluginId: "orca-organization-next",
    bundleDirectory: "/fixture/bundle",
    isCurrent: () => true,
  };
  let invocation: ManagementInvocation | undefined;
  let release: (() => void) | undefined;
  let hold = false;
  Object.assign(server, {
    pluginRuntime: {
      subscribe: () => () => {},
      subscribeSettings: () => () => {},
      managementTarget: () => target,
      invokePluginRpc: async (
        _id: string,
        _method: string,
        _input: unknown,
        management?: ManagementInvocation,
      ) => {
        invocation = management;
        if (hold)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        if (!management) return "unavailable";
        await management.invoke("call", { method: "list", input: null });
        return "ok";
      },
    },
  });
  const sockets: Socket[] = [];
  const attach = async (admission?: unknown, bearer = false, capable = false) => {
    const socket = new Socket();
    sockets.push(socket);
    if (bearer)
      await Reflect.get(server, "attachAuthenticatedSocket").call(
        server,
        socket,
        {
          headers: {
            "sec-websocket-protocol": "paseo.bearer.correct-password",
          },
          socket: {},
        },
        hash,
      );
    else
      await Reflect.get(server, "attachSocket").call(server, socket, undefined, false, admission);
    socket.hello(capable);
    await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThan(0));
    return socket;
  };
  const session = (s: Socket): Session => Reflect.get(server, "sessions").get(s).session;
  const request = async (s: Socket, input: unknown = {}) => {
    await session(s).handleMessage(
      {
        type: "plugin.rpc.invoke.request",
        requestId: "request",
        pluginId: target.pluginId,
        method: "manage",
        input,
      },
      s,
    );
  };
  return {
    home,
    server,
    host,
    bridge,
    attach,
    session,
    request,
    getInvocation: () => invocation,
    hold: () => {
      hold = true;
    },
    release: () => release?.(),
    async close() {
      release?.();
      for (const s of sockets) s.close();
      await server.close();
      host.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}
test("null admission resumes refuse before retained-session effects", async () => {
  const f = await fixture();
  const socket = new Socket();
  const updateClientCapabilities = vi.fn();
  const admitManagementSource = vi.fn();
  const sockets = new Set();
  try {
    Reflect.get(f.server, "resumeSession").call(f.server, {
      ws: socket,
      message: { capabilities: {}, appVersion: "0.10.2" },
      pending: { admission: null },
      existing: {
        session: { updateClientCapabilities, admitManagementSource },
        sockets,
      },
    });
    expect(socket.closed?.reason).toBe("Missing session admission");
    expect(updateClientCapabilities).not.toHaveBeenCalled();
    expect(admitManagementSource).not.toHaveBeenCalled();
    expect(sockets.size).toBe(0);
  } finally {
    await f.close();
  }
});

test("M3 bearer gets management; relay resume and forged payload cannot inherit it; disconnect revokes", async () => {
  const f = await fixture();
  try {
    const bearer = await f.attach(undefined, true, true);
    expect(f.session(bearer)).toBeInstanceOf(Session);
    await f.request(bearer);
    expect(f.bridge).toHaveBeenCalledOnce();
    const relay = await f.attach();
    expect(f.session(relay)).toBe(f.session(bearer));
    await f.request(relay, {
      principal: { id: "owner" },
      management: {},
      context: {},
    });
    expect(f.getInvocation()).toBeUndefined();
    expect(f.bridge).toHaveBeenCalledOnce();
    f.hold();
    const pending = f.request(bearer);
    await vi.waitFor(() => expect(f.getInvocation()).toBeDefined());
    const retained = f.getInvocation()!;
    bearer.close();
    await expect(retained.invoke("after-close", { method: "list", input: null })).rejects.toThrow();
    f.release();
    await pending;
    expect(f.bridge).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});
test("M3 resume rejects mismatched evidence and honours actual limited device admission grants", async () => {
  const f = await fixture();
  try {
    const owner = await f.attach(undefined, true);
    await f.request(owner);
    expect(f.bridge).toHaveBeenCalledOnce();
    const mismatch = await f.attach({
      principalId: "owner",
      permissions: OWNER_PERMISSIONS,
      authentication: {
        id: "other-owner",
        authentication: "daemon-password",
        deviceId: null,
      },
    });
    await f.request(mismatch);
    expect(f.getInvocation()).toBeUndefined();
    const limited = await f.attach({
      principalId: "owner",
      permissions: ["daemon.manage", "workspace.write"],
      authentication: {
        id: "owner",
        authentication: "paired-device",
        deviceId: "limited-device",
      },
    });
    expect(f.session(limited)).toBe(f.session(owner));
    await f.request(limited);
    expect(f.getInvocation()).toBeUndefined();
    expect(f.bridge).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});
test("M3 ephemeral plugin lifecycle never admits even host-supplied authentication", async () => {
  const f = await fixture();
  const admit = vi.spyOn(Session.prototype, "admitManagementSource");
  try {
    const socket = new Socket();
    const connection = Reflect.get(f.server, "createSessionConnection").call(f.server, {
      ws: socket,
      clientId: "plugin",
      appVersion: null,
      clientCapabilities: null,
      connectionLogger: pino({ level: "silent" }),
      lifecycle: { kind: "ephemeral-plugin", pluginId: "fixture" },
      admission: {
        principalId: "owner",
        permissions: OWNER_PERMISSIONS,
        authentication: {
          id: "owner",
          authentication: "daemon-password",
          deviceId: null,
        },
      },
    });
    expect(connection.session).toBeInstanceOf(Session);
    expect(admit).toHaveBeenCalledWith(socket, undefined, OWNER_PERMISSIONS);
    expect(Reflect.get(connection.session, "managementSources").has(socket)).toBe(false);
    await connection.session.cleanup();
  } finally {
    admit.mockRestore();
    await f.close();
  }
});
test("B1 hello/resume and Hub statuses are capability gated per socket", async () => {
  const f = await fixture();
  try {
    const capable = await f.attach(undefined, true, true);
    const legacy = await f.attach();
    expect(capable.sent[0].message?.payload.permissions).toContain("command-centre.manage");
    expect(FrozenServerInfo.safeParse(legacy.sent[0].message?.payload).success).toBe(true);
    // U7: accounts.manage is new too: a capable client sees it (the owner holds it), a legacy one never does.
    expect(capable.sent[0].message?.payload.permissions).toContain("accounts.manage");
    expect(legacy.sent[0].message?.payload.permissions).not.toContain("accounts.manage");
    const status = {
      state: "connected",
      daemonId: "fixture",
      hubOrigin: null,
      permissions: [...OWNER_PERMISSIONS],
      connectedAt: null,
      lastError: null,
    };
    for (const type of [
      "hub.management.daemon.connect.response",
      "hub.management.daemon.get_status.response",
      "hub.management.daemon.disconnect.response",
      "hub.management.daemon.permissions.update.response",
    ]) {
      for (const socket of [legacy, capable])
        Reflect.get(f.server, "sendToClient").call(f.server, socket, {
          type: "session",
          message: { type, payload: { requestId: "r", status } },
        });
      expect(FrozenHubStatus.safeParse(legacy.sent.at(-1)?.message?.payload.status).success).toBe(
        true,
      );
      expect(
        (capable.sent.at(-1)?.message?.payload.status as typeof status | undefined)?.permissions,
      ).toContain("command-centre.manage");
    }
  } finally {
    await f.close();
  }
});

test("main-only Authorization header authenticates without reflecting a password subprotocol", async () => {
  const f = await fixture();
  const socket = new Socket();
  try {
    await Reflect.get(f.server, "attachAuthenticatedSocket").call(
      f.server,
      socket,
      { headers: { authorization: "Bearer correct-password" }, socket: {} },
      hash,
    );
    socket.hello(true);
    await f.request(socket);
    expect(f.bridge).toHaveBeenCalledOnce();
  } finally {
    socket.close();
    await f.close();
  }
});
import * as bearerAuth from "./auth.js";
test("password checks are asynchronous and capped before session attachment", async () => {
  const f = await fixture();
  const pending: ((v: boolean) => void)[] = [];
  const check = vi
    .spyOn(bearerAuth, "isBearerTokenValidAsync")
    .mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
  const sockets = Array.from({ length: 5 }, () => new Socket());
  try {
    const calls = sockets.map((socket) =>
      Reflect.get(f.server, "attachAuthenticatedSocket").call(
        f.server,
        socket,
        { headers: { authorization: "Bearer candidate" }, socket: {} },
        hash,
      ),
    );
    expect(check).toHaveBeenCalledTimes(4);
    expect(sockets[4].readyState).toBe(3);
    expect(sockets[4].closed).toMatchObject({ code: 1013 });
    for (const resolve of pending) resolve(false);
    await Promise.all(calls);
    expect(sockets.every((s) => s.readyState === 3)).toBe(true);
  } finally {
    check.mockRestore();
    for (const s of sockets) s.close();
    await f.close();
  }
});

test("an immediate client hello survives asynchronous password verification", async () => {
  const real = await vi.importActual<typeof import("ws")>("ws");
  const { once } = await import("node:events");
  const listener = new real.WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(listener, "listening");
  const address = listener.address();
  if (typeof address === "string") throw Error("Expected numeric fixture port");
  const f = await fixture(),
    received: string[] = [];
  const check = vi.spyOn(bearerAuth, "isBearerTokenValidAsync").mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return true;
  });
  const attach = vi
    .spyOn(
      f.server as unknown as { attachSocket(socket: import("ws").WebSocket): Promise<void> },
      "attachSocket",
    )
    .mockImplementation(async (socket) => {
      (socket as import("ws").WebSocket).on("message", (data) => received.push(data.toString()));
    });
  listener.on("connection", (socket, request) => {
    void Reflect.get(f.server, "attachAuthenticatedSocket").call(f.server, socket, request, hash);
  });
  const client = new real.WebSocket(`ws://127.0.0.1:${address.port}/ws`, {
    headers: { Authorization: "Bearer fixture" },
  });
  try {
    await once(client, "open");
    client.send("immediate hello");
    await vi.waitFor(() => expect(received).toEqual(["immediate hello"]));
    expect(check).toHaveBeenCalledOnce();
  } finally {
    check.mockRestore();
    attach.mockRestore();
    client.terminate();
    for (const socket of listener.clients) socket.terminate();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await f.close();
  }
});

// L46 option 5: paired devices and Command Centre over the relay.
async function relayDevice(
  f: Awaited<ReturnType<typeof fixture>>,
  admission: Record<string, unknown>,
): Promise<Socket> {
  const socket = new Socket();
  await f.server.attachExternalSocket(socket as never, { transport: "relay" }, admission as never);
  if (!socket.closed) socket.hello(true);
  return socket;
}

function deviceAdmission(deviceId: string, granted: boolean) {
  const principalId = `device:${deviceId}`;
  return {
    principalId,
    deviceId,
    permissions: granted
      ? [...RELAY_DEVICE_DEFAULT_PERMISSIONS, "command-centre.manage"]
      : [...RELAY_DEVICE_DEFAULT_PERMISSIONS],
    ...(granted
      ? { authentication: { id: principalId, authentication: "paired-device", deviceId } }
      : {}),
  };
}

test("L46-5 a relay device without the grant is refused management, and cannot claim it", async () => {
  const f = await fixture();
  try {
    const registry = new DeviceRegistry(f.home);
    const { deviceId } = registry.add("device-key-1", "Phone");
    // Claiming paired-device authentication without the owner's grant: the relay gate refuses the socket.
    const forged = await relayDevice(f, deviceAdmission(deviceId, true));
    expect(forged.closed?.code).toBe(4403);
    // The plain device admission connects, but reads no Command Centre.
    const plain = await relayDevice(f, deviceAdmission(deviceId, false));
    expect(plain.closed).toBeUndefined();
    await f.request(plain);
    expect(f.getInvocation()).toBeUndefined();
    expect(f.bridge).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

test("L46-5 with the owner's grant a relay device reads, as its own principal (what the controller logs)", async () => {
  const f = await fixture();
  try {
    const registry = new DeviceRegistry(f.home);
    const { deviceId } = registry.add("device-key-2", "Phone");
    await registry.setCommandCentre(deviceId, true, () => {});
    const phone = await relayDevice(f, deviceAdmission(deviceId, true));
    expect(phone.closed).toBeUndefined();
    await f.request(phone);
    expect(f.bridge).toHaveBeenCalledOnce();
    const principal = f.bridge.mock.calls[0]?.[1] as unknown as {
      id: string;
      authentication: string;
      deviceId: string;
      permissions: string[];
    };
    expect(principal).toMatchObject({
      id: `device:${deviceId}`,
      authentication: "paired-device",
      deviceId,
    });
    expect(principal.permissions).toEqual(
      expect.arrayContaining(["command-centre.manage", "daemon.manage"]),
    );
    expect(principal.permissions).not.toContain("access.manage");
  } finally {
    await f.close();
  }
});

test("L46-5 removing the grant closes the device's sockets first, mid-session", async () => {
  const f = await fixture();
  try {
    const registry = new DeviceRegistry(f.home);
    const { deviceId } = registry.add("device-key-3", "Phone");
    await registry.setCommandCentre(deviceId, true, () => {});
    const phone = await relayDevice(f, deviceAdmission(deviceId, true));
    f.hold();
    const pending = f.request(phone);
    await vi.waitFor(() => expect(f.getInvocation()).toBeDefined());
    const retained = f.getInvocation()!;
    let grantedWhenClosed: boolean | undefined;
    await registry.setCommandCentre(deviceId, false, (id, code, reason) => {
      // Revocation first: already refused in memory, sockets closed before the store is written.
      grantedWhenClosed = new DeviceRegistry(f.home).hasCommandCentre(id);
      f.server.closeDeviceSockets(id, code, reason);
    });
    expect(grantedWhenClosed).toBe(false);
    expect(phone.closed?.code).toBe(WS_CLOSE_ACCESS_CHANGED);
    await expect(
      retained.invoke("after-revoke", { method: "list", input: null }),
    ).rejects.toThrow();
    f.release();
    await pending;
    expect(f.bridge).not.toHaveBeenCalled();
    // Reconnecting with the old grant's admission is refused by the gate.
    const again = await relayDevice(f, deviceAdmission(deviceId, true));
    expect(again.closed?.code).toBe(4403);
  } finally {
    await f.close();
  }
});

test("L46-5 a resumed owner session never widens a device's grant", async () => {
  const f = await fixture();
  try {
    const registry = new DeviceRegistry(f.home);
    const { deviceId } = registry.add("device-key-4", "Phone");
    const owner = await f.attach(undefined, true, true);
    // Same client id as the owner's session: the device still gets its own session, not the owner's.
    const phone = await relayDevice(f, deviceAdmission(deviceId, false));
    expect(f.session(phone)).not.toBe(f.session(owner));
    await f.request(phone);
    expect(f.bridge).not.toHaveBeenCalled();
    // With the grant (which closes the device's sockets, as the owner's RPC does), still only the device's own
    // permissions: never the owner's access.manage.
    await registry.setCommandCentre(deviceId, true, (id, code, reason) =>
      f.server.closeDeviceSockets(id, code, reason),
    );
    const granted = await relayDevice(f, deviceAdmission(deviceId, true));
    expect(f.session(granted)).not.toBe(f.session(owner));
    await f.request(granted);
    const principal = f.bridge.mock.calls.at(-1)?.[1] as unknown as { permissions: string[] };
    expect(principal.permissions).not.toContain("access.manage");
  } finally {
    await f.close();
  }
});

test("L46-5 turning the grant on closes the device's existing sockets; only a fresh admission manages", async () => {
  const f = await fixture();
  try {
    const registry = new DeviceRegistry(f.home);
    const { deviceId } = registry.add("device-key-5", "Phone");
    const before = await relayDevice(f, deviceAdmission(deviceId, false));
    await f.request(before);
    expect(f.bridge).not.toHaveBeenCalled();
    await registry.setCommandCentre(deviceId, true, (id, code, reason) =>
      f.server.closeDeviceSockets(id, code, reason),
    );
    // The socket admitted before the grant is closed (reconnect, not unpaired) and never gained management.
    expect(before.closed?.code).toBe(WS_CLOSE_ACCESS_CHANGED);
    expect(f.bridge).not.toHaveBeenCalled();
    // The device's fresh admission carries the grant and reads.
    const after = await relayDevice(f, deviceAdmission(deviceId, true));
    await f.request(after);
    expect(f.bridge).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});

// F01: any password signs in directly, whatever characters it holds. Synthetic password only.
const TRICKY_PASSWORD = `${Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join("")}日本🔐`;

test("F01 a password with every printable character and non-ASCII signs in by subprotocol and by header", async () => {
  const f = await fixture();
  const trickyHash = hashDaemonPassword(TRICKY_PASSWORD);
  const sockets: Socket[] = [];
  try {
    for (const headers of [
      { "sec-websocket-protocol": daemonAuthProtocols(TRICKY_PASSWORD).join(", ") },
      { authorization: daemonAuthorizationHeader(TRICKY_PASSWORD) },
    ]) {
      const socket = new Socket();
      sockets.push(socket);
      await Reflect.get(f.server, "attachAuthenticatedSocket").call(
        f.server,
        socket,
        { headers, socket: {} },
        trickyHash,
      );
      expect(socket.closed).toBeUndefined();
      socket.hello(true);
      await f.request(socket);
    }
    expect(f.bridge).toHaveBeenCalledTimes(2);
    // The wrong password is still refused.
    const wrong = new Socket();
    sockets.push(wrong);
    await Reflect.get(f.server, "attachAuthenticatedSocket").call(
      f.server,
      wrong,
      {
        headers: { "sec-websocket-protocol": daemonAuthProtocols("nope, not it").join(", ") },
        socket: {},
      },
      trickyHash,
    );
    expect(wrong.closed?.code).toBe(4401);
  } finally {
    for (const socket of sockets) socket.close();
    await f.close();
  }
});

// ---- U7: accounts.manage over the relay ------------------------------------------------------------------------
function accountsAdmission(deviceId: string) {
  const base = deviceAdmission(deviceId, true);
  return { ...base, permissions: [...base.permissions, "daemon.manage", "accounts.manage"] };
}

test("accounts-manage: a relay device carries accounts.manage only while the owner's grant stands; a forged admission is refused", async () => {
  // Each phase gets its own fixture: the fixture's sockets share one client id, and a resumed session never widens.
  const withoutGrant = await fixture();
  try {
    const registry = new DeviceRegistry(withoutGrant.home);
    const { deviceId } = registry.add("device-key-am1", "Phone");
    await registry.setCommandCentre(deviceId, true, () => {});
    // Command Centre alone: an admission claiming accounts.manage is refused, and management opens without it.
    expect((await relayDevice(withoutGrant, accountsAdmission(deviceId))).closed?.code).toBe(4403);
    const plain = await relayDevice(withoutGrant, deviceAdmission(deviceId, true));
    await withoutGrant.request(plain);
    expect(withoutGrant.getInvocation()?.accountsManage).toBe(false);
  } finally {
    await withoutGrant.close();
  }
  const f = await fixture();
  try {
    const registry = new DeviceRegistry(f.home);
    const { deviceId } = registry.add("device-key-am1", "Phone");
    await registry.setCommandCentre(deviceId, true, () => {});
    await registry.setAccountsManage(deviceId, true, () => {});
    // With the owner's grant it is admitted, and the plugin's management says the device may manage accounts.
    const phone = await relayDevice(f, accountsAdmission(deviceId));
    expect(phone.closed).toBeUndefined();
    await f.request(phone);
    expect(f.getInvocation()?.accountsManage).toBe(true);
    expect(f.getInvocation()?.principal.permissions).toContain("accounts.manage");
    // Revoked: the device's sockets close, and a new admission claiming it is refused again.
    await registry.setAccountsManage(deviceId, false, (id, code, reason) =>
      Reflect.get(f.server, "closeDeviceSockets").call(f.server, id, code, reason),
    );
    expect(phone.closed?.code).toBe(WS_CLOSE_ACCESS_CHANGED);
    expect((await relayDevice(f, accountsAdmission(deviceId))).closed?.code).toBe(4403);
  } finally {
    await f.close();
  }
});

test("accounts-manage: no credential material in any response or event to a remote client", async () => {
  const CANARY = "sk-ant-oat01-CANARY-accounts-manage-0123456789";
  const previous = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = CANARY;
  const f = await fixture();
  try {
    await writeFile(join(f.home, "auth.json"), JSON.stringify({ access_token: CANARY }));
    const registry = new DeviceRegistry(f.home);
    const { deviceId } = registry.add("device-key-am2", "Phone");
    await registry.setCommandCentre(deviceId, true, () => {});
    await registry.setAccountsManage(deviceId, true, () => {});
    const phone = await relayDevice(f, accountsAdmission(deviceId));
    f.hold();
    const pending = f.request(phone);
    await vi.waitFor(() => expect(f.getInvocation()).toBeDefined());
    const invocation = f.getInvocation()!;
    await expect(
      invocation.recordAccountAction({ action: "switch", accountLabel: "Work" }),
    ).resolves.toEqual({
      recorded: true,
    });
    await expect(
      invocation.recordAccountAction({ action: "add", accountLabel: CANARY }),
    ).rejects.toThrow("Invalid account action");
    f.release();
    await pending;
    // Every frame the device received: hello/server_info, the management reply, and any event.
    const frames = JSON.stringify(phone.sent);
    expect(phone.sent.length).toBeGreaterThan(0);
    expect(frames).not.toContain(CANARY);
    expect(frames).not.toMatch(/sk-ant-|auth\.json|access_token|refresh_token/);
    // The owner's audit holds the label only.
    const stored = await readFile(join(f.home, "accounts-audit.json"), "utf8");
    expect(stored).toContain('"accountLabel": "Work"');
    expect(stored).not.toContain(CANARY);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = previous;
    await f.close();
  }
});
