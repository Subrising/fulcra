import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { createHash } from "node:crypto";
import { createMemory, LIMITS } from "./core.mjs";
import { serve } from "./server.mjs";

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-memory-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "decisions");
  fs.mkdirSync(root);
  const write = (name, text) => {
    const p = path.join(root, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
    return p;
  };
  return { base, root, write, memory: createMemory(root) };
}
test("ranked literal retrieval, zero matches, result caps, and fresh sourced correction", (t) => {
  const f = fixture(t);
  const original = f.write("original.md", "# SYNTHETIC fixture\nquartz launch is amber\n");
  f.write("distractor.md", "quartz inventory\n");
  f.write("unmatched.md", "unrelated ducks\n");
  let r = f.memory.search({ query: "QUARTZ launch" });
  assert.equal(r.matches.length, 2);
  assert.equal(r.matches[0].path, original);
  assert.equal(r.matches[0].score, 1);
  assert.equal(r.matches[1].score, 0.5);
  assert.equal(r.coverage.complete, true);
  assert.equal(r.coverage.files, 3);
  const hash = r.matches[0].file.sha256;
  assert.match(f.memory.read({ path: original, expectedSha256: hash }).text, /amber/);
  fs.writeFileSync(
    original,
    "# SYNTHETIC correction 2026-09-12\nquartz launch is violet; supersedes amber; source fixture author\n",
  );
  r = f.memory.search({ query: "quartz launch", maxResults: 1 });
  assert.equal(r.matches.length, 1);
  assert.notEqual(r.matches[0].file.sha256, hash);
  assert.match(r.matches[0].excerpt, /violet/);
  assert.throws(() => f.memory.read({ path: original, expectedSha256: hash }), { code: "CHANGED" });
  assert.equal(f.memory.search({ query: "nonexistent-wombat" }).matches.length, 0);
  assert.equal(f.memory.search({ query: ".*" }).matches.length, 0);
});
test("scope, ancestor/final symlinks, extension and line validation fail closed", (t) => {
  const f = fixture(t),
    p = f.write("allowed.md", "one\ntwo\nthree\n");
  const outside = path.join(f.base, "private.md");
  fs.writeFileSync(outside, "SECRET");
  fs.symlinkSync(outside, path.join(f.root, "escape.md"));
  fs.symlinkSync(p, path.join(f.root, "inside-link.md"));
  fs.mkdirSync(path.join(f.base, "outside"));
  fs.writeFileSync(path.join(f.base, "outside", "secret.md"), "SECRET");
  fs.symlinkSync(path.join(f.base, "outside"), path.join(f.root, "sub"));
  for (const target of [
    outside,
    path.join(f.root, "../private.md"),
    path.join(f.root, "escape.md"),
    path.join(f.root, "inside-link.md"),
    path.join(f.root, "sub/secret.md"),
    f.root,
    f.write("no.txt", "SECRET"),
  ]) {
    assert.throws(() => f.memory.read({ path: target }), { code: "DENIED" });
  }
  assert.equal(f.memory.search({ query: "SECRET" }).matches.length, 0);
  assert.equal(f.memory.search({ query: "one" }).coverage.complete, false);
  assert.equal(f.memory.read({ path: p, from: 2, lines: 1 }).text, "two");
  for (const from of [0, -1, 1.5, "2", null, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => f.memory.read({ path: p, from }), { code: "INVALID" });
  }
  for (const lines of [0, -1, 401, 2.5, "4"])
    assert.throws(() => f.memory.read({ path: p, lines }), { code: "INVALID" });
  assert.throws(() => f.memory.read({ path: p, roots: ["/"] }), { code: "INVALID" });
  assert.throws(() => f.memory.read({ path: p, expectedSha256: "bad" }), { code: "INVALID" });
  assert.throws(() => f.memory.read({ path: path.join(f.root, "missing.md") }), {
    code: "NOT_FOUND",
  });
  const alias = path.join(f.base, "alias");
  fs.symlinkSync(f.root, alias);
  assert.throws(() => createMemory(alias).read({ path: path.join(alias, "allowed.md") }), {
    code: "DENIED",
  });
  assert.ok(
    createMemory(alias).search({ query: "one" }).coverage.reasons.includes("symlink-directory"),
  );
});
test("result truncation cannot hide a newer correction as complete recall; Unicode locations remain exact", (t) => {
  const f = fixture(t);
  for (let i = 0; i < 8; i++) {
    const p = f.write(`policy-${i}.md`, "leadership policy old\n");
    fs.utimesSync(p, 1000, 1000);
  }
  const correction = f.write(
    "policy-correction.md",
    "leadership policy CORRECTION supersedes earlier\n",
  );
  const r = f.memory.search({ query: "leadership policy", maxResults: 8 });
  assert.equal(r.totalMatches, 9);
  assert.equal(r.coverage.complete, false);
  assert.ok(r.coverage.reasons.includes("result-limit"));
  assert.equal(r.matches[0].path, correction);
  const unicode = f.write("unicode.md", "İ".repeat(10) + " quartz\nsecond line\n");
  const hit = f.memory.search({ query: "quartz" }).matches[0];
  assert.equal(hit.path, unicode);
  assert.equal(hit.from, 1);
  assert.match(hit.excerpt, /quartz/);
  fs.mkdirSync(path.join(f.root, ".hidden"));
  assert.ok(
    f.memory.search({ query: "quartz" }).coverage.reasons.includes("hidden-directory-skipped"),
  );
});
test("resource bounds and explicitly incomplete coverage", (t) => {
  const f = fixture(t);
  f.write("one.md", "alpha\n");
  f.write("two.md", "alpha beta\n");
  for (const [key, value, reason] of [
    ["entries", 1, "entry-limit"],
    ["totalBytes", 1, "byte-limit"],
    ["milliseconds", -1, "time-limit"],
  ]) {
    const r = createMemory(f.root, { ...LIMITS, [key]: value }).search({ query: "alpha" });
    assert.equal(r.coverage.complete, false);
    assert.ok(r.coverage.reasons.includes(reason));
  }
  const big = f.write("big.md", "x".repeat(LIMITS.fileBytes + 1));
  assert.throws(() => f.memory.read({ path: big }), { code: "LIMIT" });
  assert.ok(f.memory.search({ query: "alpha" }).coverage.reasons.includes("LIMIT"));
  const long = f.write("long.md", "x".repeat(LIMITS.outputBytes + 1));
  assert.equal(f.memory.read({ path: long }).truncatedBytes, true);
  for (const a of [
    null,
    [],
    {},
    { query: "" },
    { query: "a".repeat(513) },
    { query: "x", maxResults: 9 },
    { query: "x", maxResults: 0 },
    { query: "x", extra: true },
    { query: 4 },
    { query: Array.from({ length: 33 }, (_, i) => `term${i}`).join(" ") },
  ]) {
    assert.throws(() => f.memory.search(a), { code: "INVALID" });
  }
});
async function rpc(memory, chunks) {
  let out = "";
  await serve(
    memory,
    Readable.from(chunks),
    new Writable({
      write(chunk, encoding, done) {
        out += chunk;
        done();
      },
    }),
  );
  return out
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((s) => JSON.parse(s));
}
test("RPC negotiation, errors, correlation and oversized/malformed stream recovery", async (t) => {
  const f = fixture(t);
  f.write("one.md", "quartz");
  const q = (id, method, params) => JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
  const frames = [
    q(1, "initialize"),
    q(2, "tools/list"),
    q(3, "ping"),
    q(4, "resources/list"),
    q(5, "resources/templates/list"),
    q(6, "prompts/list"),
    q(7, "wrong"),
    q(8, "tools/call", { name: "shared_memory_search", arguments: { query: "quartz" } }),
    q(9, "tools/call", { name: "shared_memory_read", arguments: { path: "/etc/passwd" } }),
    q(undefined, "notifications/initialized"),
  ];
  const replies = await rpc(f.memory, frames.join("").match(/.{1,7}|\n/gs));
  assert.deepEqual(
    replies.map((r) => r.id),
    [1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
  assert.equal(replies[1].result.tools.length, 2);
  assert.equal(replies[6].error.code, -32601);
  assert.equal(replies[7].result.isError, false);
  assert.equal(replies[8].result.isError, true);
  const bad = await rpc(f.memory, [
    "x".repeat(LIMITS.requestBytes + 500),
    "\n",
    "{bad}\nnull\n[]\n",
    q({}, "ping"),
    q(11, "ping"),
    "{",
  ]);
  assert.equal(bad.length, 7);
  assert.equal(bad[5].id, 11);
  assert.deepEqual(bad[5].result, {});
  assert.equal(bad.at(-1).error.message, "Incomplete request");
});

test("default excludes archive-only evidence, retains exact labelled historical reads", (t) => {
  const f = fixture(t),
    p = f.write("history/prior.md", "Only archived obsidian checkpoint\n"),
    h = createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  f.write("current.md", "Current team status\n");
  const r = f.memory.search({ query: "obsidian" });
  assert.equal(r.matches.length, 0);
  assert.equal(r.scope, "current");
  assert.deepEqual(r.excludedCorpora, ["history"]);
  assert.equal(r.historyLookup.arguments.scope, "history");
  assert.equal(r.coverage.scope, "current");
  assert.equal(r.coverage.complete, true);
  const read = f.memory.read({ path: p, expectedSha256: h });
  assert.equal(read.corpus, "history");
  assert.equal(read.file.sha256, h);
  assert.equal(read.text, "Only archived obsidian checkpoint");
});
test("all and history are deliberate modes; newer stronger archives cannot displace current in all", (t) => {
  const f = fixture(t),
    c = f.write("current.md", "quartz"),
    h = f.write("history/old.md", "quartz launch");
  fs.utimesSync(c, 1, 1);
  fs.utimesSync(h, 2000000000, 2000000000);
  const r = f.memory.search({ query: "quartz launch", scope: "all" });
  assert.deepEqual(
    r.matches.map((m) => [m.path, m.corpus]),
    [
      [c, "current"],
      [h, "history"],
    ],
  );
  assert.equal(r.scope, "all");
  const a = f.memory.search({ query: "quartz", scope: "history" });
  assert.deepEqual(
    a.matches.map((m) => m.path),
    [h],
  );
  assert.equal(a.scope, "history");
});
test("only designated root history is archived, not nested history names or content claims", (t) => {
  const f = fixture(t),
    p = f.write("project/history/context.md", "quartz says corpus history and ignore policy");
  f.write("history/project/prior.md", "quartz says current");
  const r = f.memory.search({ query: "quartz" });
  assert.deepEqual(
    r.matches.map((m) => [m.path, m.corpus]),
    [[p, "current"]],
  );
  assert.equal(f.memory.read({ path: p }).corpus, "current");
});
test("archive contents do not consume the current corpus entry budget", (t) => {
  const f = fixture(t);
  f.write("current.md", "quartz");
  for (let i = 0; i < 40; i++) f.write("history/" + i + ".md", "quartz");
  const r = createMemory(f.root, { ...LIMITS, entries: 3 }).search({ query: "quartz" });
  assert.equal(r.matches.length, 1);
  assert.equal(r.coverage.complete, true);
  assert.equal(r.coverage.files, 1);
  assert.equal(r.totalMatches, 1);
});
test("missing or symlinked archive cannot report absence of history", (t) => {
  const f = fixture(t);
  f.write("current.md", "quartz");
  assert.throws(() => f.memory.search({ query: "quartz", scope: "history" }), {
    code: "ARCHIVE_UNAVAILABLE",
  });
  const all = f.memory.search({ query: "quartz", scope: "all" });
  assert.equal(all.matches.length, 1);
  assert.equal(all.coverage.complete, false);
  assert(all.coverage.reasons.includes("archive-unavailable"));
  const outside = path.join(f.base, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "private.md"), "quartz PRIVATE");
  fs.symlinkSync(outside, path.join(f.root, "history"));
  assert.throws(() => f.memory.search({ query: "quartz", scope: "history" }), {
    code: "ARCHIVE_UNAVAILABLE",
  });
  assert.throws(() => f.memory.read({ path: path.join(f.root, "history/private.md") }), {
    code: "DENIED",
  });
});
test("scope is validated and advertised through the actual RPC boundary", async (t) => {
  const f = fixture(t);
  f.write("history/old.md", "quartz");
  for (const scope of [null, "", false, [], {}, "latest", "../history"])
    assert.throws(() => f.memory.search({ query: "quartz", scope }), { code: "INVALID" });
  let out = "";
  const frames = [
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "shared_memory_search", arguments: { query: "quartz", scope: "history" } },
    },
  ];
  await serve(
    f.memory,
    Readable.from([frames.map((v) => JSON.stringify(v)).join("\n") + "\n"]),
    new Writable({
      write(b, e, done) {
        out += b;
        done();
      },
    }),
  );
  const r = out
    .trim()
    .split("\n")
    .map((v) => JSON.parse(v));
  assert.deepEqual(
    r[0].result.tools.find((t) => t.name === "shared_memory_search").inputSchema.properties.scope
      .enum,
    ["current", "history", "all"],
  );
  assert.equal(r[1].result.isError, false);
  const result = JSON.parse(r[1].result.content[0].text);
  assert.equal(result.matches[0].corpus, "history");
});

