import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addAccount, readAccounts, setAccount } from "./accounts.mjs";
import { askOnce, AskError } from "./ask.mjs";

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

// Fulcra 0.2.17 (FU-92): a Windows shell shim is never run, because a shell changes the arguments.
import { refuseShellShim, spawnClaudeOnce } from "./ask.mjs";
const scratchFolders = () =>
  fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("fulcra-ask-")).length;

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
