import path from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  RELAY_DEVICE_DEFAULT_PERMISSIONS,
  parseDaemonPermissions,
  type DaemonPermission,
} from "../authorization/index.js";
import { readStore, withPairingLock, withPairingLockRetry, writeStore } from "./file-store.js";
const filename = "paired-devices.json";
/** Access changed (a grant was added or removed): the device reconnects and is admitted afresh. Not a pairing loss. */
export const WS_CLOSE_ACCESS_CHANGED = 4012;
const record = z.object({
  deviceId: z.string().regex(/^dev_[A-Za-z0-9_-]{16}$/),
  publicKeyB64: z.string(),
  name: z.string().max(64),
  createdAt: z.string().datetime(),
  lastSeenAt: z.string().datetime().nullable(),
  permissions: z.array(z.string()),
  // Pair once, see every Mac: this Mac's owner allowed the device to request invites for new devices.
  invites: z.boolean().optional(),
  // L46 option 5: this Mac's owner allowed the device to use Command Centre over the relay. Never set at pairing.
  commandCentre: z.boolean().optional(),
  // D13: the grant is read-only -- stored permissions are exactly READ_DEVICE_PERMISSIONS and no management is added.
  readOnly: z.boolean().optional(),
  // U7: this Mac's owner allowed the device to manage accounts. Only on a full Command Centre grant; never at pairing.
  accountsManage: z.boolean().optional(),
});
const schema = z.object({ v: z.literal(1), devices: z.array(record).max(32) });
// RPC handlers and the relay gate construct separate instances for the same home.
const revokedByHome = new Map<string, Set<string>>();
// Command Centre grants being removed: refused in memory before sockets close and before the store is written.
// Per process, by design: only the daemon process holds relay sockets and admits them (its relay gate and every
// registry instance share this map). Another process on the same home, such as the CLI's offline revoke, never
// admits a relay socket, and it sees the removal once the store is written moments later.
const grantSuspendedByHome = new Map<string, Set<string>>();
// U7: account-management grants being removed, refused in memory first (as grantSuspendedByHome).
const accountsSuspendedByHome = new Map<string, Set<string>>();
/** U7: never stored in a device's permission list; added by list() only for the owner's explicit grant. */
const GRANTED_ONLY: ReadonlySet<string> = new Set([
  "command-centre.manage",
  "access.manage",
  "accounts.manage",
]);
/** What a Command Centre grant adds to a device (management needs both). Never access.manage. */
export const COMMAND_CENTRE_GRANT: readonly DaemonPermission[] = [
  "command-centre.manage",
  "daemon.manage",
];
/** D13: what a read-only device holds. Command Centre reads need nothing more (the daemon enforces reads only). */
export const READ_DEVICE_PERMISSIONS: readonly DaemonPermission[] = [
  "workspace.read",
  "daemon.read",
];
export class DeviceRegistry {
  private get revoked(): Set<string> {
    const home = path.resolve(this.home);
    let ids = revokedByHome.get(home);
    if (!ids) {
      ids = new Set();
      revokedByHome.set(home, ids);
    }
    return ids;
  }
  isRevoked(deviceId: string): boolean {
    return this.revoked.has(deviceId);
  }
  private get grantSuspended(): Set<string> {
    const home = path.resolve(this.home);
    let ids = grantSuspendedByHome.get(home);
    if (!ids) {
      ids = new Set();
      grantSuspendedByHome.set(home, ids);
    }
    return ids;
  }
  private get accountsSuspended(): Set<string> {
    const home = path.resolve(this.home);
    let ids = accountsSuspendedByHome.get(home);
    if (!ids) {
      ids = new Set();
      accountsSuspendedByHome.set(home, ids);
    }
    return ids;
  }
  constructor(private readonly home: string) {}
  /** The stored records, with management permissions always stripped. Writes use this, never list(). */
  private stored() {
    return schema.parse(readStore(this.home, filename) ?? { v: 1, devices: [] }).devices.map((d) =>
      // The parsed record is a fresh object; assigning keeps its key order and the result unchanged.
      Object.assign(d, {
        permissions: parseDaemonPermissions(d.permissions).filter(
          (p) => !GRANTED_ONLY.has(p),
        ) as DaemonPermission[],
      }),
    );
  }
  /** D13: whether a paired, unrevoked device holds the READ-ONLY Command Centre grant right now. */
  hasReadOnlyCommandCentre(deviceId: string): boolean {
    return (
      !this.isRevoked(deviceId) &&
      !this.grantSuspended.has(deviceId) &&
      this.stored().some(
        (d) => d.deviceId === deviceId && d.commandCentre === true && d.readOnly === true,
      )
    );
  }
  /** Whether a paired, unrevoked device holds the Command Centre grant right now. */
  hasCommandCentre(deviceId: string): boolean {
    return (
      !this.isRevoked(deviceId) &&
      !this.grantSuspended.has(deviceId) &&
      this.stored().some((d) => d.deviceId === deviceId && d.commandCentre === true)
    );
  }
  /** U7: whether a paired, unrevoked device holds the owner's account-management grant right now. */
  hasAccountsManage(deviceId: string): boolean {
    return (
      this.hasCommandCentre(deviceId) &&
      !this.accountsSuspended.has(deviceId) &&
      this.stored().some(
        (d) =>
          d.deviceId === deviceId &&
          d.commandCentre === true &&
          d.readOnly !== true &&
          d.accountsManage === true,
      )
    );
  }
  /**
   * Every paired device with its effective permissions: management stays stripped except for a device this Mac's
   * owner granted Command Centre (and whose grant is not being removed).
   */
  list() {
    return this.stored().map((d) => {
      if (
        d.commandCentre !== true ||
        d.readOnly === true ||
        this.isRevoked(d.deviceId) ||
        this.grantSuspended.has(d.deviceId)
      )
        return d;
      const granted = new Set<DaemonPermission>([...d.permissions, ...COMMAND_CENTRE_GRANT]);
      if (d.accountsManage === true && !this.accountsSuspended.has(d.deviceId))
        granted.add("accounts.manage");
      return Object.assign(d, { permissions: [...granted] });
    });
  }
  find(key: string) {
    return this.list().find((d) => d.publicKeyB64 === key);
  }
  add(publicKeyB64: string, name: string) {
    return withPairingLock(this.home, () => {
      const devices = this.stored();
      if (devices.length >= 32) throw new Error("Device limit reached");
      if (devices.some((d) => d.publicKeyB64 === publicKeyB64))
        throw new Error("Device already paired");
      const device = {
        deviceId: `dev_${randomBytes(12).toString("base64url")}`,
        publicKeyB64,
        name: name.slice(0, 64),
        createdAt: new Date().toISOString(),
        lastSeenAt: null,
        permissions: [...RELAY_DEVICE_DEFAULT_PERMISSIONS],
      };
      devices.push(device);
      writeStore(this.home, filename, { v: 1, devices });
      return device;
    });
  }
  /** Whether a paired, unrevoked device may request pairing invites for new devices. Off unless set here. */
  canInvite(deviceId: string): boolean {
    return (
      !this.isRevoked(deviceId) &&
      this.list().some((d) => d.deviceId === deviceId && d.invites === true)
    );
  }
  setInvites(deviceId: string, allow: boolean): void {
    withPairingLock(this.home, () => {
      const devices = this.stored();
      const device = devices.find((d) => d.deviceId === deviceId);
      if (!device) throw new Error("No such paired device");
      if (allow) device.invites = true;
      else delete device.invites;
      writeStore(this.home, filename, { v: 1, devices });
    });
  }
  /**
   * Turns the device's Command Centre grant on or off. Removal is revocation first: the grant is refused in memory,
   * then the device's sockets are closed (they reconnect without it), and only then is the store written. Turning it
   * on also closes them, so the new authority only ever arrives with a fresh per-socket admission.
   */
  async setCommandCentre(
    deviceId: string,
    allow: boolean,
    close: (deviceId: string, code: number, reason: string) => void,
    readOnly = false,
  ): Promise<void> {
    if (!this.stored().some((d) => d.deviceId === deviceId) || this.isRevoked(deviceId))
      throw new Error("No such paired device");
    if (!allow) {
      this.grantSuspended.add(deviceId);
      close(deviceId, WS_CLOSE_ACCESS_CHANGED, "Command Centre access removed");
    }
    try {
      await withPairingLockRetry(this.home, () => {
        const devices = this.stored();
        const device = devices.find((d) => d.deviceId === deviceId);
        if (!device) throw new Error("No such paired device");
        if (allow) device.commandCentre = true;
        else delete device.commandCentre;
        // U7: account management rides on a full grant; removing or narrowing it clears it, and a later grant does
        // not bring it back without the owner allowing it again.
        if (!allow || readOnly) delete device.accountsManage;
        // D13: a read-only grant keeps exactly the read permissions (least privilege survives a later removal); a
        // full grant restores the defaults.
        if (allow && readOnly) {
          device.readOnly = true;
          device.permissions = [...READ_DEVICE_PERMISSIONS];
        } else if (allow) {
          if (device.readOnly) device.permissions = [...RELAY_DEVICE_DEFAULT_PERMISSIONS];
          delete device.readOnly;
        }
        writeStore(this.home, filename, { v: 1, devices });
      });
    } finally {
      // Stay refused while the store might still say "granted"; on success it no longer does.
      if (!allow && !this.stored().some((d) => d.deviceId === deviceId && d.commandCentre === true))
        this.grantSuspended.delete(deviceId);
    }
    if (allow) close(deviceId, WS_CLOSE_ACCESS_CHANGED, "Command Centre access granted");
  }

