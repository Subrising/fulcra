import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addAccount, readAccounts, setAccount } from "./accounts.mjs";
import { askOnce, AskError, refuseShellShim, spawnClaudeOnce } from "./ask.mjs";

const T0 = Date.parse("2026-10-11T00:00:00Z");
const scratch = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fulcra-ask-test-")));
const keychain = { get: async (id) => `sk-ant-oat01-${id}` };
const LIMIT = {
  is_error: true,
  api_error_status: 429,
  result: "You've hit your session limit · resets 3pm (Australia/Brisbane)",
};
const ok = (text = "hello", extra = {}) => ({
  is_error: false,
  result: text,
  total_cost_usd: 0.0012,
  modelUsage: { "claude-haiku-5-5": {} },
  ...extra,
});
const input = (over = {}) => ({ prompt: "Say hello", model: "claude-haiku-5-5", ...over });
async function pool() {
  const root = scratch();
  const a = await addAccount(root, { provider: "claude", name: "Work" }, T0);
  const b = await addAccount(root, { provider: "claude", name: "Personal" }, T0 + 1);
  return { root, a, b };
}
const rejects = async (promise, code) => {
  await assert.rejects(promise, (e) => e instanceof AskError && e.code === code);
};

test("an ask returns output, account, model and cost, and uses the pooled account's own credential", async () => {
  const { root, a } = await pool();
  const seen = [];
  const r = await askOnce({
    root,
    keychain,
    input: input(),
    now: () => T0,
    spawnClaude: async (o) => (seen.push(o), ok("hello")),
  });
  assert.deepEqual(r, {
    output: "hello",
    account: "Work",
    model: "claude-haiku-5-5",
    costUsd: 0.0012,
  });
  assert.equal(seen[0].token, `sk-ant-oat01-${a.id}`);
  assert.equal(seen[0].model, "claude-haiku-5-5");
});

test("an ask creates no session, assignment or agent record in the pool store", async () => {
  const { root } = await pool();
  await askOnce({ root, keychain, input: input(), now: () => T0, spawnClaude: async () => ok() });
  assert.deepEqual(readAccounts(root).assignments, {});
});

test("a structured answer comes from structured_output, or from JSON text; a bad answer fails", async () => {
  const { root } = await pool();
  const schema = { type: "object", properties: { n: { type: "number" } } };
  const run = (result) =>
    askOnce({
      root,
      keychain,
      input: input({ schema }),
      now: () => T0,
      spawnClaude: async () => result,
    });
  assert.deepEqual((await run(ok("", { structured_output: { n: 1 } }))).output, { n: 1 });
  assert.deepEqual((await run(ok('{"n":2}'))).output, { n: 2 });
  await rejects(run(ok("not json")), "OUTPUT_SCHEMA_FAILED");
});

test("a limit marks the account limited with its kind and reset, and the call is tried once on the next account", async () => {
  const { root, b } = await pool();
  const used = [];
  const r = await askOnce({
    root,
    keychain,
    input: input(),
    now: () => T0,
    spawnClaude: async (o) => {
      used.push(o.token);
      return used.length === 1 ? LIMIT : ok("second");
    },
  });
  assert.equal(r.account, "Personal");
  assert.equal(r.output, "second");
  assert.equal(used.length, 2);
  const work = readAccounts(root).accounts.find((x) => x.name === "Work");
  assert.equal(work.limitKind, "session");
  assert.equal(work.limitedUntil, "2026-10-11T05:00:00.000Z");
  assert.ok(used[1].endsWith(b.id));
});

test("when both accounts are at their limit the call fails with a clear error, and marks both", async () => {
  const { root } = await pool();
  await assert.rejects(
    askOnce({ root, keychain, input: input(), now: () => T0, spawnClaude: async () => LIMIT }),
    (e) =>
      e.code === "ALL_LIMITED" &&
      /Work: session until/.test(e.message) &&
      /Personal/.test(e.message),
  );
  const state = readAccounts(root).accounts;
  assert.ok(state.every((a) => a.limitedUntil && a.limitKind === "session"));
});

