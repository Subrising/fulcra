import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OfferStore } from "./offer-store.js";
import { DeviceRegistry } from "./device-registry.js";
import { RelayDeviceGate } from "./relay-device-gate.js";
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function setup() {
  const home = mkdtempSync(join(tmpdir(), "fulcra-gate-test-"));
  homes.push(home);
  const offers = new OfferStore(home);
  const registry = new DeviceRegistry(home);
  return { offers, registry, gate: new RelayDeviceGate(offers, registry) };
}
it("refuses anonymous devices and reused screenshot offers", () => {
  const { offers, gate } = setup();
  const key = Buffer.alloc(32, 1).toString("base64");
  expect(() => gate.admit(key, { type: "hello" })).toThrow("Not paired");
  const offer = offers.mint();
  const frame = {
    type: "pairing.claim",
    offerId: offer.id,
    secret: offer.secret,
    deviceName: "Test phone",
  };
  const result = gate.admit(key, frame);
  expect(result.admission.principalId).toMatch(/^device:dev_/);
  expect(result.admission.permissions).toContain("daemon.manage");
  expect(result.admission.permissions).not.toContain("access.manage");
  expect(result.admission.permissions).not.toContain("command-centre.manage");
  expect(() => gate.admit(Buffer.alloc(32, 2).toString("base64"), frame)).toThrow("Not paired");
});
it("revokes a device and synchronously closes its sockets before returning", async () => {
  const { offers, registry, gate } = setup();
  const offer = offers.mint();
  const key = Buffer.alloc(32, 3).toString("base64");
  const { admission } = gate.admit(key, {
    type: "pairing.claim",
    offerId: offer.id,
    secret: offer.secret,
    deviceName: "Phone",
  });
  const close = vi.fn();
  const persisted = registry.revoke(admission.deviceId, close);
  expect(close).toHaveBeenCalledWith(admission.deviceId, 4403, "Device unpaired");
  expect(() => gate.admit(key, { type: "hello" })).toThrow("Not paired");
  await persisted;
});

it("strips forbidden permissions even from an altered registry", () => {
  const { registry } = setup();
  const record = registry.add(Buffer.alloc(32, 4).toString("base64"), "Phone");
  const file = join(homes[homes.length - 1], "paired-devices.json");
  const stored = JSON.parse(readFileSync(file, "utf8"));
  stored.devices[0].permissions.push("command-centre.manage", "access.manage");
  writeFileSync(file, JSON.stringify(stored));
  expect(registry.find(record.publicKeyB64)?.permissions).not.toContain("command-centre.manage");
  expect(registry.find(record.publicKeyB64)?.permissions).not.toContain("access.manage");
});

it("junk first frames do not exhaust the well-formed claim budget", () => {
  const { offers, gate } = setup();
  const key = Buffer.alloc(32, 6).toString("base64");
  for (let i = 0; i < 20; i++)
    expect(() => gate.admit(key, { type: "hello" })).toThrow("Not paired");
  const offer = offers.mint();
  expect(
    gate.admit(key, {
      type: "pairing.claim",
      offerId: offer.id,
      secret: offer.secret,
      deviceName: "Test phone",
    }).claimed,
  ).toBe(true);
});
it("well-formed wrong claims still exhaust the attempt budget", () => {
  const { offers, gate } = setup();
  const key = Buffer.alloc(32, 7).toString("base64");
  const offer = offers.mint();
  const frame = {
    type: "pairing.claim",
    offerId: offer.id,
    secret: "A".repeat(43),
    deviceName: "Test phone",
  };
  for (let i = 0; i < 10; i++) expect(() => gate.admit(key, frame)).toThrow("Not paired");
  expect(() => gate.admit(key, { ...frame, secret: offer.secret })).toThrow("Not paired");
});

// L46 option 5: Command Centre over the relay is per device, off at pairing, and per socket.
it("gives paired-device authentication only to a device the owner granted, never at pairing", async () => {
  const { offers, registry, gate } = setup();
  const offer = offers.mint();
  const key = Buffer.alloc(32, 5).toString("base64");
  const claimed = gate.admit(key, {
    type: "pairing.claim",
    offerId: offer.id,
    secret: offer.secret,
    deviceName: "Phone",
  });
  expect(claimed.admission).not.toHaveProperty("authentication");
  expect(claimed.admission.permissions).not.toContain("command-centre.manage");
  expect(gate.admit(key, { type: "hello" }).admission).not.toHaveProperty("authentication");

  const deviceId = claimed.admission.deviceId;
  await registry.setCommandCentre(deviceId, true, () => {});
  const granted = gate.admit(key, { type: "hello" }).admission;
  expect(granted).toMatchObject({
    principalId: `device:${deviceId}`,
    authentication: { id: `device:${deviceId}`, authentication: "paired-device", deviceId },
  });
  expect(granted.permissions).toEqual(
    expect.arrayContaining(["command-centre.manage", "daemon.manage"]),
  );
  expect(granted.permissions).not.toContain("access.manage");

  await registry.setCommandCentre(deviceId, false, () => {});
  expect(gate.admit(key, { type: "hello" }).admission).not.toHaveProperty("authentication");
});

it("accounts-manage: a device holds accounts.manage only while the owner's grant stands", async () => {
  const { offers, registry, gate } = setup();
  const offer = offers.mint();
  const key = Buffer.alloc(32, 4).toString("base64");
  const deviceId = gate.admit(key, {
    type: "pairing.claim",
    offerId: offer.id,
    secret: offer.secret,
    deviceName: "Phone",
  }).admission.deviceId;
  await registry.setCommandCentre(deviceId, true, () => {});
  expect(gate.admit(key, { type: "hello" }).admission.permissions).not.toContain("accounts.manage");
  await registry.setAccountsManage(deviceId, true, () => {});
  expect(gate.admit(key, { type: "hello" }).admission.permissions).toContain("accounts.manage");
  await registry.setAccountsManage(deviceId, false, () => {});
  expect(gate.admit(key, { type: "hello" }).admission.permissions).not.toContain("accounts.manage");
});
