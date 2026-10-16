import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** @param {{ root?: string, manifests?: string[], runtimeVersion?: string }} [options] */
export async function checkAppPluginCompatibility({
  root = defaultRoot,
  manifests = [path.join(root, "control/orca-organization/paseo-plugin.json")],
  runtimeVersion,
} = {}) {
  const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
  const packageVersion = readJson(path.join(root, "packages/app/package.json")).version;
  const workspaceVersion = readJson(path.join(root, "package.json")).version;
  if (packageVersion !== workspaceVersion) {
    throw new Error(
      `App runtime ${packageVersion} differs from workspace runtime ${workspaceVersion}. Set the public version in FULCRA_DISPLAY_VERSION instead of package.json.`,
    );
  }
  if (runtimeVersion !== undefined && runtimeVersion !== packageVersion) {
    throw new Error(`Built runtime ${runtimeVersion} differs from app runtime ${packageVersion}.`);
  }
  const { assertPluginCompatibility } = await import(
    pathToFileURL(path.join(root, "packages/protocol/dist/plugin-requirements.js")).href
  );
  const plugins = manifests.map((file) => {
    const manifest = readJson(file);
    assertPluginCompatibility({ ...manifest, version: packageVersion, runtime: "app" });
    return {
      id: manifest.id,
      requirements: manifest.requirements,
      manifest_sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
    };
  });
  return { runtime_version: packageVersion, plugins, accepted: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      root: { type: "string" },
      manifest: { type: "string", multiple: true },
      "runtime-version": { type: "string" },
      output: { type: "string" },
    },
  });
  const proof = await checkAppPluginCompatibility({
    root: values.root,
    manifests: values.manifest,
    runtimeVersion: values["runtime-version"],
  });
  const result = JSON.stringify(proof, null, 2) + "\n";
  if (values.output) writeFileSync(values.output, result);
  process.stdout.write(result);
}
