import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import pLimit from "p-limit";
import { ZodError } from "zod";
import type * as build from "./compiler-build.js";
import type { PluginManifest } from "./manifest.js";
import type { CompilerReply } from "./compiler-worker.js";

export {
  SERVER_HOST_MODULES,
  resolveExistingAsarUnpackedEsbuildBinary,
  unpackedEsbuildBinaryFromPackageDir,
} from "./compiler-esbuild.js";

export type CompilerTask =
  | { kind: "entries"; entries: Parameters<typeof build.compilePlugin>[0] }
  | { kind: "directory"; directory: string; version: string; builtinId?: string }
  | {
      kind: "prepare";
      directory: string;
      commands: PluginManifest["build"];
      environment: NodeJS.ProcessEnv;
    };

interface TaskResult {
  entries: Awaited<ReturnType<typeof build.compilePlugin>>;
  directory: Awaited<ReturnType<typeof build.compileDirectoryPlugin>>;
  prepare: void;
}

const IDLE_TIMEOUT_MS = 1_000;
const source = import.meta.url.endsWith(".ts");
const workerUrl = new URL(
  source ? "./compiler-worker.ts" : "./compiler-worker.js",
  import.meta.url,
);
// Resolve the development loader once at module initialization, never during a
// compile request. Packaged workers execute ordinary JavaScript without tsx.
const workerEntrypoint = source
  ? `import(${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm/api")).href)}).then(({ register }) => { register(); return import(${JSON.stringify(workerUrl.href)}); });`
  : workerUrl;

// Reuse the isolate during a build batch (notably daemon bootstrap), then release
// TypeScript's heap when idle. Only this owner admits work or stops the worker.
class PluginCompiler {
  private readonly queue = pLimit(1);
  private worker: Worker | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping: Promise<unknown> = Promise.resolve();

  run<T extends CompilerTask>(
    task: T,
    onLog?: (data: Record<string, unknown>, message: string) => void,
  ): Promise<TaskResult[T["kind"]]> {
    return this.queue(async () => {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = null;
      await this.stopping;
      const worker = this.worker ?? this.startWorker();
      worker.ref();
      try {
        return await this.request<T>(worker, task, onLog);
      } finally {
        if (this.worker === worker) {
          worker.unref();
          this.idleTimer = setTimeout(() => this.stopWorker(worker), IDLE_TIMEOUT_MS);
          this.idleTimer.unref();
        } else {
          await this.stopping;
        }
      }
    });
  }

  private startWorker(): Worker {
    const worker = new Worker(workerEntrypoint, { eval: source, execArgv: [] });
    this.worker = worker;
    // Keep error/exit ownership while idle too. The next caller gets a fresh
    // isolate after a crash; author build commands are never retried.
    worker.on("error", () => this.stopWorker(worker));
    worker.on("exit", () => {
      if (this.worker === worker) this.stopWorker(worker);
    });
    return worker;
  }

  private stopWorker(worker: Worker): void {
    if (this.worker !== worker) return;
    this.worker = null;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.stopping = worker.terminate();
  }

  private async request<T extends CompilerTask>(
    worker: Worker,
    task: T,
    onLog?: (data: Record<string, unknown>, message: string) => void,
  ): Promise<TaskResult[T["kind"]]> {
    let onMessage: (reply: CompilerReply) => void;
    let onError: (error: Error) => void;
    let onExit: (code: number) => void;
    try {
      return await new Promise<TaskResult[T["kind"]]>((resolve, reject) => {
        onError = reject;
        onExit = (code) => reject(new Error(`Plugin compiler worker exited (code ${code})`));
        onMessage = (reply) => {
          if (reply.kind === "log") {
            onLog?.(reply.data, reply.message);
          } else if (reply.kind === "result") {
            resolve(reply.value as TaskResult[T["kind"]]);
          } else {
            const error = reply.issues ? new ZodError(reply.issues) : reply.error;
            Object.assign(error, reply.properties);
            if (reply.errors) Object.assign(error, { errors: reply.errors });
            if (reply.warnings) Object.assign(error, { warnings: reply.warnings });
            // Promise.all can reject while the other target is still compiling.
            // Retire the isolate before another request can enter it.
            this.stopWorker(worker);
            reject(error);
          }
        };
        worker.on("error", onError);
        worker.on("exit", onExit);
        worker.on("message", onMessage);
        worker.postMessage(task, []);
      });
<<<<<<< HEAD
    },
  };
}