  /**
   * U7: turns the device's account-management grant on or off (owner only; the caller checks). Needs a full, not
   * read-only, Command Centre grant. As setCommandCentre: removal is refused in memory and the device's sockets are
   * closed before the store is written; granting also closes them, so the new authority arrives with a fresh admission.
   */
  async setAccountsManage(
    deviceId: string,
    allow: boolean,
    close: (deviceId: string, code: number, reason: string) => void,
  ): Promise<void> {
    const current = this.stored().find((d) => d.deviceId === deviceId);
    if (!current || this.isRevoked(deviceId)) throw new Error("No such paired device");
    if (allow && (current.commandCentre !== true || current.readOnly === true))
      throw new Error("Allow Command Centre for this device first");
    if (!allow) {
      this.accountsSuspended.add(deviceId);
      close(deviceId, WS_CLOSE_ACCESS_CHANGED, "Account management removed");
    }
    try {
      await withPairingLockRetry(this.home, () => {
        const devices = this.stored();
        const device = devices.find((d) => d.deviceId === deviceId);
        if (!device) throw new Error("No such paired device");
        if (allow && (device.commandCentre !== true || device.readOnly === true))
          throw new Error("Allow Command Centre for this device first");
        if (allow) device.accountsManage = true;
        else delete device.accountsManage;
        writeStore(this.home, filename, { v: 1, devices });
      });
    } finally {
      if (
        !allow &&
        !this.stored().some((d) => d.deviceId === deviceId && d.accountsManage === true)
      )
        this.accountsSuspended.delete(deviceId);
    }
    if (allow) close(deviceId, WS_CLOSE_ACCESS_CHANGED, "Account management allowed");
  }

  async revoke(
    deviceId: string,
    close: (deviceId: string, code: number, reason: string) => void,
  ): Promise<void> {
    // Fail closed in memory before callbacks, awaits or disk access. Keep the
    // tombstone on persistence failure; an owner can retry without reopening it.
    this.revoked.add(deviceId);
    close(deviceId, 4403, "Device unpaired");
    await withPairingLockRetry(this.home, () => {
      writeStore(this.home, filename, {
        v: 1,
        devices: this.stored().filter((d) => d.deviceId !== deviceId),
      });
    });
  }
}
