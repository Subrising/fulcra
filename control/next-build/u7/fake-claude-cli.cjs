// Update-7 permission-mode gate, scratch only: a stand-in for the `claude` CLI as the Agent SDK drives it (stream-json on
// stdin/stdout with control requests), configured as the Claude provider's command. It never contacts Anthropic and never
// reads a credential or the Keychain (the real CLI would read the login Keychain on macOS -- the reason it is never run).
// - `--version` answers like Claude Code 2.1.280.
// - Each launch logs the permission mode and model it was given (argv --permission-mode / --model, and any later
//   set_permission_mode) to FAKE_CLAUDE_LOG.
// - A user turn containing SCRIPT_TOOLS asks the host whether it may use an MCP tool (mcp__docs__search) and Write, the
//   way the CLI asks through can_use_tool; SCRIPT_CRED asks for a Bash credential read (security find-generic-password).
//   Each decision the host returns is logged; any other turn just answers.
// The stand-in asks on every scripted call; whether Fulcra's own layer turns an ask into an approval for the owner is
// what the gate measures.
const fs = require("node:fs"),
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
const LOG = process.env.FAKE_CLAUDE_LOG;
const log = (o) => {
  if (LOG)
    fs.appendFileSync(LOG, JSON.stringify({ at: Date.now(), pid: process.pid, ...o }) + "\n");
};
let mode = flag("--permission-mode"),
  model = flag("--model") ?? "claude-sonnet-5-5";
const session = flag("--resume") ?? crypto.randomUUID();
log({
  kind: "start",
  permissionMode: mode,
  model,
  resume: !!flag("--resume"),
  skipPermissions: argv.includes("--dangerously-skip-permissions"),
});
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const pending = new Map();
const control = (request) =>
  new Promise((resolve) => {
    const id = crypto.randomUUID();
    pending.set(id, resolve);
    send({ type: "control_request", request_id: id, request });
    setTimeout(() => {
      if (pending.delete(id)) resolve({ timedOut: true });
    }, 120000);
  });
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
    tools: ["Read", "Write", "Edit", "Bash", "mcp__docs__search"],
    mcp_servers: [{ name: "docs", status: "connected" }],
    slash_commands: [],
    output_style: "default",
    claude_code_version: "2.1.280",
  });
}
const assistant = (content) =>
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
      content,
      stop_reason: null,
      stop_sequence: null,
      usage,
    },
  });
async function emitTool(name, input, what) {
  const id = "toolu_" + crypto.randomUUID().replace(/-/g, "").slice(0, 24);
  assistant([{ type: "tool_use", id, name, input }]);
  const decision = await control({
    subtype: "can_use_tool",
    tool_name: name,
    input,
    permission_suggestions: [],
    tool_use_id: id,
  });
  const behavior =
    decision?.behavior ??
    decision?.response?.behavior ??
    (decision?.timedOut ? "timed-out" : "unknown");
  log({ kind: "tool", what, tool: name, behavior, permissionMode: mode });
  send({
    type: "user",
    session_id: session,
    uuid: crypto.randomUUID(),
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          content: behavior === "allow" ? "ok" : "denied",
          is_error: behavior !== "allow",
        },
      ],
    },
  });
}
async function turn(text) {
  init();
  if (text.includes("SCRIPT_TOOLS")) {
    await emitTool("mcp__docs__search", { query: "release notes" }, "mcp");
    await emitTool(
      "Write",
      { file_path: `${process.cwd()}/notes.txt`, content: "scripted write\n" },
      "file-write",
    );
  }
  if (text.includes("SCRIPT_CRED"))
    await emitTool(
      "Bash",
      {
        command: "security find-generic-password -s 'Claude Code-credentials' -w",
        description: "Read a stored credential",
      },
      "credential",
    );
  log({ kind: "turn", input: text.slice(0, 80), permissionMode: mode });
  assistant([{ type: "text", text: "done" }]);
  send({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 5,
    duration_api_ms: 5,
    num_turns: 1,
    result: "done",
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
    if (m.type === "control_response") {
      const id = m.response?.request_id;
      const r = pending.get(id);
      if (r) {
        pending.delete(id);
        r(m.response?.response ?? m.response);
      }
      continue;
    }
    if (m.type === "control_request") {
      const req = m.request ?? {};
      if (req.subtype === "set_permission_mode") {
        mode = req.mode;
        log({ kind: "set-mode", permissionMode: mode });
      }
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
