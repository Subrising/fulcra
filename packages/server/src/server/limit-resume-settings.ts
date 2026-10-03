import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { writePrivateFileAtomicSync } from "./private-files.js";

const MAX_SETTINGS_BYTES = 1024;
const SettingsSchema = z.object({ v: z.literal(1), enabled: z.boolean() }).strict();

export function limitResumeSettingsPath(paseoHome: string): string {
  return path.join(paseoHome, "limit-resume", "settings.json");
}

/** Missing alone means no saved preference. Invalid/future/unreadable input never enables resume. */
export function readLimitResumeSetting(paseoHome: string): boolean | undefined {
  let fd: number;
  try {
    fd = openSync(
      limitResumeSettingsPath(paseoHome),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("[Config] Cannot read usage-limit resume preference", { cause: error });
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_SETTINGS_BYTES)
      throw new Error("Invalid settings file");
    const buffer = Buffer.alloc(MAX_SETTINGS_BYTES + 1);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    if (bytes > MAX_SETTINGS_BYTES) throw new Error("Settings file too large");
    return SettingsSchema.parse(JSON.parse(buffer.subarray(0, bytes).toString("utf8"))).enabled;
  } catch (error) {
    throw new Error("[Config] Invalid usage-limit resume preference", { cause: error });
  } finally {
    closeSync(fd);
  }
}

/** One bounded private atomic write; this preference must never enter old binaries' config.json. */
export function writeLimitResumeSetting(paseoHome: string, enabled: boolean): void {
  const value = SettingsSchema.parse({ v: 1, enabled });
  writePrivateFileAtomicSync(limitResumeSettingsPath(paseoHome), `${JSON.stringify(value)}\n`);
}
