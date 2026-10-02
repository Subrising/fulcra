// H6 item 4: no test may load an admission guard from an installed build (it writes a receipt into the controller
// home written into it -- the live one, for the live installation).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { guardReach, guardFreeImport } from "./guard-free-import.mjs";

const scratch = (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-guard-free-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
test("a module that can reach an admission guard is refused, and the guard is never evaluated", async (t) => {
  const dir = scratch(t),
    marker = path.join(dir, "evaluated");
  fs.mkdirSync(path.join(dir, "admission", "abc"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "admission", "abc", "admission-guard.mjs"),
    `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'receipt');`,
  );
  fs.writeFileSync(
    path.join(dir, "session.mjs"),
    `import { x } from "${path.join(dir, "admission", "abc", "admission-guard.mjs")}"; export const s = 1;`,
  );
  fs.writeFileSync(path.join(dir, "middle.mjs"), `export { s } from './session.mjs';`);
  fs.writeFileSync(path.join(dir, "exports.mjs"), `import('./middle.mjs'); export const e = 1;`);
  const reach = guardReach(path.join(dir, "exports.mjs"));
  assert.equal(reach.reaches, true);
  assert.equal(reach.via, path.join(dir, "session.mjs"));
  await assert.rejects(
    guardFreeImport(path.join(dir, "exports.mjs")),
    /reaches an admission guard/,
  );
  assert.equal(fs.existsSync(marker), false, "the guard module body never ran");
  fs.writeFileSync(
    path.join(dir, "clean.mjs"),
    `import { y } from './leaf.mjs'; export const c = y + 1;`,
  );
  fs.writeFileSync(path.join(dir, "leaf.mjs"), "export const y = 41;");
  assert.equal((await guardFreeImport(path.join(dir, "clean.mjs"))).c, 42);
});
test("every installed-server module a test imports is guard-free, and exports.js is imported by none (static)", () => {
  const here = path.dirname(new URL(import.meta.url).pathname),
    roots = [here, path.dirname(here)],
    problems = [],
    seen = [];
  for (const dir of roots)
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".test.mjs"))) {
      const text = fs.readFileSync(path.join(dir, name), "utf8");
      if (
        /['"`/]exports\.js['"`]/.test(text) &&
        /dist\/server\/server|DIST/.test(text) &&
        !/guardFreeImport/.test(text)
      )
        problems.push(`${name} imports exports.js without guardFreeImport`);
      for (const [, file] of text.matchAll(
        /['"](\/[^'"]*\/@getpaseo\/server\/dist\/server\/server\/[^'"]+\.js)['"]/g,
      )) {
        seen.push(file);
        if (fs.existsSync(file) && guardReach(file).reaches)
          problems.push(`${name} imports ${file}, which reaches an admission guard`);
      }
    }
  assert.deepEqual(problems, []);
  const pm = fs.readFileSync(path.join(here, "provider-mode.test.mjs"), "utf8");
  assert.doesNotMatch(
    pm,
    /path\.join\(DIST, 'exports\.js'\)\)\.href/,
    "provider-mode no longer imports exports.js",
  );
  assert.match(pm, /guardFreeImport\(/);
});
