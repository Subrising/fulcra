// H6 item 4. Tests read real modules from an installed (and therefore PATCHED) server build. A patched session.js and
// agent modules import an admission guard whose module body writes a loaded-<pid>.json receipt into the controller
// home written into it at staging -- the LIVE home for the live installation -- the moment it loads. No environment
// variable redirects it. provider-mode.test.mjs imported exports.js, which reaches session.js, so every suite run
// wrote spurious receipts into the live admission directory (H5-CANDIDATE-REPORT s0), where an enabled seat sweep
// would read them as intervening boots and decline.
//
// So a test imports an installed module only through here: the module's static import graph is walked first, and
// the import is REFUSED if any module it can reach imports an admission guard. Relative specifiers and @getpaseo/*
// package specifiers are followed (the patched tree is @getpaseo/server's dist); other packages are unpatched
// third-party code and are not. Dynamic import() with a literal specifier is followed too.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const SPECIFIERS = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;
export function guardReach(entry) {
  const seen = new Set(),
    stack = [path.resolve(entry)];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const text = fs.readFileSync(file, "utf8");
    for (const [, spec] of text.matchAll(SPECIFIERS)) {
      if (/admission-guard(\.mjs)?$/.test(spec))
        return { reaches: true, via: file, guard: spec, modules: seen.size };
      let next = null;
      if (spec.startsWith(".")) next = path.resolve(path.dirname(file), spec);
      else if (spec.startsWith("/")) next = spec;
      else if (spec.startsWith("@getpaseo/")) {
        try {
          next = createRequire(file).resolve(spec);
        } catch {
          next = null;
        }
      }
      if (next && fs.existsSync(next) && fs.statSync(next).isFile()) stack.push(next);
    }
  }
  return { reaches: false, modules: seen.size };
}
export async function guardFreeImport(file) {
  const reach = guardReach(file);
  if (reach.reaches)
    throw Error(
      `Refusing to import ${file}: it reaches an admission guard (${reach.guard}, imported by ${reach.via}), whose load writes a receipt into a controller home`,
    );
  return import(pathToFileURL(file).href);
}
