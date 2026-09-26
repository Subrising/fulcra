const fs = require("node:fs");
const path = require("node:path");

// Keep one pre-Chromium entrypoint for AppRun, desktop entries, updates, and tarballs.
// productName comes from the builder context via after-pack, not from package.json, which is a
// separate setting and currently disagrees with it.
exports.installLinuxLauncher = function installLinuxLauncher(appOutDir, productName) {
  const launcher = path.join(appOutDir, productName);
  if (!fs.existsSync(`${launcher}.bin`)) {
    fs.renameSync(launcher, `${launcher}.bin`);
  }
  fs.copyFileSync(path.join(__dirname, "launcher.sh"), launcher);
  fs.chmodSync(launcher, 0o755);
};
