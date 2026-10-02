import { build } from "esbuild";
import { inScope } from "./portable-scope.mjs";
// Syntax and dependency-graph verification; the host's patched type API belongs to V1/V4.
for (const [entry, platform, outfile] of [
  ["orca-organization/index.server.ts", "node", "dist/plugin/index.server.mjs"],
  ["orca-organization/index.client.tsx", "browser", "dist/plugin/index.client.mjs"],
  ["orca-organization/server/portable.test.ts", "node", ".verification/plugin-portable.test.mjs"],
]) {
  const result = await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    packages: "external",
    platform,
    format: "esm",
    target: "es2023",
    metafile: true,
    legalComments: "none",
  });
  if (!entry.includes(".test.")) {
    const bad = Object.keys(result.metafile.inputs).filter((p) => !inScope(p));
    if (bad.length) throw Error(`Plugin imports excluded source: ${bad.join(", ")}`);
  }
}
console.log(
  "Plugin portable source bundles compiled; patched host typecheck remains V1/V4 integration",
);
