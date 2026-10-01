import { readDaemonInstance } from "../daemon-instance.js";
import { DeviceRegistry } from "./device-registry.js";
export async function revokeOfflineDevice(home: string, deviceId: string): Promise<void> {
  if (!/^dev_[A-Za-z0-9_-]{16}$/.test(deviceId)) throw new Error("Invalid device ID");
  if (await readDaemonInstance(home)) throw new Error("Stop this daemon before revoking offline");
  await new DeviceRegistry(home).revoke(deviceId, () => {});
}
