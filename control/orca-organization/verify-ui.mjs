// External tooling is supplied explicitly; no dependency installation or live UI control occurs here.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
const root = path.dirname(fileURLToPath(import.meta.url)),
  require = createRequire(import.meta.url);
const tooling = process.argv[2];
if (!tooling || !path.isAbsolute(tooling))
  throw Error("Supply absolute external UI tooling directory");
const testFile = process.argv[3] ?? "ui.test.mjs";
if (
  ![
    "accounts.ui.test.mjs",
    "changes.ui.test.mjs",
    "ui.test.mjs",
    "work-view.test.mjs",
    "work-map.test.mjs",
    "trackers.ui.test.mjs",
    "inbox.ui.test.mjs",
    "organisation.ui.test.mjs",
    "integrations.ui.test.mjs",
    "tracking.ui.test.mjs",
    "step-through.ui.test.mjs",
    "environments.ui.test.mjs",
    "today.ui.test.mjs",
    "launchpad.ui.test.mjs",
  ].includes(testFile)
)
  throw Error("Unknown component test file");
const uiRequire = createRequire(path.join(tooling, "package.json"));
const { build } = require("esbuild");
const adapter = path.join(root, "client/ui-test-adapters.mjs");
const coverage = process.env.ORCA_UI_COVERAGE;
const plugins = [
  {
    name: "synthetic-component-test-adapters",
    setup(build) {
      build.onResolve(
        { filter: /^(react|react\/.*|react-dom|react-dom\/.*|jsdom|@testing-library\/react)$/ },
        (args) => ({ path: uiRequire.resolve(args.path), external: true }),
      );
      build.onResolve(
        { filter: /^(react-native|@getpaseo\/plugin\/client(?:\/(?:react-native|ui))?)$/ },
        () => ({ path: adapter }),
      );
    },
  },
];
if (coverage) {
  const { createInstrumenter } = require("istanbul-lib-instrument");
  plugins.push({
    name: "component-coverage",
    setup(build) {
      build.onLoad({ filter: /(?:client\/[^/]+|index\.client)\.(tsx|ts)$/ }, (args) => {
        if (args.path.includes(".test.")) return;
        const instrumenter = createInstrumenter({
          esModules: true,
          parserPlugins: ["typescript", "jsx"],
        });
        return {
          contents: instrumenter.instrumentSync(fs.readFileSync(args.path, "utf8"), args.path),
          loader: args.path.endsWith(".tsx") ? "tsx" : "ts",
        };
      });
    },
  });
}
fs.mkdirSync(path.join(root, "runtime"), { recursive: true });
const output = path.join(root, "runtime", testFile);
await build({
  entryPoints: [path.join(root, "client", testFile)],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: output,
  plugins,
});
execFileSync(process.execPath, ["--test", "--test-reporter=tap", output], {
  cwd: root,
  stdio: "inherit",
  timeout: 30000,
});
