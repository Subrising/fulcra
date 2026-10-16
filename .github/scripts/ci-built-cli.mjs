import { access } from "node:fs/promises";
import path from "node:path";

export async function requireBuiltCli(root, check = access) {
  for (const file of [
    "packages/protocol/dist/messages.js",
    "packages/client/dist/index.js",
    "packages/server/dist/scripts/supervisor-entrypoint.js",
    "packages/cli/dist/index.js",
  ]) {
    try {
      await check(path.join(root, file));
    } catch {
      throw new Error(`Missing exact CI build input: ${file}`);
    }
  }
}
