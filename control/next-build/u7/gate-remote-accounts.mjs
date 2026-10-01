// Update-7 gate (remote account management, W1's `accounts.manage`), scratch only, on the REAL packaged candidate, over
// a scratch relay (the product's relay worker under `wrangler dev --local`) with scratch paired devices -- the gate (b)/(e)
// relay pattern. Nothing reaches a real account: Codex is the stand-in app-server (fake-codex-app-server.cjs), `codex
// login` is a stub, the Claude token is a stub kept by the B6 stand-in for `security`.
//   R0 upgrade: a device paired + granted Command Centre on candidate 6 has no accounts.manage after the upgrade
//   R1 a device WITH accounts.manage: switch, set the default and take over a running chat all take effect
//   R2 the original already-open granted connection after owner revoke: all three refused, nothing changes
//   R3 a read-tier (D13) device: refused       R4 a full Command Centre device WITHOUT accounts.manage: refused
//   R5 the upgraded existing device: refused  R6 the local owner: all three work
//   R7 no credential material (the stub Claude token, every auth.json) in any frame or reply reaching a remote client
//   R8 an audit row (device, action, account label, time) for each remote action
//   R9 the prime's LIVE one-shot (operator-job-next/u7-remote-accounts-live.py, offline mode): before/after verify R1's switch
//   node gate-remote-accounts.mjs <new Fulcra.app> <candidate-6 Fulcra.app> <client bundle> <label> <daemon port> <relay port>
// The client bundle is the folded candidate's own (stage-testdevice-client pattern); it must carry W1's grant method.
import { exactAccountAudit } from "./switch-gate-checks.mjs";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const HERE = path.dirname(new URL(import.meta.url).pathname);
const [appArg, oldArg, bundleArg, label, portArg, relayArg] = process.argv.slice(2);
const APP = fs.realpathSync(appArg),
  OLD = fs.realpathSync(oldArg),
  PORT = Number(portArg),
  RPORT = Number(relayArg);

const OUT = path.join(
  process.env.U8_GATE_OUT ?? "/private/tmp/fulcra-u8-gates",
  "remote-accounts",
  label,
);
if (fs.existsSync(OUT)) {
  console.log(`HOLD fresh label only: ${OUT}`);
  process.exit(3);
}
fs.mkdirSync(OUT, { recursive: true });
const ROOT = fs.mkdtempSync(`/private/tmp/e69gra-${label}-`),
  PH = path.join(ROOT, "paseo"),
  HOME = path.join(ROOT, "home"),
  BIN = path.join(ROOT, "bin");
const NODE = process.execPath,
  PRODUCT = path.resolve(HERE, "../../.."),
  PLUGIN = "orca-organization-next";
const FAKE = path.join(HERE, "fake-codex-app-server.cjs"),
  FAKELOG = path.join(ROOT, "fake-codex.jsonl");
const bcrypt = createRequire(`${PRODUCT}/packages/app/package.json`)("bcryptjs");
if (!process.env.U8_REMOTE_OPERATOR_DIR)
  throw Error("U8_REMOTE_OPERATOR_DIR must name the retained offline operator scripts");
const c = await import(pathToFileURL(fs.realpathSync(bundleArg)).href);

// ---- FOLD-PIN, confirmed against W1 641f1a1ae + W4 e39339cb5 (7b fold): the owner's grant is the client's
// setPairedDeviceAccountsManage; a device entry carries accountsManage; the audit is the HOST's (listAccountsAudit:
// device, action, account label, time -- the plugin supplies only action + label). A build without them HOLDs (exit 3).
const CAP = {
  supported: (owner) => typeof owner.setPairedDeviceAccountsManage === "function",
  set: (owner, deviceId, allow) => owner.setPairedDeviceAccountsManage(deviceId, allow),
  held: (entry) => entry?.accountsManage === true,
};
const AUDIT = async (owner) =>
  ((await owner.listAccountsAudit())?.entries ?? []).map((e) => ({
    device: e.deviceId,
    deviceName: e.deviceName,
    action: e.action,
    label: e.accountLabel,
    at: e.at,
  }));
