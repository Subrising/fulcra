import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { assertLockedControllerRegistryInput } from "./command-centre-registry-input.mjs";

test("portable build admits contained locked registry files and refuses unknown, version drift and escape", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cc-registry-input-"));
  try {
    const control = path.join(root, "control");
    const packageRoot = path.join(control, "node_modules", "example");
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.writeFile(
      path.join(control, "package-lock.json"),
      JSON.stringify({
        packages: { "node_modules/example": { version: "1.0.0", integrity: "sha512-fixture" } },
      }),
    );
    const manifest = path.join(packageRoot, "package.json");
    await fs.writeFile(manifest, JSON.stringify({ name: "example", version: "1.0.0" }));
    const input = path.join(packageRoot, "index.js");
    await fs.writeFile(input, "export const value = 1;");
    assert.equal(await assertLockedControllerRegistryInput(control, input), true);
    assert.equal(
      await assertLockedControllerRegistryInput(control, path.join(control, "private.mjs")),
      false,
    );
    await fs.writeFile(manifest, JSON.stringify({ version: "2.0.0" }));
    await assert.rejects(assertLockedControllerRegistryInput(control, input), /lock entry/);
    await fs.writeFile(manifest, JSON.stringify({ version: "1.0.0" }));
    const unknown = path.join(control, "node_modules", "unknown", "index.js");
    await fs.mkdir(path.dirname(unknown));
    await fs.writeFile(unknown, "export const value = 1;");
    await assert.rejects(assertLockedControllerRegistryInput(control, unknown), /absent/);
    const outside = path.join(root, "outside.js");
    await fs.writeFile(outside, "export const value = 1;");
    const escaped = path.join(packageRoot, "escape.js");
    await fs.symlink(outside, escaped);
    await assert.rejects(assertLockedControllerRegistryInput(control, escaped), /lock entry/);
  } finally {
    await fs.rm(root, { recursive: true });
  }
});
