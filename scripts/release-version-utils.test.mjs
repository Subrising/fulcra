import assert from "node:assert/strict";
import test from "node:test";
import {
  computeNextReleaseVersion,
  getReleaseInfoFromSourceTag,
  parseReleaseVersion,
} from "./release-version-utils.mjs";

test("computes the next beta patch from a stable version", () => {
  assert.equal(computeNextReleaseVersion("0.1.59", "beta-patch"), "0.1.60-beta.1");
});

test("advances beta versions", () => {
  assert.equal(computeNextReleaseVersion("0.1.60-beta.1", "beta-next"), "0.1.60-beta.2");
});

test("promotes beta versions to stable", () => {
  assert.equal(computeNextReleaseVersion("0.1.60-beta.2", "promote"), "0.1.60");
});

test("parses beta release metadata", () => {
  assert.deepEqual(parseReleaseVersion("0.1.60-beta.1"), {
    version: "0.1.60-beta.1",
    major: 0,
    minor: 1,
    patch: 60,
    prerelease: "beta.1",
    baseVersion: "0.1.60",
    isPrerelease: true,
    isBeta: true,
    betaNumber: 1,
  });
});

test("emits beta release info from tags", () => {
  assert.deepEqual(getReleaseInfoFromSourceTag("v0.1.60-beta.1"), {
    sourceTag: "v0.1.60-beta.1",
    releaseTag: "v0.1.60-beta.1",
    version: "0.1.60-beta.1",
    baseVersion: "0.1.60",
    prerelease: "beta.1",
    isPrerelease: true,
    isBeta: true,
    betaNumber: 1,
    releaseType: "prerelease",
    releaseChannel: "beta",
    builderChannel: "beta",
    isSmokeTag: false,
  });
});

test("rejects non-beta prerelease versions", () => {
  assert.throws(() => parseReleaseVersion("0.1.60-canary.1"), /Expected beta prerelease versions/);
});

const ELECTRON_BUILDER_CHANNELS = new Set(["alpha", "beta", "dev", "rc", "stable"]);

test("stable tags keep the latest update files and pass no electron-builder channel", () => {
  const info = getReleaseInfoFromSourceTag("v0.1.0");
  assert.equal(info.releaseChannel, "latest");
  assert.equal(info.builderChannel, null);
});

test("every builder channel is one electron-builder accepts", () => {
  for (const tag of ["v0.1.0", "v0.2.3", "v0.1.60-beta.1", "desktop-v1.0.0"]) {
    const { builderChannel } = getReleaseInfoFromSourceTag(tag);
    assert.ok(builderChannel === null || ELECTRON_BUILDER_CHANNELS.has(builderChannel), `${tag}: ${builderChannel}`);
  }
});
