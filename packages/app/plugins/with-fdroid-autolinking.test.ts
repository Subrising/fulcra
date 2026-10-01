import path from "node:path";
import { describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { fdroidAutolinkingPackageJson } = require("./with-fdroid-autolinking") as {
  fdroidAutolinkingPackageJson: (
    packageJson: Record<string, unknown>,
    projectRoot: string,
    overlayRoot: string,
  ) => { expo: { autolinking: { android: Record<string, unknown> } } };
};

describe("F-Droid autolinking overlay", () => {
  const projectRoot = "/fixture/packages/app";
  const overlayRoot = path.join(projectRoot, "android", "fdroid-autolinking");

  // The overlay is autolinking's project root, so the app's local native modules must be named explicitly, or
  // PaseoScrollPackage and the device key are never linked (J9: the private-preview APK failed to compile).
  it("points local native modules at the app's own modules directory", () => {
    const android = fdroidAutolinkingPackageJson({ name: "app" }, projectRoot, overlayRoot).expo
      .autolinking.android;
    expect(path.resolve(overlayRoot, String(android.nativeModulesDir))).toBe(
      path.join(projectRoot, "modules"),
    );
    expect(android.nativeModulesDir).toBe(path.join("..", "..", "modules"));
  });

  it("keeps the F-Droid exclusions and existing autolinking settings", () => {
    const out = fdroidAutolinkingPackageJson(
      {
        name: "app",
        expo: { autolinking: { searchPaths: ["../../node_modules"], android: { flag: true } } },
      },
      projectRoot,
      overlayRoot,
    );
    expect(out.expo.autolinking).toMatchObject({ searchPaths: ["../../node_modules"] });
    expect(out.expo.autolinking.android).toMatchObject({ flag: true, buildFromSource: [".*"] });
    expect(out.expo.autolinking.android.exclude).toEqual(
      expect.arrayContaining(["expo-camera", "expo-notifications"]),
    );
  });
});
