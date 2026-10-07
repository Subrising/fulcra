import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { writePrivateFileAtomicSync } from "./private-files.js";

export type NotificationMode = "all" | "primes" | "off";

const MAX_SETTINGS_BYTES = 1024;
const SettingsSchema = z
  .object({ v: z.literal(1), mode: z.enum(["all", "primes", "off"]) })
  .strict();

export function notificationSettingsPath(paseoHome: string): string {
  return path.join(paseoHome, "notifications", "settings.json");
}

/** Missing alone means no saved preference. Invalid/future/unreadable input refuses instead of inventing a policy. */
export function readNotificationSetting(paseoHome: string): NotificationMode | undefined {
  let fd: number;
  try {
    fd = openSync(
      notificationSettingsPath(paseoHome),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("[Config] Cannot read notification preference", { cause: error });
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_SETTINGS_BYTES)
      throw new Error("Invalid settings file");
    const buffer = Buffer.alloc(MAX_SETTINGS_BYTES + 1);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    if (bytes > MAX_SETTINGS_BYTES) throw new Error("Settings file too large");
    return SettingsSchema.parse(JSON.parse(buffer.subarray(0, bytes).toString("utf8"))).mode;
  } catch (error) {
    throw new Error("[Config] Invalid notification preference", { cause: error });
  } finally {
    closeSync(fd);
  }
}

/** One bounded private atomic write; this preference must never enter old binaries' config.json. */
export function writeNotificationSetting(paseoHome: string, mode: NotificationMode): void {
  const value = SettingsSchema.parse({ v: 1, mode });
  writePrivateFileAtomicSync(notificationSettingsPath(paseoHome), `${JSON.stringify(value)}\n`);
}
