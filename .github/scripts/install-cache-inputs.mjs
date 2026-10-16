import { readFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const hooks = [
  "preinstall",
  "install",
  "postinstall",
  "prepublish",
  "preprepare",
  "prepare",
  "postprepare",
  "dependencies",
];
const knownRoot = {
  postinstall: "node scripts/postinstall-patches.mjs",
  prepare: "node scripts/install-git-hooks.mjs",
};

// A new lifecycle command can read new source files. Until its inputs are
// declared in the cache key, use a fresh npm ci and do not save that install.
export function installCacheSafe(root = ".") {
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  if (hooks.some((hook) => manifest.scripts?.[hook] !== knownRoot[hook])) return false;
  if (!Array.isArray(manifest.workspaces)) return false;
  for (const workspace of manifest.workspaces) {
    if (
      typeof workspace !== "string" ||
      !/^(plugins|packages\/[^/]+)$/.test(workspace) ||
      /[*?{}]/.test(workspace)
    )
      return false;
    const member = JSON.parse(readFileSync(path.join(root, workspace, "package.json"), "utf8"));
    if (hooks.some((hook) => member.scripts?.[hook])) return false;
  }
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  appendFileSync(process.env.GITHUB_OUTPUT, `reusable=${installCacheSafe()}\n`);
}
