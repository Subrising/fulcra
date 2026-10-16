// Scratch-only integration fixture. Native sessions use the test provider. No credential backend is called.
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { compilePlugin } from "../plugins/compiler.js";
import { createTestPaseoDaemon } from "./paseo-daemon.js";
import { hashDaemonPassword } from "../auth.js";
import { createTestAgentClients } from "./fake-agent-client.js";
import { DaemonClient } from "./daemon-client.js";

const repository = fileURLToPath(new URL("../../../../../", import.meta.url));

export async function createPhoneAccountFixture(relayEndpoint?: string) {
  const scratchParent = path.join(repository, ".dev");
  await mkdir(scratchParent, { recursive: true });
  const root = await realpath(await mkdtemp(path.join(scratchParent, "phone-account-")));
  const directory = path.join(root, "bundles", "orca-organization-next");
  const source = path.join(root, "source");
  await mkdir(directory, { recursive: true });
  await cp(path.join(repository, "control/orca-organization"), source, {
    recursive: true,
    filter: (file) =>
      !file.split(path.sep).some((part) => ["node_modules", "runtime"].includes(part)),
  });
  const poolRoot = path.join(root, "home", ".paseo", "command-centre");
  await writeFile(
    path.join(source, "index.client.tsx"),
    `import { registerAccountSwitch } from './client/switch-account';
export default function contribute(client) { return registerAccountSwitch(client); }`,
  );
  await writeFile(
    path.join(source, "index.server.ts"),
    `
import { createAccountHandlers, controllerTakeOver } from './server/accounts-rpc';
import { withManagementInvocation, invokeManagement } from './server/management-context.mjs';
import { accountsRpc, sessionAccountsRpc, accountSwitchRpc, accountAddRpc, accountUpdateRpc, poolSettingsRpc } from './shared/accounts';
export default function(server) {
 const h = createAccountHandlers({ root: () => ${JSON.stringify(poolRoot)}, configRoles: () => null,
   keychain: { get: async () => null, put: async () => { throw Error('No credentials in this fixture'); }, remove: async () => {} },
   takeOver: controllerTakeOver(invokeManagement) });
 for (const [contract, run, readOnly] of [
   [sessionAccountsRpc, (i, c) => h.session(i, c.paseo), true],
   [accountSwitchRpc, (i, c) => h.switch(i, c.paseo), false],
   [accountsRpc, (i, c) => h.read(c.paseo), true],
   [accountAddRpc, (i) => h.add(i), false],
   [accountUpdateRpc, (i) => h.update(i), false],
   [poolSettingsRpc, (i) => h.settings(i), false],
 ]) server.handle(contract, (i, c) => withManagementInvocation(c, readOnly, () => run(i, c)), { readOnly });
 return () => {};
}`,
  );
  const version = "0.11.4";
  const bundles = await compilePlugin({
    client: path.join(source, "index.client.tsx"),
    server: path.join(source, "index.server.ts"),
  });
  const manifest: Record<string, string | number> = { version: 1, sdkVersion: version };
  for (const target of ["client", "server"] as const) {
    const code = bundles[`${target}Bundle`]!;
    await writeFile(path.join(directory, `runtime.${target}.js`), code);
    await writeFile(path.join(directory, `index.${target}.ts`), "// Verified runtime fixture.\n");
    manifest[target] = createHash("sha256").update(code).digest("hex");
  }
  await writeFile(path.join(directory, "runtime-manifest.json"), JSON.stringify(manifest));
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({ id: "orca-organization-next", requirements: { paseo: ">=0.11.0" } }),
  );
  const controlUrl = pathToFileURL(path.join(repository, "control/src/control")).href;
  await writeFile(
    path.join(directory, "index.host.js"),
    `
export { hostContract, default } from '${controlUrl}/distribution-host.mjs';
import { createDistribution as actual } from '${controlUrl}/distribution-host.mjs';
let ready;
export const fixtureReady = new Promise((resolve) => { ready = resolve; });
export function createDistribution(options) {
 const d = actual(options);
 return { ...d, get ready() { return d.ready; }, start(host) {
   d.start({ ...host, createChannel(child, ...args) {
     child.on('message', (frame) => { if (frame.type === 'ready') ready(); });
     return host.createChannel(child, ...args);
   } });
 } };
}`,
  );
  await writeFile(
    path.join(directory, "controller.mjs"),
    `import '${controlUrl}/distribution-child.mjs';`,
  );
  const daemon = await createTestPaseoDaemon({
    paseoHomeRoot: path.join(root, "home"),
    daemonVersion: version,
    agentClients: createTestAgentClients({ supportsMcpServers: true }),
    auth: { password: hashDaemonPassword("scratch-fixture-password") },
    bundledPluginsDirectory: path.dirname(directory),
    mcpEnabled: false,
    ...(relayEndpoint
      ? { relayEnabled: true, relayEndpoint, relayUseTls: false, relayPublicUseTls: false }
      : {}),
  });
  const owner = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: version,
    password: "scratch-fixture-password",
  });
  try {
    const readiness = await import(pathToFileURL(path.join(directory, "index.host.js")).href);
    let readyTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      readiness.fixtureReady,
      new Promise((_, reject) => {
        readyTimer = setTimeout(
          () => reject(Error("Scratch controller startup timed out")),
          30_000,
        );
      }),
    ]).finally(() => clearTimeout(readyTimer));
    await owner.connect();
    await owner.fetchAgents();
    const cwd = path.join(root, "workspace");
    await mkdir(cwd);
    const project = await owner.addProject(cwd);
    if (!project.project) throw Error("Scratch project was refused");
    const workspace = await owner.createWorkspace({
      idempotencyKey: "phone-account",
      source: { kind: "directory", path: cwd },
    });
    if (!workspace.workspace) throw Error("Scratch workspace was refused");
    const agent = await owner.createAgent({
      provider: "claude",
      cwd,
      workspaceId: workspace.workspace.id,
      initialPrompt: "Synthetic account switch proof.",
    });
    await owner.waitForAgentUpsert(agent.id, (a) => a.status === "idle");
    return {
      root,
      poolRoot,
      daemon,
      owner,
      agent,
      workspaceId: workspace.workspace.id,
      async close() {
        await owner.close();
        await daemon.close();
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await owner.close();
    await daemon.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export async function startPhoneAccountRelay() {
  const { spawn } = await import("node:child_process");
  const net = await import("node:net");
  const port = await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(Error("No scratch relay port"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
  const child = spawn(
    process.execPath,
    [
      path.join(repository, "node_modules/wrangler/bin/wrangler.js"),
      "dev",
      "--local",
      "--var",
      "PASEO_RELAY_UPSTREAM:",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--live-reload=false",
      "--show-interactive-dev-session=false",
    ],
    {
      cwd: path.join(repository, "packages/relay"),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    },
  );
  const close = () => {
    if (child.pid && child.exitCode === null) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        close();
        reject(Error("Scratch relay startup timed out"));
      }, 60_000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(Error(`Scratch relay exited: ${code}`));
      });
      child.stdout.on("data", (bytes: Buffer) => {
        if (bytes.toString().includes(`Ready on http://127.0.0.1:${port}`)) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.stderr.on("data", () => {});
    });
    return { endpoint: `127.0.0.1:${port}`, port, close };
  } catch (error) {
    close();
    throw error;
  }
}
