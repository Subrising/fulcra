import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = path.join(root, "packages/app");
const target = process.argv[2];
const abi = process.argv[3] ?? "arm64-v8a";
// Capture provenance before generators run; committing while a build is active
// must not relabel an artifact with a later source revision.
const sourceCommitResult = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
});
const sourceStatusResult = spawnSync("git", ["status", "--porcelain"], {
  cwd: root,
  encoding: "utf8",
});
if (sourceCommitResult.status !== 0 || sourceStatusResult.status !== 0) {
  throw new Error("Cannot determine source provenance");
}
const sourceCommit = sourceCommitResult.stdout.trim();
const sourceDirty = sourceStatusResult.stdout.trim().length > 0;
// Porcelain lines are `XY path`: a status code and a repo-relative path, never
// file contents. Recording them turns "sourceDirty: true" from a dead end into
// a diagnosis. Bounded so the manifest stays small.
const SOURCE_STATUS_LIMIT = 50;
const sourceStatusLines = sourceStatusResult.stdout.split("\n").filter((line) => line.trim());
const sourceStatus = sourceStatusLines
  .slice(0, SOURCE_STATUS_LIMIT)
  .map((line) => line.slice(0, 200));
const sourceStatusTruncated = sourceStatusLines.length > SOURCE_STATUS_LIMIT;
if (sourceDirty) {
  console.error(
    `Source tree is not clean at ${sourceCommit}: ${sourceStatusLines.length} entr${
      sourceStatusLines.length === 1 ? "y" : "ies"
    }. Status codes and paths only:`,
  );
  for (const line of sourceStatus) console.error(`  ${line}`);
  if (sourceStatusTruncated)
    console.error(`  … ${sourceStatusLines.length - SOURCE_STATUS_LIMIT} more`);
}
// `--provenance-only` is the cheap pre-build check: it reports the same facts
// the manifest would record, in seconds, before a long packaging run.
if (process.argv.includes("--provenance-only")) {
  console.log(`Source commit: ${sourceCommit}`);
  console.log(`Source dirty:  ${sourceDirty}`);
  process.exit(sourceDirty ? 1 : 0);
}
// A dirty build cannot be delivered, so packaging one wastes the whole run.
// Fail before that. `--allow-dirty-source` still records sourceDirty: true, so
// delivery keeps refusing; it only permits producing a local artifact.
if (sourceDirty && !process.argv.includes("--allow-dirty-source")) {
  throw new Error(
    "Refusing to package from an unclean source tree. Inspect the paths above. Use --allow-dirty-source to build anyway; the manifest will still record sourceDirty: true and private-draft delivery will still refuse.",
  );
}
const env = { ...process.env, CI: "1", CSC_IDENTITY_AUTO_DISCOVERY: "false" };
// Preview bundles must not inherit a developer's host or release credentials.
for (const key of Object.keys(env)) {
  if (
    /^(EXPO_PUBLIC_LOCAL_DAEMON|ORCA_GOOGLE_|CSC_|WIN_CSC_|APPLE_|GH_TOKEN|GITHUB_TOKEN)/.test(key)
  ) {
    delete env[key];
  }
}
env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
}

function manifest(directory, names) {
  const version = JSON.parse(readFileSync(path.join(root, "package.json"))).version;
  copyFileSync(path.join(root, "LICENSE"), path.join(directory, "LICENSE"));
  const files = [...names, "LICENSE"].map((name) => ({
    name,
    sha256: createHash("sha256")
      .update(readFileSync(path.join(directory, name)))
      .digest("hex"),
  }));
  writeFileSync(
    path.join(directory, "build-manifest.json"),
    JSON.stringify(
      {
        product: "Fulcra private preview",
        version,
        sourceCommit,
        sourceDirty,
        sourceStatus,
        sourceStatusTruncated,
        target,
        abi: target === "android" ? abi : "x64",
        node: process.version,
        signing: "unsigned",
        deviceAcceptance: "not performed",
        files,
      },
      null,
      2,
    ) + "\n",
  );
}

