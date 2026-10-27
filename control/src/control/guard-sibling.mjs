// The staged admission guard imports ./automatic-permission.mjs. A release route that copies the guard must copy that
// sibling beside it, with its one package import pinned to the product's file (a staged copy has no node_modules).
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { bindPluginGit } from "./native-release-hooks.mjs";
import { productPluginGit } from "./stage-native-turn.mjs";
export const GUARD_SIBLING = "automatic-permission.mjs";
export function guardSiblingBytes(controlDir, productRoot) {
  const text = fs.readFileSync(path.join(controlDir, GUARD_SIBLING), "utf8");
  const pluginGit = productPluginGit(productRoot);
  return Buffer.from(pluginGit ? bindPluginGit(text, pluginGit) : text);
}
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
// The folder a release stages into is named by the guard and its sibling together, so a release that changes only the
// sibling gets a new folder and never meets the old one's bytes.
export const guardFolderHash = (guard, sibling) => digest(digest(guard) + ":" + digest(sibling));
// Writes the sibling beside the staged guard file. An existing copy must match byte for byte.
export function writeGuardSibling(guardFile, bytes) {
  const file = path.join(path.dirname(guardFile), GUARD_SIBLING);
  if (fs.existsSync(file)) {
    if (!fs.readFileSync(file).equals(bytes)) throw new Error("Guard sibling destination drift");
  } else fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
  return file;
}
