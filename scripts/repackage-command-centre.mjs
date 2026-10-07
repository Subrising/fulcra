// Retry the builder step only after the caller verifies unchanged compiled inputs.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { commandCentrePackageOutput } from "./command-centre-output.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
if (!process.env.FULCRA_PACKAGE_CONFIG || !process.env.FULCRA_PACKAGE_OUTPUT)
  throw Error("Repackage requires explicit verified build config and output");
const output = commandCentrePackageOutput(root, process.env, process.platform);
execFileSync(
  path.join(root, "node_modules/.bin/electron-builder"),
  [
    "--config",
    process.env.FULCRA_PACKAGE_CONFIG,
    "--dir",
    `-c.directories.output=${output}`,
    "-c.mac.identity=null",
    "-c.mac.notarize=false",
    "-c.mac.hardenedRuntime=false",
  ],
  {
    cwd: path.join(root, "packages/desktop"),
    stdio: "inherit",
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false", PASEO_DESKTOP_SMOKE: "0" },
  },
);
