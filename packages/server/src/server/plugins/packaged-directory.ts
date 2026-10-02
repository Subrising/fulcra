import { requireTrustedBundleHost } from "./trusted-platform.js";
import { realpathSync, lstatSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
/** Derive solely from the packaged worker location, never a persisted plugin path. */
export function packagedPluginsDirectory(moduleUrl: string, enabled: boolean): string | undefined {
  if (!enabled) return undefined;
  requireTrustedBundleHost();
  const entry = fileURLToPath(moduleUrl);
  const marker = `${path.sep}Contents${path.sep}Resources${path.sep}`;
  const offset = entry.lastIndexOf(marker);
  if (offset < 0 || !entry.slice(0, offset).endsWith(".app"))
    throw Error("Command Centre requires a packaged app");
  const resources = realpathSync(entry.slice(0, offset + marker.length));
  const bundles = realpathSync(path.join(resources, "bundled-plugins"));
  if (!bundles.startsWith(resources + path.sep))
    throw Error("Bundled plugins escaped app resources");
  for (const directory of [resources, bundles]) {
    const stat = lstatSync(directory);
    if (
      !stat.isDirectory() ||
      stat.mode & 0o022 ||
      (stat.uid !== 0 && stat.uid !== process.getuid?.())
    )
      throw Error("Unsafe packaged directory ownership");
  }
  return bundles;
}
