// Focused N gate, same scratch staged-host harness as gate-modes. No real provider.
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const HERE = path.dirname(new URL(import.meta.url).pathname);
const [appArg, label, miniArg] = process.argv.slice(2);
const APP = fs.realpathSync(appArg),
  R = path.join(APP, "Contents/Resources"),
  PLUGIN = "orca-organization-next";

const OUT = path.join(
  process.env.U8_GATE_OUT ?? "/private/tmp/fulcra-u8-gates",
  "pending-permission",
  label,
);
if (fs.existsSync(OUT)) {
  console.log(`HOLD fresh label only: ${OUT}`);
  process.exit(3);
}
fs.mkdirSync(OUT, { recursive: true });
const ROOT = fs.mkdtempSync(`/private/tmp/e69gm-${label}-`),
  NODE = process.execPath,
  PRODUCT = path.resolve(HERE, "../../..");
const PROBE = process.env.U8_PROBE_CLIENT;
if (!PROBE) throw Error("U8_PROBE_CLIENT must name the candidate-matching client bundle");
const FAKE_CODEX = path.join(HERE, "fake-codex-app-server.cjs"),
  FAKE_CLAUDE = path.join(HERE, "fake-claude-cli.cjs");
const bcrypt = createRequire(`${PRODUCT}/packages/app/package.json`)("bcryptjs");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, every = 500) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    await delay(every);
  }
  return null;
};
const listening = (port) =>
  new Promise((res) => {
    const s = net.connect(port, "127.0.0.1");
    s.once("connect", () => {
      s.destroy();
      res(true);
    });
    s.once("error", () => res(false));
  });
const result = { label, app: APP, checks: [], matrix: [] };
const save = () =>
  fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(result, null, 1) + "\n");
const check = (name, ok, detail) => {
  result.checks.push({ name, ok: !!ok, detail });
  save();
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name} ${detail === undefined ? "" : JSON.stringify(detail).slice(0, 500)}`,
  );
};

// ---- one scratch host (the Mini shape with Command Centre, or the MacBook shape without)
function host(name, port, commandCentre) {
  const H = path.join(ROOT, name),
    PH = path.join(H, "paseo"),
    HOME = path.join(H, "home"),
    proj = path.join(H, "project");
  for (const d of [PH, HOME, proj, path.join(H, "tmp"), path.join(PH, "projects")])
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  const secret = crypto.randomBytes(32).toString("base64url");
  fs.writeFileSync(path.join(PH, "controller.secret"), secret, { mode: 0o600 });
  const claudeBin = path.join(H, "claude");
  fs.writeFileSync(claudeBin, `#!/bin/sh\nexec "${NODE}" "${FAKE_CLAUDE}" "$@"\n`, { mode: 0o700 });
  const logs = {
    claude: path.join(H, "fake-claude.jsonl"),
    codex: path.join(H, "fake-codex.jsonl"),
  };
  const at = "2026-10-01T00:00:00.000Z";
  fs.writeFileSync(
    path.join(PH, "projects/projects.json"),
    JSON.stringify([
      {
        projectId: `prj_${name}`,
        rootPath: proj,
        kind: "non_git",
        displayName: "project",
        customName: null,
        projectKey: null,
        customIconRevision: null,
        createdAt: at,
        updatedAt: at,
        archivedAt: null,
      },
    ]),
  );
  fs.writeFileSync(
    path.join(PH, "config.json"),
    JSON.stringify({
      version: 1,
      daemon: {
        listen: `127.0.0.1:${port}`,
        hostnames: [],
        mcp: { enabled: true, injectIntoAgents: true },
        relay: { enabled: false },
        auth: { password: bcrypt.hashSync(secret, 12) },
      },
      agents: {
        providers: {
          claude: { command: [claudeBin], env: { FAKE_CLAUDE_LOG: logs.claude } },
          codex: { command: [NODE, FAKE_CODEX], env: { FAKE_CODEX_LOG: logs.codex } },
        },
      },
      features: {
        webUi: { enabled: false },
        dictation: { enabled: false },
        voiceMode: { enabled: false },
      },
    }),
  );
  const env = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME,
    USER: process.env.USER,
    TMPDIR: path.join(H, "tmp") + "/",
    LANG: "en_US.UTF-8",
    PASEO_HOME: PH,
  };
  const logf = path.join(OUT, `daemon-${name}.log`);
  const daemon = spawn(
    path.join(APP, "Contents/MacOS/Fulcra"),
    [
      path.join(R, "app.asar.unpacked/dist/daemon/node-entrypoint-runner.js"),
      "node-script",
      path.join(R, "app.asar/node_modules/@getpaseo/server/dist/scripts/supervisor-entrypoint.js"),
    ],
    {
      cwd: R,
      env: {
        ...env,
        PASEO_LISTEN: `127.0.0.1:${port}`,
        ELECTRON_RUN_AS_NODE: "1",
        PASEO_NODE_ENV: "production",
        PASEO_CLI: path.join(R, "bin/paseo"),
        ...(commandCentre ? { FULCRA_COMMAND_CENTRE: "1" } : {}),
      },
      detached: true,
      stdio: ["ignore", fs.openSync(logf, "w"), fs.openSync(logf, "a")],
    },
  );
  return { name, port, PH, HOME, proj, secret, env, logs, daemon, commandCentre };
}
async function up(h) {
  const ok = await until(
    async () =>
      (!h.commandCentre || fs.existsSync(path.join(h.PH, "command-centre/control.sock"))) &&
      (await listening(h.port)),
    300000,
  );
  if (!ok) throw Error(`${h.name}: the service did not come up`);
  await delay(3000);
  const { DaemonClient } = await import(pathToFileURL(PROBE).href);
  h.d = new DaemonClient({
    url: `ws://127.0.0.1:${h.port}/ws`,
    clientId: `gate-modes-${crypto.randomUUID()}`,
    clientType: "cli",
    password: h.secret,
    connectTimeoutMs: 10000,
    reconnect: { enabled: false },
  });
  h.frames = [];
  h.d.subscribeRawMessages((m) => {
    if (/permission/i.test(String(m?.type ?? "")))
      h.frames.push({
        at: Date.now(),
        type: m.type,
        agentId: m.payload?.agentId ?? m.agentId ?? null,
      });
  });
  await h.d.connect();
  h.rpc = (m, input = {}) => h.d.invokePluginRpc(PLUGIN, m, input);
  h.ws = (await h.d.fetchWorkspaces({ page: { limit: 10 } })).entries?.[0] ?? null;
  return h;
}
async function down(h) {
  try {
    await h?.d?.close?.();
  } catch {}
  if (h?.daemon) {
    try {
      process.kill(-h.daemon.pid, "SIGTERM");
    } catch {}
    await delay(2500);
    try {
      process.kill(-h.daemon.pid, "SIGKILL");
    } catch {}
  }
}
const agents = async (h) =>
  (await h.d.fetchAgents({ page: { limit: 200 } })).entries?.map((e) => e.agent).filter(Boolean) ??
  [];

