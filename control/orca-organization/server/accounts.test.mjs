import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  update,
  addAccount,
  setAccount,
  setPolicy,
  assign,
  rotate,
  readAccounts,
  publicView,
  accountOf,
  choose,
  prepareCodexHome,
  codexHome,
  SHARED,
  createKeychain,
  sessionOpenHook,
  rotationFor,
  sessionEnded,
  removeAccount,
  setDefaultAccount,
  switchSession,
  sessionAccounts,
} from "./accounts.mjs";

const T0 = Date.parse("2026-10-01T00:00:00Z");
const scratch = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fulcra-accounts-")));
const S = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("a new launch takes an account by priority, keeps it on resume, and the pool is empty until an account is added", async () => {
  const root = scratch();
  assert.equal(await assign(root, S(1), "claude", T0), null); // no pool: the launch is left as it was
  const a = await addAccount(root, { provider: "claude", name: "Work" }, T0),
    b = await addAccount(root, { provider: "claude", name: "Personal" }, T0 + 1);
  assert.equal((await assign(root, S(1), "claude", T0)).account.id, a.id);
  assert.equal((await assign(root, S(2), "claude", T0)).account.id, a.id);
  assert.equal((await assign(root, S(1), "claude", T0 + 5)).account.id, a.id); // resume keeps its account
  await setAccount(root, a.id, { enabled: false });
  assert.equal((await assign(root, S(3), "claude", T0)).account.id, b.id);
  assert.equal(await assign(root, S(4), "codex", T0), null); // other provider: no pool
});
test("spread policy balances live sessions across accounts", async () => {
  const root = scratch();
  const a = await addAccount(root, { provider: "codex", name: "A" }, T0),
    b = await addAccount(root, { provider: "codex", name: "B" }, T0 + 1);
  for (const x of [a, b]) await setAccount(root, x.id, { auth: "ok" });
  await setPolicy(root, "spread");
  const got = [];
  for (let i = 1; i <= 4; i++) got.push((await assign(root, S(i), "codex", T0)).account.name);
  assert.deepEqual(got.sort(), ["A", "A", "B", "B"]);
  // Two sessions end on one account: the next launch goes there.
  const s = readAccounts(root),
    onA = Object.entries(s.assignments)
      .filter(([, x]) => x.accountId === a.id)
      .map(([id]) => id);
  for (const id of onA) await sessionEnded(root, id);
  assert.equal(choose(readAccounts(root), "codex", T0).name, "A");
});
test("a usage limit marks the account limited until its reset, moves the session, and new sessions avoid it; all limited -> the earliest reset", async () => {
  const root = scratch();
  const a = await addAccount(root, { provider: "claude", name: "A" }, T0),
    _b = await addAccount(root, { provider: "claude", name: "B" }, T0 + 1);
  assert.equal((await assign(root, S(1), "claude", T0)).account.id, a.id);
  const reset = new Date(T0 + 3600000).toISOString();
  const r = await rotate(
    root,
    S(1),
    "claude",
    { resetAt: reset, note: "session limit", stopId: "stop-1" },
    T0 + 10,
  );
  assert.deepEqual([r.fromName, r.toName, r.resetAt], ["A", "B", reset]);
  assert.equal(accountOf(readAccounts(root), S(1)).name, "B");
  assert.equal((await assign(root, S(2), "claude", T0 + 20)).account.name, "B"); // a new session avoids A
  assert.equal(rotationFor(root, "stop-1").toName, "B");
  const r2 = await rotate(
    root,
    S(1),
    "claude",
    { resetAt: new Date(T0 + 7200000).toISOString() },
    T0 + 30,
  );
  assert.equal(r2.to, null);
  assert.equal(r2.earliestReset, reset);
  const v = publicView(readAccounts(root), T0 + 40);
  assert.equal(v.allLimited.claude, reset);
  assert.equal(v.accounts.find((x) => x.name === "A").status.state, "limited");
  const again = await assign(root, S(3), "claude", T0 + 40);
  assert.equal(again.allLimited, true);
  assert.equal(again.account.name, "A"); // earliest reset
  assert.equal((await assign(root, S(4), "claude", T0 + 3600001 + 1)).account.name, "A"); // after A's reset it is back
});
test("the public view carries no credential and no path", async () => {
  const root = scratch();
  await addAccount(root, { provider: "claude", name: "A" }, T0);
  const text = JSON.stringify(publicView(readAccounts(root), T0));
  assert.equal(/token|secret|auth\.json|\/Users\/|\/private\//i.test(text), false, text);
  assert.equal(fs.statSync(path.join(root, "accounts/accounts.json")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(root, "accounts")).mode & 0o777, 0o700);
});
test("a Codex account home: its own auth, everything else linked to the shared base", async () => {
  const root = scratch(),
    base = path.join(scratch(), "codex-base");
  const a = await addAccount(root, { provider: "codex", name: "A" }, T0);
  const home = prepareCodexHome(root, a.id, base);
  assert.equal(home, codexHome(root, a.id));
  for (const n of SHARED) assert.equal(fs.readlinkSync(path.join(home, n)), path.join(base, n));
  assert.match(
    fs.readFileSync(path.join(home, "config.toml"), "utf8"),
    /cli_auth_credentials_store = "file"/,
  );
  assert.equal(fs.statSync(home).mode & 0o777, 0o700);
  fs.writeFileSync(path.join(base, "sessions", "rollout-x.jsonl"), "{}");
  assert.ok(fs.existsSync(path.join(home, "sessions", "rollout-x.jsonl"))); // a thread written on any account is seen by all
  prepareCodexHome(root, a.id, base); // idempotent
});
test("the launch hook: a pooled Claude launch gets the token for this launch only; a missing token moves to the next account; no pool leaves the launch alone", async () => {
  const root = scratch();
  const tokens = new Map();
  const keychain = { get: async (id) => tokens.get(id) ?? null };
  const hook = sessionOpenHook({ root: () => root, keychain, now: () => T0 });
  const req = (id, provider = "claude", purpose = "interactive") => ({
    request: {
      agentId: id,
      provider,
      cwd: "/x",
      workspaceId: null,
      reason: "create",
      purpose,
      env: { KEEP: "1" },
    },
  });
  assert.deepEqual((await hook(req(S(1)))).env, { KEEP: "1" });
  const a = await addAccount(root, { provider: "claude", name: "A" }, T0),
    b = await addAccount(root, { provider: "claude", name: "B" }, T0 + 1);
  tokens.set(b.id, "sk-ant-oat01-" + "x".repeat(40));
  const out = await hook(req(S(2)));
  assert.equal(out.env.CLAUDE_CODE_OAUTH_TOKEN, tokens.get(b.id));
  assert.equal(out.env.ANTHROPIC_API_KEY, "");
  assert.equal(out.env.KEEP, "1");
  assert.equal(out.env.FULCRA_ACCOUNT_ID, b.id);
  assert.equal(out.env.FULCRA_ACCOUNT_NAME, "B");
  assert.equal(readAccounts(root).accounts.find((x) => x.id === a.id).auth, "expired");
  assert.equal(JSON.stringify(readAccounts(root)).includes(tokens.get(b.id)), false); // never stored in the account store
  assert.deepEqual((await hook(req(S(3), "claude", "history"))).env, { KEEP: "1" }); // a history read is not a launch
});
// B6: the Keychain path is exercised against fake-security.fixture.mjs (0600 files in a scratch dir) -- never the real
// `security`, which would create a keychain and add it to the user's keychain search list.
function fakeSecurity(dir) {
  const bin = path.join(dir, "security");
  fs.writeFileSync(
    bin,
    `#!/bin/sh\nexec "${process.execPath}" "${path.join(import.meta.dirname, "fake-security.fixture.mjs")}" "$@"\n`,
    { mode: 0o700 },
  );
  return bin;
}
test("keychain: a token goes in through stdin only (never argv) and comes back; a bad token is refused; no real keychain is touched", async () => {
  const dir = scratch(),
    kc = path.join(dir, "kc"),
    k = createKeychain({ keychain: kc, security: fakeSecurity(dir) }),
    id = S(9),
    tok = "sk-ant-oat01-" + "a".repeat(60);
  await k.put(id, tok);
  assert.equal(await k.get(id), tok);
  await assert.rejects(() => k.put(id, "short"), /claude setup-token/);
  await k.remove(id);
  assert.equal(await k.get(id), null);
  const argv = fs.readFileSync(path.join(kc, "argv.log"), "utf8");
  assert.equal(argv.includes(tok), false, "the token never reaches argv");
  assert.ok(
    argv.split("\n").some((l) => l === '["-i"]'),
    "put goes through `security -i` (stdin)",
  );
});
test("B5: a failed keychain call carries no stderr (put sends the token on stdin)", async () => {
  const dir = scratch(),
    bin = path.join(dir, "security");
  fs.writeFileSync(bin, "#!/bin/sh\ncat >&2; exit 1\n", { mode: 0o700 }); // echoes whatever it was sent to stderr
  const tok = "sk-ant-oat01-" + "b".repeat(60);
  const err = await createKeychain({ keychain: path.join(dir, "kc"), security: bin })
    .put(S(10), tok)
    .then(
      () => null,
      (e) => e,
    );
  assert.ok(err);
  assert.equal(Object.hasOwn(err, "stderr"), false);
  assert.equal(JSON.stringify(err, Object.getOwnPropertyNames(err)).includes(tok), false);
});
// Only fake subprocesses: no device Keychain or account/provider configuration.
for (const behavior of ["interactive-refusal", "missing", "mismatch", "read-error", "whitespace"]) {
  test(`keychain verified put: ${behavior} never reports success or leaks diagnostics`, async () => {
    const dir = scratch(),
      bin = path.join(dir, "security"),
      tok = "sk-ant-oat01-" + "c".repeat(60);
    const program = `#!/usr/bin/env node
const behavior = ${JSON.stringify(behavior)};
if (process.argv[2] === "-i") {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", x => input += x);
  process.stdin.on("end", () => {
    if (behavior === "interactive-refusal") process.stderr.write("security> SecKeychainItemCreateFromContent: User interaction is not allowed. " + input);
  });
} else {
  if (behavior === "missing") process.exit(44);
  if (behavior === "read-error") { process.stderr.write(${JSON.stringify(tok)}); process.exit(1); }
  if (behavior === "mismatch") process.stdout.write("sk-ant-oat01-" + "d".repeat(60) + "\\n");
  if (behavior === "whitespace") process.stdout.write(" " + ${JSON.stringify(tok)} + "\\n");
}
`;
    fs.writeFileSync(bin, program, { mode: 0o700 });
    const err = await createKeychain({ keychain: path.join(dir, "kc"), security: bin })
      .put(S(11), tok)
      .then(
        () => null,
        (e) => e,
      );
    assert.ok(err, "unverified write must reject");
    let expected = "Account Keychain: readback-mismatch";
    if (behavior === "interactive-refusal") expected = "Account Keychain: operation-failed";
    if (["missing", "read-error"].includes(behavior))
      expected = "Account Keychain: readback-failed";
    assert.equal(err.message, expected);
    assert.equal(Object.hasOwn(err, "stderr"), false);
    assert.equal(Object.hasOwn(err, "cause"), false);
    assert.equal(JSON.stringify(err, Object.getOwnPropertyNames(err)).includes(tok), false);
  });
}
test("keychain verified put: interactive prompts alone permit exact fixture readback and replacement", async () => {
  const dir = scratch(),
    bin = path.join(dir, "security"),
    fixture = path.join(import.meta.dirname, "fake-security.fixture.mjs");
  fs.writeFileSync(
    bin,
    `#!/bin/sh\nif [ "$1" = "-i" ]; then printf 'security> security> ' >&2; fi\nexec "${process.execPath}" "${fixture}" "$@"\n`,
    { mode: 0o700 },
  );
  const kc = path.join(dir, "kc"),
    k = createKeychain({ keychain: kc, security: bin });
  await k.put(S(12), "sk-ant-oat01-" + "e".repeat(60));
  await k.put(S(12), "sk-ant-oat01-" + "f".repeat(60));
  assert.equal(await k.get(S(12)), "sk-ant-oat01-" + "f".repeat(60));
  const calls = fs
    .readFileSync(path.join(kc, "argv.log"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
  assert.equal(
    calls.filter((args) => args[0] === "find-generic-password").length,
    3,
    "both writes require readback",
  );
  assert.equal(
    calls.some((args) => args[0] === "delete-generic-password"),
    false,
  );
});
test("B4: a human-held session is not moved at the limit (the account is still marked limited); its next launch moves and is recorded", async () => {
  const root = scratch();
  const a = await addAccount(root, { provider: "claude", name: "A" }, T0),
    b = await addAccount(root, { provider: "claude", name: "B" }, T0 + 1);
  await assign(root, S(20), "claude", T0);
  const r = await rotate(
    root,
    S(20),
    "claude",
    { resetAt: new Date(T0 + 3600000).toISOString(), stopId: "x", reassign: false },
    T0,
  );
  assert.equal(r.to, null);
  assert.equal(r.held, true);
  let s = readAccounts(root);
  assert.equal(s.assignments[S(20)].accountId, a.id, "still on its account");
  assert.equal(publicView(s, T0).accounts.find((x) => x.id === a.id).status.state, "limited");
  assert.equal((await assign(root, S(20), "claude", T0 + 1000)).account.id, b.id);
  s = readAccounts(root);
  assert.deepEqual(
    s.rotations.at(-1) && [
      s.rotations.at(-1).reason,
      s.rotations.at(-1).from,
      s.rotations.at(-1).to,
    ],
    ["launch", a.id, b.id],
  );
});

// ---- W1: manual switch and the default account for new sessions
test("the default account takes every new session of its provider while it is ready; otherwise the pool order does", async () => {
  const root = scratch();
  const a = await addAccount(root, { provider: "claude", name: "Work" }, T0),
    b = await addAccount(root, { provider: "claude", name: "Personal" }, T0 + 1);
  await setDefaultAccount(root, "claude", b.id);
  assert.equal((await assign(root, S(1), "claude", T0)).account.id, b.id); // default beats priority order
  assert.equal((await assign(root, S(2), "claude", T0)).account.id, b.id);
  await rotate(root, S(2), "claude", { resetAt: new Date(T0 + 3600000).toISOString() }, T0 + 5);
  assert.equal((await assign(root, S(3), "claude", T0 + 10)).account.id, a.id); // default limited: pool order
  assert.equal(publicView(readAccounts(root), T0).defaultAccounts.claude, b.id);
  await assert.rejects(() => setDefaultAccount(root, "codex", a.id), /No such Codex account/);
  await setDefaultAccount(root, "claude", null);
  assert.equal(publicView(readAccounts(root), T0).defaultAccounts.claude, null);
  await setDefaultAccount(root, "claude", b.id);
  await removeAccount(root, b.id);
  assert.equal(readAccounts(root).defaults.claude, null); // removing it clears the default
});
test("a switch moves only that session, is recorded, and a new launch of it takes the chosen account", async () => {
  const root = scratch();
  const a = await addAccount(root, { provider: "claude", name: "Work" }, T0),
    b = await addAccount(root, { provider: "claude", name: "Personal" }, T0 + 1);
  await assign(root, S(1), "claude", T0);
  await assign(root, S(2), "claude", T0);
  const r = await switchSession(
    root,
    { sessionId: S(1), provider: "claude", account: "personal" },
    {},
    T0 + 5,
  );
  assert.equal(r.ok, true);
  assert.match(r.message, /Personal/);
  assert.equal(accountOf(readAccounts(root), S(1)).id, b.id);
  assert.equal(accountOf(readAccounts(root), S(2)).id, a.id); // the other session stays
  assert.equal((await assign(root, S(1), "claude", T0 + 6)).account.id, b.id); // its relaunch keeps the choice
  const last = publicView(readAccounts(root), T0 + 7).rotations.at(-1);
  assert.deepEqual([last.from, last.to, last.reason], ["Work", "Personal", "manual"]);
  assert.equal(
    (await switchSession(root, { sessionId: S(1), provider: "claude", account: b.id }, {}, T0 + 8))
      .message,
    "This session already uses Personal.",
  );
});
test("a switch refuses plainly: a limited, turned-off, signed-out, unknown or other-provider account", async () => {
  const root = scratch();
  const a = await addAccount(root, { provider: "claude", name: "Work" }, T0),
    b = await addAccount(root, { provider: "claude", name: "Personal" }, T0 + 1);
  const c = await addAccount(root, { provider: "codex", name: "Cx" }, T0 + 2);
  await assign(root, S(1), "claude", T0);
  await assign(root, S(2), "claude", T0);
  await rotate(root, S(2), "claude", { resetAt: "2026-10-01T05:00:00.000Z" }, T0 + 1); // Work is limited now
  const sw = (account) =>
    switchSession(root, { sessionId: S(1), provider: "claude", account }, {}, T0 + 2);
  await switchSession(root, { sessionId: S(1), provider: "claude", account: b.id }, {}, T0 + 2);
  assert.match((await sw(a.id)).message, /^Work is limited until /);
  await setAccount(root, a.id, { clearLimit: true, enabled: false });
  assert.equal((await sw("Work")).message, "Work is turned off.");
  await setAccount(root, a.id, { enabled: true, auth: "expired" });
  assert.equal(
    (await sw("Work")).message,
    "Work is signed out. Add its token again in Settings › Accounts & Defaults.",
  );
  const none = "No Claude account has that name. Type /account to list them.";
  assert.equal((await sw("Nope")).message, none);
  assert.equal((await sw(c.id)).message, none);
  // R1 W1-1: what was typed is never echoed -- it could be a token pasted after /account.
  const pasted = await sw("sk-ant-oat01-" + "x".repeat(60));
  assert.equal(pasted.message, none);
  assert.equal(JSON.stringify(pasted).includes("sk-ant-"), false);
  for (const r of [await sw(a.id)]) assert.equal(r.ok, false);
  assert.equal(accountOf(readAccounts(root), S(1)).id, b.id); // nothing moved
});
test("a switch hands over to the takeover seam, which owns the move: nothing is written before or instead of it (R1 W1-3)", async () => {
  const root = scratch();
  const a = await addAccount(root, { provider: "claude", name: "Work" }, T0),
    b = await addAccount(root, { provider: "claude", name: "Personal" }, T0 + 1);
  await assign(root, S(1), "claude", T0);
  const before = readAccounts(root).rotations.length,
    calls = [];
  // A stand-in for W2's fenced takeover: while it runs, the store still says Work (a launch in that window takes Work,
  // matching the running process); it writes the assignment and the one history record itself.
  const w2 = async (id, acc, o) => {
    calls.push([id, acc, o]);
    assert.equal(accountOf(readAccounts(root), id).id, a.id);
    await switchSession(root, { sessionId: id, provider: "claude", account: acc.id }, {}, T0 + 2); // the interim direct write, as W2 would
    return { ok: true, message: "Continued on Personal with its history." };
  };
  const ok = await switchSession(
    root,
    { sessionId: S(1), provider: "claude", account: "Personal" },
    { takeOver: w2 },
    T0 + 1,
  );
  assert.deepEqual(calls, [
    [S(1), { id: b.id, name: "Personal", provider: "claude" }, { reason: "manual" }],
  ]);
  assert.deepEqual([ok.ok, ok.message], [true, "Continued on Personal with its history."]);
  assert.equal(accountOf(readAccounts(root), S(1)).id, b.id);
  assert.equal(readAccounts(root).rotations.length, before + 1); // one record per move (W2's)
  const n = readAccounts(root).rotations.length;
  const no = await switchSession(
    root,
    { sessionId: S(1), provider: "claude", account: "Work" },
    { takeOver: async () => ({ ok: false, message: "A turn is running. Stop it first." }) },
    T0 + 3,
  );
  assert.deepEqual([no.ok, no.message], [false, "A turn is running. Stop it first."]);
  assert.equal(accountOf(readAccounts(root), S(1)).id, b.id); // never moved
  const boom = await switchSession(
    root,
    { sessionId: S(1), provider: "claude", account: "Work" },
    {
      takeOver: async () => {
        throw Error("token sk-ant-oat01-" + "z".repeat(40) + " at /Users/x");
      },
    },
    T0 + 4,
  );
  assert.deepEqual(
    [boom.ok, boom.message],
    [false, "The session could not continue on Work. It stays on Personal."],
  ); // no echo
  assert.equal(accountOf(readAccounts(root), S(1)).id, b.id);
  assert.equal(readAccounts(root).rotations.length, n); // no record of a move that did not happen
  assert.equal(readAccounts(root).accounts.find((x) => x.id === a.id).limitedUntil, null); // a manual switch never marks an account limited
});
test("a rename keeps names unique per provider (R1 W1-6): /account <name> must pick exactly one", async () => {
  const root = scratch();
  const a = await addAccount(root, { provider: "claude", name: "Work" }, T0),
    b = await addAccount(root, { provider: "claude", name: "Personal" }, T0 + 1);
  await addAccount(root, { provider: "codex", name: "Home" }, T0 + 2);
  await assert.rejects(
    () => setAccount(root, b.id, { name: " work " }),
    /An account with that name exists/,
  );
  assert.equal((await setAccount(root, a.id, { name: "WORK" })).name, "WORK"); // its own name, another case
  assert.equal((await setAccount(root, b.id, { name: "Home" })).name, "Home"); // another provider's name is fine
});
test("the session picker lists only that provider’s accounts with their state, the current one and the default", async () => {
  const root = scratch();
  const a = await addAccount(root, { provider: "claude", name: "Work" }, T0),
    b = await addAccount(root, { provider: "claude", name: "Personal" }, T0 + 1);
  await addAccount(root, { provider: "codex", name: "Cx" }, T0 + 2);
  await assign(root, S(1), "claude", T0);
  await assign(root, S(2), "claude", T0);
  await rotate(root, S(2), "claude", { resetAt: "2026-10-01T05:00:00.000Z" }, T0 + 1);
  await setDefaultAccount(root, "claude", b.id);
  const v = sessionAccounts(readAccounts(root), S(1), "claude", T0 + 2);
  assert.equal(v.provider, "claude");
  assert.equal(v.current, a.id);
  assert.deepEqual(
    v.accounts.map((x) => [x.name, x.status.state, x.isDefault]),
    [
      ["Work", "limited", false],
      ["Personal", "ok", true],
    ],
  );
  assert.equal(sessionAccounts(readAccounts(root), S(9), "codex", T0).accounts.length, 1);
  assert.equal(sessionAccounts(readAccounts(root), S(9), "codex", T0).current, null);
});
test("credential grep: a switch and its launch put the token in the environment only -- the launch request changes nowhere else, and it is not in the store, a reply, a view or a log", async () => {
  // The provider's argv is built by the product from its own config, never from this request; that argv is checked
  // against a stub CLI in the product (claude-launch-credential.test.ts). Here: the hook may change `env` only.
  const root = scratch(),
    token = "sk-ant-oat01-" + "Q".repeat(48),
    logged = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  for (const k of Object.keys(orig)) console[k] = (...x) => logged.push(x.map(String).join(" "));
  try {
    await addAccount(root, { provider: "claude", name: "Work" }, T0);
    const b = await addAccount(root, { provider: "claude", name: "Personal" }, T0 + 1);
    const hook = sessionOpenHook({
      root: () => root,
      keychain: { get: async () => token },
      now: () => T0,
    });
    const req = {
      agentId: S(1),
      provider: "claude",
      cwd: "/x",
      workspaceId: null,
      reason: "create",
      purpose: "interactive",
      env: { KEEP: "1" },
    };
    await hook({ request: req });
    const r = await switchSession(
      root,
      { sessionId: S(1), provider: "claude", account: "Personal" },
      {},
      T0 + 1,
    );
    const out = await hook({ request: { ...req, reason: "resume" } });
    assert.equal(out.env.CLAUDE_CODE_OAUTH_TOKEN, token);
    assert.equal(out.env.FULCRA_ACCOUNT_ID, b.id);
    const { env: _out, ...rest } = out,
      { env: _in, ...asked } = { ...req, reason: "resume" };
    assert.deepEqual(rest, asked); // only env changes
    assert.deepEqual(Object.keys(out).sort(), Object.keys(req).sort()); // no field added (no args)
    const everywhere = [
      fs.readFileSync(path.join(root, "accounts/accounts.json"), "utf8"),
      JSON.stringify(r),
      JSON.stringify(publicView(readAccounts(root), T0)),
      JSON.stringify(sessionAccounts(readAccounts(root), S(1), "claude", T0)),
      logged.join("\n"),
    ].join("\n");
    assert.equal(everywhere.includes(token), false);
    assert.equal(everywhere.includes("sk-ant-"), false);
  } finally {
    Object.assign(console, orig);
  }
});

// Source-only admission fixtures: no real provider, credential store or native process.
const admissionFailure = (e) =>
  e instanceof Error && e.message === "The pooled account launch could not be admitted";
async function admissionFixture(t, provider, count, good = []) {
  const root = scratch();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const accounts = [];
  for (let i = 0; i < count; i++) {
    const a = await addAccount(root, { provider, name: `Fixture ${i + 1}` }, T0 + i);
    await setAccount(root, a.id, { auth: "ok" });
    accounts.push(a);
    if (provider === "codex" && good.includes(i)) {
      const home = codexHome(root, a.id);
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(path.join(home, "auth.json"), "{}");
    }
  }
  const reads = [];
  const keychain = {
    get: async (id) => {
      reads.push(id);
      return good.includes(accounts.findIndex((a) => a.id === id)) ? "fixture-credential" : null;
    },
  };
  const request = {
    agentId: S(901),
    provider,
    purpose: "interactive",
    reason: "resume",
    env: { KEEP: "yes" },
  };
  const hook = sessionOpenHook({
    root: () => root,
    keychain,
    now: () => T0 + 100,
    env: { HOME: root, CODEX_HOME: root },
  });
  return { root, accounts, reads, request, hook, keychain };
}
for (const provider of ["claude", "codex"]) {
  test(`admission ${provider}: eight unavailable credentials do not hide the ninth usable account`, async (t) => {
    const f = await admissionFixture(t, provider, 9, [8]);
    const out = await f.hook({ request: f.request });
    assert.equal(out.env.FULCRA_ACCOUNT_ID, f.accounts[8].id);
    assert.equal(out.env.KEEP, "yes");
    assert.equal(
      Object.values(readAccounts(f.root).accounts).filter((a) => a.auth !== "ok").length,
      8,
    );
    if (provider === "claude") assert.equal(new Set(f.reads).size, 9);
  });
  test(`admission ${provider}: all 32 unavailable credentials refuse without native fallback`, async (t) => {
    const f = await admissionFixture(t, provider, 32);
    await assert.rejects(f.hook({ request: f.request }), admissionFailure);
    assert.equal(readAccounts(f.root).accounts.filter((a) => a.auth !== "ok").length, 32);
    if (provider === "claude") assert.equal(new Set(f.reads).size, 32);
  });
  test(`admission ${provider}: history-unknown empty and disabled pools preserve native opt-out`, async (t) => {
    for (const count of [0, 1]) {
      const f = await admissionFixture(t, provider, count);
      if (count) await setAccount(f.root, f.accounts[0].id, { enabled: false });
      assert.equal(await f.hook({ request: f.request }), f.request);
      assert.equal(f.reads.length, 0);
    }
  });
  test(`admission ${provider}: retained ended assignment refuses an empty or disabled pool`, async (t) => {
    for (const removed of [false, true]) {
      const f = await admissionFixture(t, provider, 1, [0]);
      await assign(f.root, f.request.agentId, provider, T0);
      await sessionEnded(f.root, f.request.agentId);
      if (removed) await removeAccount(f.root, f.accounts[0].id);
      else await setAccount(f.root, f.accounts[0].id, { enabled: false });
      await assert.rejects(f.hook({ request: f.request }), admissionFailure);
    }
  });
  test(`admission ${provider}: enabled but signed-out pool refuses`, async (t) => {
    const f = await admissionFixture(t, provider, 1);
    await setAccount(f.root, f.accounts[0].id, { auth: "expired" });
    await assert.rejects(f.hook({ request: f.request }), admissionFailure);
  });
  test(`admission ${provider}: explicit intent never rotates to another credential`, async (t) => {
    const f = await admissionFixture(t, provider, 2, [1]);
    await update(f.root, (s) => {
      s.assignments[f.request.agentId] = {
        accountId: f.accounts[0].id,
        provider,
        at: new Date(T0).toISOString(),
        ended: false,
        takeover: "fixture-intent",
      };
    });
    await assert.rejects(f.hook({ request: f.request }), admissionFailure);
    assert.equal(readAccounts(f.root).assignments[f.request.agentId].accountId, f.accounts[0].id);
  });
}
for (const change of [
  "disable",
  "remove",
  "auth",
  "assignment",
  "intent",
  "revoke-intent",
  "disable-pool",
]) {
  test(`admission Claude: post-credential ${change} refuses stale environment publication`, async (t) => {
    const f = await admissionFixture(t, "claude", 2, [0, 1]);
    if (change === "revoke-intent")
      await update(f.root, (s) => {
        s.assignments[f.request.agentId] = {
          accountId: f.accounts[0].id,
          provider: "claude",
          at: new Date(T0).toISOString(),
          ended: false,
          takeover: "fixture-intent",
        };
      });
    let entered, release;
    const opened = new Promise((r) => {
      entered = r;
    });
    const credential = new Promise((r) => {
      release = r;
    });
    f.keychain.get = async () => {
      entered();
      return credential;
    };
    const pending = f.hook({ request: f.request });
    await opened;
    if (change === "remove") await removeAccount(f.root, f.accounts[0].id);
    else if (change === "disable" || change === "auth")
      await setAccount(
        f.root,
        f.accounts[0].id,
        change === "disable" ? { enabled: false } : { auth: "expired" },
      );
    else
      await update(f.root, (s) => {
        if (change === "disable-pool") for (const a of s.accounts) a.enabled = false;
        if (change === "assignment") s.assignments[f.request.agentId].accountId = f.accounts[1].id;
        if (change === "intent") s.assignments[f.request.agentId].takeover = "replacement-intent";
        if (change === "revoke-intent") delete s.assignments[f.request.agentId].takeover;
      });
    release("fixture-credential");
    await assert.rejects(pending, admissionFailure);
  });
}
test("admission explicit intent success retains its target and intent", async (t) => {
  const f = await admissionFixture(t, "claude", 2, [0, 1]);
  await update(f.root, (s) => {
    s.assignments[f.request.agentId] = {
      accountId: f.accounts[1].id,
      provider: "claude",
      takeover: "fixture-intent",
      ended: false,
    };
  });
  const out = await f.hook({ request: f.request });
  assert.equal(out.env.FULCRA_ACCOUNT_ID, f.accounts[1].id);
  assert.equal(readAccounts(f.root).assignments[f.request.agentId].takeover, "fixture-intent");
});
test("admission credential and unreadable-store errors are finite and sanitized", async (t) => {
  const f = await admissionFixture(t, "claude", 1, [0]);
  f.keychain.get = async () => {
    throw Error("private fixture diagnostic");
  };
  await assert.rejects(f.hook({ request: f.request }), admissionFailure);
  fs.writeFileSync(path.join(f.root, "accounts/accounts.json"), "{");
  await assert.rejects(f.hook({ request: f.request }), admissionFailure);
});

for (const change of ["account", "assignment", "intent"]) {
  test(`admission Codex: post-credential ${change} refuses stale environment publication`, async (t) => {
    const f = await admissionFixture(t, "codex", 2, [0, 1]);
    const stat = fs.statSync;
    t.mock.method(fs, "statSync", (...args) => {
      const result = stat(...args);
      if (String(args[0]) === path.join(codexHome(f.root, f.accounts[0].id), "auth.json")) {
        const store = path.join(f.root, "accounts/accounts.json");
        const s = JSON.parse(fs.readFileSync(store, "utf8"));
        if (change === "account") s.accounts[0].enabled = false;
        if (change === "assignment") s.assignments[f.request.agentId].accountId = f.accounts[1].id;
        if (change === "intent") s.assignments[f.request.agentId].takeover = "replacement-intent";
        fs.writeFileSync(store, JSON.stringify(s));
      }
      return result;
    });
    await assert.rejects(f.hook({ request: f.request }), admissionFailure);
  });
}

test("Book local: Work replaces ambient auth while higher-priority Personal stays disabled", async (t) => {
  const f = await admissionFixture(t, "claude", 2, [1]);
  const [personal, work] = f.accounts;
  await setAccount(f.root, personal.id, { name: "Personal", enabled: false, priority: 1 });
  await setAccount(f.root, work.id, { name: "Work", enabled: true, priority: 2 });
  f.request.env = {
    KEEP: "book-fixture",
    CLAUDE_CODE_OAUTH_TOKEN: "fake-ambient-oauth",
    ANTHROPIC_API_KEY: "fake-ambient-api-key",
    ANTHROPIC_AUTH_TOKEN: "fake-ambient-auth",
  };
  const inputEnv = { ...f.request.env };
  const out = await f.hook({ request: f.request });
  // Boolean credential comparisons keep failed assertions free of credential values.
  assert.equal(out.env.CLAUDE_CODE_OAUTH_TOKEN === "fixture-credential", true);
  assert.equal(out.env.CLAUDE_CODE_OAUTH_TOKEN === inputEnv.CLAUDE_CODE_OAUTH_TOKEN, false);
  assert.equal(out.env.ANTHROPIC_API_KEY === "", true);
  assert.equal(out.env.ANTHROPIC_AUTH_TOKEN === "", true);
  assert.equal(out.env.KEEP, "book-fixture");
  assert.equal(out.env.FULCRA_ACCOUNT_ID, work.id);
  assert.equal(out.env.FULCRA_ACCOUNT_NAME, "Work");
  assert.deepEqual(f.reads, [work.id]);
  assert.equal(accountOf(readAccounts(f.root), f.request.agentId).id, work.id);
  assert.equal(readAccounts(f.root).accounts.find((a) => a.id === personal.id).enabled, false);
  for (const key of Object.keys(inputEnv)) assert.equal(f.request.env[key] === inputEnv[key], true);
});

test("Book local: unavailable enabled Work refuses ambient login before provider launch", async (t) => {
  const f = await admissionFixture(t, "claude", 2);
  const [personal, work] = f.accounts;
  await setAccount(f.root, personal.id, { name: "Personal", enabled: false, priority: 1 });
  await setAccount(f.root, work.id, { name: "Work", enabled: true, priority: 2 });
  f.request.env = {
    KEEP: "book-fixture",
    CLAUDE_CODE_OAUTH_TOKEN: "fake-ambient-oauth",
    ANTHROPIC_API_KEY: "fake-ambient-api-key",
    ANTHROPIC_AUTH_TOKEN: "fake-ambient-auth",
  };
  const inputEnv = { ...f.request.env };
  let providerLaunches = 0;
  await assert.rejects(async () => {
    await f.hook({ request: f.request });
    providerLaunches++;
  }, admissionFailure);
  assert.equal(providerLaunches, 0);
  assert.deepEqual(f.reads, [work.id]);
  assert.equal(readAccounts(f.root).accounts.find((a) => a.id === personal.id).enabled, false);
  for (const key of Object.keys(inputEnv)) assert.equal(f.request.env[key] === inputEnv[key], true);
});
