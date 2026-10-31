import { defineConfig, configDefaults } from "vitest/config";
import { transformWithEsbuild } from "vite";
import { playwright } from "@vitest/browser-playwright";
import path from "path";
import fs from "fs";
import { transformSync } from "@babel/core";
import { build } from "esbuild";

// Set this before Vite resolves dependencies and Vitest starts its workers.
Object.assign(process.env, { NODE_ENV: "test" });

const appNodeModules = path.resolve(__dirname, "node_modules");
const rootNodeModules = path.resolve(__dirname, "../../node_modules");
const appTestWorkers = Number(process.env.APP_TEST_MAX_WORKERS ?? 2);
if (!Number.isInteger(appTestWorkers) || appTestWorkers < 1) {
  throw new Error("APP_TEST_MAX_WORKERS must be a positive integer");
}
const resolvePackageEntry = (packageName: string) => {
  const appPackagePath = path.resolve(appNodeModules, packageName);
  return fs.existsSync(appPackagePath)
    ? appPackagePath
    : path.resolve(rootNodeModules, packageName);
};

export default defineConfig({
  plugins: [
    {
<<<<<<< HEAD
      name: "native-markdown-jsx",
      enforce: "pre",
      transform(code, id) {
        // This native package publishes JSX in .js files; exercise its real exports in tests.
        const file = id.split("?")[0];
        if (/\/react-native-markdown-display\/src\/.*\.js$/.test(file)) {
          return transformWithEsbuild(code, file, { loader: "jsx", jsx: "automatic" });
        }
=======
      name: "compile-usage-components",
      enforce: "pre",
      transform(source, id) {
        // These labels must react to time and language in the compiled app too.
        if (!id.includes("/src/usage/") || !id.endsWith(".tsx") || id.includes(".test.")) return;
        const result = transformSync(source, {
          filename: id,
          babelrc: false,
          configFile: false,
          parserOpts: { plugins: ["typescript", "jsx"] },
          plugins: [["babel-plugin-react-compiler", { target: "19" }]],
          sourceMaps: true,
        });
        if (result?.code) return { code: result.code, map: result.map };
      },
    },
    {
      name: "bundle-i18n-resources",
      // Metro resolves literal requires lazily. Vite's TS transform leaves them
      // to Node, which cannot resolve the resource modules. Bundle this boundary
      // so unit and browser consumers exercise the same deferred module loading.
      async transform(_source, id) {
        if (path.resolve(id) !== path.resolve(__dirname, "src/i18n/i18next.ts")) return;
        const result = await build({
          entryPoints: [id],
          bundle: true,
          format: "esm",
          platform: "neutral",
          external: ["i18next", "react-i18next"],
          write: false,
        });
        return { code: result.outputFiles[0].text, map: null };
>>>>>>> refs/remotes/upstream/tags/v0.13.1
      },
    },
  ],
  test: {
    environment: "node",
    deps: {
      optimizer: {
        ssr: { enabled: true, include: ["react-native-fit-image"] },
      },
    },
    exclude: [...configDefaults.exclude, "e2e/**"],
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: [
            "src/**/*.{test,spec}.{ts,tsx}",
            "native-release-version.test.ts",
<<<<<<< HEAD
            "plugins/with-fdroid-autolinking.test.ts",
=======
            "app.config.test.ts",
            "vitest-environment.test.ts",
>>>>>>> refs/remotes/upstream/tags/v0.13.1
          ],
          setupFiles: [path.resolve(__dirname, "vitest.setup.ts")],
          exclude: [...configDefaults.exclude, "e2e/**", "src/**/*.browser.{test,spec}.{ts,tsx}"],
        },
      },
      {
        extends: true,
        // Match Expo's automatic JSX runtime throughout the real browser renderer graph.
        esbuild: { jsx: "automatic", jsxImportSource: "react" },
        optimizeDeps: {
          esbuildOptions: { jsx: "automatic", jsxImportSource: "react" },
          // Pairing mocks host-runtime, but discovery still scans its dependencies.
          // Keep web dependencies discoverable; these native graphs are unused here.
          exclude: ["expo-router", "expo-modules-core"],
        },
        test: {
          name: "browser",
          fileParallelism: false,
          include: ["src/**/*.browser.{test,spec}.{ts,tsx}"],
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            connectTimeout: 180_000,
            instances: [{ browser: "chromium" }],
            screenshotDirectory: ".vitest-screenshots",
          },
          globalSetup: path.resolve(__dirname, "src/runtime/websocket-test-global-setup.ts"),
        },
      },
    ],
    /**
     * Expo pulls in native tooling (xcode, etc.) that executes files relying on `process.send`.
     * Vitest's default worker pool uses worker_threads, which intentionally stub that API and
     * immediately throw `Unexpected call to process.send`. Running the suite in forked processes
     * keeps `process.send` intact so the app tests can boot before hitting the intentional failures.
     */
    pool: "forks",
    // Project configuration takes precedence over Vitest's root CLI limit.
    maxWorkers: appTestWorkers,
    server: {
      deps: {
        fallbackCJS: true,
        inline: [
          "react-native-enriched-markdown",
          "zustand",
          "@tanstack/react-query",
          "react-native-web",
          "react-native-reanimated",
          "react-native-worklets",
          "react-native-gesture-handler",
          "react-native-keyboard-controller",
        ],
      },
    },
  },
  // Reanimated and gesture-handler pick platform files by extension
  // (e.g. `GestureHandlerRootView.web.js`). Vite's optimizer does not apply `resolve.extensions`,
  // so it scans the native files and dies on imports react-native-web has no answer for.
  // Unbundled, the same imports go through the resolver below and land on the web files.
  optimizeDeps: {
    // Expo's public navigation barrel also loads screens. Match Metro's web-first resolution
    // while optimizing its CJS dependencies, including DebugContainer.web.js.
    esbuildOptions: {
      resolveExtensions: [
        ".web.js",
        ".web.jsx",
        ".web.ts",
        ".web.tsx",
        ".js",
        ".jsx",
        ".ts",
        ".tsx",
        ".json",
      ],
    },
    // Bundle the CJS dependencies of the excluded gesture-handler package for the browser.
    include: [
      "react/jsx-runtime",
      "react/compiler-runtime",
      "expo-router/react-navigation",
      "@testing-library/react",
      "@tanstack/react-query",
      "react-i18next",
      "i18next",
      "@marijn/find-cluster-break",
      "tiny-invariant",
      "react-native-gesture-handler > hoist-non-react-statics",
      "react-native-gesture-handler > invariant",
    ],
    exclude: [
      "react-native-reanimated",
      "react-native-gesture-handler",
      "react-native-keyboard-controller",
      // Its entry imports the Flow-typed native file; unbundled, the resolver picks MaskedView.web.js.
      "@react-native-masked-view/masked-view",
    ],
  },
  // The globals a React Native bundler defines, which esbuild is no longer there to supply for
  // the package excluded above.
  define: {
    "process.env.JEST_WORKER_ID": "undefined",
    __DEV__: "false",
    global: "globalThis",
  },
  resolve: {
    extensions: [
      ".web.mjs",
      ".web.js",
      ".web.mts",
      ".web.ts",
      ".web.jsx",
      ".web.tsx",
      ".mjs",
      ".js",
      ".mts",
      ".ts",
      ".jsx",
      ".tsx",
      ".json",
    ],
    alias: [
      {
        find: /^@getpaseo\/client\/relay-v3$/,
        replacement: path.resolve(__dirname, "../client/src/relay-v3/index.ts"),
      },
      {
        find: /^@getpaseo\/relay\/e2ee$/,
        replacement: path.resolve(__dirname, "../relay/src/e2ee.ts"),
      },
      {
        find: /^@getpaseo\/relay$/,
        replacement: path.resolve(__dirname, "../relay/src/index.ts"),
      },
      // Vitest loses the grammars' propSources when it loads their ESM
      // builds, so every highlighted token comes back unstyled. The CJS
      // builds keep them. Node and Metro both get this right; this only
      // steers the test loader.
      {
        find: /^@lezer\/([a-z-]+)$/,
        replacement: path.resolve(rootNodeModules, "@lezer/$1/dist/index.cjs"),
      },
      {
        find: /^expo-clipboard$/,
        replacement: path.resolve(__dirname, "test-stubs/expo-clipboard.ts"),
      },
      { find: "@", replacement: path.resolve(__dirname, "src") },
      // Keep keyboard-controller's imports in Vite so native aliases and platform extensions apply.
      {
        find: /^react-native-keyboard-controller$/,
        replacement: path.resolve(
          resolvePackageEntry("react-native-keyboard-controller"),
          "lib/module/index.js",
        ),
      },
      // The CJS entry bypasses Vite's React Native alias and web-extension resolution.
      {
        find: /^react-native-gesture-handler$/,
        replacement: path.resolve(
          rootNodeModules,
          "react-native-gesture-handler/lib/module/index.js",
        ),
      },
      // Must precede the `react-native` alias: a string `find` matches by prefix, so this subpath
      // would otherwise resolve inside a react-native-web *file* and break the dependency scan.
      // Reanimated only imports it on the native path, which no test takes.
      {
        find: /^react-native\/Libraries\/Renderer\/shims\/ReactFabric$/,
        replacement: path.resolve(__dirname, "test-stubs/react-native-fabric-shim.ts"),
      },
      // Point to the ESM build so Vite can transform its imports and apply the
      // react alias below (the CJS build uses require('react') which bypasses
      // Vite alias resolution).
      {
        find: "react-native",
        replacement: path.resolve(rootNodeModules, "react-native-web/dist/index.js"),
      },
      { find: "react", replacement: resolvePackageEntry("react") },
      {
        find: "react-dom",
        replacement: resolvePackageEntry("react-dom"),
      },
      {
        find: /^@xterm\/addon-ligatures\/lib\/addon-ligatures\.mjs$/,
        replacement: path.resolve(__dirname, "test-stubs/xterm-addon-ligatures.ts"),
      },
      {
        find: /^@xterm\/addon-ligatures$/,
        replacement: path.resolve(__dirname, "test-stubs/xterm-addon-ligatures.ts"),
      },
      {
        find: /^react-native-unistyles$/,
        replacement: path.resolve(__dirname, "test-stubs/react-native-unistyles.ts"),
      },
      {
        find: /^react-native-svg$/,
        replacement: path.resolve(__dirname, "test-stubs/react-native-svg.ts"),
      },
      // Both ship untranspiled Flow and fail to parse on import, which takes out any test that
      // mounts a menu surface.
      {
        find: /^react-native-safe-area-context$/,
        replacement: path.resolve(__dirname, "test-stubs/react-native-safe-area-context.ts"),
      },
      {
        find: /^@gorhom\/bottom-sheet$/,
        replacement: path.resolve(__dirname, "test-stubs/gorhom-bottom-sheet.ts"),
      },
      {
        find: /^react-native-reanimated\/scripts\/validate-worklets-version$/,
        replacement: path.resolve(__dirname, "test-stubs/reanimated-validate-worklets-version.ts"),
      },
      {
        find: /^expo-linking$/,
        replacement: path.resolve(__dirname, "test-stubs/expo-linking.ts"),
      },
      // No Node implementation: every call on the real module rejects, so a test
      // touching a persisted store drowns in unhandled rejections.
      {
        find: /^@react-native-async-storage\/async-storage$/,
        replacement: path.resolve(__dirname, "test-stubs/async-storage.ts"),
      },
      {
        find: /^lucide-react-native$/,
        replacement: path.resolve(__dirname, "test-stubs/lucide-react-native.ts"),
      },
    ],
  },
});
