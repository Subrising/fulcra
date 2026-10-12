import { readdir } from "node:fs/promises";
import { isBuiltin } from "node:module";
import path from "node:path";
import { build } from "esbuild";

export async function builtinRuntimeFiles(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await builtinRuntimeFiles(file)));
    else if (entry.isFile() && /\.[cm]?js$/.test(entry.name)) files.push(file);
  }
  return files;
}

// TypeScript and declaration files are compiler inputs. JavaScript files run directly
// outside app.asar, so package imports must be inlined, even when the checkout resolves them.
export async function assertBuiltinRuntimeImports(root) {
  for (const file of await builtinRuntimeFiles(root)) {
    const result = await build({
      entryPoints: [file],
      bundle: true,
      packages: "external",
      platform: "node",
      format: "esm",
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    for (const output of Object.values(result.metafile.outputs)) {
      for (const dependency of output.imports) {
        if (!isBuiltin(dependency.path)) {
          throw new Error(
            `Physical built-in runtime ${path.relative(root, file)} has an unbundled import: ${dependency.path}`,
          );
        }
      }
    }
  }
}
