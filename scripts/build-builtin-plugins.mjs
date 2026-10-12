import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { assertBuiltinRuntimeImports, builtinRuntimeFiles } from "./builtin-plugin-runtime.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = path.join(root, "plugins");
const output = path.join(root, "packages/server/dist/server/builtin-plugins");

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(source, output, {
  recursive: true,
  filter: (file) =>
    !file.split(path.sep).some((segment) => segment === "node_modules" || segment === "test") &&
    !/\.(test|spec)\.[cm]?[jt]sx?$/.test(file) &&
    !file.endsWith(".tsbuildinfo"),
});

// Keep the host's existing module paths and exports. Bundle from the source tree,
// where workspace dependencies resolve, rather than from physical app resources.
for (const file of await builtinRuntimeFiles(output)) {
  await build({
    entryPoints: [path.join(source, path.relative(output, file))],
    outfile: file,
    bundle: true,
    platform: "node",
    format: file.endsWith(".cjs") ? "cjs" : "esm",
    target: "node22",
  });
}
await assertBuiltinRuntimeImports(output);