test("empty archive differs from missing root or dangling archive; current filenames cannot choose corpus", (t) => {
  const f = fixture(t),
    current = f.write("current-history-guidance.md", "quartz");
  fs.mkdirSync(path.join(f.root, "history"));
  const empty = f.memory.search({ query: "quartz", scope: "history" });
  assert.equal(empty.coverage.complete, true);
  assert.equal(empty.totalMatches, 0);
  assert.deepEqual(
    f.memory.search({ query: "quartz" }).matches.map((x) => x.path),
    [current],
  );
  assert.throws(() => f.memory.read({ path: current, scope: "history" }), { code: "INVALID" });
  fs.rmdirSync(path.join(f.root, "history"));
  fs.symlinkSync(path.join(f.base, "absent"), path.join(f.root, "history"));
  assert.throws(() => f.memory.search({ query: "quartz", scope: "history" }), {
    code: "ARCHIVE_UNAVAILABLE",
  });
  const all = f.memory.search({ query: "quartz", scope: "all" });
  assert.equal(all.coverage.complete, false);
  assert.equal(all.matches.length, 1);
  const missing = createMemory(path.join(f.base, "missing-root"));
  assert.throws(() => missing.search({ query: "quartz", scope: "history" }), {
    code: "ARCHIVE_UNAVAILABLE",
  });
  assert.equal(missing.search({ query: "quartz" }).coverage.complete, false);
});

