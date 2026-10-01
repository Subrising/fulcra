// Update-7 gate (pool), scratch only: a stand-in for `codex app-server` (stdio JSON-RPC), in the shape of the product's
// own fake (codex-app-server-agent.test.ts), extended to model ACCOUNTS the way the real CLI does:
// - the account is CODEX_HOME (the pool sets it per launch); it must hold auth.json (written by the fake `codex login`);
// - a thread lives in <CODEX_HOME>/sessions (the pool links it to the ONE shared base), so thread/resume finds a thread
//   started under another account only if the sessions are really shared -- otherwise "no rollout found", as Codex says;
// - a file named LIMIT_NEXT_TURN in the account's home makes the next turn hit the limit DURING the turn (as in real use:
//   the pre-send quota read still said ordinary usage was allowed); from then on the account reads LIMITED and every
//   turn on it fails with Codex's usage-limit text and reset time.
// Every process start and turn is appended to FAKE_CODEX_LOG (account id and thread only: no auth content).
// Permission-mode gate (update-7): thread/start and turn/start log the approvalPolicy and sandbox Fulcra sent. A turn
// whose input contains SCRIPT_TOOLS runs an MCP tool call and a file write the way Codex reports them in full-access
// (no approval request); SCRIPT_CRED asks approval for a credential read (item/commandExecution/requestApproval) and
// logs the decision Fulcra returns. SCRIPT_ASK (L54) asks an async question the way Codex does (an agentMessage with
// delivery "async" and questions) and completes the turn; the answer arrives as a steer or a follow-up turn (logged).
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const home = process.env.CODEX_HOME || path.join(process.env.HOME || "/tmp", ".codex");
const account = process.env.CODEX_HOME ? path.basename(process.env.CODEX_HOME) : "machine";
const LOG = process.env.FAKE_CODEX_LOG;
const log = (o) => {
  if (LOG)
    fs.appendFileSync(
      LOG,
      JSON.stringify({ at: Date.now(), pid: process.pid, account, ...o }) + "\n",
    );
};
log({
  kind: "start",
  signedIn: fs.existsSync(path.join(home, "auth.json")),
  sqliteHome: process.env.CODEX_SQLITE_HOME ?? null,
  sessionsLinked: (() => {
    try {
      return fs.lstatSync(path.join(home, "sessions")).isSymbolicLink();
    } catch {
      return false;
    }
  })(),
});
const threads = path.join(home, "sessions");
const threadFile = (id) => path.join(threads, `fake-${id}.json`);
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const pendingServer = new Map();
let serverId = 1000;
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = serverId++;
    pendingServer.set(id, resolve);
    send({ id, method, params });
    setTimeout(() => {
      if (pendingServer.delete(id)) resolve({ timedOut: true });
    }, 90000);
  });
