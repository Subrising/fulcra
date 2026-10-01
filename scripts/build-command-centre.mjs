import { assertCompleteBundledPlugins } from "./assert-bundled-plugins.mjs";
import { assertLockedControllerRegistryInput } from "./command-centre-registry-input.mjs";
// Distribution build. Run only through the packaging/heavy-work wrapper.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createRequire, isBuiltin } from "node:module";
const product = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const control = path.resolve(
  process.argv[2] ?? process.env.FULCRA_CONTROL_ROOT ?? path.join(product, "control"),
);
const require = createRequire(path.join(product, "package.json"));
const { build } = require("esbuild");
const { compilePlugin } = await import("../packages/server/dist/server/server/plugins/compiler.js");
const output = process.env.FULCRA_PLUGIN_OUTPUT
  ? path.resolve(process.env.FULCRA_PLUGIN_OUTPUT, "orca-organization-next")
  : path.join(product, "packages/desktop/bundled-plugins/orca-organization-next");
await fs.mkdir(output, { recursive: true });
const version = JSON.parse(
  await fs.readFile(path.join(product, "packages/server/package.json"), "utf8"),
).version;
// Compile in a temporary in-tree source directory so type/runtime SDK resolution uses this checkout.
const staging = await fs.mkdtemp(path.join(product, ".command-centre-stage-"));
let compiled;
try {
  await fs.cp(path.join(control, "orca-organization"), staging, {
    recursive: true,
    filter: (file) => !file.split(path.sep).includes("node_modules"),
  });
  compiled = await compilePlugin({
    client: path.join(staging, "index.client.tsx"),
    server: path.join(staging, "index.server.ts"),
  });
} finally {
  await fs.rm(staging, { recursive: true, force: true });
}
const manifest = { version: 1, sdkVersion: version };
for (const target of ["client", "server"]) {
  const source = compiled[`${target}Bundle`];
  if (!source) throw Error("Missing ordinary plugin half");
  await fs.writeFile(path.join(output, `runtime.${target}.js`), source);
  await fs.writeFile(
    path.join(output, `index.${target}.ts`),
    "// Loaded from the verified precompiled runtime manifest.\n",
  );
  manifest[target] = createHash("sha256").update(source).digest("hex");
}
await fs.writeFile(path.join(output, "runtime-manifest.json"), JSON.stringify(manifest));
const pluginManifest = await fs.readFile(path.join(control, "orca-organization/paseo-plugin.json"));
await fs.writeFile(path.join(output, "paseo-plugin.json"), pluginManifest);
await fs.mkdir(path.join(output, "orca-organization"), { recursive: true });
await fs.writeFile(path.join(output, "orca-organization/paseo-plugin.json"), pluginManifest);
await fs.writeFile(
  path.join(output, "package.json"),
  JSON.stringify({ type: "module", private: true, version }),
);
const { inScope } = await import(
  new URL("file://" + path.join(control, "tools/portable-scope.mjs"))
);
const sources = [
  ["src/control/distribution-host.mjs", "index.host.js"],
  ["src/control/distribution-child.mjs", "controller.mjs"],
  ["src/control/inbox.mjs", "src/control/inbox.mjs"],
  ["src/control/delegated.mjs", "src/control/delegated.mjs"],
  ["src/portable-memory/entry.mjs", "src/portable-memory/entry.mjs"],
];
for (const [entry, filename] of sources) {
  const result = await build({
    absWorkingDir: control,
    entryPoints: [path.join(control, entry)],
    outfile: path.join(output, filename),
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    sourcemap: false,
    legalComments: "none",
    metafile: true,
    nodePaths: [path.join(product, "node_modules")],
    plugins: [
      {
        name: "in-tree-sdk-and-assets",
        setup(b) {
          b.onResolve({ filter: /^@getpaseo\// }, (args) => ({ path: require.resolve(args.path) }));
          b.onLoad({ filter: /\.mjs$/ }, async (args) => {
            if (!args.path.startsWith(control + path.sep) || args.path.includes("/node_modules/"))
              return;
            // Preserve resource paths for both root bundles and nested agent helper entries.
            const relative = path
              .relative(
                path.dirname(path.join(output, filename)),
                path.join(output, path.relative(control, args.path)),
              )
              .split(path.sep)
              .join("/");
            return {
              contents: (await fs.readFile(args.path, "utf8")).replaceAll(
                "import.meta.url",
                `new URL(${JSON.stringify(relative.startsWith(".") ? relative : "./" + relative)}, import.meta.url).href`,
              ),
              loader: "js",
            };
          });
        },
      },
    ],
    banner: {
      js: "import { createRequire as __ccRequire } from 'node:module'; const require = __ccRequire(import.meta.url);",
    },
  });
  for (const input of Object.keys(result.metafile.inputs)) {
    const absolute = path.resolve(control, input);
    if (
      absolute.startsWith(control + path.sep) &&
      !inScope(path.relative(control, absolute)) &&
      !(await assertLockedControllerRegistryInput(control, absolute))
    )
      throw Error(`Excluded controller build input: ${input}`);
  }
  for (const chunk of Object.values(result.metafile.outputs))
    for (const dependency of chunk.imports) {
      if (dependency.external && !isBuiltin(dependency.path))
        throw Error(`Unbundled runtime dependency: ${dependency.path}`);
    }
  await fs.writeFile(
    path.join(output, filename + ".inputs.json"),
    JSON.stringify(
      Object.keys(result.metafile.inputs).map((file) =>
        file.replaceAll(control, "<controller>").replaceAll(product, "<product>"),
      ),
    ),
  );
}
assertCompleteBundledPlugins(path.dirname(output));
console.log("Built self-contained Command Centre against in-tree SDK " + version);
