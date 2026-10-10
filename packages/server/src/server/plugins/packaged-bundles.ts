import { unsafeOwnership } from "./trusted-ownership.js";
import { readFile, realpath, lstat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
const Manifest = z
  .object({
    version: z.literal(1),
    sdkVersion: z.string().min(1),
    client: z.string().regex(/^[a-f0-9]{64}$/),
    server: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
/** Precompiled distribution only. Never performs ancestor node_modules resolution. */
export async function readPackagedBundles(directory: string, sdkVersion: string) {
  const root = await realpath(directory);
  const manifest = Manifest.parse(
    JSON.parse(await readFile(path.join(root, "runtime-manifest.json"), "utf8")),
  );
  if (manifest.sdkVersion !== sdkVersion) throw Error("Bundled plugin SDK version mismatch");
  async function read(target: "client" | "server") {
    const file = path.join(root, `runtime.${target}.js`),
      resolved = await realpath(file),
      stat = await lstat(file);
    if (
      !resolved.startsWith(root + path.sep) ||
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      unsafeOwnership(file, stat, { checkOwner: false }) ||
      stat.size > 16 * 1024 * 1024
    )
      throw Error("Unsafe packaged plugin artifact");
    const bytes = await readFile(file);
    if (createHash("sha256").update(bytes).digest("hex") !== manifest[target])
      throw Error("Packaged plugin digest mismatch");
    return bytes.toString("utf8");
  }
  return { clientBundle: await read("client"), serverBundle: await read("server") };
}
