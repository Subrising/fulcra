import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../skills/", import.meta.url));
const catalogPath = path.join(root, ".bundled-skill-hashes.json");
const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
let changed = false;
async function visit(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) await visit(file);
    else if (entry.isFile()) {
      const relative = path.relative(root, file).split(path.sep).join("/");
      const hash = createHash("sha256")
        .update(await readFile(file))
        .digest("hex");
      const known = catalog.files[relative] ?? [];
      if (!known.includes(hash)) {
        catalog.files[relative] = [...known, hash].sort();
        changed = true;
      }
    }
  }
}
await visit(root);
if (process.argv.includes("--check")) {
  if (changed) throw new Error("Record the current bundled skill hashes before release");
} else if (changed) {
  catalog.files = Object.fromEntries(
    Object.entries(catalog.files).sort(([a], [b]) => a.localeCompare(b)),
  );
  await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
}
