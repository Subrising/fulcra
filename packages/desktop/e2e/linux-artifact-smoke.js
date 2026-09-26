// Observe published Linux artifacts without repairing their sandbox permissions.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { smokePackagedDesktopApp } = require("./packaged-app-smoke.js");

const BUILDER_CONFIG = path.join(__dirname, "..", "electron-builder.yml");

// Every Linux name here comes from the packaging config that produced the artifacts.
// electron-builder derives the install root from `productName` and the desktop entry and
// launcher from `executableName`, so those two keys are the only source of truth. Hardcoding
// them is what left this file looking for /opt/Paseo and Paseo.desktop long after the product
// was renamed: the smoke kept passing on a fork's layout and would have failed on the real one.
//
// Missing key means stop, not guess. A default would put the old name back a rename later.
function builderName(key) {
  const config = fs.readFileSync(BUILDER_CONFIG, "utf8");
  // Column-anchored: nested `mac:`/`win:` keys are indented and must not match.
  const match = config.match(
    new RegExp(String.raw`^${key}:[ \t]*["']?([^"'\n#]+?)["']?[ \t]*(?:#.*)?$`, "m"),
  );
  const value = match?.[1]?.trim();
  if (!value) {
    throw new Error(
      `${BUILDER_CONFIG} declares no ${key}; refusing to guess the Linux package layout`,
    );
  }
  return value;
}

async function main() {
  if (process.getuid() === 0) throw new Error("Launch the smoke as an unprivileged user");
  const release = path.resolve(process.argv[2]);
  const portableSandbox = process.argv[3] === "enabled";
  const artifactRoot = process.env.PASEO_DESKTOP_SMOKE_ARTIFACT_DIR;
  const installedOnly = process.argv.includes("--installed-only");
  const productName = builderName("productName");
  const executableName = builderName("executableName");
  // deb and rpm both install under /opt/<productName>; see scripts/linux-sandbox/after-install.tpl,
  // which electron-builder expands with the same value.
  const installRoot = path.join("/opt", productName);
  const extracted = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-linux-artifacts-"));
  const findArtifact = (suffix) => {
    const matches = fs.readdirSync(release).filter((file) => file.endsWith(suffix));
    if (matches.length !== 1) throw new Error(`Expected one ${suffix} in ${release}: ${matches}`);
    return path.join(release, matches[0]);
  };
  try {
    process.env.PASEO_DESKTOP_SMOKE_ARTIFACT_DIR = path.join(artifactRoot, "installed");
    const helper = fs.statSync(path.join(installRoot, "chrome-sandbox"));
    if (helper.uid !== 0 || (helper.mode & 0o7777) !== 0o4755) {
      throw new Error("Installed native package did not provide a root-owned 4755 helper");
    }
    await smokePackagedDesktopApp({ appPath: installRoot, executableName, expectedSandbox: true });
    if (installedOnly) return;

    const appImage = findArtifact(".AppImage");
    fs.chmodSync(appImage, 0o755);
    execFileSync(appImage, ["--appimage-extract"], { cwd: extracted, stdio: "ignore" });
    const appDir = path.join(extracted, "squashfs-root");
    const desktopEntry = fs.readFileSync(path.join(appDir, `${executableName}.desktop`), "utf8");
    if (/^Exec=.*--no-sandbox/m.test(desktopEntry)) {
      throw new Error("AppImage desktop entry bypasses runtime sandbox policy");
    }
    process.env.PASEO_DESKTOP_SMOKE_ARTIFACT_DIR = path.join(artifactRoot, "appimage");
    await smokePackagedDesktopApp({
      appPath: appDir,
      executableName,
      executablePath: appImage,
      launchArgs: ["--appimage-extract-and-run"],
      expectedSandbox: portableSandbox,
    });

    const tarDir = path.join(extracted, "tar");
    fs.mkdirSync(tarDir);
    execFileSync("tar", ["-xzf", findArtifact(".tar.gz"), "-C", tarDir]);
    // The tarball either holds the launcher at its root or nests it one directory down.
    // scripts/linux-sandbox/index.js installs that launcher under the product name.
    const appPath = fs.existsSync(path.join(tarDir, executableName))
      ? tarDir
      : path.join(tarDir, fs.readdirSync(tarDir)[0]);
    process.env.PASEO_DESKTOP_SMOKE_ARTIFACT_DIR = path.join(artifactRoot, "tar");
    await smokePackagedDesktopApp({ appPath, executableName, expectedSandbox: portableSandbox });
  } finally {
    fs.rmSync(extracted, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
