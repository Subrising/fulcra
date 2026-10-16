import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

export function browserInputPaths(root = ".") {
  const required = ["packages/app/.e2e-web", "packages/app/.e2e-plan"];
  for (const file of [
    ...required.map(
      (directory) => `${directory}/${directory.endsWith("web") ? "index.html" : "manifest.json"}`,
    ),
    "packages/server/dist/scripts/supervisor-entrypoint.js",
    "packages/cli/dist/index.js",
  ]) {
    if (!existsSync(path.join(root, file))) throw new Error(`Missing browser input: ${file}`);
  }
  return [
    ...readdirSync(path.join(root, "packages"))
      .map((name) => `packages/${name}/dist`)
      .filter((directory) => existsSync(path.join(root, directory))),
    ...["plugins/dist", "packages/expo-two-way-audio/build"].filter((directory) =>
      existsSync(path.join(root, directory)),
    ),
    ...required,
  ];
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  writeFileSync("browser-input-paths.txt", browserInputPaths().join("\n") + "\n");
}
