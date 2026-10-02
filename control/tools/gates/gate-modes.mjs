// Update-7 gate (default permission modes; David 01:29Z: "auto / full-access; no accept/deny unless necessary"), scratch
// only, on the REAL packaged candidate. Providers are stand-ins: fake-claude-cli.cjs (the Agent SDK's stream-json CLI;
// the real CLI is never run -- it would read the login Keychain) and fake-codex-app-server.cjs. Nothing reaches an account.
//   M  the Mini shape (Command Centre on): a new Claude and a new Codex session through EACH create path --
//      P1 the app/UI create, P2 `paseo run` from a lead, P3 manager_create_worker, P4 role_start_session,
//      P5 the controller create (the launcher's and Command Centre's), P6 the agent tools' create_agent --
//      record Claude `auto` and Codex `full-access`, and the provider is launched that way (Claude --permission-mode auto;
//      Codex approvalPolicy never + sandbox danger-full-access)
//   B  the MacBook shape (a plain host, Command Centre off): the paths a plain host has (P1, P2, P6). Claude auto; Codex
//      full-access on every host, including hosts without Command Centre
//   C  a child is never more permissive than its caller (W3 P-3): a Claude-auto lead's Codex children (paseo run,
//      create_agent) are auto-review; the children of plan/default leads stay restricted, including via paseo run
//   X  an explicit mode still wins (P1 with a chosen mode)
//   Z  a scripted Claude and a scripted Codex session doing an MCP tool call and a file write complete with ZERO approvals
//      reaching the owner (no pending permission, no permission request frame), the calls allowed
//   K  a credential/Keychain read still escalates: a pending permission reaches the owner, is shown as needing them
//      (Sessions: pending), and the owner's deny is what the provider gets
//   N  while that permission is pending, Sessions shows the session as needing the owner -- never just "running"
//   node gate-modes.mjs <Fulcra.app> <label> <mini port> <plain port>
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const [appArg, label, miniArg, plainArg] = process.argv.slice(2);
if (
  !/^[A-Za-z0-9_-]{1,24}$/.test(label ?? "") ||
  ![miniArg, plainArg].every(
    (p) =>
      Number.isInteger(Number(p)) && Number(p) > 1024 && Number(p) < 65536 && Number(p) !== 6767,
  ) ||
  miniArg === plainArg
)
  throw Error("Fresh label and two distinct scratch ports (never 6767) required");
const APP = fs.realpathSync(appArg),
  R = path.join(APP, "Contents/Resources"),
  PLUGIN = "orca-organization-next";
const HERE = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.resolve(process.env.U8_GATE_OUT ?? "./gate-modes-evidence", label);
if (fs.existsSync(OUT)) {
  console.log(`HOLD fresh label only: ${OUT}`);
  process.exit(3);
}
fs.mkdirSync(OUT, { recursive: true });
const ROOT = fs.mkdtempSync(`/private/tmp/e69gm-${label}-`),
  NODE = "/opt/homebrew/opt/node@24/bin/node",
  PRODUCT = process.env.FULCRA_TEST_PRODUCT;
if (!PRODUCT || !process.env.U8_PROBE_CLIENT)
  throw Error("FULCRA_TEST_PRODUCT and U8_PROBE_CLIENT are required");
const PROBE = process.env.U8_PROBE_CLIENT;
const FAKE_CODEX = path.join(HERE, "fake-codex-app-server.cjs"),
  FAKE_CLAUDE = path.join(HERE, "fake-claude-cli.cjs");
const bcrypt = createRequire(`${PRODUCT}/packages/app/package.json`)("bcryptjs");
const sdk = (p) =>
  import(
    pathToFileURL(
      createRequire(`${PRODUCT}/packages/server/package.json`).resolve(
        `@modelcontextprotocol/sdk/${p}`,
      ),
    ).href
  );