test("with one account, a limit fails at once and a later ask skips the limited account", async () => {
  const root = scratch();
  await addAccount(root, { provider: "claude", name: "Only" }, T0);
  await rejects(
    askOnce({ root, keychain, input: input(), now: () => T0, spawnClaude: async () => LIMIT }),
    "ALL_LIMITED",
  );
  let called = 0;
  await rejects(
    askOnce({
      root,
      keychain,
      input: input(),
      now: () => T0 + 60_000,
      spawnClaude: async () => (called++, ok()),
    }),
    "ALL_LIMITED",
  );
  assert.equal(called, 0);
});

test("no pool, no usable account, or no credential: a clear error and no model call", async () => {
  const empty = scratch();
  const never = async () => assert.fail("must not call the model");
  await rejects(
    askOnce({ root: empty, keychain, input: input(), spawnClaude: never }),
    "NO_ACCOUNT",
  );
  const { root, a } = await pool();
  await setAccount(root, a.id, { enabled: false });
  const b = readAccounts(root).accounts.find((x) => x.name === "Personal");
  await setAccount(root, b.id, { enabled: false });
  await rejects(askOnce({ root, keychain, input: input(), spawnClaude: never }), "NO_ACCOUNT");
  const lonely = await pool();
  await rejects(
    askOnce({
      root: lonely.root,
      keychain: { get: async () => null },
      input: input(),
      spawnClaude: never,
    }),
    "NO_CREDENTIAL",
  );
});

test("a bad prompt or model is refused before any account is read", async () => {
  const { root } = await pool();
  const never = async () => assert.fail("must not call the model");
  await rejects(
    askOnce({ root, keychain, input: input({ prompt: "  " }), spawnClaude: never }),
    "BAD_INPUT",
  );
  await rejects(
    askOnce({ root, keychain, input: input({ model: "gpt-5" }), spawnClaude: never }),
    "BAD_INPUT",
  );
});

test("a model error that is not a limit fails without marking the account", async () => {
  const { root } = await pool();
  await assert.rejects(
    askOnce({
      root,
      keychain,
      input: input(),
      now: () => T0,
      spawnClaude: async () => ({
        is_error: true,
        api_error_status: 500,
        result: "API Error: boom",
      }),
    }),
    /The model call failed: API Error: boom/,
  );
  assert.ok(readAccounts(root).accounts.every((a) => !a.limitedUntil));
});

test("the real weekly-limit result of the Claude CLI (11 Oct, exit 1, is_error, 429) marks the account weekly with its reset", async () => {
  const { root } = await pool();
  const real = {
    type: "result",
    subtype: "success",
    is_error: true,
    api_error_status: 429,
    api_error: "usage_limit_reached",
    terminal_reason: "api_error",
    result: "You've hit your weekly limit · resets Oct 13 at 8am (Australia/Brisbane)",
    total_cost_usd: 0,
  };
  const now = Date.parse("2026-10-11T05:00:00Z");
  await assert.rejects(
    askOnce({ root, keychain, input: input(), now: () => now, spawnClaude: async () => real }),
    (e) => e.code === "ALL_LIMITED",
  );
  const work = readAccounts(root).accounts.find((a) => a.name === "Work");
  assert.deepEqual([work.limitKind, work.limitedUntil], ["weekly", "2026-10-12T22:00:00.000Z"]);
});

test("a 429 with no limit line holds the account for a short time only, and the call moves on", async () => {
  const { root } = await pool();
  let calls = 0;
  const rate = { is_error: true, api_error_status: 429, result: "Rate limited, try again shortly" };
  const r = await askOnce({
    root,
    keychain,
    input: input(),
    now: () => T0,
    spawnClaude: async () => (++calls === 1 ? rate : ok()),
  });
  assert.equal(r.account, "Personal");
  const work = readAccounts(root).accounts.find((a) => a.name === "Work");
  assert.deepEqual(
    [work.limitKind, work.limitedUntil],
    ["rate", new Date(T0 + 10 * 60_000).toISOString()],
  );
});

test(
  "a CLI that exits before it reads a large prompt fails the call; the EPIPE does not crash the process",
  { skip: process.platform === "win32" },
  async () => {
    await assert.rejects(
      spawnClaudeOnce({
        token: "T",
        model: "claude-haiku-5-5",
        prompt: "x".repeat(5_000_000),
        timeoutMs: 20_000,
        bin: "/usr/bin/false",
      }),
      (e) => e instanceof AskError && e.code === "BAD_RESULT",
    );
  },
);

