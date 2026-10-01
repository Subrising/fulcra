import { readFile, writeFile, lstat, rename } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isSameDaemonInstance, type DaemonInstance } from "@getpaseo/server/daemon-control";
const filename = "command-centre-supervisor.json";
export async function saveCommandCentreOwner(
  home: string,
  instance: DaemonInstance,
): Promise<void> {
  const destination = path.join(home, filename),
    temporary = `${destination}.${randomUUID()}`;
  await writeFile(temporary, JSON.stringify(instance), { mode: 0o600, flag: "wx" });
  await rename(temporary, destination);
}
export async function ownsCommandCentreSupervisor(
  home: string,
  instance: DaemonInstance,
): Promise<boolean> {
  try {
    const file = path.join(home, filename),
      stat = await lstat(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.mode & 0o077 ||
      stat.uid !== process.getuid?.() ||
      stat.size > 4096
    )
      return false;
    const captured = JSON.parse(await readFile(file, "utf8"));
    return instance.desktopManaged === true && isSameDaemonInstance(captured, instance);
  } catch {
    return false;
  }
}
