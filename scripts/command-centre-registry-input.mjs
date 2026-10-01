import fs from "node:fs/promises";
import path from "node:path";

/** Registry inputs must belong to the selected controller lock and remain physically contained. */
export async function assertLockedControllerRegistryInput(control, absolute) {
  const registry = path.join(control, "node_modules");
  if (!absolute.startsWith(registry + path.sep)) return false;
  const lock = JSON.parse(await fs.readFile(path.join(control, "package-lock.json"), "utf8"));
  const realRegistry = await fs.realpath(registry);
  if (realRegistry !== path.join(await fs.realpath(control), "node_modules"))
    throw new Error("Controller registry root is not physically contained");
  let directory = path.dirname(absolute);
  while (directory.startsWith(registry + path.sep)) {
    const relative = path.relative(control, directory).split(path.sep).join("/");
    const entry = lock.packages?.[relative];
    if (entry) {
      const manifest = JSON.parse(await fs.readFile(path.join(directory, "package.json"), "utf8"));
      const realPackage = await fs.realpath(directory);
      const realInput = await fs.realpath(absolute);
      if (
        entry.link ||
        !entry.integrity ||
        manifest.version !== entry.version ||
        !realPackage.startsWith(realRegistry + path.sep) ||
        !realInput.startsWith(realPackage + path.sep)
      )
        throw new Error("Controller registry input does not match its contained lock entry");
      return true;
    }
    directory = path.dirname(directory);
  }
  throw new Error("Controller registry input is absent from the selected lock");
}
