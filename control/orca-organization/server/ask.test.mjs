import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addAccount, readAccounts, setAccount, publicView } from "./accounts.mjs";
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
  assert.deepEqual(killed, [], "the leader is killed after taskkill has run, not at once");
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

// 0.2.17 review: the credential never leaves, the leader's old ID is never killed, and one deadline covers the ask.
import { scrubCredential, REDACTED, TOO_DEEP, closePipes, MIN_ATTEMPT_MS } from "./ask.mjs";
import { mock } from "node:test";

test("scrubCredential removes the exact credential, its JSON and URL forms, from values and keys", () => {
  const token = "sk-ant-oat01-AAAA+BBBB/CCCC=DDDD";
  const out = scrubCredential(
    {
      result: `bad ${token} and ${encodeURIComponent(token)}`,
      nested: [{ [`key ${token}`]: `quoted \\"${token}\\"` }],
      n: 3,
      ok: null,
    },
    token,
  );
  const text = JSON.stringify(out);
  assert.equal(text.includes(token), false);
  assert.equal(text.includes(encodeURIComponent(token)), false);
  assert.ok(text.includes(REDACTED));
  assert.equal(out.n, 3);
  // A short or missing credential changes nothing.
  assert.deepEqual(scrubCredential({ a: "abc" }, "abc"), { a: "abc" });
  assert.deepEqual(scrubCredential({ a: "abc" }, undefined), { a: "abc" });
});

test("a child that prints the credential in an error, an answer, a model name or a limit line leaks it nowhere", async () => {
  const { root, a } = await pool();
  const token = `sk-ant-oat01-${a.id}`;
  const leak = (extra) => async () => ({ is_error: false, result: `x ${token}`, ...extra });
  // 1. A failed call's text.
  const failed = await askOnce({
    root,
    keychain,
    input: input(),
    now: () => T0,
    spawnClaude: async () => ({ is_error: true, api_error_status: 500, result: `boom ${token}` }),
  }).catch((e) => e);
  assert.ok(failed instanceof AskError);
  assert.equal(failed.message.includes(token), false);
  // 2. A good answer, structured output and the model name.
  const good = await askOnce({
    root,
    keychain,
    input: input({ schema: { type: "object" } }),
    now: () => T0 + 1,
    spawnClaude: leak({
      structured_output: { note: token, [token]: 1 },
      modelUsage: { [`claude-haiku-5-5-${token}`]: {} },
    }),
  });
  assert.equal(JSON.stringify(good).includes(token), false);
  // 3. A limit line: the saved note and the account view hold no credential.
  await askOnce({
    root,
    keychain,
    input: input({ account: "Work" }),
    now: () => T0 + 2,
    spawnClaude: async () => ({
      is_error: true,
      api_error_status: 429,
      result: `rate limited for ${token}`,
    }),
  }).catch(() => {});
  assert.equal(JSON.stringify(readAccounts(root)).includes(token), false);
  assert.equal(JSON.stringify(publicView(readAccounts(root), T0 + 3)).includes(token), false);
  // 4. A spawn function that throws its own text.
  const thrown = await askOnce({
    root,
    keychain,
    input: input({ account: "Personal" }),
    now: () => T0 + 4,
    spawnClaude: async () => {
      throw new Error(`spawn failed for ${token}`);
    },
  }).catch((e) => e);
  assert.equal(thrown.code, "ASK_FAILED");
  assert.equal(thrown.message.includes(token), false);
});

test("a spawn error has a fixed text: no command line, no path", posix, async () => {
  const error = await run("/nonexistent/dir/claude-with-secret-name").catch((e) => e);
  assert.equal(error.code, "CLI_UNAVAILABLE");
  assert.match(error.message, /^The Claude CLI could not start \([A-Z0-9_]+\)$/);
  assert.equal(error.message.includes("secret-name"), false);
});

test(
  "once the leader has exited, the deadline closes the pipes and rejects; the old ID is not killed",
  posix,
  async () => {
    const marker = path.join(scratch(), "grandchild.pid");
    // The leader starts a detached descendant that keeps the output pipes, then exits.
    const { file } = fakeClaude(`
    import { spawn } from "node:child_process";
    import fs from "node:fs";
    const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "inherit" });
    fs.writeFileSync(${JSON.stringify(marker)}, String(g.pid));
    g.unref();
    process.exit(0);
  `);
    const kill = mock.method(process, "kill");
    const started = Date.now();
    try {
      await assert.rejects(run(file, { timeoutMs: 1500 }), (e) => e.code === "TIMEOUT");
      assert.ok(Date.now() - started < 6000, "rejected at the deadline, not when the pipes closed");
      const negative = kill.mock.calls.filter(
        (c) => typeof c.arguments[0] === "number" && c.arguments[0] < 0,
      );
      assert.deepEqual(negative, [], "no process group was killed by its old number");
    } finally {
      kill.mock.restore();
      // The detached descendant is outside this module's reach: the test stops it.
      try {
        process.kill(Number(fs.readFileSync(marker, "utf8")), "SIGKILL");
      } catch {}
    }
  },
);

