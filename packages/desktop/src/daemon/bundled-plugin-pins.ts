import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** Only the main process chooses the app resource root. No catalog/renderer path is accepted. */
export function readBundledPluginPins(
  root: string,
  warn: (message: string) => void = console.warn,
): Record<string, string> {
  const pins: Record<string, string> = Object.create(null);
  try {
    const entries = readdirSync(root, { withFileTypes: true });
    if (entries.length > 128) return pins;
    const json = (file: string) => {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.size > 65536) throw Error("Invalid bundled manifest");
      return JSON.parse(readFileSync(file, "utf8"));
    };
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const directory = path.join(root, entry.name);
      let plugin: { id: string };
      let manifest: { version: number; client: string };
      try {
        plugin = json(path.join(directory, "paseo-plugin.json"));
        // Generated at build time from the exact compiled client bytes by build-command-centre.mjs.
        manifest = json(path.join(directory, "runtime-manifest.json"));
        if (
          typeof plugin.id !== "string" ||
          !plugin.id ||
          plugin.id.length > 256 ||
          manifest.version !== 1 ||
          typeof manifest.client !== "string" ||
          !/^[a-f0-9]{64}$/.test(manifest.client)
        )
          throw Error("Invalid bundled pin");
      } catch {
        warn(`Skipping malformed bundled plugin directory: ${entry.name}`);
        continue;
      }
      if (Object.hasOwn(pins, plugin.id)) throw Error("Duplicate bundled plugin");
      pins[plugin.id] = manifest.client;
    }
    return pins;
  } catch {
    return Object.create(null);
  }
}
