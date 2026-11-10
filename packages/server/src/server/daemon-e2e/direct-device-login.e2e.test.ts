import { afterEach, describe, expect, test, vi } from "vitest";
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

async function setup(
  auth?: { password: string },
  directDeviceLogin: boolean | null = true,
  relayEnabled = false,
) {
  daemon = await createTestPaseoDaemon({
    relayEnabled,
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

  test("D2: a direct device without the Command Centre grant has no Command Centre permission; with it, it has", async () => {
    const { client, registry, device } = await setup({ password: "owner-secret" });
    const off = client();
    await off.connect();
    const offPermissions = JSON.stringify(off.getLastServerInfoMessage()?.permissions ?? []);
    // Sessions and chat work: the device still holds its default permissions.
    expect(offPermissions).not.toBe("[]");
    expect(offPermissions).not.toContain("command-centre.manage");
    await off.close();

    await registry.setCommandCentre(device.deviceId, true, () => {});
    const on = client();
    await on.connect();
    expect(JSON.stringify(on.getLastServerInfoMessage()?.permissions ?? [])).toContain(
      "command-centre.manage",
    );
    await on.close();
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

  test("N2: turning the relay off closes live direct device sessions and refuses new ones", async () => {
    const { client } = await setup({ password: "owner-secret" }, null, true);
    const device = client();
    await device.connect();
    const owner = new DaemonClient({
      url: `ws://127.0.0.1:${daemon!.port}/ws`,
      clientId: "cid_owner_toggle",
      clientType: "cli",
      password: "owner-secret",
      reconnect: { enabled: false },
    });
    await owner.connect();
    await owner.patchDaemonConfig({ relay: { enabled: false } });
    await vi.waitFor(() => expect(device.getConnectionState().status).not.toBe("connected"), {
      timeout: 10000,
    });
    const refused = client();
    await expect(refused.connect()).rejects.toBeTruthy();
    await refused.close();
    // Turning it back on lets a device in again.
    await owner.patchDaemonConfig({ relay: { enabled: true } });
    const again = client();
    await again.connect();
    expect(again.getLastServerInfoMessage()?.features?.directDeviceLogin).toBe(true);
    await again.close();
    await device.close();
    await owner.close();
  }, 60000);

  test("L4: the override wins in both directions", async () => {
    const off = await setup(undefined, false, true);
    const refused = off.client();
    await expect(refused.connect()).rejects.toBeTruthy();
    await refused.close();
    await daemon?.close();
    daemon = null;
    const on = await setup(undefined, true, false);
    const ok = on.client();
    await ok.connect();
    expect(ok.getLastServerInfoMessage()?.features?.directDeviceLogin).toBe(true);
    await ok.close();
  }, 60000);

  test("L3: an admitted device frees its slot", async () => {
    const { client } = await setup();
    const url = `ws://127.0.0.1:${daemon!.port}/ws`;
    const raw: WebSocket[] = [];
    const openRaw = async () => {
      const ws = new WebSocket(url, ["fulcra.device.v1"]);
      const opened = await new Promise<boolean>((resolve) => {
        ws.once("open", () => resolve(true));
        ws.once("close", () => resolve(false));
      });
      if (opened) raw.push(ws);
      return { ws, opened };
    };
    try {
      for (let i = 0; i < 31; i++) expect((await openRaw()).opened).toBe(true);
      const admitted = client();
      await admitted.connect(); // 32nd, admitted: its slot is released at once
      const last = await openRaw(); // would close with 1013 if the admitted slot leaked
      await new Promise((r) => setTimeout(r, 700));
      expect(last.ws.readyState).toBe(WebSocket.OPEN);
      // An upgrade always opens first; a refusal shows as a 1013 close right after.
      const over = await openRaw();
      const code = await new Promise<number>((resolve) => {
        over.ws.once("close", (c) => resolve(c));
        setTimeout(() => resolve(-1), 3000);
      });
      expect(code).toBe(1013);
      await admitted.close();
    } finally {
      for (const ws of raw) ws.terminate();
    }
  }, 60000);
});
