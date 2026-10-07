import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PLUGIN_ID } from "./plugin-identity.mjs";

test("the controller's own ID is its manifest ID", () => {
  const manifest = JSON.parse(
    fs.readFileSync(new URL("../../orca-organization/paseo-plugin.json", import.meta.url), "utf8"),
  );
  assert.equal(PLUGIN_ID, manifest.id);
});
