import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkAppPluginCompatibility } from "../../scripts/check-app-plugin-compatibility.mjs";

const {
  FDROID_ABI_VERSION_CODE_SUFFIXES,
  getFdroidVersionCodes,
  getNativeReleaseVersion,
} = require("./native-release-version");

describe("native release version", () => {
  it("keeps runtime build numbers when the public display version differs", () => {
    expect(getNativeReleaseVersion("0.11.4", "0.2.22")).toEqual({
      appVersion: "0.2.22",
      androidVersionCode: 11004,
      iosBuildNumber: "11004999",
    });
    expect(() => getNativeReleaseVersion("0.11.4", "invalid")).toThrow();
  });

  it("checks the app runtime against the actual controller requirement", async () => {
    const root = path.resolve(__dirname, "../..");
    const result = await checkAppPluginCompatibility({ root });
    expect(result.accepted).toBe(true);
    expect(result.plugins[0]).toMatchObject({
      id: "orca-organization-next",
      requirements: { paseo: ">=0.11.0-beta.5" },
    });
    await expect(checkAppPluginCompatibility({ root, runtimeVersion: "0.2.22" })).rejects.toThrow(
      "differs from app runtime",
    );
  });

  it("rejects a display label written into the runtime package before bundling", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "app-runtime-version-"));
    try {
      mkdirSync(path.join(root, "packages/app"), { recursive: true });
      writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "0.11.4" }));
      writeFileSync(
        path.join(root, "packages/app/package.json"),
        JSON.stringify({ version: "0.2.22" }),
      );
      await expect(checkAppPluginCompatibility({ root })).rejects.toThrow("FULCRA_DISPLAY_VERSION");
      writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "0.2.22" }));
      mkdirSync(path.join(root, "packages/protocol"), { recursive: true });
      symlinkSync(
        path.resolve(__dirname, "../protocol/dist"),
        path.join(root, "packages/protocol/dist"),
        "dir",
      );
      await expect(
        checkAppPluginCompatibility({
          root,
          manifests: [path.resolve(__dirname, "../../control/orca-organization/paseo-plugin.json")],
        }),
      ).rejects.toThrow("requires Fulcra >=0.11.0-beta.5");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("reserves the final iOS build slot for a stable release", () => {
    expect(getNativeReleaseVersion("0.2.6")).toEqual({
      appVersion: "0.2.6",
      androidVersionCode: 2006,
      iosBuildNumber: "2006999",
    });
  });

  it("gives each beta a unique iOS build slot under the stable app version", () => {
    expect(getNativeReleaseVersion("0.2.6-beta.2")).toEqual({
      appVersion: "0.2.6",
      androidVersionCode: 2006,
      iosBuildNumber: "2006002",
    });
  });

  it("rejects beta numbers that consume the stable iOS build slot", () => {
    expect(() => getNativeReleaseVersion("0.2.6-beta.999")).toThrow(
      "iOS beta number must be between 1 and 998",
    );
  });

  it("derives one F-Droid version code per published ABI", () => {
    expect(FDROID_ABI_VERSION_CODE_SUFFIXES).toEqual({
      "armeabi-v7a": 1,
      "arm64-v8a": 2,
      x86: 3,
      x86_64: 4,
    });
    expect(getFdroidVersionCodes("0.5.0")).toEqual([
      { abi: "armeabi-v7a", versionCode: 50001 },
      { abi: "arm64-v8a", versionCode: 50002 },
      { abi: "x86", versionCode: 50003 },
      { abi: "x86_64", versionCode: 50004 },
    ]);
  });
});
