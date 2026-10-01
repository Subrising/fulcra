import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { assertCompleteBundledPlugins } from "./assert-bundled-plugins.mjs";
test("m3 packaging requires every bundled directory complete with matching client/server pins", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-completeness-"));
  try {
    const dir = path.join(root, "good");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "paseo-plugin.json"), JSON.stringify({ id: "good" }));
    const manifest = { version: 1 };
    for (const target of ["client", "server"]) {
      const bytes = "fixture " + target;
      fs.writeFileSync(path.join(dir, `runtime.${target}.js`), bytes);
      manifest[target] = createHash("sha256").update(bytes).digest("hex");
    }
    fs.writeFileSync(path.join(dir, "runtime-manifest.json"), JSON.stringify(manifest));
    assert.doesNotThrow(() => assertCompleteBundledPlugins(root));
    fs.mkdirSync(path.join(root, "broken"));
    assert.throws(() => assertCompleteBundledPlugins(root));
    fs.rmdirSync(path.join(root, "broken"));
    fs.writeFileSync(path.join(dir, "runtime.client.js"), "modified");
    assert.throws(() => assertCompleteBundledPlugins(root), /mismatched/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
