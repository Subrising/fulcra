import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceRegistry } from "./device-registry.js";
import { RelayDeviceGate } from "./relay-device-gate.js";
import { OfferStore } from "./offer-store.js";
const homes: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function setup(pid: number) {
  const home = mkdtempSync(join(tmpdir(), "fulcra-revoke-test-"));
  homes.push(home);
  const registry = new DeviceRegistry(home);
  const device = registry.add(Buffer.alloc(32, 8).toString("base64"), "Test device");
  const lock = join(home, ".pairing.lock");
  mkdirSync(lock);
  writeFileSync(join(lock, `owner-${pid}-test`), "");
  return { home, registry, device, lock };
}
it("closes immediately and denies reconnect across registries while persistence waits", async () => {
  const { home, registry, device, lock } = setup(process.pid);
  const close = vi.fn();
  let pending: unknown;
  expect(() => {
    pending = registry.revoke(device.deviceId, close);
  }).not.toThrow();
  expect(close).toHaveBeenCalledWith(device.deviceId, 4403, "Device unpaired");
  expect(registry.list()).toHaveLength(1);
  const gate = new RelayDeviceGate(new OfferStore(home), new DeviceRegistry(home));
  expect(() => gate.admit(device.publicKeyB64, { type: "hello" })).toThrow("Not paired");
  rmSync(lock, { recursive: true });
  await pending;
  expect(new DeviceRegistry(home).list()).toEqual([]);
});
it("recovers a lock only when its owner PID is dead", async () => {
  const { registry, device, lock } = setup(2147483647);
  await registry.revoke(device.deviceId, vi.fn());
  expect(registry.list()).toEqual([]);
  expect(existsSync(lock)).toBe(false);
});
it("never steals a live owner's lock and retains denial after bounded retry expires", async () => {
  vi.useFakeTimers();
  const { home, registry, device, lock } = setup(process.pid);
  const close = vi.fn();
  let pending: unknown;
  expect(() => {
    pending = registry.revoke(device.deviceId, close);
  }).not.toThrow();
  const rejected = expect(pending).rejects.toThrow("Pairing lock busy");
  await vi.advanceTimersByTimeAsync(2000);
  await rejected;
  expect(close).toHaveBeenCalledOnce();
  expect(existsSync(lock)).toBe(true);
  const gate = new RelayDeviceGate(new OfferStore(home), new DeviceRegistry(home));
  expect(() => gate.admit(device.publicKeyB64, { type: "hello" })).toThrow("Not paired");
});

it("allows invites only when set, per device, and never for a revoked device", async () => {
  const home = mkdtempSync(join(tmpdir(), "fulcra-invite-test-"));
  homes.push(home);
  const registry = new DeviceRegistry(home);
  const a = registry.add(Buffer.alloc(32, 1).toString("base64"), "Phone");
  const b = registry.add(Buffer.alloc(32, 2).toString("base64"), "Mac app");
  expect(registry.canInvite(a.deviceId)).toBe(false);
  registry.setInvites(b.deviceId, true);
  expect(new DeviceRegistry(home).canInvite(b.deviceId)).toBe(true);
  expect(registry.canInvite(a.deviceId)).toBe(false);
  expect(registry.list().find((d) => d.deviceId === b.deviceId)?.permissions).not.toContain(
    "access.manage",
  );
  registry.setInvites(b.deviceId, false);
  expect(registry.canInvite(b.deviceId)).toBe(false);
  registry.setInvites(b.deviceId, true);
  await registry.revoke(b.deviceId, vi.fn());
  expect(registry.canInvite(b.deviceId)).toBe(false);
  expect(() => registry.setInvites("dev_AAAAAAAAAAAAAAAA", true)).toThrow("No such paired device");
});

it("keeps Command Centre stripped unless the owner granted it, and removes the grant before writing", async () => {
  const home = mkdtempSync(join(tmpdir(), "fulcra-grant-test-"));
  homes.push(home);
  const registry = new DeviceRegistry(home);
  const device = registry.add(Buffer.alloc(32, 9).toString("base64"), "Phone");
  expect(registry.hasCommandCentre(device.deviceId)).toBe(false);
  expect(registry.list()[0].permissions).not.toContain("command-centre.manage");

  const opened = vi.fn();
  await registry.setCommandCentre(device.deviceId, true, opened);
  expect(opened).toHaveBeenCalledWith(device.deviceId, 4012, "Command Centre access granted");
  expect(registry.list()[0].permissions).toEqual(
    expect.arrayContaining(["command-centre.manage", "daemon.manage"]),
  );
  expect(registry.list()[0].permissions).not.toContain("access.manage");

  // Removal: refused and closed before the store changes.
  const lock = join(home, ".pairing.lock");
  mkdirSync(lock);
  writeFileSync(join(lock, `owner-${process.pid}-test`), "");
  const closed = vi.fn();
  const removing = registry.setCommandCentre(device.deviceId, false, closed);
  expect(closed).toHaveBeenCalledWith(device.deviceId, 4012, "Command Centre access removed");
  expect(new DeviceRegistry(home).hasCommandCentre(device.deviceId)).toBe(false);
  rmSync(lock, { recursive: true, force: true });
  await removing;
  expect(registry.list()[0].permissions).not.toContain("command-centre.manage");
});

