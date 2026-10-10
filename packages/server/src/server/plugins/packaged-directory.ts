import { unsafeOwnership } from "./trusted-ownership.js";
import { existsSync, realpathSync, lstatSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
/** Derive solely from the packaged worker location, never a persisted plugin path. */
export function packagedPluginsDirectory(moduleUrl: string, enabled: boolean): string | undefined {
  if (!enabled) return undefined;
  const entry = fileURLToPath(moduleUrl);
  const resources = realpathSync(packagedResourcesDirectory(entry));
  const bundles = realpathSync(path.join(resources, "bundled-plugins"));
  if (!bundles.startsWith(resources + path.sep))
    throw Error("Bundled plugins escaped app resources");
  for (const directory of [resources, bundles]) {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || unsafeOwnership(directory, stat))
      throw Error("Unsafe packaged directory ownership");
  }
  return bundles;
}

/** macOS: <App>.app/Contents/Resources. Windows: <install>\\resources, beside app.asar. */
function packagedResourcesDirectory(entry: string): string {
  if (process.platform === "win32") {
    const marker = `${path.sep}resources${path.sep}`;
    const offset = entry.toLowerCase().lastIndexOf(marker);
    const resources = offset < 0 ? "" : entry.slice(0, offset + marker.length);
    if (!resources || !existsSync(path.join(resources, "app.asar")))
      throw Error("Command Centre requires a packaged app");
    return resources;
  }
  const marker = `${path.sep}Contents${path.sep}Resources${path.sep}`;
  const offset = entry.lastIndexOf(marker);
  if (offset < 0 || !entry.slice(0, offset).endsWith(".app"))
    throw Error("Command Centre requires a packaged app");
  return entry.slice(0, offset + marker.length);
}
