// Codex half of switch-continuity. Scratch provider and homes; exercises the packaged
// RPC used by the picker (account id) and /account (name). No real CLI or credentials.
// node gate-switch-continuity-codex.mjs <staged Fulcra.app> <fresh label> <port>
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const HERE = path.dirname(new URL(import.meta.url).pathname);
const [appArg, label, portArg] = process.argv.slice(2);
const APP = fs.realpathSync(appArg),
  PORT = Number(portArg);

const OUT = path.join(
  process.env.U8_GATE_OUT ?? "/private/tmp/fulcra-u8-gates",
  "switch-continuity-codex",
  label,
);
if (fs.existsSync(OUT)) throw Error("Use a fresh evidence label");
fs.mkdirSync(OUT, { recursive: true });
const ROOT = fs.mkdtempSync(`/private/tmp/e69gp-${label}-`),
  PH = path.join(ROOT, "paseo"),
  HOME = path.join(ROOT, "home"),
  BIN = path.join(ROOT, "bin");
const NODE = process.execPath,
  PRODUCT = path.resolve(HERE, "../../..");
const PROBE = process.env.U8_PROBE_CLIENT;
if (!PROBE) throw Error("U8_PROBE_CLIENT must name the candidate-matching client bundle");
const FAKE = new URL("./fake-codex-continuity.cjs", import.meta.url).pathname,
  FAKELOG = path.join(ROOT, "fake-codex.jsonl");
const bcrypt = createRequire(`${PRODUCT}/packages/app/package.json`)("bcryptjs");
const R = path.join(APP, "Contents/Resources"),
  PLUGIN = "orca-organization-next";
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
const result = { label, app: APP, probe: PROBE, checks: [] };
const save = () =>
  fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(result, null, 1) + "\n");