let mini;
try {
  mini = host("mini", Number(miniArg), true);
  await up(mini);
  for (const provider of ["claude", "codex"]) {
    const created = await mini.d.createAgent({
      provider,
      cwd: mini.proj,
      ...(mini.ws ? { workspaceId: mini.ws.id } : {}),
      title: `Pending ${provider} permission`,
    });
    const id = created.id ?? created.agent?.id ?? created.agentId;
    await mini.d.sendMessage(id, "SCRIPT_CRED: read the stored credential.");
    const entry = await until(
      async () => (await agents(mini)).find((a) => a.id === id && a.pendingPermissions?.length),
      60000,
      100,
    );
    check(
      `N ${provider} pending permission is Needs you in Sessions`,
      !!entry && entry.requiresAttention === true && entry.attentionReason === "permission",
      {
        status: entry?.status,
        pending: entry?.pendingPermissions?.length,
        attention: entry?.requiresAttention,
        reason: entry?.attentionReason,
      },
    );
    if (entry)
      await mini.d.respondToPermission(id, entry.pendingPermissions[0].id, {
        behavior: "deny",
        message: "Scratch gate denial",
      });
    const cleared = await until(
      async () => {
        const a = (await agents(mini)).find((candidate) => candidate.id === id);
        return a && !a.pendingPermissions?.length && a.attentionReason !== "permission" && a;
      },
      30000,
      100,
    );
    check(`N ${provider} resolved permission clears its attention`, !!cleared, {
      attention: cleared?.requiresAttention,
      reason: cleared?.attentionReason,
    });
  }
} catch (e) {
  result.error = String(e.message).slice(0, 300);
  console.log("FAIL error", result.error);
} finally {
  await down(mini);
  result.pass = !result.error && result.checks.length === 4 && result.checks.every((c) => c.ok);
  save();
  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log(`evidence ${OUT}`);
  process.exit(result.pass ? 0 : 1);
}
