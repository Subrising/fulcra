import { z } from "zod";
import { importPublicKey } from "@getpaseo/relay/e2ee";
import type { DeviceRegistry } from "./device-registry.js";
import type { DaemonPermission } from "../authorization/index.js";
import type { OfferStore } from "./offer-store.js";
const claim = z
  .object({
    type: z.literal("pairing.claim"),
    offerId: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
    secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    deviceName: z.string().min(1).max(64),
  })
  .strict();
export class RelayDeviceGate {
  private failures = 0;
  private minute = 0;
  constructor(
    private readonly offers: OfferStore,
    private readonly registry: DeviceRegistry,
  ) {}
  admit(devicePublicKeyB64: string, firstFrame: unknown) {
    importPublicKey(devicePublicKeyB64);
    let record = this.registry.find(devicePublicKeyB64);
    if (record && this.registry.isRevoked(record.deviceId)) throw new Error("Not paired");
    let claimed = false;
    if (
      !record ||
      (typeof firstFrame === "object" &&
        firstFrame !== null &&
        "type" in firstFrame &&
        firstFrame.type === "pairing.claim")
    ) {
      const minute = Math.floor(Date.now() / 60000);
      if (minute !== this.minute) {
        this.minute = minute;
        this.failures = 0;
      }
      const parsed = claim.safeParse(firstFrame);
      if (!parsed.success) throw new Error("Not paired");
      if (this.failures >= 10 || !this.offers.claim(parsed.data.offerId, parsed.data.secret)) {
        this.failures++;
        throw new Error("Not paired");
      }
      record ??= this.registry.add(devicePublicKeyB64, parsed.data.deviceName);
      claimed = true;
    }
    const principalId = `device:${record.deviceId}`;
    // The E2EE handshake proved this socket holds the device's pairing key. Only a device this Mac's owner granted
    // Command Centre gets paired-device authentication, and only on this socket's admission; a device that has
    // just paired (claimed) never has the grant.
    const granted = !claimed && this.registry.hasCommandCentre(record.deviceId);
    // U7: account management only while the owner's separate grant stands (read fresh, like Command Centre).
    const accounts = granted && this.registry.hasAccountsManage(record.deviceId);
    const permissions: DaemonPermission[] = (record.permissions as DaemonPermission[]).filter(
      (p) => (granted || p !== "command-centre.manage") && (accounts || p !== "accounts.manage"),
    );
    return {
      claimed,
      admission: {
        principalId,
        deviceId: record.deviceId,
        permissions,
        ...(granted
          ? {
              authentication: {
                id: principalId,
                authentication: "paired-device" as const,
                deviceId: record.deviceId,
              },
            }
          : {}),
      },
    };
  }
}