const check = (name, ok, detail) => {
  result.checks.push({ name, ok: !!ok, detail });
  save();
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name} ${detail === undefined ? "" : JSON.stringify(detail).slice(0, 300)}`,
  );
};
const fakeLog = () =>
  fs.existsSync(FAKELOG)
    ? fs
        .readFileSync(FAKELOG, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
const secret = crypto.randomBytes(32).toString("base64url");

for (const d of [HOME, BIN, PH, path.join(ROOT, "tmp")])
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(PH, "controller.secret"), secret, { mode: 0o600 });
// The fake `codex login`: one "browser sign-in" writes the account's auth.json (a fake secret the gate greps for).
fs.writeFileSync(
  path.join(BIN, "codex"),
  `#!${NODE}\nconst fs=require("fs"),p=require("path"),c=require("crypto");if(process.argv[2]!=="login"){process.exit(1)}const h=process.env.CODEX_HOME;fs.mkdirSync(h,{recursive:true});fs.writeFileSync(p.join(h,"auth.json"),JSON.stringify({tokens:{access_token:"FAKE-CODEX-SECRET-"+c.randomBytes(16).toString("hex")}}),{mode:0o600});process.exit(0);\n`,
  { mode: 0o755 },
);
fs.mkdirSync(path.join(PH, "projects"), { recursive: true });
const proj = path.join(ROOT, "project");
fs.mkdirSync(proj);
const at = "2026-10-01T00:00:00.000Z";
fs.writeFileSync(
  path.join(PH, "projects/projects.json"),
  JSON.stringify([
    {
      projectId: "prj_gp",
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
      listen: `127.0.0.1:${PORT}`,
      hostnames: [],
      mcp: { enabled: false, injectIntoAgents: false },
      relay: { enabled: false },
      auth: { password: bcrypt.hashSync(secret, 12) },
    },
    agents: { providers: { codex: { command: [NODE, FAKE], env: { FAKE_CODEX_LOG: FAKELOG } } } },
    features: {
      webUi: { enabled: false },
      dictation: { enabled: false },
      voiceMode: { enabled: false },
    },
  }),
);
const env = {
  PATH: `${BIN}:/usr/bin:/bin:/usr/sbin:/sbin`,
  HOME,
  USER: process.env.USER,
  TMPDIR: path.join(ROOT, "tmp") + "/",
  LANG: "en_US.UTF-8",
  PASEO_HOME: PH,
};
let daemon, d;
try {
  daemon = spawn(
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
        PASEO_LISTEN: `127.0.0.1:${PORT}`,
        ELECTRON_RUN_AS_NODE: "1",
        PASEO_NODE_ENV: "production",
        PASEO_CLI: path.join(R, "bin/paseo"),
        FULCRA_COMMAND_CENTRE: "1",
      },
      detached: true,
      stdio: [
        "ignore",
        fs.openSync(path.join(OUT, "daemon.log"), "w"),
        fs.openSync(path.join(OUT, "daemon.log"), "a"),
      ],
    },
  );
  const up = await until(
    async () =>
      fs.existsSync(path.join(PH, "command-centre/control.sock")) && (await listening(PORT)),
    300000,
  );
  if (!up) throw Error("the service did not come up");
  await delay(3000);
  // The installation's programme task in its local catalog (a real installation has it; a fresh scratch one does not).
  {
    const CC = path.join(PH, "command-centre"),
      cfg = JSON.parse(fs.readFileSync(path.join(CC, "config.json"), "utf8")),
      cat = JSON.parse(fs.readFileSync(path.join(CC, "tasks.json"), "utf8"));
    const pid = cfg.authority.programmeId;
    if (!(cat.issues ?? []).some((i) => i.id === pid))
      cat.issues = [
        ...(cat.issues ?? []),
        {
          id: pid,
          companyId: cfg.authority.companyId,
          parentId: null,
          assigneeUserId: "local-board",
          assigneeAgentId: null,
          status: "in_progress",
          title: "Gate programme",
          projectId: null,
        },
      ];
    const tmp = path.join(CC, `.tasks.json-${crypto.randomUUID()}`);
    fs.writeFileSync(tmp, JSON.stringify(cat, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, path.join(CC, "tasks.json"));
  }
  const { DaemonClient } = await import(pathToFileURL(PROBE).href);
  d = new DaemonClient({
    url: `ws://127.0.0.1:${PORT}/ws`,
    clientId: `gate-pool-${crypto.randomUUID()}`,
    clientType: "cli",
    password: secret,
    connectTimeoutMs: 10000,
    reconnect: { enabled: false },
  });
  await d.connect();
  if (!String(d.listProviderUsage).includes("agentId"))
    throw Error("Use the candidate-8 or newer probe client: older clients discard usage agentId");
  const rpc = (m, input = {}) => d.invokePluginRpc(PLUGIN, m, input);
  await rpc("organization.accounts.add", { provider: "codex", name: "Alpha" });
  await rpc("organization.accounts.add", { provider: "codex", name: "Beta" });
  const ready = await until(async () => {
    const v = await rpc("organization.accounts");
    return v.accounts.filter((a) => a.status.state === "ok").length === 2 && v;
  }, 60000);
  if (!ready) throw Error("Scratch accounts did not sign in");
  const alpha = ready.accounts.find((a) => a.name === "Alpha").id,
    beta = ready.accounts.find((a) => a.name === "Beta").id;
  const list = async () =>
    (await d.fetchAgents({ page: { limit: 200 } })).entries.map((e) => e.agent);
  const before = new Set((await list()).map((a) => a.id));
  await rpc("organization.manage", {
    action: "create",
    messageId: crypto.randomUUID(),
    provider: "codex",
    title: "Codex continuity",
    role: "implementation",
  });
  const agent = await until(async () => (await list()).find((a) => !before.has(a.id)), 60000);
  if (!agent) throw Error("Session was not created");
  const sid = agent.id,
    marker = crypto.randomUUID();
  const timelineRead = () =>
    d.fetchAgentTimeline(sid, { limit: 200, direction: "tail", projection: "canonical" });
  const timeline = async () => (await timelineRead()).entries ?? [];
  const idle = () =>
    until(async () => (await list()).find((a) => a.id === sid)?.status === "idle", 30000);
  await d.sendMessage(sid, `SET_MARKER:${marker}`);
  const seeded = await until(
    () => fakeLog().find((e) => e.kind === "turn" && e.input.includes("SET_MARKER")),
    60000,
  );
  await idle();
  if (!seeded) throw Error("Marker turn did not finish");
  const thread = seeded.thread,
    historyBefore = await timelineRead(),
    historyEntries = historyBefore.entries ?? [];
  const transcript = fs.realpathSync(
    path.join(PH, "command-centre/accounts/codex", alpha, "sessions", `fake-${thread}.json`),
  );
  check(
    "C0 Codex marker stored on Alpha",
    seeded.account === alpha &&
      JSON.parse(fs.readFileSync(transcript)).turns.some((t) => t.input.includes(marker)),
  );
  for (const [to, account, labelText, entryPoint] of [
    [beta, beta, "Beta", "picker account id"],
    [alpha, "Alpha", "Alpha", "/account name"],
  ]) {
    const moved = await rpc("organization.accounts.switch", { agentId: sid, account });
    check(`C1 ${entryPoint}: switch accepted`, moved.ok === true, { message: moved.message });
    if (!moved.ok) continue;
    await d.sendMessage(sid, "RECALL_MARKER");
    const recalled = await until(
      async () => (await timeline()).some((e) => e.item?.text === `marker:${marker} on ${to}`),
      60000,
    );
    await idle();
    const sessions = await list(),
      current = await rpc("organization.accounts.session", { agentId: sid });
    const sameTranscript =
      fs.realpathSync(
        path.join(PH, "command-centre/accounts/codex", to, "sessions", `fake-${thread}.json`),
      ) === transcript;
    const historyAfter = await timelineRead(),
      nowHistory = historyAfter.entries ?? [];
    const usage = await d.listProviderUsage({ agentId: sid });
    const quota = usage.providers.find((p) => p.providerId === "codex");
    const nativeQuota = await d.readAgentQuota(sid);
    check(
      `C2 ${labelText}: same session and transcript, marker recalled, no new chat`,
      recalled &&
        sameTranscript &&
        historyAfter.epoch === historyBefore.epoch &&
        sessions.length === before.size + 1 &&
        sessions.some((a) => a.id === sid) &&
        historyEntries.length > 0 &&
        historyEntries.every(
          (old) =>
            Number.isInteger(old.seqStart) &&
            Number.isInteger(old.seqEnd) &&
            nowHistory.some(
              (e) =>
                e.seqStart === old.seqStart &&
                e.seqEnd === old.seqEnd &&
                JSON.stringify(e.item) === JSON.stringify(old.item),
            ),
        ) &&
        fakeLog().filter((e) => e.kind === "thread-start").length === 1,
    );
    check(
      `C3 ${labelText}: account and usage label follow switch`,
      current.current === to &&
        sessions.find((a) => a.id === sid)?.labels?.["fulcra.account-name"] === labelText &&
        quota?.sourceLabel === labelText &&
        !!nativeQuota.quota.accountScope &&
        quota?.admission?.accountScope === nativeQuota.quota.accountScope,
      { current: current.current, usageLabel: quota?.sourceLabel ?? null },
    );
  }
} catch (e) {
  result.error = String(e?.message ?? e).slice(0, 300);
  console.log("FAIL error", result.error);
} finally {
  try {
    await d?.close();
  } catch {}
  if (daemon) {
    try {
      process.kill(-daemon.pid, "SIGTERM");
    } catch {}
    await delay(2500);
    try {
      process.kill(-daemon.pid, "SIGKILL");
    } catch {}
  }
  result.pass = !result.error && result.checks.length === 7 && result.checks.every((c) => c.ok);
  save();
  console.log(
    `${result.checks.filter((c) => c.ok).length}/${result.checks.length} passed; evidence ${OUT}`,
  );
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(result.pass ? 0 : 1);
}