test("killProcessTree on Unix kills the group only while the leader runs, and never by the number of an exited one", () => {
  const kill = mock.method(process, "kill", () => true);
  try {
    killProcessTree({ pid: 99999, exitCode: 0, kill() {} }, { platform: "linux" });
    killProcessTree(
      { pid: 99999, exitCode: null, signalCode: "SIGTERM", kill() {} },
      { platform: "linux" },
    );
    assert.equal(kill.mock.calls.length, 0);
    const killed = [];
    killProcessTree(
      { pid: 99999, exitCode: null, signalCode: null, kill: (s) => killed.push(s) },
      { platform: "linux" },
    );
    assert.deepEqual(
      kill.mock.calls.map((c) => c.arguments),
      [[-99999, "SIGKILL"]],
    );
    assert.deepEqual(killed, ["SIGKILL"]);
  } finally {
    kill.mock.restore();
  }
});

test("a pending taskkill is not cut short by a timer that kills the leader", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const killed = [];
    const run = () => ({ on: () => undefined, unref() {} });
    killProcessTree(
      { pid: 4242, exitCode: null, signalCode: null, kill: (s) => killed.push(s) },
      { platform: "win32", run },
    );
    mock.timers.tick(60_000);
    assert.deepEqual(killed, [], "the leader stays until taskkill ends");
  } finally {
    mock.timers.reset();
  }
});

test("a credential deep inside the answer, as a value or a key, is replaced and never returned unwalked", () => {
  const token = "sk-ant-oat01-DEEPDEEPDEEPDEEP";
  let value = { leaf: token, [token]: 1 };
  for (let i = 0; i < 40; i++) value = { next: value, list: [value] };
  const text = JSON.stringify(scrubCredential(value, token));
  assert.equal(text.includes(token), false);
  assert.ok(text.includes(TOO_DEEP) || text.includes(REDACTED));
  // A shallow object is still walked in full.
  assert.equal(JSON.stringify(scrubCredential({ a: { b: token } }, token)).includes(token), false);
});

test("the credential lookup is bounded by the ask's deadline, and the spawn gets the time left after it", async () => {
  const { root } = await pool();
  let clock = T0;
  const slow = { get: async (id) => ((clock += 5000), `sk-ant-oat01-${id}`) };
  const spawned = [];
  await rejects(
    askOnce({
      root,
      keychain: slow,
      input: input({ timeoutMs: 2000 }),
      now: () => clock,
      spawnClaude: async (o) => (spawned.push(o.timeoutMs), ok()),
    }),
    "TIMEOUT",
  );
  assert.deepEqual(spawned, [], "no child starts with an expired allowance");
  // Part of the time went on the lookup: the child gets the rest, not the old figure.
  let clock2 = T0;
  const partly = { get: async (id) => ((clock2 += 1500), `sk-ant-oat01-${id}`) };
  await askOnce({
    root,
    keychain: partly,
    input: input({ timeoutMs: 5000 }),
    now: () => clock2,
    spawnClaude: async (o) => (spawned.push(o.timeoutMs), ok()),
  });
  assert.deepEqual(spawned, [3500]);
  // A lookup that never answers ends at the deadline.
  const hung = { get: () => new Promise(() => {}) };
  const started = Date.now();
  await rejects(
    askOnce({
      root,
      keychain: hung,
      input: input({ timeoutMs: 1000 }),
      spawnClaude: async () => ok(),
    }),
    "TIMEOUT",
  );
  assert.ok(Date.now() - started < 4000);
});

test("on Windows the leader is killed only after taskkill has finished", () => {
  const handlers = {};
  const run = () => ({ on: (event, fn) => ((handlers[event] = fn), undefined), unref() {} });
  const killed = [];
  killProcessTree(
    { pid: 4242, exitCode: null, signalCode: null, kill: (s) => killed.push(s) },
    { platform: "win32", run },
  );
  assert.deepEqual(killed, [], "taskkill still needs the leader to look it up");
  handlers.exit();
  assert.deepEqual(killed, ["SIGKILL"]);
  // A taskkill that cannot start falls back to the leader at once.
  const failed = [];
  killProcessTree(
    { pid: 1, exitCode: null, signalCode: null, kill: (s) => failed.push(s) },
    {
      platform: "win32",
      run: () => {
        throw new Error("no taskkill");
      },
    },
  );
  assert.deepEqual(failed, ["SIGKILL"]);
});

test("closePipes closes all three pipes and ignores one that is missing or already closed", () => {
  const closed = [];
  const pipe = (name) => ({ destroy: () => closed.push(name) });
  closePipes({ stdin: pipe("in"), stdout: pipe("out"), stderr: undefined });
  closePipes({
    stdout: {
      destroy: () => {
        throw new Error("closed");
      },
    },
  });
  assert.deepEqual(closed, ["in", "out"]);
});

