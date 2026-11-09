import { afterEach, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { exportPublicKey, generateKeyPair } from "@getpaseo/relay";
import { hashDaemonPassword } from "../auth.js";
import { DeviceRegistry } from "../pairing/device-registry.js";
import { loadOrCreateDaemonKeyPair } from "../daemon-keypair.js";
import { getOrCreateServerId } from "../server-id.js";
import { isRouteAudience } from "../websocket-server.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";

// FU-746: a paired device signs in on the direct socket with its device key. Scratch daemon, own home.
let daemon: TestPaseoDaemon | null = null;
afterEach(async () => {
  await daemon?.close();
  daemon = null;
});

async function setup(auth?: { password: string }, directDeviceLogin: boolean | null = true) {
  daemon = await createTestPaseoDaemon({
    relayEnabled: false,
    directDeviceLogin: directDeviceLogin ?? undefined,
    logger: (await import("pino")).default({ level: "warn" }),
    ...(auth ? { auth: { password: hashDaemonPassword(auth.password) } } : {}),
  });
  const serverId = getOrCreateServerId(daemon.paseoHome);
  const daemonPublicKeyB64 = (await loadOrCreateDaemonKeyPair(daemon.paseoHome)).publicKeyB64;
  const deviceKeyPair = generateKeyPair();
  const registry = new DeviceRegistry(daemon.paseoHome);
  const device = registry.add(exportPublicKey(deviceKeyPair.publicKey), "Test phone");
  const client = (key = deviceKeyPair) =>
    new DaemonClient({
      url: `ws://127.0.0.1:${daemon!.port}/ws`,
      clientId: `cid_${Math.random().toString(36).slice(2)}`,
      clientType: "mobile",
      reconnect: { enabled: false },
      connectTimeoutMs: 5000,
      e2ee: {
        enabled: true,
        directDevice: true,
        serverId,
        daemonPublicKeyB64,
        getDeviceKeyPair: async () => key,
      },
    });
  return { serverId, registry, device, client, deviceKeyPair };
}

describe("direct device login", () => {
  test("a paired device connects with its key, no password, and sees the host feature flag", async () => {
    const { client, serverId, device } = await setup({ password: "owner-secret" });
    const c = client();
    await c.connect();
    const info = c.getLastServerInfoMessage();
    expect(info?.serverId).toBe(serverId);
    expect(info?.features?.directDeviceLogin).toBe(true);
    // The device is its own principal, never the owner.
    expect(JSON.stringify(info?.permissions ?? {})).not.toContain("access.manage");
    expect(device.deviceId).toMatch(/^dev_/);
    await c.close();
  });

  test("an unpaired key is refused and cannot pair on a direct socket", async () => {
    const { client } = await setup();
    const c = client(generateKeyPair());
    await expect(c.connect()).rejects.toBeTruthy();
    await c.close();
  });

  test("a revoked device is refused on the direct socket", async () => {
    const { client, registry, device } = await setup();
    const open = client();
    await open.connect();
    await registry.revoke(device.deviceId, () => undefined);
    const again = client();
    await expect(again.connect()).rejects.toBeTruthy();
    await open.close();
    await again.close();
  });

  test("the host password path still works, and a device-protocol socket is not the owner", async () => {
    await setup({ password: "owner-secret" });
    const ok = new DaemonClient({
      url: `ws://127.0.0.1:${daemon!.port}/ws`,
      clientId: "cid_pw",
      clientType: "cli",
      password: "owner-secret",
      reconnect: { enabled: false },
    });
    await ok.connect();
    expect(ok.getLastServerInfoMessage()?.features?.directDeviceLogin).toBe(true);
    await ok.close();
    const bad = new DaemonClient({
      url: `ws://127.0.0.1:${daemon!.port}/ws`,
      clientId: "cid_pw2",
      clientType: "cli",
      reconnect: { enabled: false },
    });
    await expect(bad.connect()).rejects.toBeTruthy();
    await bad.close();
  });

  test("a raw socket that offers the device protocol but sends junk is closed", async () => {
    await setup();
    const ws = new WebSocket(`ws://127.0.0.1:${daemon!.port}/ws`, ["fulcra.device.v1"]);
    const code = await new Promise<number>((resolve) => {
      ws.on("open", () => ws.send("not a handshake"));
      ws.on("close", (c) => resolve(c));
      setTimeout(() => resolve(-1), 20000);
    });
    expect(code).not.toBe(-1);
  }, 30000);

  test("L1: the owner and a paired device get directRoutes; isRouteAudience refuses other principals", async () => {
    const { client } = await setup({ password: "owner-secret" });
    const device = client();
    await device.connect();
    expect(Array.isArray(device.getLastServerInfoMessage()?.directRoutes)).toBe(true);
    await device.close();
    const owner = new DaemonClient({
      url: `ws://127.0.0.1:${daemon!.port}/ws`,
      clientId: "cid_owner",
      clientType: "cli",
      password: "owner-secret",
      reconnect: { enabled: false },
    });
    await owner.connect();
    expect(Array.isArray(owner.getLastServerInfoMessage()?.directRoutes)).toBe(true);
    await owner.close();
    expect(isRouteAudience("owner")).toBe(true);
    expect(isRouteAudience("device:dev_1")).toBe(true);
    for (const other of ["", "plugin:x", "host-link:abc", "route:owner:a:b", "devices:x"])
      expect(isRouteAudience(other)).toBe(false);
  });

  test("L3: the 33rd unadmitted device-protocol upgrade is closed with 1013", async () => {
    await setup();
    const url = `ws://127.0.0.1:${daemon!.port}/ws`;
    const open: WebSocket[] = [];
    try {
      for (let i = 0; i < 32; i++) {
        const ws = new WebSocket(url, ["fulcra.device.v1"]);
        await new Promise<void>((resolve, reject) => {
          ws.once("open", () => resolve());
          ws.once("error", reject);
        });
        open.push(ws);
      }
      const extra = new WebSocket(url, ["fulcra.device.v1"]);
      const code = await new Promise<number>((resolve) => {
        extra.on("close", (c) => resolve(c));
        setTimeout(() => resolve(-1), 10000);
      });
      expect(code).toBe(1013);
      // Closing one frees a slot.
      open.pop()?.close();
      await new Promise((r) => setTimeout(r, 300));
      const again = new WebSocket(url, ["fulcra.device.v1"]);
      const opened = await new Promise<boolean>((resolve) => {
        again.once("open", () => resolve(true));
        again.once("close", () => resolve(false));
      });
      expect(opened).toBe(true);
      again.close();
    } finally {
      for (const ws of open) ws.terminate();
    }
  }, 60000);

  test("L4: with the relay off and no override, device login is off", async () => {
    const { client } = await setup(undefined, null);
    const c = client();
    await expect(c.connect()).rejects.toBeTruthy();
    await c.close();
    const plain = new DaemonClient({
      url: `ws://127.0.0.1:${daemon!.port}/ws`,
      clientId: "cid_plain",
      clientType: "cli",
      reconnect: { enabled: false },
    });
    await plain.connect();
    const info = plain.getLastServerInfoMessage();
    expect(info?.features?.directDeviceLogin).toBeUndefined();
    expect(info?.directRoutes).toBeUndefined();
    await plain.close();
  });
});
