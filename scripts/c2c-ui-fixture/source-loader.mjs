import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
registerHooks({
  resolve(specifier, context, nextResolve) {
    let base;
    if (specifier.startsWith("@/")) base = path.join(root, "packages/app/src", specifier.slice(2));
    else if (specifier.startsWith("@getpaseo/protocol/"))
      base = path.join(
        root,
        "packages/protocol/src",
        specifier.slice("@getpaseo/protocol/".length),
      );
    else if (specifier.startsWith(".") && context.parentURL?.startsWith("file:"))
      base = fileURLToPath(new URL(specifier, context.parentURL));
    if (base) {
      for (const candidate of [
        base,
        `${base}.ts`,
        base.replace(/\.js$/, ".ts"),
        path.join(base, "index.ts"),
      ]) {
        if (candidate.endsWith(".ts") && existsSync(candidate))
          return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});
