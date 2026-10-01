import { expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const instance = vi.hoisted(() => vi.fn());
vi.mock("../daemon-instance.js", () => ({ readDaemonInstance: instance }));
import { DeviceRegistry } from "./device-registry.js";
import { revokeOfflineDevice } from "./revoke-offline.js";
it("offline revoke edits only a stopped local registry", async () => {
  const home = mkdtempSync(join(tmpdir(), "fulcra-offline-revoke-"));
  try {
    const registry = new DeviceRegistry(home);
    const device = registry.add(Buffer.alloc(32, 9).toString("base64"), "Test device");
    instance.mockResolvedValue({ pid: process.pid });
    await expect(revokeOfflineDevice(home, device.deviceId)).rejects.toThrow("Stop this daemon");
    expect(registry.list()).toHaveLength(1);
    instance.mockResolvedValue(null);
    await revokeOfflineDevice(home, device.deviceId);
    expect(registry.list()).toEqual([]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