const WANT = { claude: "auto", codex: "full-access" };
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
const jsonl = (f) =>
  fs.existsSync(f)
    ? fs
        .readFileSync(f, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

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
function record(h, id) {
  const found = [];
  const walk = (d) => {
    for (const n of fs.existsSync(d) ? fs.readdirSync(d) : []) {
      const p = path.join(d, n);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (n === `${id}.json`) found.push(p);
    }
  };
  walk(path.join(h.PH, "agents"));
  return found[0] ? JSON.parse(fs.readFileSync(found[0], "utf8")) : null;
}
const agents = async (h) =>
  (await h.d.fetchAgents({ page: { limit: 200 } })).entries?.map((e) => e.agent).filter(Boolean) ??
  [];
const newAgent = async (h, before, pred = () => true) =>
  until(async () => (await agents(h)).find((a) => !before.has(a.id) && pred(a)), 90000);
// What the provider was launched with, from the stand-ins' own logs (after `since`).
function launched(h, provider, since) {
  // Claude: only the process that ran this session's turn (short-lived catalog probes also start the CLI, in its default mode).
  if (provider === "claude") {
    const log = jsonl(h.logs.claude).filter((e) => e.at >= since),
      turned = new Set(log.filter((e) => e.kind === "turn").map((e) => e.pid));
    const s = log.filter((e) => turned.has(e.pid) && (e.kind === "start" || e.kind === "set-mode"));
    return s.length ? { permissionMode: s.at(-1).permissionMode } : null;
  }
  const t = jsonl(h.logs.codex).filter(
    (e) => e.at >= since && (e.kind === "thread-start" || e.kind === "turn-policy"),
  );
  return t.length ? { approvalPolicy: t.at(-1).approvalPolicy, sandbox: t.at(-1).sandbox } : null;
}
const launchOk = (provider, l) =>
  provider === "claude"
    ? l?.permissionMode === "auto"
    : l?.approvalPolicy === "never" &&
      /danger-full-access|dangerFullAccess/i.test(JSON.stringify(l?.sandbox ?? ""));
function note(hostName, pathName, provider, id, h, since, want = WANT[provider]) {
  const rec = id ? record(h, id) : null,
    l = id ? launched(h, provider, since) : null;
  const judge = want === WANT[provider] ? l !== null && launchOk(provider, l) : true; // launch shape is checked for the default modes
  const row = {
    host: hostName,
    path: pathName,
    provider,
    id,
    mode: rec?.config?.modeId ?? null,
    want,
    launch: l,
    ok: !!rec && rec.config?.modeId === want && judge,
  };
  result.matrix.push(row);
  save();
  return row;
}

let mini, plain;
try {
  mini = host("mini", Number(miniArg), true);
  plain = host("macbook", Number(plainArg), false);
  await up(mini);
  await up(plain);
  // The Mini's programme task and a project it is an explicit member of (a real installation has them).
  const GAME = crypto.randomUUID();
  {
    const CC = path.join(mini.PH, "command-centre"),
      cfg = JSON.parse(fs.readFileSync(path.join(CC, "config.json"), "utf8")),
      cat = JSON.parse(fs.readFileSync(path.join(CC, "tasks.json"), "utf8"));
    const pid = cfg.authority.programmeId;
    mini.task = pid;
    cat.issues = [
      ...(cat.issues ?? []).filter((i) => i.id !== pid),
      {
        id: pid,
        companyId: cfg.authority.companyId,
        parentId: null,
        assigneeUserId: "local-board",
        assigneeAgentId: null,
        status: "in_progress",
        title: "Gate programme",
        projectId: GAME,
      },
    ];
    cat.projects = [
      ...(cat.projects ?? []).filter((p) => p.id !== GAME),
      {
        id: GAME,
        companyId: cfg.authority.companyId,
        name: "Game",
        description: null,
        status: "in_progress",
      },
    ];
    const tmp = path.join(CC, `.tasks.json-${crypto.randomUUID()}`);
    fs.writeFileSync(tmp, JSON.stringify(cat, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, path.join(CC, "tasks.json"));
  }
  // GM_LIVE_SHAPE=1: the live Mini's installation value (defaults.modes = claude auto / codex auto-review, 7a) -- tells
  // whether the Codex-default one-shot (next-codex-mode) is still needed once the candidate is live.
  if (process.env.GM_LIVE_SHAPE === "1") {
    const CC = path.join(mini.PH, "command-centre"),
      f = path.join(CC, "config.json"),
      cfg = JSON.parse(fs.readFileSync(f, "utf8"));
    cfg.defaults = { ...cfg.defaults, modes: { claude: "auto", codex: "auto-review" } };
    const tmp = path.join(CC, `.config.json-${crypto.randomUUID()}`);
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, f);
    result.liveShape = cfg.defaults.modes;
    save();
  }
  const { Client } = await sdk("client/index.js"),
    { StreamableHTTPClientTransport } = await sdk("client/streamableHttp.js"),
    { StdioClientTransport } = await sdk("client/stdio.js");

  // Paths that need no lead: P1 (app/UI create), P5 (controller create).
  const p1 = async (h, provider, extra = {}) => {
    const before = new Set((await agents(h)).map((a) => a.id)),
      t = Date.now();
    const a = await h.d.createAgent({
      provider,
      cwd: h.proj,
      ...(h.ws ? { workspaceId: h.ws.id } : {}),
      title: `UI ${provider}`,
      ...extra,
    });
    const id = a?.id ?? a?.agent?.id ?? a?.agentId ?? (await newAgent(h, before))?.id;
    await until(() => record(h, id), 30000);
    return { id, t };
  };
  for (const provider of ["claude", "codex"]) {
    const { id, t } = await p1(mini, provider);
    note("mini", "P1 app/UI create", provider, id, mini, t);
  }
  const list = async () =>
    (await mini.rpc("organization.manage", { action: "list" })).sessions ?? [];
  const p5 = async (provider, extra = {}) => {
    const before = new Set((await list()).map((s) => s.id)),
      t = Date.now();
    await mini.rpc("organization.manage", {
      action: "create",
      messageId: crypto.randomUUID(),
      provider,
      title: `Controller ${provider}`,
      ...extra,
    });
    const row = await until(async () => (await list()).find((s) => !before.has(s.id)), 60000);
    await until(() => record(mini, row?.id), 30000);
    return { id: row?.id, row, t };
  };
  for (const provider of ["claude", "codex"]) {
    const { id, t } = await p5(provider);
    note("mini", "P5 controller create (launcher / Command Centre)", provider, id, mini, t);
  }

  // A lead (Codex, orchestration role, the Game project), made a supervisor and seated as the project's orchestrator.
  const lead = await p5("codex", { role: "orchestration", projectId: GAME });
  const leadId = lead.id,
    leadRec = record(mini, leadId);
  const gen = async () => (await list()).find((s) => s.id === leadId)?.generation;
  result.lead = {
    leadId,
    supervise: await mini
      .rpc("organization.manage", {
        action: "supervise",
        sessionId: leadId,
        generation: await gen(),
        maxWorkers: 6,
        reason: "Supervisor grant for the permission-mode gate verification",
      })
      .then(
        (r) => r.status ?? r.state,
        (e) => e.message,
      ),
  };
  result.lead.seat = await mini
    .rpc("organization.role-assign", {
      action: "assign",
      role: "project-orchestrator",
      seat: GAME,
      sessionId: leadId,
      expectedRevision: 0,
      expectedSessionGeneration: await gen(),
      reason: "Seat for the permission-mode gate verification",
    })
    .then(
      (r) => r.status ?? r.state ?? "ok",
      (e) => e.message,
    );
  result.lead.allowance = await mini
    .rpc("organization.role-allowance-set", {
      seat: GAME,
      role: "project-orchestrator",
      expectedRevision: 1,
      maxSessions: 6,
      reason: "Sessions for the permission-mode gate verification",
    })
    .then(
      (r) => r.status ?? r.state ?? "ok",
      (e) => e.message,
    );
  save();
  const server = record(mini, leadId)?.config?.mcpServers?.["orca-supervisor"];
  const tools = new Client({ name: "gate-modes-lead", version: "1" });
  await tools.connect(
    new StdioClientTransport({
      command: server.command,
      args: server.args,
      env: { ...mini.env, ...server.env },
      stderr: "ignore",
    }),
  );
  for (const provider of ["claude", "codex"]) {
    // P2: `paseo run` from inside the lead.
    let before = new Set((await agents(mini)).map((a) => a.id)),
      t = Date.now();
    spawnSync(
      path.join(R, "bin/paseo"),
      [
        "run",
        "--host",
        `127.0.0.1:${mini.port}`,
        "--provider",
        provider,
        "--title",
        `Run ${provider}`,
        "Reply briefly.",
      ],
      {
        cwd: leadRec?.cwd ?? mini.proj,
        env: { ...mini.env, PASEO_AGENT_ID: leadId, PASEO_PASSWORD: mini.secret },
        encoding: "utf8",
        timeout: 120000,
      },
    );
    note(
      "mini",
      "P2 paseo run (from a lead)",
      provider,
      (await newAgent(mini, before, (a) => a.labels?.["paseo.parent-agent-id"] === leadId))?.id,
      mini,
      t,
    );
    // P3: manager_create_worker.
    before = new Set((await agents(mini)).map((a) => a.id));
    t = Date.now();
    const mw = await tools.callTool({
      name: "manager_create_worker",
      arguments: { messageId: crypto.randomUUID(), provider, title: `Manager ${provider}` },
    });
    const w3 = await newAgent(mini, before, (a) => a.labels?.["fulcra.parent-session"] === leadId);
    note("mini", "P3 manager_create_worker", provider, w3?.id, mini, t);
    if (!w3) result.matrix.at(-1).error = String(mw?.content?.[0]?.text ?? "").slice(0, 200);
    // P4: role_start_session.
    before = new Set((await agents(mini)).map((a) => a.id));
    t = Date.now();
    const rs = await tools.callTool({
      name: "role_start_session",
      arguments: {
        seat: GAME,
        taskId: mini.task,
        messageId: crypto.randomUUID(),
        provider,
        title: `Seat ${provider}`,
      },
    });
    const w4 = await newAgent(mini, before);
    note("mini", "P4 role_start_session", provider, w4?.id, mini, t);
    if (!w4) result.matrix.at(-1).error = String(rs?.content?.[0]?.text ?? "").slice(0, 200);
  }
  await tools.close();
  // P6 last: a create_agent child reports back into the lead when it finishes, which revokes the lead's delegation (a
  // known controller interaction), so the lead's own manager/seat creates run first.
  for (const provider of ["claude", "codex"]) {
    let before, t;
    // P6: the agent tools' create_agent, as the lead calls it.
    before = new Set((await agents(mini)).map((a) => a.id));
    t = Date.now();
    const m = new Client({ name: "gate-modes-agent-tools", version: "1" });
    await m.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${mini.port}/mcp/agents?callerAgentId=${leadId}`),
        { requestInit: { headers: { Authorization: `Bearer ${mini.secret}` } } },
      ),
    );
    const made = await m.callTool({
      name: "create_agent",
      arguments: {
        title: `Tools ${provider}`,
        provider: provider === "claude" ? "claude/claude-sonnet-5-5" : "codex/gpt-fake",
        initialPrompt: "Reply briefly.",
      },
    });
    await m.close();
    note(
      "mini",
      "P6 create_agent (agent tools)",
      provider,
      made?.structuredContent?.agentId ?? (await newAgent(mini, before))?.id,
      mini,
      t,
    );
    if (!result.matrix.at(-1).id)
      result.matrix.at(-1).error = JSON.stringify(made?.content ?? made).slice(0, 300);
  }
  const miniRows = result.matrix.filter((r) => r.host === "mini");
  check(
    "M the Mini: every create path (P1-P6) records Claude auto and Codex full-access, and launches the provider that way",
    miniRows.length === 12 && miniRows.every((r) => r.ok),
    miniRows.map(
      (r) =>
        `${r.path.split(" ")[0]} ${r.provider}: ${r.mode}${r.launch ? "/" + JSON.stringify(r.launch) : ""}${r.ok ? "" : " FAIL"}`,
    ),
  );

  // B: the MacBook shape (a plain host): P1, and P2/P6 from a session on it.
  const plainPlugin = await plain.rpc("organization.accounts", {}).then(
    (v) => !!v?.defaults,
    () => false,
  );
  const WANT_B = { claude: "auto", codex: "full-access" };
  const CHILD_B = { claude: "auto", codex: WANT_B.codex };
  result.plainHost = { fulcraPlugin: plainPlugin, want: WANT_B, children: CHILD_B };
  save();
  for (const provider of ["claude", "codex"]) {
    const { id, t } = await p1(plain, provider);
    note("macbook", "P1 app/UI create", provider, id, plain, t, WANT_B[provider]);
  }
  const pl = (await p1(plain, "codex")).id;
  const { Client: C2 } = await sdk("client/index.js");
  for (const provider of ["claude", "codex"]) {
    let before = new Set((await agents(plain)).map((a) => a.id)),
      t = Date.now();
    spawnSync(
      path.join(R, "bin/paseo"),
      [
        "run",
        "--host",
        `127.0.0.1:${plain.port}`,
        "--provider",
        provider,
        "--title",
        `Run ${provider}`,
        "Reply briefly.",
      ],
      {
        cwd: plain.proj,
        env: { ...plain.env, PASEO_AGENT_ID: pl, PASEO_PASSWORD: plain.secret },
        encoding: "utf8",
        timeout: 120000,
      },
    );
    // Children of the plain host's full-access Codex session use their provider defaults. A restricted parent still caps a
    // Claude child is "default"; under a full-access parent (plugin present) the provider's own default.
    note(
      "macbook",
      "P2 paseo run (from a session)",
      provider,
      (await newAgent(plain, before, (a) => a.labels?.["paseo.parent-agent-id"] === pl))?.id,
      plain,
      t,
      CHILD_B[provider],
    );
    before = new Set((await agents(plain)).map((a) => a.id));
    t = Date.now();
    const m = new C2({ name: "gate-modes-plain-tools", version: "1" });
    await m.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${plain.port}/mcp/agents?callerAgentId=${pl}`),
        { requestInit: { headers: { Authorization: `Bearer ${plain.secret}` } } },
      ),
    );
    const made = await m.callTool({
      name: "create_agent",
      arguments: {
        title: `Tools ${provider}`,
        provider: provider === "claude" ? "claude/claude-sonnet-5-5" : "codex/gpt-fake",
        initialPrompt: "Reply briefly.",
      },
    });
    await m.close();
    note(
      "macbook",
      "P6 create_agent (agent tools)",
      provider,
      made?.structuredContent?.agentId ?? (await newAgent(plain, before))?.id,
      plain,
      t,
      CHILD_B[provider],
    );
    if (!result.matrix.at(-1).id)
      result.matrix.at(-1).error = JSON.stringify(made?.content ?? made).slice(0, 300);
  }
  const bookRows = result.matrix.filter((r) => r.host === "macbook");
  check(
    `B the MacBook shape (plain host, Fulcra plugin ${plainPlugin ? "present" : "absent"}): P1, P2 and P6 record Claude auto and Codex ${WANT_B.codex} (P3-P5 need a Command Centre host)`,
    bookRows.length === 6 && bookRows.every((r) => r.ok),
    bookRows.map(
      (r) =>
        `${r.path.split(" ")[0]} ${r.provider}: ${r.mode}${r.ok ? "" : " FAIL (want " + r.want + ")"}`,
    ),
  );

  // C: a child is never more permissive than its caller (W3 P-3).
  const runChild = async (parent, provider) => {
    const before = new Set((await agents(mini)).map((a) => a.id)),
      t = Date.now();
    spawnSync(
      path.join(R, "bin/paseo"),
      [
        "run",
        "--host",
        `127.0.0.1:${mini.port}`,
        "--provider",
        provider,
        "--title",
        `Child ${provider}`,
        "Reply briefly.",
      ],
      {
        cwd: mini.proj,
        env: { ...mini.env, PASEO_AGENT_ID: parent, PASEO_PASSWORD: mini.secret },
        encoding: "utf8",
        timeout: 120000,
      },
    );
    const id = (await newAgent(mini, before, (a) => a.labels?.["paseo.parent-agent-id"] === parent))
      ?.id;
    return { id, mode: id ? (record(mini, id)?.config?.modeId ?? null) : null, t };
  };
  const toolChild = async (parent, provider) => {
    const m = new Client({ name: "gate-modes-child", version: "1" });
    await m.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${mini.port}/mcp/agents?callerAgentId=${parent}`),
        { requestInit: { headers: { Authorization: `Bearer ${mini.secret}` } } },
      ),
    );
    const made = await m.callTool({
      name: "create_agent",
      arguments: {
        title: `Child ${provider}`,
        provider: provider === "claude" ? "claude/claude-sonnet-5-5" : "codex/gpt-fake",
        initialPrompt: "Reply briefly.",
      },
    });
    await m.close();
    const id = made?.structuredContent?.agentId ?? null;
    if (id) await until(() => record(mini, id), 30000);
    return {
      id,
      mode: id ? (record(mini, id)?.config?.modeId ?? null) : null,
      error: id ? undefined : JSON.stringify(made?.content ?? made).slice(0, 200),
    };
  };
  const autoLead = (await p1(mini, "claude")).id,
    planLead = (await p1(mini, "claude", { modeId: "plan" })).id,
    defaultLead = (await p1(mini, "claude", { modeId: "default" })).id;
  const children = {
    "auto lead -> codex (paseo run)": await runChild(autoLead, "codex"),
    "auto lead -> codex (create_agent)": await toolChild(autoLead, "codex"),
    "plan lead -> claude (paseo run)": await runChild(planLead, "claude"),
    "plan lead -> codex (paseo run)": await runChild(planLead, "codex"),
    "default lead -> claude (paseo run)": await runChild(defaultLead, "claude"),
    "default lead -> codex (paseo run)": await runChild(defaultLead, "codex"),
  };
  const restrictedClaude = (m) => m === "plan" || m === "default",
    notFull = (m) => !!m && m !== "full-access";
  const cOk =
    children["auto lead -> codex (paseo run)"].mode === "auto-review" &&
    children["auto lead -> codex (create_agent)"].mode === "auto-review" &&
    restrictedClaude(children["plan lead -> claude (paseo run)"].mode) &&
    notFull(children["plan lead -> codex (paseo run)"].mode) &&
    restrictedClaude(children["default lead -> claude (paseo run)"].mode) &&
    notFull(children["default lead -> codex (paseo run)"].mode);
  check(
    "C a child is never more permissive than its caller: a Claude-auto lead's Codex children are auto-review; plan/default leads' children stay restricted (paseo run included)",
    cOk,
    Object.fromEntries(
      Object.entries(children).map(([k, v]) => [k, v.mode ?? v.error ?? "not created"]),
    ),
  );

  // X: an explicit mode still wins.
  const xc = await p1(mini, "claude", { modeId: "default" }),
    xx = await p1(mini, "codex", { modeId: "auto" });
  check(
    "X an explicit mode wins over the default (Claude default, Codex auto)",
    record(mini, xc.id)?.config?.modeId === "default" &&
      record(mini, xx.id)?.config?.modeId === "auto",
    { claude: record(mini, xc.id)?.config?.modeId, codex: record(mini, xx.id)?.config?.modeId },
  );

  // Z and K: scripted sessions on the Mini (app/UI create, the default mode).
  const pendingOf = async (id) =>
    (await agents(mini)).find((a) => a.id === id)?.pendingPermissions ?? [];
  for (const provider of ["claude", "codex"]) {
    const { id } = await p1(mini, provider),
      t = Date.now(),
      seen = { pending: 0 },
      framesBefore = mini.frames.length;
    await mini.d.sendMessage(id, "SCRIPT_TOOLS: search the docs, then write notes.txt.");
    const done = await until(
      async () => {
        const p = await pendingOf(id);
        seen.pending = Math.max(seen.pending, p.length);
        return provider === "claude"
          ? jsonl(mini.logs.claude).some(
              (e) => e.at >= t && e.kind === "turn" && e.input.includes("SCRIPT_TOOLS"),
            )
          : jsonl(mini.logs.codex).some((e) => e.at >= t && e.kind === "scripted-tools");
      },
      120000,
      250,
    );
    const decisions = jsonl(mini.logs.claude)
      .filter((e) => e.at >= t && e.kind === "tool")
      .map((e) => [e.what, e.behavior]);
    const frames = mini.frames
      .slice(framesBefore)
      .filter((f) => f.agentId === id && /request/i.test(f.type));
    check(
      `Z ${provider}: a scripted MCP tool call and file write complete with ZERO approvals reaching the owner`,
      !!done &&
        seen.pending === 0 &&
        frames.length === 0 &&
        (provider === "codex" ||
          (decisions.length === 2 && decisions.every(([, b]) => b === "allow"))),
      { maxPending: seen.pending, permissionFrames: frames.length, decisions },
    );
    // K: a credential read on the same session escalates to the owner, is shown as needing them, and the owner's deny is final.
    const t2 = Date.now();
    await mini.d.sendMessage(id, "SCRIPT_CRED: read the stored credential.");
    const req = await until(async () => (await pendingOf(id))[0], 60000, 250);
    // What Sessions shows: the session list entry (its pending permissions drive the "needs you" badge) and, when the
    // session is in the Command Centre fleet, its node.
    const entry = (await agents(mini)).find((a) => a.id === id);
    let node = null;
    try {
      const f = await mini.rpc("organization.fleet", {});
      const n = f.nodes?.find((x) => x.id === id);
      node = n ? { status: n.status, pending: n.pending } : null;
    } catch {}
    const shown = {
      status: entry?.status ?? null,
      pending: entry?.pendingPermissions?.length ?? 0,
      attention: entry?.requiresAttention ?? entry?.attention ?? null,
      fleet: node,
    };
    if (req)
      await mini.d.respondToPermission(id, req.id ?? req.requestId, {
        behavior: "deny",
        message: "Credential access is not allowed in this gate",
      });
    const answered = await until(
      () =>
        provider === "claude"
          ? jsonl(mini.logs.claude).find(
              (e) => e.at >= t2 && e.kind === "tool" && e.what === "credential",
            )
          : jsonl(mini.logs.codex).find(
              (e) => e.at >= t2 && e.kind === "approval" && e.what === "credential",
            ),
      60000,
      250,
    );
    const denied =
      provider === "claude"
        ? answered?.behavior === "deny"
        : /decline|deny|reject|cancel/i.test(JSON.stringify(answered?.decision ?? ""));
    check(
      `K ${provider}: a credential/Keychain read still escalates -- a pending permission reaches the owner, Sessions shows it as needing them, and the owner's deny is what the provider gets`,
      !!req && shown.pending > 0 && (!node || node.pending > 0) && denied,
      { pending: !!req, sessions: shown, answer: answered?.behavior ?? answered?.decision ?? null },
    );
    check(
      `N ${provider}: while the permission is pending, Sessions shows the session as needing the owner, not just "running"`,
      !!req && (shown.attention === true || (shown.status !== "running" && shown.status !== null)),
      { status: shown.status, attention: shown.attention, pending: shown.pending },
    );
  }
} catch (e) {
  result.error = String(e?.message ?? e)
    .split("\n")[0]
    .slice(0, 300);
  save();
  console.log("ERROR", result.error);
} finally {
  await down(mini);
  await down(plain);
  for (const h of [mini, plain])
    if (h)
      for (const [k, f] of Object.entries(h.logs))
        if (fs.existsSync(f)) fs.copyFileSync(f, path.join(OUT, `${h.name}-fake-${k}.jsonl`));
  result.pass = !result.error && result.checks.length === 10 && result.checks.every((c) => c.ok);
  save();
  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log(
    `${result.checks.filter((c) => c.ok).length}/${result.checks.length} passed${result.error ? " (error: " + result.error + ")" : ""}`,
  );
  process.exit(result.pass ? 0 : 1);
}
