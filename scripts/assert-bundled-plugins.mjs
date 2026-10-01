import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
// Strict distribution gate; runtime may skip a malformed neighbor, packaging must never ship it.
export function assertCompleteBundledPlugins(root) {
  const entries = fs.readdirSync(root, { withFileTypes: true }),
    ids = new Set();
  if (!entries.length || entries.length > 128) throw Error("Invalid bundled plugin root count");
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw Error("Invalid bundled directory: " + entry.name);
    const directory = path.join(root, entry.name);
    const read = (name) => {
      const file = path.join(directory, name);
      if (!fs.lstatSync(file).isFile()) throw Error("Invalid bundled file: " + name);
      return fs.readFileSync(file);
    };
    const plugin = JSON.parse(read("paseo-plugin.json")),
      manifest = JSON.parse(read("runtime-manifest.json"));
    if (typeof plugin.id !== "string" || !plugin.id || ids.has(plugin.id) || manifest.version !== 1)
      throw Error("Invalid bundled manifest: " + entry.name);
    ids.add(plugin.id);
    for (const target of ["client", "server"]) {
      const hash = createHash("sha256")
        .update(read(`runtime.${target}.js`))
        .digest("hex");
      if (manifest[target] !== hash)
        throw Error("Incomplete or mismatched bundled " + target + ": " + entry.name);
    }
  }
}
