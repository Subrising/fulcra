// FIX-8 B-1 (W1): a stand-in for the `claude` CLI as the Agent SDK drives it (stream-json on stdin/stdout), with a
// CONVERSATION: each session id keeps its transcript in FAKE_CLAUDE_STATE/<session>.jsonl, and `--resume <id>` continues
// it -- the property the real CLI gives a switched chat. It never contacts Anthropic and never reads the Keychain.
// - A user turn "REMEMBER <marker>" stores the marker in the transcript; a turn containing "RECALL" answers from the
//   transcript ("recalled:<marker>", or "recalled:none" when this process does not hold that conversation).
// - Each launch logs its session id, whether it resumed (and whether the transcript was there), the account label it was
//   launched with (FULCRA_ACCOUNT_NAME) and a SHORT HASH of its token -- never the token -- to FAKE_CLAUDE_LOG.
// Based on next-build/u7/fake-claude-cli.cjs (the permission-mode gate's stand-in).
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  process.stdout.write("2.1.280 (Claude Code)\n");
  process.exit(0);
}
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
};
const LOG = process.env.FAKE_CLAUDE_LOG,
  STATE = process.env.FAKE_CLAUDE_STATE;
const log = (o) => {
  if (LOG)
    fs.appendFileSync(LOG, JSON.stringify({ at: Date.now(), pid: process.pid, ...o }) + "\n");
};
let mode = flag("--permission-mode"),
  model = flag("--model") ?? "claude-sonnet-5-5";
const resumed = flag("--resume"),
  session = resumed ?? flag("--session-id") ?? crypto.randomUUID();
const file = STATE ? path.join(STATE, `${session.replace(/[^A-Za-z0-9-]/g, "")}.jsonl`) : null;
const token = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "";
const tokenHash = token
  ? crypto.createHash("sha256").update(token).digest("hex").slice(0, 16)
  : null;
log({
  kind: "start",
  session,
  resume: !!resumed,
  transcriptFound: !!(file && fs.existsSync(file)),
  account: process.env.FULCRA_ACCOUNT_NAME ?? null,
  tokenHash,
  apiKeyEmpty: process.env.ANTHROPIC_API_KEY === "" || process.env.ANTHROPIC_API_KEY === undefined,
});
const transcript = () =>
  file && fs.existsSync(file)
    ? fs
        .readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
const append = (o) => {
  if (file) {
    fs.mkdirSync(STATE, { recursive: true });
    fs.appendFileSync(file, JSON.stringify(o) + "\n");
  }
};
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const usage = {
  input_tokens: 1,
  output_tokens: 1,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};
let initSent = false;
function init() {
  if (initSent) return;
  initSent = true;
  send({
    type: "system",
    subtype: "init",
    session_id: session,
    uuid: crypto.randomUUID(),
    cwd: process.cwd(),
    model,
    permissionMode: mode ?? "default",
    apiKeySource: "none",
    tools: ["Read", "Write", "Edit", "Bash"],
    mcp_servers: [],
    slash_commands: [],
    output_style: "default",
    claude_code_version: "2.1.280",
  });
}
const assistant = (text) =>
  send({
    type: "assistant",
    session_id: session,
    uuid: crypto.randomUUID(),
    parent_tool_use_id: null,
    message: {
      id: "msg_" + crypto.randomUUID().replace(/-/g, ""),
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text }],
      stop_reason: null,
      stop_sequence: null,
      usage,
    },
  });
async function turn(text) {
  init();
  let reply = "done",
    recall = null;
  const remember = /REMEMBER (\S+)/.exec(text);
  if (text.includes("RECALL")) {
    const m = transcript()
      .filter((e) => e.role === "user")
      .map((e) => /REMEMBER (\S+)/.exec(e.text)?.[1])
      .findLast(Boolean);
    recall = m ?? "none";
    reply = `recalled:${recall}`;
  }
  append({ role: "user", text: text.slice(0, 400) });
  if (remember) reply = `noted:${remember[1]}`;
  append({ role: "assistant", text: reply });
  log({
    kind: "turn",
    session,
    input: text.slice(0, 80),
    recall,
    account: process.env.FULCRA_ACCOUNT_NAME ?? null,
    tokenHash,
    turns: transcript().length / 2,
  });
  assistant(reply);
  send({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 5,
    duration_api_ms: 5,
    num_turns: 1,
    result: reply,
    session_id: session,
    total_cost_usd: 0,
    usage,
    uuid: crypto.randomUUID(),
  });
}
let buffer = "",
  queue = Promise.resolve();
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
    if (m.type === "control_response") continue;
    if (m.type === "control_request") {
      const req = m.request ?? {};
      if (req.subtype === "set_permission_mode") mode = req.mode;
      if (req.subtype === "set_model" && req.model) model = req.model;
      const response =
        req.subtype === "initialize"
          ? {
              commands: [],
              output_style: "default",
              available_output_styles: ["default"],
              account: {},
              models: [
                { value: "claude-opus-5-5", displayName: "Opus 5.5", description: "" },
                { value: "claude-sonnet-5-5", displayName: "Sonnet 5.5", description: "" },
              ],
            }
          : {};
      send({
        type: "control_response",
        response: { subtype: "success", request_id: m.request_id, response },
      });
      continue;
    }
    if (m.type === "user") {
      const c = m.message?.content;
      let text = "";
      if (typeof c === "string") text = c;
      else if (Array.isArray(c)) text = c.map((x) => x?.text ?? "").join(" ");
      queue = queue
        .then(() => turn(text))
        .catch((e) => log({ kind: "error", error: String(e?.message ?? e) }));
    }
  }
});
process.stdin.on("end", () => {
  queue.then(() => process.exit(0));
});