const ACT = {
  // the three remote actions, as the app sends them
  switch: (rpc, sessionId, account) =>
    rpc("organization.accounts.switch", { agentId: sessionId, account }),
  default: (rpc, provider, id) =>
    rpc("organization.accounts.settings", { defaultAccount: { provider, id } }),
  takeover: (rpc, sessionId, account) =>
    rpc("organization.accounts.takeover", { agentId: sessionId, account }), // a running chat
};
// ---- end FOLD-PIN

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
const result = { label, app: APP, old: OLD, bundle: bundleArg, checks: [] };
const save = () =>
  fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(result, null, 1) + "\n");
const check = (name, ok, detail) => {
  result.checks.push({ name, ok: !!ok, detail });
  save();
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name} ${detail === undefined ? "" : JSON.stringify(detail).slice(0, 400)}`,
  );
};
const hold = (why) => {
  result.hold = why;
  save();
  console.log(`HOLD ${why}`);
  throw Object.assign(Error(why), { hold: true });
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
const refused = (r) =>
  r?.error !== undefined ||
  r?.ok === false ||
  ["error", "refused", "uncertain"].includes(r?.status ?? r?.state);

// ---- scratch home: owner credential, stub `codex login`, B6 `security` stand-in, fake app-server, relay ON
const secret = crypto.randomBytes(32).toString("base64url"),
  claudeToken = "sk-ant-oat01-" + crypto.randomBytes(40).toString("base64url");
for (const d of [HOME, BIN, PH, path.join(ROOT, "tmp")])
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(PH, "controller.secret"), secret, { mode: 0o600 });
fs.writeFileSync(
  path.join(BIN, "codex"),
  `#!${NODE}\nconst fs=require("fs"),p=require("path"),c=require("crypto");if(process.argv[2]!=="login"){process.exit(1)}const h=process.env.CODEX_HOME;fs.mkdirSync(h,{recursive:true});fs.writeFileSync(p.join(h,"auth.json"),JSON.stringify({tokens:{access_token:"FAKE-CODEX-SECRET-"+c.randomBytes(16).toString("hex")}}),{mode:0o600});process.exit(0);\n`,
  { mode: 0o700 },
);
const KC = path.join(ROOT, "keychain"),
  SECURITY = path.join(BIN, "security");
