// Runs the work-map readers against the real controller source in this tree (in-process, temporary
// journal, no socket, no daemon, no native session). Needs ../src/control, so it is separate from
// verify.mjs, which must also pass in a standalone plugin checkout.
//   node verify-controller-contract.mjs [tmp-dir]
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
const root = path.dirname(fileURLToPath(import.meta.url)),
  require = createRequire(import.meta.url);
const { build } = require("esbuild");
if (!fs.existsSync(path.join(root, "../src/control/bindings.mjs")))
  throw Error("Controller source not found beside this plugin");
const tmp = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, "runtime", "tmp");
fs.mkdirSync(tmp, { recursive: true });
const out = path.join(root, "runtime", "work-map.controller.test.mjs");
await build({
  entryPoints: [path.join(root, "server/work-map.controller.test.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  outfile: out,
  logLevel: "warning",
});
execFileSync(process.execPath, ["--test", "--test-reporter=tap", out], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, TMPDIR: tmp },
});
