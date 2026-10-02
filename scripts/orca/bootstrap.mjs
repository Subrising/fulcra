#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { spawnSync, spawn } from "node:child_process";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const selfPath = fileURLToPath(import.meta.url);
// POSIX single-quote escaping. Printed commands name real paths, and a home containing
// $, ` or ' would otherwise run a substitution when the reader pastes the line.
export const shellQuote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;
export const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const write = (file, value) =>
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
export function cleanEnvironment(home, env = process.env) {
  const clean = Object.fromEntries(
    Object.entries(env).filter(([k]) => !/^(ORCA_|PASEO_|EXPO_PUBLIC_)/.test(k)),
  );
  return {
    ...clean,
    ORCA_HOME: home,
    ORCA_NODE: process.execPath,
    ORCA_CONTROLLER_HOME: path.join(home, "controller"),
    PASEO_HOME: path.join(home, "daemon"),
    PASEO_NODE_ENV: "production",
  };
}
// The installed Mac app launches with the user's own environment. loadHome() rewrites
// PASEO_HOME/ORCA_* in this process, and `open` passes its environment to a cold app
// launch, so a handoff must strip them or the app's own built-in daemon would adopt the
// portable data home.
export function appLaunchEnvironment(env = process.env) {
  return Object.fromEntries(
    Object.entries(env).filter(([k]) => !/^(ORCA_|PASEO_|EXPO_PUBLIC_)/.test(k)),
  );
}
const APP_NAME = "Orca";
export function resolveNativeApp(options = {}) {
  const {
    platform = process.platform,
    explicit,
    exists = fs.existsSync,
    registered = () =>
      spawnSync("/usr/bin/open", ["-Ra", APP_NAME], { stdio: "ignore", shell: false }).status === 0,
    home = os.homedir(),
  } = options;
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (!exists(resolved)) throw Error(`No application bundle at ${resolved}.`);
    return { found: true, path: resolved, candidates: [resolved] };
  }
  const candidates = [
    path.join("/Applications", `${APP_NAME}.app`),
    path.join(home, "Applications", `${APP_NAME}.app`),
  ];
  if (platform !== "darwin") return { found: false, path: null, candidates, reason: "platform" };
  for (const candidate of candidates)
    if (exists(candidate)) return { found: true, path: candidate, candidates };
  if (registered()) return { found: true, path: null, candidates };
  return { found: false, path: null, candidates, reason: "missing" };
}
// Never print the password itself; the file keeps it at 0600 under the private home.
export function nativeHandoffReport({ app, url, port, passwordFile, opened = true, command }) {
  const lines = [];
  if (app.found) {
    lines.push(
      `${opened ? "Opening" : "Open"} the installed ${APP_NAME} app${app.path ? ` (${app.path})` : ""}.`,
      // Labels verified against packages/app/src/i18n/resources/en.ts: the settings
      // sidebar group is "Host", the sheet is "Add connection", and the loopback method
      // is "Direct connection". Keep these in step with the app's strings.
      `Add this installation once: Settings -> Host -> Add host -> Direct connection.`,
      `Then Host 127.0.0.1, Port ${port}, the password below, and Connect.`,
      `Password file (never printed here): ${passwordFile}`,
      `  copy it with: pbcopy < ${shellQuote(passwordFile)}`,
      `This command starts no daemon. The app applies its own settings when it opens: built-in daemon management is off in a fresh app, and a setting you already changed is left as you set it.`,
      `The app cannot take this host automatically: its pairing links carry a relay offer, and this installation keeps relay disabled. Enter the host once; the app remembers it.`,
      `Browser fallback: ${url}`,
    );
  } else {
    if (app.reason === "missing")
      lines.push(
        `No installed ${APP_NAME} app found (looked in ${app.candidates.join(", ")} and the macOS launch database).`,
        `Install the ${APP_NAME} desktop app, or build it from packages/desktop, then run this command again for the native route.`,
      );
    if (app.reason === "platform")
      lines.push(`Opening the installed ${APP_NAME} app is macOS-only in this increment.`);
    lines.push(
      opened ? `Using the bundled browser client: ${url}` : `Bundled browser client: ${url}`,
      `Password file (never printed here): ${passwordFile}`,
      `  copy it with: pbcopy < ${shellQuote(passwordFile)}`,
    );
  }
  if (command) lines.push(`Open this installation with:\n  ${command}`);
  return lines.join("\n");
}
export function initHome(target, port = 6791) {
  if (process.platform === "win32")
    throw Error("Portable controller requires macOS or Linux (POSIX locks and Unix sockets).");
  if (Number(process.versions.node.split(".")[0]) < 24)
    throw Error("Node.js 24 or newer required.");
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw Error("Port must be 1024–65535.");
  const requested = path.resolve(target);
  fs.mkdirSync(path.dirname(requested), { recursive: true, mode: 0o700 });
  const home = path.join(fs.realpathSync(path.dirname(requested)), path.basename(requested));
  if (Buffer.byteLength(path.join(home, "controller/control.sock")) > 100)
    throw Error("ORCA_HOME is too long for a portable Unix socket; choose a shorter path.");
  // Even an empty existing directory or dangling symlink is refused. No merge or migration.
  fs.mkdirSync(home, { mode: 0o700 });
  for (const name of [
    "daemon",
    "controller",
    "controller/tasks",
    "controller/grants",
    "controller/bindings",
    "memory",
    "memory/history",
    "sources",
    "sdk",
    "run",
  ])
    fs.mkdirSync(path.join(home, name), { mode: 0o700 });
  const companyId = randomUUID(),
    programmeId = randomUUID();
  const config = {
    version: 1,
    daemon: { port },
    providers: { claude: "claude", codex: "codex" },
    authority: { companyId, programmeId },
    hosts: { mini: { label: os.hostname() }, macbook: null },
    conversation: {
      provider: "local",
      accountId: "local",
      senderId: "local",
      conversationId: randomUUID(),
      sessionId: randomUUID(),
    },
  };
  write(path.join(home, "config.json"), config);
  write(path.join(home, "tasks.json"), {
    version: 1,
    issues: [
      {
        id: programmeId,
        companyId,
        parentId: null,
        identifier: "ORCA",
        title: "My projects",
        status: "in_progress",
        assigneeUserId: "local-board",
        assigneeAgentId: null,
        // The ancestry root is not a project. It stays unaffiliated until you create one.
        projectId: null,
      },
    ],
    // Present and valid from the first write, so the catalog reader never sees a missing
    // key. `project add` registers rows here; nothing is inferred from a task.
    projects: [],
  });
  fs.writeFileSync(
    path.join(home, "daemon/controller.secret"),
    randomBytes(32).toString("base64url"),
    { flag: "wx", mode: 0o600 },
  );
  write(path.join(home, "bootstrap.json"), {
    version: 1,
    state: "initialized",
    createdAt: new Date().toISOString(),
  });
  return home;
}
function run(command, args, cwd, env) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw Error(
      `${command} failed (${result.status ?? result.signal}); partial home retained. Inspect it before retrying.`,
    );
}
function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1048576 });
  if (result.status !== 0) throw Error(`Git failed: ${result.stderr}`);
  return result.stdout.trim();
}
export async function loadHome(home) {
  const canonical = fs.realpathSync(path.resolve(home));
  const clean = cleanEnvironment(canonical);
  for (const key of Object.keys(process.env))
    if (/^(ORCA_|PASEO_|EXPO_PUBLIC_)/.test(key)) delete process.env[key];
  Object.assign(process.env, clean);
  return (
    await import(pathToFileURL(path.join(canonical, "sources/runtime/src/portable-config.mjs")))
  ).loadPortable();
}
export async function compose(home) {
  const c = await loadHome(home);
  if (fs.existsSync(path.join(home, "installed.json")))
    throw Error("Already installed; in-place upgrades are not supported.");
  const selected = json(path.join(home, "sources.json"));
  for (const name of ["native", "runtime", "conversation", "workspace"]) {
    const source = path.join(home, "sources", name);
    if (
      !/^[a-f0-9]{40}$/.test(selected[name] ?? "") ||
      git(["rev-parse", "HEAD"], source) !== selected[name] ||
      git(["status", "--porcelain", "--untracked-files=no"], source)
    )
      throw Error(`Selected ${name} source changed before composition; inspect the retained home.`);
  }
  const req = createRequire(path.join(c.native, "packages/server/package.json"));
  const { hashSync } = req("bcryptjs");
  const { build } = req("esbuild");
  const password = fs.readFileSync(path.join(c.daemonHome, "controller.secret"), "utf8");
  const daemonConfig = {
    version: 1,
    daemon: {
      listen: `127.0.0.1:${c.daemon.port}`,
      auth: { password: hashSync(password, 12) },
      relay: { enabled: false },
      serviceProxy: { enabled: false },
    },
    features: {
      webUi: { enabled: true },
      dictation: { enabled: false },
      voiceMode: { enabled: false },
    },
    pluginsEnabled: true,
    plugins: {
      "orca-organization": {
        source: "directory",
        path: path.join(home, "sources/workspace/orca-organization"),
        enabled: true,
      },
    },
  };
  // Existing configs, staged code and journal are never overwritten by composition.
  for (const name of [
    "daemon/config.json",
    "controller/journal.sqlite",
    "controller/admission",
    "run/native",
    "sdk/client.mjs",
    "sdk/manifest.json",
  ])
    if (fs.existsSync(path.join(home, name)))
      throw Error(`Refusing existing installation data: ${name}`);
  await build({
    stdin: {
      contents: `export { createPaseoApi } from './packages/client/dist/index.js'; export { DaemonClient } from './packages/client/dist/daemon-client.js';`,
      resolveDir: c.native,
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: path.join(home, "sdk/client.mjs"),
    banner: {
      js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
    },
  });
  fs.chmodSync(path.join(home, "sdk/client.mjs"), 0o600);
  write(path.join(home, "sdk/manifest.json"), {
    sha256: sha(fs.readFileSync(path.join(home, "sdk/client.mjs"))),
  });
  const runtime = path.join(home, "sources/runtime/src/control");
  const { ControlStore } = await import(pathToFileURL(path.join(runtime, "store.mjs")));
  new ControlStore(path.join(c.controller, "journal.sqlite")).close();
  const { stageNativeTurn } = await import(
    pathToFileURL(path.join(runtime, "stage-native-turn.mjs"))
  );
  stageNativeTurn({
    sourceRoot: c.native,
    outputRoot: path.join(home, "run/native"),
    controllerHome: c.controller,
    journalFile: path.join(c.controller, "journal.sqlite"),
    portableSourceHead: selected.native,
  });
  write(path.join(home, "daemon/config.json"), daemonConfig);
  // Share the matching type/runtime dependency tree with the directory plugin.
  fs.symlinkSync(
    path.join(c.native, "node_modules"),
    path.join(home, "sources/workspace/orca-organization/node_modules"),
  );
  const receipt = {
    version: 1,
    installedAt: new Date().toISOString(),
    node: process.version,
    components: selected,
    sdk: json(path.join(home, "sdk/manifest.json")),
  };
  write(path.join(home, "installed.json"), receipt);
  return { home, url: `http://127.0.0.1:${c.daemon.port}`, components: receipt.components };
}
function cloneLegacyComponents(options, pins, home, env, selected) {
  for (const name of ["native", "runtime", "conversation", "workspace"]) {
    const local = options[name];
    const repository = local ? fs.realpathSync(path.resolve(local)) : pins.repository;
    const revision = local ? git(["rev-parse", "HEAD"], repository) : pins[name];
    if (!/^[a-f0-9]{40}$/.test(revision)) throw Error(`Pinned ${name} commit required.`);
    if (local && git(["status", "--porcelain", "--untracked-files=no"], repository))
      throw Error(`Commit ${name} source changes before installing.`);
    const destination = path.join(home, "sources", name);
    run(
      "git",
      ["clone", "--no-hardlinks", "--no-checkout", "--", repository, destination],
      undefined,
      env,
    );
    run("git", ["checkout", "--detach", revision], destination, env);
    selected[name] = revision;
  }
}

export async function install(target, options = {}) {
  const consolidated =
    options.source ??
    (!options.runtime && !options.conversation && !options.workspace
      ? (options.native ?? path.resolve(here, "../.."))
      : null);
  let pins;
  if (!consolidated) {
    const pinsFile = path.resolve(here, "../../local/components.json");
    pins = fs.existsSync(pinsFile) ? json(pinsFile) : {};
    if (
      !["native", "runtime", "conversation", "workspace"].every(
        (name) => options[name] || typeof pins[name] === "string",
      )
    )
      throw Error(
        "Populate local/components.json or pass all four component source options before installing.",
      );
  }
  const home = initHome(target, options.port ?? 6791),
    env = cleanEnvironment(home);
  const selected = {};
  // Default installation uses one reviewed local checkout. The control component
  // roots are aliases of its control/ tree, so source pins remain a single SHA.
  if (consolidated) {
    const repository = fs.realpathSync(path.resolve(consolidated));
    const revision = git(["rev-parse", "HEAD"], repository);
    if (!fs.existsSync(path.join(repository, "control/src/portable-config.mjs")))
      throw Error("Consolidated source requires control/src/portable-config.mjs.");
    if (git(["status", "--porcelain", "--untracked-files=no"], repository))
      throw Error("Commit consolidated source changes before installing.");
    const destination = path.join(home, "sources/native");
    run(
      "git",
      ["clone", "--no-hardlinks", "--no-checkout", "--", repository, destination],
      undefined,
      env,
    );
    run("git", ["checkout", "--detach", revision], destination, env);
    selected.native = revision;
    for (const name of ["runtime", "conversation", "workspace"]) {
      fs.symlinkSync(path.join("native", "control"), path.join(home, "sources", name));
      selected[name] = revision;
    }
  } else {
    // Explicit legacy component overrides retain the original setup interface.
    cloneLegacyComponents(options, pins, home, env, selected);
  }
  write(path.join(home, "sources.json"), selected);
  if (options.prepareOnly) return { home, state: "sources-prepared" };
  const native = path.join(home, "sources/native");
  run("npm", ["ci"], native, { ...env, LEFTHOOK: "0" });
  run("npm", ["run", "build:server"], native, env);
  run("npm", ["run", "build:daemon-web-ui"], native, env);
  return compose(home);
}
export function task(home, action, value, parent, description) {
  const result = spawnSync("python3", [path.join(here, "task-catalog.py")], {
    input: JSON.stringify({ home, action, value, parent, description }),
    encoding: "utf8",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(result.stderr.trim() || "Task catalog update failed.");
  return JSON.parse(result.stdout);
}
export async function probe(home) {
  const c = await loadHome(home);
  const { verifyActivation } = await import(
    pathToFileURL(path.join(home, "sources/runtime/src/control/activation.mjs"))
  );
  const boot = verifyActivation();
  const { installedConversation } = await import(
    pathToFileURL(path.join(home, "sources/conversation/orca-conversation/client.mjs"))
  );
  const { DaemonClient } = await import(
    pathToFileURL(path.join(home, "sources/runtime/src/control/client-sdk.mjs"))
  );
  const client = new DaemonClient({
    clientId: "orca-setup-" + randomUUID(),
    clientType: "cli",
    url: c.url,
    password: fs.readFileSync(path.join(c.daemonHome, "controller.secret"), "utf8"),
    connectTimeoutMs: 5000,
  });
  try {
    await client.connect();
    const catalog = await client.invokePluginRpc("orca-organization", "organization.tasks", {
      cursor: 0,
    });
    const management = await client.invokePluginRpc("orca-organization", "organization.manage", {
      action: "health",
    });
    if (!catalog?.available || management?.status !== "observed")
      throw Error("Workspace plugin is unavailable");
    const response = await fetch(`http://127.0.0.1:${c.daemon.port}/`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok || !(response.headers.get("content-type") ?? "").includes("text/html"))
      throw Error("Bundled browser client is unavailable");
    return {
      boot,
      workspace: { available: true, taskCount: catalog.total },
      web: true,
      sessions: await installedConversation()({ action: "list" }),
      hosts: await installedConversation()({ action: "hosts" }),
    };
  } finally {
    await client.close();
  }
}
async function reachable(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return response.ok && (response.headers.get("content-type") ?? "").includes("text/html");
  } catch {
    return false;
  }
}
// Native first: hand the running installation to the installed app when there is one, and
// fall back to the bundled browser client otherwise. Nothing here starts a daemon.
export async function open(home, options = {}) {
  const launchEnv = appLaunchEnvironment();
  if (!fs.existsSync(path.join(home, "installed.json"))) throw Error("Installation is incomplete.");
  const c = await loadHome(home);
  const url = `http://127.0.0.1:${c.daemon.port}`;
  const passwordFile = path.join(c.daemonHome, "controller.secret");
  if (!(await reachable(url)))
    throw Error(
      `No portable daemon answering on ${url}. Start it first: ${shellQuote(process.execPath)} ${shellQuote(selfPath)} start --home ${shellQuote(home)}`,
    );
  const app = options.browser
    ? { found: false, path: null, candidates: [], reason: "browser" }
    : resolveNativeApp({ explicit: options.app });
  // Only macOS has a launcher here; elsewhere the address is printed and opened by hand.
  const opened = !options.print && process.platform === "darwin";
  if (opened) {
    const target = app.found ? ["-a", app.path ?? APP_NAME] : [url];
    const launch = spawnSync("/usr/bin/open", target, {
      env: launchEnv,
      stdio: "inherit",
      shell: false,
    });
    if (launch.error) throw launch.error;
    if (launch.status !== 0)
      throw Error(`Could not open ${target.at(-1)} (open exited ${launch.status}).`);
  }
  console.log(nativeHandoffReport({ app, url, port: c.daemon.port, passwordFile, opened }));
  return { url, app, opened };
}
async function start(home) {
  const c = await loadHome(home),
    env = cleanEnvironment(home);
  if (!fs.existsSync(path.join(home, "installed.json"))) throw Error("Installation is incomplete.");
  const children = new Set();
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    for (const child of children) child.kill("SIGTERM");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const launch = (cmd, args) => {
    const child = spawn(cmd, args, { env, stdio: "inherit", shell: false });
    children.add(child);
    child.on("error", (error) => {
      console.error(error.message);
      process.exitCode = 1;
      stop();
    });
    child.on("exit", (code) => {
      children.delete(child);
      if (!stopping) {
        process.exitCode = code || 1;
        stop();
      }
    });
    return child;
  };
  try {
    launch(process.execPath, [
      path.join(home, "run/native/packages/server/dist/scripts/supervisor-entrypoint.js"),
    ]);
    const { verifyActivation } = await import(
      pathToFileURL(path.join(home, "sources/runtime/src/control/activation.mjs"))
    );
    let ready = false;
    for (let n = 0; n < 120; n++) {
      if (stopping) break;
      try {
        verifyActivation();
        ready = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (stopping) return;
    if (!ready)
      throw Error("Daemon did not establish its admission receipt; inspect startup logs.");
    launch("python3", [path.join(home, "sources/runtime/src/control/process.py")]);
    let healthy = false;
    for (let n = 0; n < 120; n++) {
      if (stopping) break;
      try {
        await probe(home);
        healthy = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (stopping) return;
    if (!healthy) throw Error("Controller/workspace startup did not complete; inspect the logs.");
    // start stays in the foreground and launches nothing; `open` performs the handoff.
    // The printed command carries this Node, this script and this home, so it runs from
    // any working directory and selects the installation the reader is looking at.
    console.log(
      nativeHandoffReport({
        app: resolveNativeApp(),
        url: `http://127.0.0.1:${c.daemon.port}`,
        port: c.daemon.port,
        passwordFile: path.join(c.daemonHome, "controller.secret"),
        opened: false,
        command: `${shellQuote(process.execPath)} ${shellQuote(selfPath)} open --home ${shellQuote(home)}`,
      }) + "\nRun it in another terminal. Ctrl-C stops this installation.",
    );
  } catch (error) {
    stop();
    throw error;
  }
}
async function main() {
  const args = process.argv.slice(2),
    command = args.shift();
  const take = (flag, fallback) => {
    const i = args.indexOf(flag);
    if (i < 0) return fallback;
    if (!args[i + 1]) throw Error(`Missing value for ${flag}`);
    const value = args[i + 1];
    args.splice(i, 2);
    return value;
  };
  const home = path.resolve(
    take("--home", process.env.ORCA_HOME ?? path.join(os.homedir(), ".local/share/orca")),
  );
  if (command === "init")
    console.log(JSON.stringify({ home: initHome(home, Number(take("--port", 6791))) }));
  else if (command === "install") {
    const options = {
      port: Number(take("--port", 6791)),
      prepareOnly: args.includes("--prepare-only"),
      source: take("--source"),
    };
    for (const name of ["native", "runtime", "conversation", "workspace"])
      options[name] = take(`--${name}-source`);
    console.log(JSON.stringify(await install(home, options)));
  } else if (command === "start") await start(home);
  else if (command === "open")
    await open(home, {
      app: take("--app"),
      browser: args.includes("--browser"),
      print: args.includes("--print"),
    });
  else if (command === "task")
    console.log(JSON.stringify(task(fs.realpathSync(home), ...args), null, 2));
  else if (command === "project") {
    const [action, name, description] = args;
    if (action !== "add") throw Error("Use: project add NAME [DESCRIPTION].");
    console.log(
      JSON.stringify(task(fs.realpathSync(home), "project-add", name, null, description), null, 2),
    );
  } else if (command === "conversation" || command === "memory") {
    await loadHome(home);
    const env = cleanEnvironment(home);
    run(
      process.execPath,
      [
        path.join(
          home,
          command === "conversation"
            ? "sources/conversation/orca-conversation/client.mjs"
            : "sources/runtime/src/portable-memory/entry.mjs",
        ),
      ],
      undefined,
      { ...env, ORCA_MEMORY_CLIENT: "local" },
    );
  } else if (command === "doctor") {
    console.log(JSON.stringify(await probe(home), null, 2));
  } else
    console.log(
      "Use: node scripts/orca/bootstrap.mjs install|init|start|open|doctor|project|task|conversation|memory [--home PATH]. `open` takes --app PATH, --browser and --print. See docs/portable-setup.md.",
    );
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