function wrapCommonJsBundle(code: string): string {
  return `(function(require) {\nvar module = { exports: {} };\nvar exports = module.exports;\n${code}\nreturn module.exports;\n})`;
}

function makeHermesInteropEager(code: string): string {
  // Hermes evaluates esbuild's lazy CommonJS interop getters from a string with
  // the final loop binding, so every named import can resolve to the last export.
  // Plugin bundles execute once and do not need live bindings from host modules.
  // esbuild renames `key` (key10) when the plugin has its own top-level `key`.
  return code.replace(/get: ?\(\) ?=> ?from\[(key\d*)\]/g, "value: from[$1]");
}

// FULCRA(plugin-host): the app's Hermes compiles a plugin bundle from source, not through Metro.
// For a large source it compiles lazily, and then every class expression evaluates to undefined
// (an error boundary becomes "Element type is invalid ... got: undefined"). It also gives let/const
// one binding per function, so a closure made in a loop sees the last value. Lower exactly these
// two features, as Metro's preset does for app code; the rest of es2020 runs on Hermes as is.
function lowerForHermes(code: string, minifyWhitespace: boolean): string {
  const babel = nodeRequire("@babel/core") as typeof import("@babel/core");
  const result = babel.transformSync(code, {
    babelrc: false,
    configFile: false,
    sourceType: "script",
    compact: minifyWhitespace,
    comments: !minifyWhitespace,
    plugins: [
      nodeRequire.resolve("@babel/plugin-transform-classes"),
      nodeRequire.resolve("@babel/plugin-transform-block-scoping"),
    ],
  });
  if (!result?.code) throw new Error("Plugin client compilation produced no output");
  return result.code;
}

function runtimeSpecifierError(
  specifier: string,
  target: PluginBuildTarget | "shared",
  importer: string,
): OnResolveResult | null {
  let kind: string | null = null;
  if (specifier === "@getpaseo/plugin/client/host") kind = "host-private";
  else if (
    (specifier === "@getpaseo/plugin" ||
      specifier.startsWith("@getpaseo/plugin/") ||
      specifier === "@paseo/plugin" ||
      specifier.startsWith("@paseo/plugin/")) &&
    !(PLUGIN_SDK_SPECIFIERS as readonly string[]).includes(specifier)
  )
    kind = "Unknown SDK";
  else if (target !== "server" && (isBuiltin(specifier) || specifier === "@types/node"))
    kind = "Node";
  else if (target !== "server" && isPluginServerOnlySdkSpecifier(specifier)) kind = "server-only";
  else if (
    target !== "client" &&
    (isPluginClientOnlySdkSpecifier(specifier) ||
      /^((?:@types\/)?react(?:-dom|-native)?|use-sync-external-store|@tanstack\/react-query)(\/|$)/.test(
        specifier,
      ))
  )
    kind = "client-only";
  return kind
    ? {
        errors: [
          {
            text: `${kind} module cannot be imported into the plugin ${target} bundle: ${specifier} imported by ${importer}`,
          },
        ],
      }
    : null;
}

function checkSharedDependencies(inputs: Metafile["inputs"], pluginDirectory: string): void {
  function inputLocation(file: string): PluginModuleLocation | null {
    const absolutePath = path.resolve(pluginDirectory, file);
    // Metafile keys must stay unchanged for graph traversal. Only filesystem
    // inputs have canonical paths; data URLs and external specifiers do not.
    return directoryTarget(
      existsSync(absolutePath) ? realpathSync.native(absolutePath) : absolutePath,
      pluginDirectory,
    );
  }
  const pending = Object.keys(inputs).filter((file) => inputLocation(file) === "shared");
  const visited = new Set<string>();
  while (pending.length) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    for (const dependency of inputs[file]?.imports ?? []) {
      const location = dependency.external ? null : inputLocation(dependency.path);
      const error =
        runtimeSpecifierError(dependency.original ?? dependency.path, "shared", file) ??
        (dependency.external
          ? null
          : moduleBoundaryError(
              location === "invalid" ? null : location,
              "shared",
              dependency.path,
            ));
      if (error?.errors?.length) throw new Error(error.errors[0].text);
      if (!dependency.external) pending.push(dependency.path);
=======
    } finally {
      worker.off("message", onMessage!);
      worker.off("error", onError!);
      worker.off("exit", onExit!);
>>>>>>> refs/remotes/upstream/tags/v0.14.0
    }
  }
}

