import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import path from "node:path";

// Boot succession for the owned controller's seat sweep (W1 row 9, H7b part ii). Every boot records itself before
// it admits any input; what it replaces is the boot that ran immediately before it. The controller distribution
// uses that to chain its per-boot records, so a boot that left no clean-exit seal breaks the chain. Evidence only:
// no admission path reads or writes it.
const BOOT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const DAEMON_BOOT_FILE = "daemon-boot.json";

/** Records `boot` and returns the boot it replaced, or null when that cannot be established. */
export function recordDaemonBoot(paseoHome: string, boot: string): string | null {
  const file = path.join(paseoHome, DAEMON_BOOT_FILE);
  let previous: string | null = null;
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    if (value?.v === 1 && typeof value.boot === "string" && BOOT.test(value.boot))
      previous = value.boot;
  } catch {
    previous = null;
  }
  const temporary = `${file}.${boot}.tmp`;
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeSync(fd, JSON.stringify({ v: 1, boot }) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, file);
    return previous;
  } catch {
    // Unrecorded, the next boot must not name an older boot as its predecessor: fail towards "unknown".
    // Best effort, and never a reason to fail the daemon's own startup.
    for (const leftover of [temporary, file]) {
      try {
        rmSync(leftover, { force: true });
      } catch {}
    }
    return null;
  }
}

/** Agents must not rewrite the succession record (review W1-1(d)): the file and its temporary siblings. */
export function daemonBootDenyRules(paseoHome: string): string[] {
  let real = paseoHome;
  try {
    real = realpathSync(paseoHome);
  } catch {}
  const rules: string[] = [];
  for (const home of new Set([paseoHome, real])) {
    const file = path.join(home, DAEMON_BOOT_FILE);
    for (const tool of ["Read", "Edit", "Write"])
      rules.push(`${tool}(/${file})`, `${tool}(/${file}.*)`);
    rules.push(`Bash(*${file}*)`);
  }
  return rules;
}
