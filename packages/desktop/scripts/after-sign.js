const path = require("node:path");

const { smokePackagedDesktopApp } = require("../e2e/packaged-app-smoke.js");

// Resolved from what electron-builder actually produced, never from this package.json. The two are
// separate settings and since the Fulcra rename they disagree: the builder emits Fulcra.app while
// package.json still says Orca, so the smoke check looked for a bundle that does not exist and the
// PASEO_DESKTOP_SMOKE build failed here. Reading the builder's own appInfo means a future rename
// cannot desync them again.
function productFilename(context) {
  const name = context.packager?.appInfo?.productFilename;
  if (!name) {
    throw new Error(
      "electron-builder did not provide appInfo.productFilename to the afterSign hook",
    );
  }
  return name;
}

exports.default = async function afterSign(context) {
  if (process.env.PASEO_DESKTOP_SMOKE !== "1") {
    return;
  }

  if (context.electronPlatformName !== "darwin") {
    return;
  }

  const name = productFilename(context);
  await smokePackagedDesktopApp({
    appPath: path.join(context.appOutDir, `${name}.app`),
    executableName: name,
  });
};