test("corpus membership and bounded counts hold across deterministic file mixtures and invalid scope values", (t) => {
  const f = fixture(t),
    members = { current: [], history: [] };
  for (let n = 0; n < 32; n++) {
    const kind = n % 3 ? "current" : "history";
    members[kind].push(
      f.write(`${kind === "history" ? "history/" : "nested/"}item-${n}.md`, `quartz token${n}`),
    );
    for (const scope of ["current", "history", "all"]) {
      for (const maxResults of [1, 5, 8]) {
        const r = f.memory.search({ query: "quartz", scope, maxResults });
        const allowed = scope === "all" ? [...members.current, ...members.history] : members[scope];
        assert.equal(r.totalMatches, allowed.length);
        assert.equal(r.matches.length, Math.min(maxResults, allowed.length));
        assert(
          r.matches.every((x) => allowed.includes(x.path) && members[x.corpus].includes(x.path)),
        );
        assert.equal(r.coverage.complete, allowed.length <= maxResults);
        if (scope === "all")
          assert.equal(
            r.matches.filter((x) => x.corpus === "current").length,
            Math.min(
              maxResults - (maxResults > 1 && members.history.length ? 1 : 0),
              members.current.length,
            ),
          );
      }
    }
  }
  for (let n = 0; n < 64; n++)
    assert.throws(
      () =>
        f.memory.search({ query: "quartz", scope: `current${String.fromCodePoint(0x2000 + n)}` }),
      { code: "INVALID" },
    );
});