test(
  "a scratch folder that cannot be removed does not throw; the answer still comes back",
  { skip: process.platform === "win32" || process.getuid?.() === 0 },
  async () => {
    const dir = scratch();
    const bin = path.join(dir, "fake-claude.sh");
    // Leaves a folder that rmSync cannot empty (no write permission), then answers with its own scratch path.
    fs.writeFileSync(
      bin,
      '#!/bin/sh\ncat > /dev/null\nmkdir locked && touch locked/f && chmod 500 locked\nprintf \'{"is_error":false,"result":"%s"}\' "$PWD"\n',
      { mode: 0o700 },
    );
    const r = await spawnClaudeOnce({
      token: "T",
      model: "claude-haiku-5-5",
      prompt: "hi",
      timeoutMs: 20_000,
      bin,
    });
    assert.equal(r.is_error, false);
    fs.chmodSync(path.join(r.result, "locked"), 0o700);
    fs.rmSync(r.result, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  },
);

// Fulcra 0.2.17 (FU-92): a Windows shell shim is never run, because a shell changes the arguments.
const scratchFolders = () =>
  fs.readdirSync(os.tmpdir()).filter((name) => /^fulcra-ask-[A-Za-z0-9]{6}$/.test(name)).length;

test("a .cmd or .bat Claude binary is refused with a plain error, and nothing is started or left behind", async () => {
  for (const name of ["claude.cmd", "C:\\tools\\claude.BAT", "/x/claude.Cmd"]) {
    assert.throws(
      () => refuseShellShim(name),
      (e) => e instanceof AskError && e.code === "CLI_UNSUPPORTED" && /claude\.exe/.test(e.message),
    );
  }
  assert.doesNotThrow(() => refuseShellShim("claude"));
  assert.doesNotThrow(() => refuseShellShim("C:\\tools\\claude.exe"));
  const before = scratchFolders();
  for (const via of [{ bin: "claude.cmd" }, { env: { FULCRA_CLAUDE_BIN: "C:\\x\\claude.bat" } }]) {
    await assert.rejects(
      spawnClaudeOnce({
        token: "t",
        model: "claude-haiku-5-5",
        prompt: "x",
        timeoutMs: 1000,
        ...via,
      }),
      (e) => e.code === "CLI_UNSUPPORTED",
    );
  }
  assert.equal(scratchFolders(), before);
});

test("the CLI is never started through a shell, even for a schema with shell characters", () => {
  const src = fs.readFileSync(new URL("./ask.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /shell:\s*(?:true|process|[a-z]+\()/);
  assert.match(src, /shell:\s*false/);
});

// Fulcra 0.2.17 (FU-93, FU-94): spawnClaudeOnce against a fake Claude CLI, and the timeout that stops the whole tree.
import { killProcessTree } from "./ask.mjs";
const posix = process.platform === "win32" ? { skip: "needs a POSIX shell" } : {};
function fakeClaude(body) {
  const dir = scratch();
  const file = path.join(dir, "fake-claude.mjs");
  fs.writeFileSync(file, `#!${process.execPath}\n${body}`, { mode: 0o755 });
  return { dir, file };
}
const run = (file, over = {}) =>
  spawnClaudeOnce({
    token: "sk-ant-oat01-testtoken",
    model: "claude-haiku-5-5",
    prompt: "x",
    timeoutMs: 15000,
    bin: file,
    env: { PATH: process.env.PATH, HOME: os.homedir(), UNRELATED_SECRET: "must-not-pass" },
    ...over,
  });

test(
  "spawnClaudeOnce: flags, scratch folder, environment and stdin are exactly as designed",
  posix,
  async () => {
    const { file } = fakeClaude(`
    let input = ""; process.stdin.on("data", (d) => (input += d));
    process.stdin.on("end", () => process.stdout.write(JSON.stringify({
      is_error: false, result: "ok", argv: process.argv.slice(2), cwd: process.cwd(), input,
      env: { token: process.env.CLAUDE_CODE_OAUTH_TOKEN, config: process.env.CLAUDE_CONFIG_DIR,
        apiKey: process.env.ANTHROPIC_API_KEY, authToken: process.env.ANTHROPIC_AUTH_TOKEN,
        secret: process.env.UNRELATED_SECRET ?? null } })));
  `);
    const prompt = 'Say "hi" & | < > ^ % now';
    const schema = { type: "object", properties: { "a&b": { type: "string" } } };
    const before = scratchFolders();
    const r = await run(file, { prompt, schema });
    assert.equal(r.input, prompt, "the prompt goes on stdin, unchanged");
    const flag = (name) => r.argv[r.argv.indexOf(name) + 1];
    assert.equal(r.argv.includes("-p"), true);
    assert.equal(flag("--output-format"), "json");
    assert.equal(flag("--model"), "claude-haiku-5-5");
    assert.equal(flag("--tools"), "", "tools are off: an empty value stays an empty argument");
    assert.equal(flag("--setting-sources"), "");
    assert.ok(r.argv.includes("--no-session-persistence"));
    assert.ok(r.argv.includes("--disable-slash-commands"));
    assert.deepEqual(JSON.parse(flag("--json-schema")), schema);
    assert.equal(r.env.token, "sk-ant-oat01-testtoken");
    assert.equal(r.env.apiKey, "");
    assert.equal(r.env.authToken, "");
    assert.equal(r.env.secret, null, "the parent's other variables do not reach the CLI");
    assert.ok(path.basename(r.cwd).startsWith("fulcra-ask-"));
    assert.equal(path.basename(path.dirname(r.env.config)), path.basename(r.cwd));
    assert.ok(!r.argv.some((a) => a.includes("testtoken")), "the token is never in argv");
    assert.equal(fs.existsSync(r.cwd), false, "the scratch folder is removed");
    assert.equal(scratchFolders(), before);
  },
);

test(
  "spawnClaudeOnce: a bad result and a missing binary both clean up the scratch folder",
  posix,
  async () => {
    const before = scratchFolders();
    const bad = fakeClaude(`process.stdout.write("not json");`);
    await assert.rejects(run(bad.file), (e) => e.code === "BAD_RESULT");
    await assert.rejects(run("/nonexistent/claude"), (e) => e.code === "CLI_UNAVAILABLE");
    assert.equal(scratchFolders(), before);
  },
);

test(
  "spawnClaudeOnce: a CLI that exits before reading a large prompt does not crash the process",
  posix,
  async () => {
    await assert.rejects(run("/usr/bin/false", { prompt: "x".repeat(5_000_000) }), (e) =>
      ["BAD_RESULT", "CLI_UNAVAILABLE"].includes(e.code),
    );
  },
);

test(
  "spawnClaudeOnce: a timeout ends the call at once and stops a process the CLI started",
  posix,
  async () => {
    const marker = path.join(scratch(), "grandchild.pid");
    const { file } = fakeClaude(`
    import { spawn } from "node:child_process"; import fs from "node:fs";
    const g = spawn("sleep", ["30"], { stdio: ["ignore", "inherit", "inherit"] });
    fs.writeFileSync(${JSON.stringify(marker)}, String(g.pid));
    setInterval(() => {}, 1000);
  `);
    const started = Date.now();
    await assert.rejects(run(file, { timeoutMs: 1500 }), (e) => e.code === "TIMEOUT");
    assert.ok(Date.now() - started < 6000, "the job did not wait for the grandchild");
    const pid = Number(fs.readFileSync(marker, "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.throws(() => process.kill(pid, 0), /ESRCH/, "the grandchild is gone");
  },
);

test("killProcessTree uses taskkill /T /F on Windows and the process group elsewhere", () => {
  const calls = [];
  const run = (...args) => (calls.push(args), { on: () => ({ unref() {} }) });
  const killed = [];
  killProcessTree({ pid: 4242, kill: (s) => killed.push(s) }, { platform: "win32", run });
  assert.deepEqual(calls[0].slice(0, 2), ["taskkill", ["/pid", "4242", "/T", "/F"]]);
  assert.deepEqual(killed, ["SIGKILL"]);
  assert.doesNotThrow(() => killProcessTree({ pid: undefined, kill() {} }, { platform: "linux" }));
});

test("an ask with --account takes a name or an ID, in any case", async () => {
  const { root, b } = await pool();
  for (const wanted of ["personal", b.id.toUpperCase()]) {
    const r = await askOnce({
      root,
      keychain,
      input: input({ account: wanted }),
      now: () => T0,
      spawnClaude: async () => ok(),
    });
    assert.equal(r.account, "Personal");
  }
});
