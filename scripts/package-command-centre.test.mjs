import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { commandCentrePackageOutput } from "./command-centre-output.mjs";
const url = new URL("./package-command-centre.mjs", import.meta.url);
const source = fs
  .readFileSync(url, "utf8")
  .replace(/^import .*;\n/gm, "")
  .replaceAll("import.meta.url", JSON.stringify(url.href));
function calls(env, platform = "linux") {
  const result = [];
  vm.runInNewContext(source, {
    path,
    URL,
    fileURLToPath,
    process: {
      argv: ["node", "script", "/reviewed/control"],
      execPath: "/node",
      env,
      platform,
      arch: "arm64",
    },
    execFileSync: (...args) => result.push(args),
    commandCentrePackageOutput,
  });
  return result;
}
test("default package location and build scratch stay unchanged", () => {
  const result = calls({ TMPDIR: "/external/scratch" });
  assert.equal(result.length, 5);
  assert.equal(
    result.at(-1)[1].some((x) => x.startsWith("-c.directories.output=")),
    false,
  );
  for (const call of result) assert.equal(call[2].env.TMPDIR, "/external/scratch");
});

test("macOS packaging always gates its own CLI, daemon and cached speech models before delivery", () => {
  const result = calls(
    {
      FULCRA_PACKAGE_OUTPUT: "/scratch/runtime.noindex/output",
      FULCRA_SPEECH_MODELS: "/cached/models",
    },
    "darwin",
  );
  assert.deepEqual(
    [...result.at(-1)[1]],
    [
      "scripts/packaged-runtime-gate.mjs",
      "/scratch/runtime.noindex/output/mac-arm64/Fulcra.app",
      "/cached/models",
    ],
  );
});
test("Mac default and override staging exclude candidate apps before builds begin", () => {
  const result = calls({ HOME: "/private/test" }, "darwin");
  assert.ok(result.at(-2)[1].some((arg) => arg.endsWith("/packages/desktop/release.noindex")));
  assert.match(result.at(-1)[1][1], /release\.noindex\/mac-arm64\/Fulcra\.app$/);
  assert.throws(() => calls({ FULCRA_PACKAGE_OUTPUT: "/scratch/output" }, "darwin"), /\.noindex/);
});
test("run-only output and temp overrides apply only to electron-builder", () => {
  const result = calls({
    TMPDIR: "/external/scratch",
    FULCRA_PACKAGE_OUTPUT: "/private/tmp/task/output",
    FULCRA_BUILDER_TMP: "/private/tmp/task/builder-tmp",
  });
  for (const call of result.slice(0, -1)) assert.equal(call[2].env.TMPDIR, "/external/scratch");
  const builder = result.at(-1);
  assert.ok(builder[1].includes("-c.directories.output=/private/tmp/task/output"));
  for (const name of ["TMPDIR", "TMP", "TEMP"])
    assert.equal(builder[2].env[name], "/private/tmp/task/builder-tmp");
  assert.equal(builder[2].env.CSC_IDENTITY_AUTO_DISCOVERY, "false");
});

test("scratch web output uses the desktop export mode and run-specific builder config", () => {
  const result = calls({
    FULCRA_WEB_OUTPUT: "/private/tmp/task/web",
    FULCRA_PACKAGE_CONFIG: "/private/tmp/task/builder.json",
  });
  const expo = result.find((call) => call[0].endsWith("/.bin/expo"));
  assert.ok(expo);
  assert.equal(expo[1].join(" "), "export --platform web --output-dir /private/tmp/task/web");
  assert.equal(expo[2].env.PASEO_WEB_PLATFORM, "electron");
  assert.ok(result.at(-1)[1].includes("/private/tmp/task/builder.json"));
  assert.ok(result.some((call) => call[1].join(" ") === "run build:app-deps"));
});
