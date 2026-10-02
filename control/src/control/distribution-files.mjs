import fs from "node:fs";
import path from "node:path";
export function controllerEntry(directory) {
  const root = fs.realpathSync(directory),
    entry = path.join(root, "controller.mjs");
  const stat = fs.lstatSync(entry);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.mode & 0o022 ||
    ![0, process.getuid()].includes(stat.uid) ||
    fs.realpathSync(entry) !== entry
  )
    throw Error("Unsafe packaged controller entry");
  return entry;
}