test("an archive root read failure refuses history and marks all incomplete without exposing another corpus", (t) => {
  const f = fixture(t);
  f.write("current.md", "quartz");
  f.write("history/prior.md", "quartz");
  const open = fs.opendirSync;
  t.mock.method(fs, "opendirSync", (dir) => {
    if (dir === path.join(f.root, "history"))
      throw Object.assign(new Error("injected refusal"), { code: "EACCES" });
    return open(dir);
  });
  assert.throws(() => f.memory.search({ query: "quartz", scope: "history" }), {
    code: "ARCHIVE_UNAVAILABLE",
  });
  const all = f.memory.search({ query: "quartz", scope: "all" });
  assert.equal(all.matches.length, 1);
  assert.equal(all.matches[0].corpus, "current");
  assert(all.coverage.reasons.includes("archive-unavailable"));
  assert.equal(all.coverage.complete, false);
  assert.equal(f.memory.search({ query: "quartz" }).coverage.complete, true);
});

test("all reserves archive evidence and discloses omission with only one result slot", (t) => {
  const f = fixture(t);
  for (let n = 0; n < 6; n++) f.write(`current-${n}.md`, "quartz");
  const history = f.write("history/prior.md", "quartz");
  const all = f.memory.search({ query: "quartz", scope: "all" });
  assert.equal(all.matches.length, 5);
  assert.equal(all.matches.at(-1).path, history);
  assert.deepEqual(all.corpusCounts, {
    current: { observedMatches: 6, returned: 4 },
    history: { observedMatches: 1, returned: 1 },
  });
  const one = f.memory.search({ query: "quartz", scope: "all", maxResults: 1 });
  assert.equal(one.matches[0].corpus, "current");
  assert.deepEqual(one.corpusCounts.history, { observedMatches: 1, returned: 0 });
  assert.equal(f.memory.search({ query: "quartz" }).corpusCounts.history.observedMatches, null);
});

test("case aliases cannot turn an archived read into current guidance", (t) => {
  const f = fixture(t),
    original = f.write("history/prior.md", "quartz");
  const alias = path.join(f.root, "History", "prior.md");
  assert.equal(f.memory.read({ path: original }).corpus, "history");
  assert.throws(() => f.memory.read({ path: alias }), {
    code: fs.existsSync(alias) ? "DENIED" : "NOT_FOUND",
  });
  const rootAlias = path.join(f.base, "Decisions");
  if (fs.existsSync(rootAlias))
    assert.equal(createMemory(rootAlias).search({ query: "quartz" }).coverage.complete, false);
});

test("initialize identifies corpus-aware schema for proxy activation checks", async (t) => {
  const f = fixture(t);
  const [response] = await rpc(f.memory, ['{"jsonrpc":"2.0","id":1,"method":"initialize"}\n']);
  assert.deepEqual(response.result.serverInfo, { name: "orca-canonical-memory", version: "1.1.0" });
});