fs.writeFileSync(
  SECURITY,
  `#!/bin/sh\nexec "${NODE}" "${path.resolve(HERE, "../../orca-organization/server/fake-security.fixture.mjs")}" "$@"\n`,
  { mode: 0o700 },
);
fs.mkdirSync(path.join(PH, "projects"), { recursive: true });
const proj = path.join(ROOT, "project");
fs.mkdirSync(proj);
const at0 = "2026-10-01T00:00:00.000Z";
fs.writeFileSync(
  path.join(PH, "projects/projects.json"),
  JSON.stringify([
    {
      projectId: "prj_gra",
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
      relay: { enabled: true, endpoint: `127.0.0.1:${RPORT}`, useTls: false },
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
  FULCRA_ACCOUNTS_KEYCHAIN: KC,
  FULCRA_ACCOUNTS_SECURITY: SECURITY,
};

function startDaemon(app, tag) {
  const R = path.join(app, "Contents/Resources"),
    logf = path.join(OUT, `daemon-${tag}.log`);
  return spawn(
    path.join(app, "Contents/MacOS/Fulcra"),
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
}
async function stopDaemon(p) {
  if (!p) return;
  try {
    process.kill(-p.pid, "SIGTERM");
  } catch {}
  await until(async () => !(await listening(PORT)), 30000);
  try {
    process.kill(-p.pid, "SIGKILL");
  } catch {}
}
const ownerClient = async () => {
  const o = new c.DaemonClient({
    url: `ws://127.0.0.1:${PORT}/ws`,
    clientId: `gra-owner-${crypto.randomUUID()}`,
    clientType: "cli",
    password: secret,
    connectTimeoutMs: 10000,
    reconnect: { enabled: false },
  });
  await o.connect();
  return o;
};

// Pair one device over the relay, exactly as the app's device flow does (testdevice-ops.mjs claim).
function claim(offer, keyPair, deviceName) {
  const { promise, resolve } = Promise.withResolvers();
  let settled = false;
  const socket = new WebSocket(
    c.buildRelayWebSocketUrl({
      endpoint: offer.relay.endpoint,
      useTls: offer.relay.useTls,
      serverId: offer.serverId,
      role: "client",
    }),
  );
  const done = (v) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    try {
      socket.close();
    } catch {}
    resolve(v);
  };
  const timer = setTimeout(() => done({ ok: false, error: "pairing timed out" }), 20000);
  socket.binaryType = "arraybuffer";
  const transport = {
    send: (d) => socket.send(d),
    close: (code, r) => socket.close(code, r),
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  socket.addEventListener("message", (e) =>
    transport.onmessage?.({ data: e.data, isBinary: typeof e.data !== "string" }),
  );
  socket.addEventListener("close", (e) => {
    transport.onclose?.(e.code, e.reason);
    done({ ok: false, error: `relay closed ${e.code}` });
  });
  socket.addEventListener("open", async () => {
    let channel;
    try {
      channel = await c.createClientChannel(
        transport,
        offer.daemonPublicKeyB64,
        {
          onopen: () =>
            void channel.send(
              JSON.stringify({
                type: "pairing.claim",
                offerId: offer.pairing.id,
                secret: offer.pairing.secret,
                deviceName,
              }),
            ),
          onmessage: (data) => {
            const r = JSON.parse(String(data));
            done(
              r.type === "pairing.claimed"
                ? { ok: true, deviceId: r.deviceId }
                : { ok: false, error: `reply ${r.type}` },
            );
          },
          onerror: (e) => done({ ok: false, error: String(e?.message ?? e) }),
        },
        { deviceKeyPair: keyPair, serverId: offer.serverId },
      );
    } catch (error) {
      done({ ok: false, error: String(error?.message ?? error) });
    }
  });
  return promise;
}

async function pair(owner, name, grant) {
  const payload = await owner.getDaemonPairingOffer();
  const url = payload?.url ?? "",
    i = url.indexOf("#offer=");
  if (i < 0) hold(`no relay pairing offer (relayEnabled=${payload?.relayEnabled ?? null})`);
  const offer = JSON.parse(Buffer.from(url.slice(i + 7), "base64url").toString("utf8")),
    kp = c.generateKeyPair();
  const claimed = await claim(offer, kp, name);
  if (!claimed.ok) throw Error(`pairing ${name}: ${claimed.error}`);
  if (grant === "full") await owner.setPairedDeviceCommandCentre(claimed.deviceId, true);
  if (grant === "read")
    await owner.setPairedDeviceCommandCentre(claimed.deviceId, true, { readOnly: true });
  return { name, deviceId: claimed.deviceId, kp, offer };
}
// A remote client as that device: every decrypted inbound message is captured (R7 greps them all).
const frames = path.join(OUT, "device-frames.jsonl");
async function asDevice(dev) {
  const client = new c.DaemonClient({
    url: c.buildRelayWebSocketUrl({
      endpoint: dev.offer.relay.endpoint,
      useTls: false,
      serverId: dev.offer.serverId,
      role: "client",
    }),
    clientId: `gra-${dev.name}-${crypto.randomUUID()}`,
    clientType: "mobile",
    connectTimeoutMs: 15000,
    reconnect: { enabled: false },
    e2ee: {
      enabled: true,
      daemonPublicKeyB64: dev.offer.daemonPublicKeyB64,
      getDeviceKeyPair: async () => dev.kp,
    },
  });
  client.subscribeRawMessages((m) =>
    fs.appendFileSync(frames, JSON.stringify({ device: dev.name, m }) + "\n"),
  );
  await client.connect();
  const rpc = async (m, input) => {
    try {
      const r = await client.invokePluginRpc(PLUGIN, m, input);
      fs.appendFileSync(frames, JSON.stringify({ device: dev.name, reply: m, r }) + "\n");
      return r;
    } catch (e) {
      const r = { error: String(e?.message ?? e).slice(0, 200) };
      fs.appendFileSync(frames, JSON.stringify({ device: dev.name, reply: m, r }) + "\n");
      return r;
    }
  };
  return { client, rpc };
}

let daemon, relay, owner;
try {
  const wenv = {
    PATH: `${path.dirname(NODE)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    HOME,
    TMPDIR: path.join(ROOT, "tmp") + "/",
    XDG_CONFIG_HOME: path.join(ROOT, "xdg"),
    WRANGLER_SEND_METRICS: "false",
    CI: "1",
    LANG: "en_US.UTF-8",
  };
  relay = spawn(
    "npx",
    [
      "--no-install",
      "wrangler",
      "dev",
      "--local",
      "--var",
      "PASEO_RELAY_UPSTREAM:",
      "--ip",
      "127.0.0.1",
      "--port",
      String(RPORT),
      "--live-reload=false",
      "--show-interactive-dev-session=false",
      "--persist-to",
      path.join(ROOT, "relay-state"),
    ],
    {
      cwd: path.join(PRODUCT, "packages/relay"),
      env: wenv,
      detached: true,
      stdio: [
        "ignore",
        fs.openSync(path.join(OUT, "relay.log"), "w"),
        fs.openSync(path.join(OUT, "relay.log"), "a"),
      ],
    },
  );
  if (!(await until(() => listening(RPORT), 90000))) throw Error("the scratch relay did not start");

  // R0 part 1: candidate 6 pairs a device and grants it Command Centre (the state every existing device is in).
  daemon = startDaemon(OLD, "old");
  if (
    !(await until(
      async () =>
        fs.existsSync(path.join(PH, "command-centre/control.sock")) && (await listening(PORT)),
      300000,
    ))
  )
    throw Error("candidate 6 did not come up");
  await delay(3000);
  owner = await ownerClient();
  const existing = await pair(owner, "Existing phone", "full");
  await owner.close();
  owner = null;
  await stopDaemon(daemon);
  daemon = null;

  // The candidate, on the same home.
  daemon = startDaemon(APP, "new");
  if (
    !(await until(
      async () =>
        fs.existsSync(path.join(PH, "command-centre/control.sock")) && (await listening(PORT)),
      300000,
    ))
  )
    throw Error("the candidate did not come up");
  await delay(3000);
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
  owner = await ownerClient();
  const devices = async () => (await owner.listPairedDevices())?.devices ?? [];
  const exAfter = (await devices()).find((x) => x.deviceId === existing.deviceId);
  result.existingAfterUpgrade = exAfter ?? null;
  save();
  if (!CAP.supported(owner))
    hold(
      "this build's client has no accounts.manage grant call (FOLD-PIN: W1's API not in this build)",
    );
  check(
    "R0 upgrade: a device paired and granted Command Centre on candidate 6 is still paired, still granted, and has NO accounts.manage",
    !!exAfter && exAfter.commandCentre === true && !CAP.held(exAfter),
    {
      device: exAfter && {
        commandCentre: exAfter.commandCentre,
        accountsManage: CAP.held(exAfter),
      },
    },
  );

  // Accounts and sessions (owner).
  const orpc = (m, input = {}) => owner.invokePluginRpc(PLUGIN, m, input);
  await orpc("organization.accounts.add", { provider: "codex", name: "Alpha" });
  await orpc("organization.accounts.add", { provider: "codex", name: "Beta" });
  await orpc("organization.accounts.add", {
    provider: "claude",
    name: "Gamma",
    token: claudeToken,
  });
  const view = await until(async () => {
    const v = await orpc("organization.accounts", {});
    return v.accounts.filter((a) => a.provider === "codex" && a.status.state === "ok").length === 2
      ? v
      : null;
  }, 60000);
  if (!view) throw Error("the two Codex accounts did not sign in");
  const acct = {
    Alpha: view.accounts.find((a) => a.name === "Alpha").id,
    Beta: view.accounts.find((a) => a.name === "Beta").id,
  };
  const list = async () => (await orpc("organization.manage", { action: "list" })).sessions ?? [];
  const createDelegated = async (title) => {
    const before = new Set((await list()).map((s) => s.id));
    await orpc("organization.manage", {
      action: "create",
      messageId: crypto.randomUUID(),
      provider: "codex",
      title,
      role: "implementation",
    });
    const row = await until(async () => (await list()).find((s) => !before.has(s.id)), 60000);
    await orpc("organization.manage", {
      action: "handback",
      sessionId: row.id,
      generation: row.generation,
      reason: "Delegated for the remote accounts gate verification",
    });
    return row.id;
  };
  const S1 = await createDelegated("Remote switch target"),
    S2 = await createDelegated("Remote takeover target");
  const gen2 = async () => (await list()).find((s) => s.id === S2)?.generation;
  await orpc("organization.manage", {
    action: "assign",
    sessionId: S2,
    generation: await gen2(),
    messageId: crypto.randomUUID(),
    text: "Start the chat and reply briefly.",
  });
  const thread2 = (
    await until(
      () => fakeLog().find((e) => e.kind === "turn" && e.input.includes("Start the chat")),
      90000,
    )
  )?.thread;
  const state = async () => {
    const a = await orpc("organization.accounts.session", { agentId: S1 }),
      b = await orpc("organization.accounts.session", { agentId: S2 });
    return { s1: a.current, s2: b.current, def: a.accounts.find((x) => x.isDefault)?.id ?? null };
  };
  const nameOf = (id) => Object.entries(acct).find(([, v]) => v === id)?.[0];
  const other = (id) => (id === acct.Alpha ? "Beta" : "Alpha");
  result.setup = { acct, S1, S2, thread2, state: await state() };
  save();

  // One actor tries all three actions; each is judged by its effect as the owner reads it.
  async function tryAll(rpc) {
    const before = await state(),
      t = Date.now(),
      r = {};
    r.switch = await ACT.switch(rpc, S1, other(before.s1));
    r.default = await ACT.default(rpc, "codex", acct[other(before.def ?? acct.Beta)]);
    const want = other(before.s2);
    r.takeover = await ACT.takeover(rpc, S2, want);
    const moved = await until(
      () =>
        fakeLog().some(
          (e) =>
            e.at >= t &&
            e.kind === "thread-resume" &&
            e.account === acct[want] &&
            e.thread === thread2 &&
            e.found,
        ),
      20000,
      500,
    );
    const after = await state();
    return {
      r,
      before,
      after,
      took: {
        switch: after.s1 !== before.s1,
        default: after.def !== before.def,
        takeover: after.s2 !== before.s2 && !!moved,
      },
    };
  }
  const summary = (x) => ({
    took: x.took,
    replies: Object.fromEntries(
      Object.entries(x.r).map(([k, v]) => [
        k,
        refused(v)
          ? `refused: ${String(v.error ?? v.message ?? v.status ?? v.state).slice(0, 90)}`
          : "ok",
      ]),
    ),
  });

  // R1: a device with a full Command Centre grant AND accounts.manage.
  const acctDev = await pair(owner, "Owner phone", "full");
  await CAP.set(owner, acctDev.deviceId, true);
  const liveJob = (...a) => {
    const OJ = process.env.U8_REMOTE_OPERATOR_DIR,
      r = spawnSync(
        process.env.U8_PYTHON ?? "python3",
        ["-B", path.join(OJ, "u7-remote-accounts-live.py"), ...a],
        {
          encoding: "utf8",
          timeout: 180000,
          env: {
            PATH: "/usr/bin:/bin",
            HOME: process.env.HOME,
            RA_OFFLINE_TEST: "1",
            RA_TEST_HOME: PH,
            RA_TEST_PORT: String(PORT),
            RA_TEST_EVIDENCE: path.join(OUT, "live-oneshot"),
            RA_TEST_PLIST: fakePlist,
            RA_TEST_OPS_SHA: crypto
              .createHash("sha256")
              .update(fs.readFileSync(path.join(OJ, "u7-remote-accounts-ops.mjs")))
              .digest("hex"),
            RA_TEST_CLIENT: fs.realpathSync(bundleArg),
            RA_TEST_CLIENT_SHA: crypto
              .createHash("sha256")
              .update(fs.readFileSync(fs.realpathSync(bundleArg)))
              .digest("hex"),
          },
        },
      );
    const lines = fs.existsSync(path.join(OUT, "live-oneshot/receipt.jsonl"))
      ? fs.readFileSync(path.join(OUT, "live-oneshot/receipt.jsonl"), "utf8").trim().split("\n")
      : [];
    return { code: r.status, last: lines.length ? JSON.parse(lines.at(-1)) : null };
  };
  const fakePlist = path.join(ROOT, "paseo.plist");
  fs.writeFileSync(
    fakePlist,
    '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>ProgramArguments</key><array><string>/x</string></array></dict></plist>',
  );
  const oneshotBefore = liveJob("before", "--session", S1);
  let dev = await asDevice(acctDev);
  const r1Started = Date.now();
  const r1 = await tryAll(dev.rpc);
  // Keep this exact granted relay connection open through revocation (R2).
  const s1Label = nameOf((await state()).s1);
  const oneshotAfter = liveJob(
    "after",
    "--session",
    S1,
    "--expect",
    s1Label,
    "--device",
    acctDev.name,
  );
  const oneshotWrongDevice = liveJob(
    "after",
    "--session",
    S1,
    "--expect",
    s1Label,
    "--device",
    "Work laptop",
  );
  const receipt = fs.existsSync(path.join(OUT, "live-oneshot/receipt.jsonl"))
    ? fs.readFileSync(path.join(OUT, "live-oneshot/receipt.jsonl"), "utf8")
    : "";
  check(
    "R9 the prime's live one-shot (offline): before records the account, after verifies the remote switch (account, capability, audit row, Sessions); another device is NOT YET; no credential in its receipt",
    oneshotBefore.last?.step === "SNAPSHOT RECORDED" &&
      oneshotAfter.code === 0 &&
      oneshotAfter.last?.step === "REMOTE SWITCH VERIFIED" &&
      oneshotAfter.last?.sessionsShows === s1Label &&
      oneshotWrongDevice.code === 2 &&
      !receipt.includes(secret) &&
      !receipt.includes(claudeToken),
    {
      before: oneshotBefore.last?.step,
      after: oneshotAfter.last && {
        step: oneshotAfter.last.step,
        accountNow: oneshotAfter.last.accountNow,
      },
      wrongDevice: oneshotWrongDevice.last?.step,
    },
  );
  check(
    "R1 a device WITH accounts.manage: switch, set the default and take over a running chat all take effect",
    r1.took.switch &&
      r1.took.default &&
      r1.took.takeover &&
      !refused(r1.r.switch) &&
      !refused(r1.r.default) &&
      !refused(r1.r.takeover),
    summary(r1),
  );

  // R2: the owner revokes accounts.manage (the Command Centre grant stays).
  await CAP.set(owner, acctDev.deviceId, false);
  const acctAfter = (await devices()).find((x) => x.deviceId === acctDev.deviceId);
  const r2 = await tryAll(dev.rpc);
  await dev.client.close();
  const none = (x) =>
    !x.took.switch &&
    !x.took.default &&
    !x.took.takeover &&
    refused(x.r.switch) &&
    refused(x.r.default) &&
    refused(x.r.takeover);
  check(
    "R2 the original already-open granted connection after owner revoke: all three refused, nothing changes",
    none(r2) && !CAP.held(acctAfter) && acctAfter?.commandCentre === true,
    summary(r2),
  );

  // R3-R5: a read-tier device, a full Command Centre device without the capability, the upgraded existing device.
  for (const [id, name, grant, text] of [
    ["R3", "Read tablet", "read", "a read-tier (D13) device"],
    ["R4", "Work laptop", "full", "a full Command Centre device WITHOUT accounts.manage"],
    ["R5", null, null, "the existing device after the upgrade"],
  ]) {
    const who = name ? await pair(owner, name, grant) : existing;
    dev = await asDevice(who);
    const r = await tryAll(dev.rpc);
    await dev.client.close();
    check(`${id} ${text}: all three refused, nothing changes`, none(r), summary(r));
  }

  // R6: the local owner (direct connection, the daemon credential).
  const r6 = await tryAll(orpc);
  check(
    "R6 the local owner: switch, set the default and take over all take effect",
    r6.took.switch && r6.took.default && r6.took.takeover,
    summary(r6),
  );

  // R8: an audit row for each remote action R1 made (device, action, account label, time).
  const audit = await AUDIT(owner);
  const rows = audit.filter((a) => a.device === acctDev.deviceId);
  const shaped = rows.filter(
    (a) =>
      typeof a.action === "string" &&
      typeof a.label === "string" &&
      a.label &&
      Number.isFinite(Date.parse(a.at)),
  );
  const currentRows = shaped.filter((a) => Date.parse(a.at) >= r1Started);
  const expectedRows = [
    { action: "switch", label: nameOf(r1.after.s1) },
    { action: "set-default", label: nameOf(r1.after.def) },
    { action: "takeover", label: nameOf(r1.after.s2) },
  ];
  check(
    "R8 exact fresh audit rows for this device, each action and target account label",
    exactAccountAudit(audit, {
      deviceId: acctDev.deviceId,
      startedAt: r1Started,
      expected: expectedRows,
    }),
    { rows: currentRows, expectedRows },
  );
  result.audit = audit.slice(-20);
  save();
  await owner.close();
  owner = null;
} catch (e) {
  if (!e.hold) {
    result.error = String(e?.message ?? e)
      .split("\n")[0]
      .slice(0, 300);
    save();
    console.log("ERROR", result.error);
  }
} finally {
  try {
    await owner?.close?.();
  } catch {}
  await stopDaemon(daemon);
  if (relay) {
    try {
      process.kill(-relay.pid, "SIGTERM");
    } catch {}
    await delay(1500);
    try {
      process.kill(-relay.pid, "SIGKILL");
    } catch {}
  }
  // R7: no credential material in anything that reached a remote client: every captured decrypted frame and every reply.
  const needles = [claudeToken];
  const walk = (dir, visit) => {
    for (const n of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      const p = path.join(dir, n),
        st = fs.lstatSync(p);
      if (st.isDirectory()) walk(p, visit);
      else if (st.isFile()) visit(p);
    }
  };
  walk(path.join(PH, "command-centre/accounts/codex"), (p) => {
    if (path.basename(p) === "auth.json") {
      const raw = fs.readFileSync(p, "utf8");
      needles.push(raw.trim());
      try {
        needles.push(JSON.parse(raw).tokens.access_token);
      } catch {}
    }
  });
  const captured = fs.existsSync(frames) ? fs.readFileSync(frames, "utf8") : "";
  const hits = needles.filter((n) => n && captured.includes(n)).length;
  if (!result.hold)
    check(
      "R7 no credential material (the Claude token, every auth.json and its token) in any frame or reply that reached a remote client",
      needles.length >= 5 && captured.length > 0 && hits === 0,
      { needles: needles.length, frames: captured ? captured.trim().split("\n").length : 0, hits },
    );
  if (fs.existsSync(FAKELOG)) fs.copyFileSync(FAKELOG, path.join(OUT, "fake-codex.jsonl"));
  result.pass =
    !result.error &&
    !result.hold &&
    result.checks.length === 10 &&
    result.checks.every((x) => x.ok);
  save();
  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log(
    result.hold
      ? `HOLD ${result.hold}`
      : `${result.checks.filter((x) => x.ok).length}/${result.checks.length} passed${result.error ? " (error: " + result.error + ")" : ""}`,
  );
  let exitCode = result.pass ? 0 : 1;
  if (result.hold) exitCode = 3;
  process.exit(exitCode);
}
