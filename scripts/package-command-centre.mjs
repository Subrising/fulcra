// Invoke via the required build scheduler; controller source must be a reviewed checkout.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const controller = path.resolve(
  process.argv[2] ?? process.env.FULCRA_CONTROL_ROOT ?? path.join(root, "control"),
);
const run = (command, args, cwd = root, env = {}) =>
  execFileSync(command, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false", PASEO_DESKTOP_SMOKE: "0", ...env },
  });
run("npm", ["run", "build:server:clean"]);
run(process.execPath, ["scripts/build-command-centre.mjs", controller]);
const desktop = path.join(root, "packages/desktop");
if (process.env.FULCRA_WEB_OUTPUT) {
  run("npm", ["run", "build:app-deps"]);
  run(
    path.join(root, "node_modules/.bin/expo"),
    ["export", "--platform", "web", "--output-dir", path.resolve(process.env.FULCRA_WEB_OUTPUT)],
    path.join(root, "packages/app"),
    { PASEO_WEB_PLATFORM: "electron" },
  );
} else {
  run("npm", ["run", "build:app-dist"], desktop);
}
run("npm", ["run", "build:main"], desktop);
run(
  path.join(root, "node_modules/.bin/electron-builder"),
  [
    "--config",
    process.env.FULCRA_PACKAGE_CONFIG || "electron-builder.yml",
    "--dir",
    ...(process.env.FULCRA_PACKAGE_OUTPUT
      ? [`-c.directories.output=${path.resolve(process.env.FULCRA_PACKAGE_OUTPUT)}`]
      : []),
    "-c.mac.identity=null",
    "-c.mac.notarize=false",
    "-c.mac.hardenedRuntime=false",
  ],
  desktop,
  process.env.FULCRA_BUILDER_TMP
    ? {
        TMPDIR: process.env.FULCRA_BUILDER_TMP,
        TMP: process.env.FULCRA_BUILDER_TMP,
        TEMP: process.env.FULCRA_BUILDER_TMP,
      }
    : {},
);
