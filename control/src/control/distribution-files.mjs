import fs from "node:fs";
import path from "node:path";
import { trustedCode } from "../../orca-organization/server/owned.mjs";
export function controllerEntry(directory) {
  const root = fs.realpathSync(directory),
    entry = path.join(root, "controller.mjs");
  const stat = fs.lstatSync(entry);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    !trustedCode(stat, entry) ||
    fs.realpathSync(entry) !== entry
  )
    throw Error("Unsafe packaged controller entry");
  return entry;
}
