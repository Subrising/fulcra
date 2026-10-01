// FIX-8 B-1 gate `switch-continuity` (Claude half, W1), scratch only, on a STAGED packaged candidate. ONE Claude chat,
// the owner's own (an ordinary app chat, the owner's case), is switched A -> B -> A: first through "Switch account…" (the
// panel's organization.accounts.switch with the account id), then through `/account alpha` (the chat command's same RPC
// with the name as typed). The Claude CLI is a stand-in with a real transcript per session id (fake-claude-continuity.cjs),
// so recall proves the SAME conversation was resumed; the Claude tokens are stubs kept by the B6 `security` stand-in.
//   S0 the chat runs on account A and a marker is set before any switch
//   S1 A -> B via "Switch account…": replied ok; the same chat (agent id), no new chat; the same Claude session id
//      resumed with its transcript; the marker is recalled; the relaunch ran with B's credential and B's label; the
//      account binding and the usage meter's label follow (usage label required)
//   S2 B -> A via `/account alpha`: the same checks, back on A
//   S3 no credential in any reply the owner's client received, nor in the stand-in's log
//   node gate-switch-continuity.mjs <Fulcra.app> <client bundle> <label> <daemon port>
// The usage sourceLabel is REQUIRED, including when the offline account read is unavailable.
import { claudeContinuityPassed, switchReplyLabel } from "./switch-gate-checks.mjs";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const [appArg, bundleArg, label, portArg] = process.argv.slice(2);
const APP = fs.realpathSync(appArg),
  PORT = Number(portArg),
  R = path.join(APP, "Contents/Resources");
const HERE = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.join(
  process.env.U8_GATE_OUT ?? "/private/tmp/fulcra-u8-gates",
  "switch-continuity-claude",
  label,
);
if (fs.existsSync(OUT)) {
  console.log(`HOLD fresh label only: ${OUT}`);
  process.exit(3);
}
fs.mkdirSync(OUT, { recursive: true });
const ROOT = fs.mkdtempSync(`/private/tmp/w1sc-${label}-`),
  PH = path.join(ROOT, "paseo"),
  HOME = path.join(ROOT, "home"),
  BIN = path.join(ROOT, "bin");
const NODE = process.execPath,
  PRODUCT = path.resolve(HERE, "../../.."),
  PLUGIN = "orca-organization-next";
const FAKE = path.join(HERE, "fake-claude-continuity.cjs"),
  LOG = path.join(ROOT, "fake-claude.jsonl"),
  STATE = path.join(ROOT, "claude-state");
const SECURITY_FIXTURE = path.resolve(
  HERE,
  "../../orca-organization/server/fake-security.fixture.mjs",
);
const bcrypt = createRequire(`${PRODUCT}/packages/app/package.json`)("bcryptjs");
const c = await import(pathToFileURL(fs.realpathSync(bundleArg)).href);

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, every = 400) => {
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
const result = { label, app: APP, bundle: bundleArg, checks: [] };
const save = () =>
  fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(result, null, 1) + "\n");