test("one deadline covers the whole ask: the retry gets the time that is left, and none left is a timeout", async () => {
  const { root } = await pool();
  let clock = T0;
  const seen = [];
  const r = await askOnce({
    root,
    keychain,
    input: input({ timeoutMs: 60_000 }),
    now: () => clock,
    spawnClaude: async (o) => {
      seen.push(o.timeoutMs);
      if (seen.length === 1) {
        clock += 45_000; // the first account ends in a limit after 45 s
        return LIMIT;
      }
      return ok("second");
    },
  });
  assert.equal(r.output, "second");
  assert.deepEqual(seen, [60_000, 15_000]);
  // Used up: the retry is not started, and the error says why.
  const { root: root2 } = await pool();
  clock = T0;
  const calls = [];
  await rejects(
    askOnce({
      root: root2,
      keychain,
      input: input({ timeoutMs: 60_000 }),
      now: () => clock,
      spawnClaude: async (o) => {
        calls.push(o.timeoutMs);
        clock += 60_000 - MIN_ATTEMPT_MS + 1;
        return LIMIT;
      },
    }),
    "TIMEOUT",
  );
  assert.equal(calls.length, 1);
});

// FU-112: a revoked or invalid token is an account-down, not a usage limit.
const REVOKED_TEXT =
  'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has been revoked."}}';
// A fake Claude CLI that prints the revoked-token error for the first account's token and answers for any other.
const revokedFor = (token) =>
  fakeClaude(`
    process.stdin.resume();
    process.stdin.on("end", () => {
      const revoked = process.env.CLAUDE_CODE_OAUTH_TOKEN === ${JSON.stringify(token)};
      process.stdout.write(JSON.stringify(revoked
        ? { is_error: true, api_error_status: 401, result: ${JSON.stringify(REVOKED_TEXT)} }
        : { is_error: false, result: "hello from the next account", modelUsage: { "claude-haiku-5-5": {} } }));
    });
  `).file;

test(
  "an ask whose account token is revoked marks the account down with its reason and tries the next one",
  posix,
  async () => {
    const { root, a, b } = await pool();
    const bin = revokedFor(`sk-ant-oat01-${a.id}`);
    const r = await askOnce({
      root,
      keychain,
      input: input(),
      now: () => T0,
      spawnClaude: (o) => spawnClaudeOnce({ ...o, bin }),
    });
    assert.equal(r.output, "hello from the next account");
    assert.equal(r.account, "Personal");
    const stored = readAccounts(root).accounts.find((x) => x.id === a.id);
    assert.equal(stored.limitedUntil, null, "not a usage limit: no reset time");
    assert.match(stored.revoked.reason, /OAuth token has been revoked/);
    assert.equal(readAccounts(root).accounts.find((x) => x.id === b.id).revoked ?? null, null);
    // The revoked account stays out of the next call, with no new probe of it.
    const used = [];
    await askOnce({
      root,
      keychain,
      input: input(),
      now: () => T0 + 1000,
      spawnClaude: async (o) => (used.push(o.token), ok()),
    });
    assert.deepEqual(used, [`sk-ant-oat01-${b.id}`]);
  },
);

test("an ask for a named account with a revoked token says so and does not use another", async () => {
  const { root, a } = await pool();
  await rejects(
    askOnce({
      root,
      keychain,
      input: input({ account: "Work" }),
      now: () => T0,
      spawnClaude: async () => ({ is_error: true, api_error_status: 401, result: REVOKED_TEXT }),
    }),
    "ACCOUNT_REVOKED",
  );
  assert.ok(readAccounts(root).accounts.find((x) => x.id === a.id).revoked);
});

test("a revoked token on every account ends with a clear error, never a limit message", async () => {
  const { root } = await pool();
  await rejects(
    askOnce({
      root,
      keychain,
      input: input(),
      now: () => T0,
      spawnClaude: async () => ({ is_error: true, result: REVOKED_TEXT }),
    }),
    "ALL_REVOKED",
  );
});

test("a depth cutoff fails structured output instead of returning a changed schema type", async (t) => {
  const { root } = await pool();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const schema = {
    $defs: { node: { type: "object", properties: { next: { $ref: "#/$defs/node" } } } },
    $ref: "#/$defs/node",
  };
  let deep = {};
  for (let i = 0; i < 40; i++) deep = { next: deep };
  const run = (result) =>
    askOnce({
      root,
      keychain,
      input: input({ schema }),
      now: () => T0,
      spawnClaude: async () => result,
    });
  await rejects(run(ok("", { structured_output: deep })), "OUTPUT_SCHEMA_FAILED");
  await rejects(run(ok(JSON.stringify(deep))), "OUTPUT_SCHEMA_FAILED");
  // A literal marker is model data, not proof that the scrubber cut a subtree.
  assert.deepEqual((await run(ok("", { structured_output: { note: TOO_DEEP } }))).output, {
    note: TOO_DEEP,
  });
  assert.deepEqual((await run(ok("", { structured_output: {}, modelUsage: deep }))).output, {});
});