if (target === "android" || target === "android-prebuild") {
  if (!new Set(["arm64-v8a", "x86_64"]).has(abi))
    throw new Error("ABI must be arm64-v8a or x86_64");
  if (process.platform === "win32") throw new Error("Build Android on macOS or Linux");
  env.APP_VARIANT = "private-preview";
  env.PASEO_FDROID_BUILD = "1";
  env.PASEO_PROFILE_BUILD = "0";
  run(npm, ["run", "build:app-deps"]);
  run(npm, ["run", "build:terminal-webview", "--workspace=@getpaseo/app"]);
  run(npm, [
    "run",
    "format:files",
    "--",
    "packages/app/src/terminal/webview/terminal-emulator-webview-html.ts",
  ]);
  run(
    npm,
    ["exec", "--", "expo", "prebuild", "--platform", "android", "--clean", "--no-install"],
    app,
  );
  const assets = path.join(app, "android/app/src/main/assets");
  mkdirSync(assets, { recursive: true });
  copyFileSync(path.join(root, "LICENSE"), path.join(assets, "Fulcra-LICENSE.txt"));
  // Expo's release template signs with its development keystore. This task is
  // build-only: leave signing to the distributor, without reading any key.
  const gradleFile = path.join(app, "android/app/build.gradle");
  const gradle = readFileSync(gradleFile, "utf8");
  const releaseSigning = /(release\s*\{[\s\S]*?)signingConfig signingConfigs\.debug/;
  if (!releaseSigning.test(gradle)) throw new Error("Expo release signing template changed");
  writeFileSync(gradleFile, gradle.replace(releaseSigning, "$1signingConfig null"));
  if (target === "android") {
    run(
      "./gradlew",
      [
        ":app:assembleRelease",
        `-PreactNativeArchitectures=${abi}`,
        "--no-daemon",
        "--max-workers=1",
        "-Dorg.gradle.parallel=false",
        // app.config.js sets expo-gradle-jvmargs to xmx 4096m + metaspace
        // 1024m, sized for a developer machine. The hosted runner this preview
        // builds on reported 7938 MB with 2 CPUs, and the instrumented run
        // measured MemAvailable falling to 813 MB with 2222 MB pushed to swap
        // before the runner was terminated.
        //
        // These are ceilings, not measured usage: nothing yet shows the JVM
        // reached 4 GB resident, so lowering them is a bounded experiment, not
        // a proven repair. The sampler now records per-process RSS so the next
        // run says what the JVM actually held. Revert these if that shows the
        // ceiling was never the constraint, and raise them if a build fails
        // with a heap or metaspace error rather than a terminated runner.
        "-Dorg.gradle.jvmargs=-Xmx3g -XX:MaxMetaspaceSize=768m",
        "-Pkotlin.daemon.jvmargs=-Xmx1g",
      ],
      path.join(app, "android"),
    );
    const output = path.join(root, "artifacts/orca-preview/android");
    mkdirSync(output, { recursive: true });
    const version = JSON.parse(readFileSync(path.join(root, "package.json"))).version;
    const name = `Fulcra-Preview-${version}-${abi}-unsigned.apk`;
    copyFileSync(
      path.join(app, "android/app/build/outputs/apk/release/app-release-unsigned.apk"),
      path.join(output, name),
    );
    manifest(output, [name]);
  }
} else if (target === "windows") {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error(
      "Windows preview requires a Windows x64 runner (native dependencies and package smoke)",
    );
  }
  env.PASEO_DESKTOP_SMOKE = "1";
  env.PASEO_WEB_PLATFORM = "electron";
  // The bundled Command Centre controller plugin is staged into packages/desktop/bundled-plugins
  // and packed as resources/bundled-plugins; without this step the app has no Command Centre.
  run(npm, ["run", "build:server:clean"]);
  run(process.execPath, [
    path.join(root, "scripts/build-command-centre.mjs"),
    path.join(root, "control"),
  ]);
  run(npm, [
    "run",
    "build:desktop",
    "--",
    "--publish",
    "never",
    "--win",
    "nsis",
    "zip",
    "--x64",
    "--config",
    "electron-builder.preview.yml",
  ]);
  const output = path.join(root, "artifacts/orca-preview/windows");
  mkdirSync(output, { recursive: true });
  const release = path.join(root, "packages/desktop/release-preview");
  const names = readdirSync(release).filter((name) => /\.(exe|zip)$/.test(name));
  if (
    !names.some((name) => name.endsWith(".exe")) ||
    !names.some((name) => name.endsWith(".zip"))
  ) {
    throw new Error("Missing Windows installer or portable ZIP");
  }
  for (const name of names) copyFileSync(path.join(release, name), path.join(output, name));
  manifest(output, names);
} else {
  throw new Error(
    "Usage: node scripts/orca-preview-build.mjs android|android-prebuild|windows [arm64-v8a|x86_64]",
  );
}