<<<<<<< HEAD
async function compileTarget(
  entryPath: string,
  target: PluginBuildTarget,
  minifyWhitespace: boolean,
): Promise<string> {
  const { build } = loadEsbuild();
  // Use native canonical paths throughout: TypeScript expands Windows short names
  // when resolving type references, while the JS realpath implementation retains them.
  const pluginDirectory = realpathSync.native(path.dirname(entryPath));
  const result = await build({
    // Stable module labels and identifiers: never embed a random staging root in client bytes.
    absWorkingDir: pluginDirectory,
    entryPoints: [realpathSync.native(entryPath)],
    bundle: true,
    format: "cjs",
    jsx: "automatic",
    platform: target === "server" ? "node" : "neutral",
    target: target === "server" ? "node20" : "es2020",
    // The neutral platform reads no package.json entry fields, so packages without
    // `exports` would not resolve. Read the same fields as esbuild's browser platform
    // minus `browser`, since the bundle also runs in React Native.
    mainFields: target === "client" ? ["module", "main"] : undefined,
    // Metro lowers async syntax before Hermes sees app code. Plugin client bundles bypass Metro,
    // so apply the same compatibility transform before the app evaluates them from source.
    supported: target === "client" ? { "async-await": false } : undefined,
    external:
      target === "client"
        ? [
            ...PLUGIN_SDK_SPECIFIERS,
            "@tanstack/react-query",
            "react",
            "react/jsx-runtime",
            "react-native",
            "zod",
          ]
        : SERVER_HOST_MODULES,
    plugins: [createRuntimeBoundaryPlugin(target, pluginDirectory)],
    metafile: true,
    logLevel: "silent",
    treeShaking: true,
    minifyWhitespace,
    write: false,
  });
  checkSharedDependencies(result.metafile.inputs, pluginDirectory);
  const output = result.outputFiles[0]?.text;
  if (!output) throw new Error(`Plugin ${target} compilation produced no output`);
  const eager = makeHermesInteropEager(output);
  return wrapCommonJsBundle(target === "client" ? lowerForHermes(eager, minifyWhitespace) : eager);
}

// minifyWhitespace is for the precompiled bundled plugin build only: it keeps the client catalog
// entry under the 1 MiB runtime limit. User plugins keep readable output.
export async function compilePlugin(
  entryPaths: {
    client: string | null;
    server: string | null;
  },
  options: { minifyWhitespace?: boolean } = {},
): Promise<{
  clientBundle: string | null;
  serverBundle: string | null;
}> {
  const [clientBundle, serverBundle] = await Promise.all([
    entryPaths.client
      ? compileTarget(entryPaths.client, "client", options.minifyWhitespace === true)
      : null,
    entryPaths.server
      ? compileTarget(entryPaths.server, "server", options.minifyWhitespace === true)
      : null,
  ]);
  return { clientBundle, serverBundle };
=======
const compiler = new PluginCompiler();

export function runCompilerTask<T extends CompilerTask>(
  task: T,
  onLog?: (data: Record<string, unknown>, message: string) => void,
): Promise<TaskResult[T["kind"]]> {
  return compiler.run(task, onLog);
}

export function compilePlugin(entries: Parameters<typeof build.compilePlugin>[0]) {
  return runCompilerTask({ kind: "entries", entries });
}

export function compileDirectoryPlugin(directory: string, version: string, builtinId?: string) {
  return runCompilerTask({ kind: "directory", directory, version, builtinId });
>>>>>>> refs/remotes/upstream/tags/v0.14.0
}
