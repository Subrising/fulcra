import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertBuiltinRuntimeImports } from "./builtin-plugin-runtime.mjs";

async function fixture(t, files) {
  const root = await mkdtemp(path.join(os.tmpdir(), "builtin-runtime-imports-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  }
  return root;
}

test("physical runtime permits Node builtins and relative modules", async (t) => {
  const root = await fixture(t, {
    "index.mjs": 'import { value } from "./nested/value.mjs"; export { value };',
    "nested/value.mjs": 'import path from "node:path"; export const value = path.sep;',
  });
  await assertBuiltinRuntimeImports(root);
});

for (const [kind, code] of Object.entries({
  import:
    'import { LIMIT_RESUME_PROMPT } from "@getpaseo/protocol/limit-resume"; export { LIMIT_RESUME_PROMPT };',
  reexport: 'export { LIMIT_RESUME_PROMPT } from "@getpaseo/protocol/limit-resume";',
  dynamic: 'export const load = () => import("@getpaseo/protocol/limit-resume");',
  require: 'module.exports = require("@getpaseo/protocol/limit-resume");',
})) {
  test(`physical runtime rejects an unresolved package ${kind}`, async (t) => {
    const root = await fixture(t, {
      [`nested/policy.${kind === "require" ? "cjs" : "mjs"}`]: code,
    });
    await assert.rejects(
      assertBuiltinRuntimeImports(root),
      /unbundled import: @getpaseo\/protocol/,
    );
  });
}