const policy = (p) => ({
  approvalPolicy: p.approvalPolicy ?? null,
  sandbox: p.sandbox ?? p.sandboxPolicy ?? null,
});
const notify = (method, params) => send({ method, params });
function resetText() {
  const t = new Date(Date.now() + 2 * 3600000);
  const mon = t.toLocaleString("en-US", { month: "short" }),
    h = t.getHours() % 12 || 12,
    ap = t.getHours() < 12 ? "AM" : "PM";
  return `You've hit your usage limit. Upgrade to Pro, or try again later. Try again at ${mon} ${t.getDate()}, ${t.getFullYear()} ${h}:${String(t.getMinutes()).padStart(2, "0")} ${ap}.`;
}
function result(id, value) {
  send({ id, result: value });
}
function failure(id, message) {
  send({ id, error: { code: -32000, message } });
}
async function scripted(threadId, turnId, text) {
  notify("turn/started", { threadId, turn: { id: turnId } });
  const item = (x) => {
    notify("item/started", { threadId, turnId, item: { ...x, status: "inProgress" } });
    notify("item/completed", { threadId, turnId, item: x });
  };
  if (text.includes("SCRIPT_TOOLS")) {
    item({
      id: crypto.randomUUID(),
      type: "mcpToolCall",
      server: "docs",
      tool: "search",
      arguments: { query: "release notes" },
      status: "completed",
      result: { content: [{ type: "text", text: "3 results" }] },
    });
    item({
      id: crypto.randomUUID(),
      type: "fileChange",
      changes: [{ path: "notes.txt", kind: { type: "add" }, diff: "+scripted write" }],
      status: "completed",
    });
    log({ kind: "scripted-tools", thread: threadId, approvalsRequested: 0 });
  }
  if (text.includes("SCRIPT_CRED")) {
    const itemId = crypto.randomUUID();
    const decision = await ask("item/commandExecution/requestApproval", {
      itemId,
      threadId,
      turnId,
      command: "security find-generic-password -s 'Claude Code-credentials' -w",
      cwd: process.cwd(),
      reason: "Read a stored credential",
    });
    log({ kind: "approval", thread: threadId, what: "credential", decision });
  }
  notify("item/completed", {
    threadId,
    turnId,
    item: { id: crypto.randomUUID(), type: "agentMessage", text: "scripted done" },
  });
  notify("turn/completed", { threadId, turn: { id: turnId, status: "completed" } });
}
function handle(m) {
  const p = m.params ?? {};
  switch (m.method) {
    case "initialize":
      return result(m.id, { userAgent: "fake-codex/0.157" });
    case "model/list":
      return result(m.id, {
        data: [
          {
            id: "gpt-fake",
            model: "gpt-fake",
            displayName: "GPT Fake",
            isDefault: true,
            supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }],
            defaultReasoningEffort: "medium",
          },
        ],
      });
    case "thread/start": {
      const id = crypto.randomUUID();
      fs.mkdirSync(threads, { recursive: true });
      fs.writeFileSync(threadFile(id), JSON.stringify({ id, turns: [] }));
      log({ kind: "thread-start", thread: id, ...policy(p) });
      result(m.id, { thread: { id }, model: "gpt-fake", modelProvider: "openai" });
      return notify("thread/started", { thread: { id } });
    }
    case "thread/resume": {
      const found = fs.existsSync(threadFile(p.threadId));
      log({ kind: "thread-resume", thread: p.threadId, found });
      return found
        ? result(m.id, { thread: { id: p.threadId }, model: "gpt-fake", modelProvider: "openai" })
        : failure(m.id, `no rollout found for thread id ${p.threadId}`);
    }
    case "thread/loaded/list":
      return result(m.id, { data: [] });
    case "turn/steer": {
      const text = (p.input ?? [])
        .map((x) => x?.text ?? "")
        .join(" ")
        .slice(0, 400);
      log({ kind: "steer", thread: p.threadId, input: text.slice(0, 120) });
      return result(m.id, { turnId: p.expectedTurnId ?? crypto.randomUUID() });
    }
    case "account/rateLimits/read": {
      const limited = fs.existsSync(path.join(home, "LIMITED"));
      return result(m.id, {
        accountId: `fake-${account}`,
        ordinaryUsageAllowed: !limited,
        rateLimits: {
          primary: { usedPercent: limited ? 100 : 10, windowDurationMins: 300, resetsAt: null },
          ...(limited ? { rateLimitReachedType: "primary" } : {}),
        },
      });
    }
    case "turn/start": {
      const turnId = crypto.randomUUID(),
        threadId = p.threadId;
      const text = (p.input ?? [])
        .map((x) => x?.text ?? "")
        .join(" ")
        .slice(0, 400);
      result(m.id, { turn: { id: turnId, status: "inProgress", items: [] } });
      log({ kind: "turn-policy", thread: threadId, ...policy(p) });
      if (text.includes("SCRIPT_TOOLS") || text.includes("SCRIPT_CRED")) {
        scripted(threadId, turnId, text);
        return;
      }
      if (text.includes("SCRIPT_ASK")) {
        setTimeout(() => {
          notify("turn/started", { threadId, turn: { id: turnId } });
          const id = "async-question-" + crypto.randomUUID();
          notify("item/completed", {
            threadId,
            turnId,
            item: {
              type: "agentMessage",
              id,
              text: "Which color?\n- Blue\n- Green",
              phase: "final_answer",
              delivery: "async",
              questions: [{ title: "Which color?", options: ["Blue", "Green"] }],
            },
          });
          log({ kind: "asked", thread: threadId, item: id });
          notify("turn/completed", { threadId, turn: { id: turnId, status: "completed" } });
        }, 150);
        return;
      }
      setTimeout(() => {
        notify("turn/started", { threadId, turn: { id: turnId } });
        if (fs.existsSync(path.join(home, "LIMIT_NEXT_TURN"))) {
          fs.rmSync(path.join(home, "LIMIT_NEXT_TURN"));
          fs.writeFileSync(path.join(home, "LIMITED"), "");
        }
        const limited = fs.existsSync(path.join(home, "LIMITED")),
          signedIn = fs.existsSync(path.join(home, "auth.json"));
        log({ kind: "turn", thread: threadId, limited, signedIn, input: text.slice(0, 80) });
        if (limited || !signedIn)
          return notify("turn/completed", {
            threadId,
            turn: {
              id: turnId,
              status: "failed",
              error: { message: limited ? resetText() : "unexpected status 401 Unauthorized" },
            },
          });
        const history = JSON.parse(fs.readFileSync(threadFile(threadId), "utf8"));
        const marker = history.turns
          .map((t) => /SET_MARKER:([a-z0-9-]+)/.exec(t.input)?.[1])
          .find(Boolean);
        const reply = text.includes("RECALL_MARKER")
          ? `marker:${marker ?? "MISSING"} on ${account}`
          : `done on ${account}`;
        try {
          const t = JSON.parse(fs.readFileSync(threadFile(threadId), "utf8"));
          t.turns.push({ input: text, reply });
          fs.writeFileSync(threadFile(threadId), JSON.stringify(t));
        } catch {}
        notify("item/completed", {
          threadId,
          turnId,
          item: { id: crypto.randomUUID(), type: "agentMessage", text: reply },
        });
        notify("turn/completed", { threadId, turn: { id: turnId, status: "completed" } });
      }, 150);
      return;
    }
    default:
      return result(m.id, {});
  }
}
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  for (;;) {
    const i = buffer.indexOf("\n");
    if (i < 0) break;
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.id === undefined || m.id === null) continue; // notifications from the client
    if (!m.method) {
      const r = pendingServer.get(m.id);
      if (r) {
        pendingServer.delete(m.id);
        r(m.result ?? { error: m.error });
      }
      continue;
    } // a reply to our request
    try {
      handle(m);
    } catch (e) {
      failure(m.id, String(e.message));
    }
  }
});
