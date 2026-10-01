import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const builderConfig = readFileSync(
  new URL("../packages/desktop/electron-builder.yml", import.meta.url),
  "utf8",
);
const workflow = readFileSync(
  new URL("../.github/workflows/desktop-release.yml", import.meta.url),
  "utf8",
)
  .split("\n")
  .filter((line) => !line.trim().startsWith("#"))
  .join("\n");

test("desktop release passes no publish overrides while electron-builder publishing is disabled", () => {
  if (/^publish:\s*null\s*$/m.test(builderConfig)) {
    assert.doesNotMatch(
      workflow,
      /-c\.publish\./,
      "a -c.publish.* override recreates a provider-less publish config",
    );
  }
});