it("D13: a read-only grant keeps exactly the read permissions, adds no management, and a full grant restores the defaults", async () => {
  const home = mkdtempSync(join(tmpdir(), "fulcra-read-tier-"));
  homes.push(home);
  const registry = new DeviceRegistry(home);
  const device = registry.add(Buffer.alloc(32, 7).toString("base64"), "Test device");
  const close = vi.fn();
  await registry.setCommandCentre(device.deviceId, true, close, true);
  expect(close).toHaveBeenCalledWith(device.deviceId, 4012, "Command Centre access granted");
  expect(registry.list()[0].permissions.sort()).toEqual(["daemon.read", "workspace.read"]);
  expect(registry.hasCommandCentre(device.deviceId)).toBe(true);
  expect(registry.hasReadOnlyCommandCentre(device.deviceId)).toBe(true);
  // A full grant restores the default device permissions (and management), and is no longer read-only.
  await registry.setCommandCentre(device.deviceId, true, close);
  expect(registry.hasReadOnlyCommandCentre(device.deviceId)).toBe(false);
  expect(registry.list()[0].permissions).toEqual(
    expect.arrayContaining(["command-centre.manage", "daemon.manage", "workspace.write"]),
  );
  // Back to read-only, then the grant removed: the read permissions stay (least privilege survives the removal).
  await registry.setCommandCentre(device.deviceId, true, close, true);
  await registry.setCommandCentre(device.deviceId, false, close);
  expect(registry.hasCommandCentre(device.deviceId)).toBe(false);
  expect(registry.list()[0].permissions.sort()).toEqual(["daemon.read", "workspace.read"]);
});

// ---- U7: accounts.manage ---------------------------------------------------------------------------------------
it("accounts-manage: existing paired devices start without it (upgrade)", () => {
  const home = mkdtempSync(join(tmpdir(), "fulcra-accounts-upgrade-"));
  homes.push(home);
  // A store written before U7: one full Command Centre device, one read-only, one plain; a stray permission string
  // in the stored array must not count as the grant.
  const device = (n: number, extra: object) => ({
    deviceId: `dev_${String(n).repeat(16)}`,
    publicKeyB64: Buffer.alloc(32, n).toString("base64"),
    name: `Device ${n}`,
    createdAt: "2026-09-29T00:00:00.000Z",
    lastSeenAt: null,
    permissions: ["daemon.read", "daemon.manage", "workspace.read", "accounts.manage"],
    ...extra,
  });
  writeFileSync(
    join(home, "paired-devices.json"),
    JSON.stringify({
      v: 1,
      devices: [
        device(1, { commandCentre: true }),
        device(2, { commandCentre: true, readOnly: true }),
        device(3, {}),
      ],
    }),
  );
  const registry = new DeviceRegistry(home);
  for (const d of registry.list()) {
    expect(d.permissions).not.toContain("accounts.manage");
    expect(registry.hasAccountsManage(d.deviceId)).toBe(false);
    expect(d).not.toHaveProperty("accountsManage");
  }
});

it("accounts-manage: only the owner's explicit grant sets it, on a full Command Centre grant; revoke and removal clear it", async () => {
  const home = mkdtempSync(join(tmpdir(), "fulcra-accounts-grant-"));
  homes.push(home);
  const registry = new DeviceRegistry(home);
  const device = registry.add(Buffer.alloc(32, 6).toString("base64"), "Phone");
  const close = vi.fn();
  // Not without Command Centre, and never on the read-only tier.
  await expect(registry.setAccountsManage(device.deviceId, true, close)).rejects.toThrow(
    "Allow Command Centre for this device first",
  );
  await registry.setCommandCentre(device.deviceId, true, close, true);
  await expect(registry.setAccountsManage(device.deviceId, true, close)).rejects.toThrow(
    "Allow Command Centre for this device first",
  );
  // A full Command Centre grant alone does not include it.
  await registry.setCommandCentre(device.deviceId, true, close);
  expect(registry.list()[0].permissions).not.toContain("accounts.manage");
  close.mockClear();
  await registry.setAccountsManage(device.deviceId, true, close);
  expect(close).toHaveBeenCalledWith(device.deviceId, 4012, "Account management allowed");
  expect(registry.hasAccountsManage(device.deviceId)).toBe(true);
  expect(registry.list()[0].permissions).toContain("accounts.manage");
  expect(registry.list()[0].accountsManage).toBe(true);
  // Revoke: refused and closed first.
  close.mockClear();
  await registry.setAccountsManage(device.deviceId, false, close);
  expect(close).toHaveBeenCalledWith(device.deviceId, 4012, "Account management removed");
  expect(registry.hasAccountsManage(device.deviceId)).toBe(false);
  expect(registry.list()[0].permissions).not.toContain("accounts.manage");
  // Removing (or narrowing to read-only) Command Centre clears it; granting Command Centre again does not restore it.
  await registry.setAccountsManage(device.deviceId, true, close);
  await registry.setCommandCentre(device.deviceId, false, close);
  await registry.setCommandCentre(device.deviceId, true, close);
  expect(registry.hasAccountsManage(device.deviceId)).toBe(false);
  await registry.setAccountsManage(device.deviceId, true, close);
  await registry.setCommandCentre(device.deviceId, true, close, true);
  expect(registry.hasAccountsManage(device.deviceId)).toBe(false);
  expect(registry.list()[0].permissions).not.toContain("accounts.manage");
});
