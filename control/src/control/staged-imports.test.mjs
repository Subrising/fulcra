// The controller modules stage-native-turn.mjs copies into the native daemon's admission root run THERE, beside
// only each other and ../portable-config.mjs. A relative import of anything else resolves to nothing in the daemon,
// and the daemon cannot load its hooks. H5 build found exactly that: quota-wait.mjs had started importing
// journal-capacity.mjs (G3), which is not staged. This reads the staged list from stage-native-turn.mjs itself.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const staged = JSON.parse(
  fs
    .readFileSync(path.join(here, "stage-native-turn.mjs"), "utf8")
    .match(/const files = (\[[^\]]*\]);/)[1]
    .replace(/'/g, '"'),
);
test("every staged controller module imports only staged siblings, ../portable-config.mjs or node builtins", () => {
  assert.deepEqual(staged, [
    "admission-guard.mjs",
    "native-turn.mjs",
    "quota-wait.mjs",
    "quota-observation.mjs",
    "authority.mjs",
  ]);
  for (const name of staged) {
    const text = fs.readFileSync(path.join(here, name), "utf8");
    const specifiers = [
      ...text.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm),
      ...text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g),
    ].map((m) => m[1]);
    for (const s of specifiers)
      assert.ok(
        s.startsWith("node:") ||
          s === "../portable-config.mjs" ||
          (s.startsWith("./") && staged.includes(s.slice(2))),
        `${name} imports ${s}, which is not staged into the daemon root`,
      );
  }
});