const check = (name, ok, detail) => {
  result.checks.push({ name, ok: !!ok, detail });
  save();
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name} ${detail === undefined ? "" : JSON.stringify(detail).slice(0, 600)}`,
  );
};
const jsonl = (f) =>
  fs.existsSync(f)
    ? fs
        .readFileSync(f, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
const hash = (t) => crypto.createHash("sha256").update(t).digest("hex").slice(0, 16);
const replies = path.join(OUT, "replies.jsonl");
const keep = (what, r) => {
  fs.appendFileSync(replies, JSON.stringify({ what, r }) + "\n");
  return r;
};

// ---- scratch home: owner credential, the B6 `security` stand-in, the Claude stand-in, Command Centre on
const secret = crypto.randomBytes(32).toString("base64url");
const tokens = {
  Alpha: "sk-ant-oat01-" + crypto.randomBytes(40).toString("base64url"),
  Beta: "sk-ant-oat01-" + crypto.randomBytes(40).toString("base64url"),
};
for (const d of [HOME, BIN, PH, STATE, path.join(ROOT, "tmp"), path.join(PH, "projects")])
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(PH, "controller.secret"), secret, { mode: 0o600 });
const KC = path.join(ROOT, "keychain"),
  SECURITY = path.join(BIN, "security");
fs.writeFileSync(SECURITY, `#!/bin/sh\nexec "${NODE}" "${SECURITY_FIXTURE}" "$@"\n`, {
  mode: 0o700,
});
const claudeBin = path.join(BIN, "claude");
fs.writeFileSync(claudeBin, `#!/bin/sh\nexec "${NODE}" "${FAKE}" "$@"\n`, { mode: 0o700 });
const proj = path.join(ROOT, "project");
fs.mkdirSync(proj);
const at0 = "2026-10-01T00:00:00.000Z";
fs.writeFileSync(
  path.join(PH, "projects/projects.json"),
  JSON.stringify([
    {
      projectId: "prj_w1sc",
      rootPath: proj,
      kind: "non_git",
      displayName: "project",
      customName: null,
      projectKey: null,
      customIconRevision: null,
      createdAt: at0,
      updatedAt: at0,
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
    agents: {
      providers: {
        claude: { command: [claudeBin], env: { FAKE_CLAUDE_LOG: LOG, FAKE_CLAUDE_STATE: STATE } },
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
  PATH: `${BIN}:/usr/bin:/bin:/usr/sbin:/sbin`,
  HOME,
  USER: process.env.USER,
  TMPDIR: path.join(ROOT, "tmp") + "/",
  LANG: "en_US.UTF-8",
  PASEO_HOME: PH,
  FULCRA_ACCOUNTS_KEYCHAIN: KC,
  FULCRA_ACCOUNTS_SECURITY: SECURITY,
};

let daemon, owner;
try {
  const logf = path.join(OUT, "daemon.log");
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
      stdio: ["ignore", fs.openSync(logf, "w"), fs.openSync(logf, "a")],
    },
  );
  if (
    !(await until(
      async () =>
        fs.existsSync(path.join(PH, "command-centre/control.sock")) && (await listening(PORT)),
      300000,
    ))
  )
    throw Error("the candidate did not come up");
  await delay(3000);
  owner = new c.DaemonClient({
    url: `ws://127.0.0.1:${PORT}/ws`,
    clientId: `w1sc-${crypto.randomUUID()}`,
    clientType: "cli",
    password: secret,
    connectTimeoutMs: 10000,
    reconnect: { enabled: false },
  });
  await owner.connect();
  if (!String(owner.listProviderUsage).includes("agentId"))
    throw Error("Use a candidate-matching client that forwards usage agentId");
  const rpc = async (m, input = {}) => {
    try {
      return keep(m, await owner.invokePluginRpc(PLUGIN, m, input));
    } catch (e) {
      return keep(m, { error: String(e?.message ?? e).slice(0, 300) });
    }
  };
  const ws = (await owner.fetchWorkspaces({ page: { limit: 10 } })).entries?.[0] ?? null;
  const agents = async () =>
    (await owner.fetchAgents({ page: { limit: 200 } })).entries
      ?.map((e) => e.agent)
      .filter(Boolean) ?? [];

  // Two pooled Claude accounts (stub tokens, kept by the `security` stand-in).
  for (const name of ["Alpha", "Beta"])
    keep(
      `add ${name}`,
      await rpc("organization.accounts.add", { provider: "claude", name, token: tokens[name] }),
    );
  const view = await until(async () => {
    const v = await rpc("organization.accounts", {});
    return (v.accounts ?? []).filter((a) => a.provider === "claude").length === 2 ? v : null;
  }, 30000);
  if (!view) throw Error("the two Claude accounts were not added");
  const acct = Object.fromEntries(view.accounts.map((a) => [a.name, a.id]));
  const nameOfHash = (h) => Object.entries(tokens).find(([, t]) => hash(t) === h)?.[0] ?? null;

  // ONE Claude chat, the owner's own; the marker is set before any switch.
  const before = new Set((await agents()).map((a) => a.id));
  const made = await owner.createAgent({
    provider: "claude",
    cwd: proj,
    ...(ws ? { workspaceId: ws.id } : {}),
    title: "Switch continuity chat",
  });
  const chat =
    made?.id ??
    made?.agent?.id ??
    made?.agentId ??
    (await until(async () => (await agents()).find((a) => !before.has(a.id)), 60000))?.id;
  if (!chat) throw Error("the chat was not created");
  const marker = "MARK-" + crypto.randomBytes(6).toString("hex");
  const say = async (text, t = Date.now()) => {
    await owner.sendMessage(chat, text);
    return until(
      () =>
        jsonl(LOG).find(
          (e) => e.at >= t && e.kind === "turn" && e.input.includes(text.slice(0, 40)),
        ),
      60000,
    );
  };
  const first = await say(`REMEMBER ${marker}`);
  const session0 = first?.session ?? null;
  if (
    !(await until(
      async () => (await agents()).find((a) => a.id === chat)?.status === "idle",
      30000,
    ))
  )
    throw Error("Marker turn did not settle before switching");
  const agentCount = (await agents()).length;
  const historyRead = () =>
    owner.fetchAgentTimeline(chat, { limit: 200, direction: "tail", projection: "canonical" });
  const historyBefore = await historyRead();
  const where = async () => {
    const s = await rpc("organization.accounts.session", { agentId: chat });
    return Object.entries(acct).find(([, id]) => id === s.current)?.[0] ?? null;
  };
  const usage = async () => {
    try {
      const u = keep("usage", await owner.listProviderUsage({ agentId: chat }));
      const claude = (u?.providers ?? u?.entries ?? []).find((p) =>
        /claude/i.test(p.providerId ?? p.provider ?? ""),
      );
      return claude
        ? { label: claude.sourceLabel ?? null, error: claude.error ?? null }
        : { label: null, note: "no Claude entry" };
    } catch (e) {
      return { label: null, error: String(e?.message ?? e).slice(0, 120) };
    }
  };
  check(
    "S0 one Claude chat runs on account A and a marker is set before any switch",
    !!first &&
      first.account === "Alpha" &&
      nameOfHash(first.tokenHash) === "Alpha" &&
      (await where()) === "Alpha",
    {
      session: session0,
      turn: first && { account: first.account, token: nameOfHash(first.tokenHash) },
      bound: await where(),
    },
  );

  async function step(id, text, account, want) {
    const t = Date.now();
    const reply = await rpc("organization.accounts.switch", { agentId: chat, account });
    const relaunch = await until(
      () =>
        jsonl(LOG).find(
          (e) => e.at >= t && e.kind === "start" && e.resume && e.session === session0,
        ),
      30000,
    );
    const recalled = await say("RECALL the marker", Date.now());
    if (
      !(await until(
        async () => (await agents()).find((a) => a.id === chat)?.status === "idle",
        30000,
      ))
    )
      throw Error("Recall turn did not settle before inspecting history");
    const all = await agents();
    const historyAfter = await historyRead();
    const facts = {
      reply: switchReplyLabel(reply),
      wireAccount: all.find((a) => a.id === chat)?.labels?.["fulcra.account-name"] ?? null,
      sameHistory:
        historyAfter.epoch === historyBefore.epoch &&
        (historyBefore.entries ?? []).length > 0 &&
        historyBefore.entries.every(
          (old) =>
            Number.isInteger(old.seqStart) &&
            Number.isInteger(old.seqEnd) &&
            (historyAfter.entries ?? []).some(
              (e) =>
                e.seqStart === old.seqStart &&
                e.seqEnd === old.seqEnd &&
                JSON.stringify(e.item) === JSON.stringify(old.item),
            ),
        ),
      sameChat: all.some((a) => a.id === chat),
      newChats: all.length - agentCount,
      resumedSameSession: !!relaunch,
      transcriptFound: relaunch?.transcriptFound ?? null,
      relaunchAccount: relaunch?.account ?? null,
      relaunchToken: relaunch ? nameOfHash(relaunch.tokenHash) : null,
      recall: recalled?.recall ?? null,
      recallSession: recalled?.session ?? null,
      recallAccount: recalled?.account ?? null,
      recallToken: recalled ? nameOfHash(recalled.tokenHash) : null,
      bound: await where(),
      usage: await usage(),
    };
    result[id] = facts;
    save();
    check(
      `${id} ${text}`,
      claudeContinuityPassed(facts, { want, marker, session: session0 }),
      facts,
    );
  }
  await step(
    "S1",
    'A -> B via "Switch account…": the same chat and Claude session resumed with its transcript, the marker recalled, running on B (credential + label), bound to B',
    acct.Beta,
    "Beta",
  );
  await step(
    "S2",
    "B -> A via /account alpha: the same chat and session, the marker recalled again, back on A (credential + label), bound to A",
    "alpha",
    "Alpha",
  );
} catch (e) {
  result.error = String(e?.message ?? e)
    .split("\n")[0]
    .slice(0, 300);
  save();
  console.log("ERROR", result.error);
} finally {
  try {
    await owner?.close?.();
  } catch {}
  if (daemon) {
    try {
      process.kill(-daemon.pid, "SIGTERM");
    } catch {}
    await until(async () => !(await listening(PORT)), 30000);
    try {
      process.kill(-daemon.pid, "SIGKILL");
    } catch {}
  }
  // S3: no credential in anything the owner's client received, nor in the stand-in's own log.
  const seen = [
    fs.existsSync(replies) ? fs.readFileSync(replies, "utf8") : "",
    fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8") : "",
  ].join("\n");
  const hits = Object.values(tokens).filter((t) => seen.includes(t)).length;
  if (result.checks.length)
    check(
      "S3 no credential in any reply to the owner's client or in the provider log",
      hits === 0 && seen.length > 0,
      { needles: 2, hits },
    );
  if (fs.existsSync(LOG)) fs.copyFileSync(LOG, path.join(OUT, "fake-claude.jsonl"));
  result.pass = !result.error && result.checks.length === 4 && result.checks.every((x) => x.ok);
  save();
  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log(
    `${result.checks.filter((x) => x.ok).length}/${result.checks.length} passed${result.error ? " (error: " + result.error + ")" : ""}`,
  );
  process.exit(result.pass ? 0 : 1);
}
