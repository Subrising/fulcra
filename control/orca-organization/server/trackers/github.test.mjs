// J3 GitHub connector and HTTP port (J3-DESIGN.md §3.1–§3.3, mutations §9). Fixtures only.
import test from "node:test";
import assert from "node:assert/strict";
import { createGithubConnector, assertGhArgs, ghArgs } from "./github.mjs";
import { createGhRunner, ghEnvironment, classifyGhError } from "./gh-runner.mjs";
import { getJson, TrackerFailure, FAILURES } from "./http.mjs";
import {
  fakeFetch,
  fakeSecrets,
  githubRoutes,
  response,
  fixture,
  GH,
  MAPPING,
} from "./test-support.mjs";
const TOKEN = "CANARY-gh-" + "x".repeat(24);
const secrets = () => fakeSecrets({ "github.com:read": TOKEN });
const failureOf = async (p) => {
  try {
    await p;
    return null;
  } catch (e) {
    return e;
  }
};

test("G1: after the one name-addressed resolve, every call is addressed by the pinned numeric repository id", async () => {
  const fetcher = fakeFetch(githubRoutes()),
    c = createGithubConnector({ fetcher, secrets: secrets() });
  assert.deepEqual(
    await c.resolve({ auth: "keychain", site: "github.com", remoteName: "Subrising/scratch" }),
    { remoteId: "123456", remoteName: "Subrising/scratch" },
  );
  fetcher.calls.length = 0;
  await c.validate(MAPPING);
  await c.listOpen(MAPPING);
  await c.get(MAPPING, "12");
  assert.equal(fetcher.calls.length, 3);
  for (const { url } of fetcher.calls)
    assert.match(url, /^https:\/\/api\.github\.com\/repositories\/123456(\/|$|\?)/, url);
  // A different mapping id is the only thing that changes the target; the name is never used for reads.
  const renamed = { ...MAPPING, remoteName: "Evil/other" };
  await c.listOpen(renamed, { observedName: "Subrising/scratch" });
  assert.match(fetcher.calls.at(-1).url, /\/repositories\/123456\/issues\?/);
});

test("G2: pull requests are dropped and an item claiming another repository is dropped and marks the read partial", async () => {
  const c = createGithubConnector({ fetcher: fakeFetch(githubRoutes()), secrets: secrets() });
  const r = await c.listOpen(MAPPING, { observedName: "Subrising/scratch" });
  assert.deepEqual(
    r.items.map((i) => i.ref),
    ["7", "11"],
  );
  assert.equal(r.partial, true);
  assert.equal((await failureOf(c.get(MAPPING, "13"))).failure, "not-found");
  assert.equal((await failureOf(c.get(MAPPING, "14"))).failure, "invalid-response");
});

test("G3: every request is a GET with redirects refused, to an allowlisted HTTPS host only", async () => {
  const fetcher = fakeFetch(githubRoutes()),
    c = createGithubConnector({ fetcher, secrets: secrets() });
  await c.resolve({ auth: "keychain", site: "github.com", remoteName: "Subrising/scratch" });
  await c.validate(MAPPING);
  await c.listOpen(MAPPING);
  await c.get(MAPPING, "7");
  for (const { init } of fetcher.calls) {
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "error");
    assert.equal("body" in init, false);
  }
  for (const url of [
    "http://api.github.com/x",
    "https://evil.example/x",
    "https://user:pw@api.github.com/x",
  ]) {
    assert.equal((await failureOf(getJson({ fetcher, url, headers: {} }))).failure, "error", url);
  }
  const moved = fakeFetch({
    [`${GH}/repositories/1`]: response(301, {}, { location: "https://evil.example" }),
  });
  assert.equal(
    (await failureOf(getJson({ fetcher: moved, url: `${GH}/repositories/1`, headers: {} })))
      .failure,
    "invalid-response",
  );
});

test("G4: failures are a fixed enum; no status text, body, header or thrown message leaves the port", async () => {
  const at = Date.parse("2026-09-23T12:00:00Z");
  const cases = [
    [response(401, { message: "Bad credentials " + TOKEN }), "auth-required"],
    [
      response(
        403,
        { message: "API rate limit" },
        { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(at / 1000 + 120) },
      ),
      "rate-limited",
    ],
    [response(429, {}, { "retry-after": "30" }), "rate-limited"],
    [response(403, { message: "Resource not accessible by personal access token" }), "forbidden"],
    [response(404, { message: "Not Found" }), "not-found"],
    [response(500, { message: "boom " + TOKEN }), "error"],
    [response(200, "{not json " + TOKEN), "invalid-response"],
    [response(200, "x".repeat(1048577)), "invalid-response"],
    [{ throw: `connect ECONNREFUSED; Authorization: Bearer ${TOKEN}` }, "offline"],
  ];
  for (const [r, expected] of cases) {
    const e = await failureOf(
      getJson({
        fetcher: fakeFetch({ [`${GH}/x`]: r }),
        url: `${GH}/x`,
        headers: { Authorization: `Bearer ${TOKEN}` },
        now: at,
      }),
    );
    assert.ok(e instanceof TrackerFailure);
    assert.equal(e.failure, expected);
    assert.equal(e.message, expected);
    assert.ok(FAILURES.includes(e.message));
    assert.equal(
      JSON.stringify({ ...e, message: e.message, stack: e.stack }).includes(TOKEN),
      false,
    );
    if (expected === "rate-limited") assert.ok(e.retryAfterMs > 0 && e.retryAfterMs <= 3600000);
  }
});

test("G5: gh fallback runs one fixed argv template; fields, bodies and non-GET methods are impossible", async () => {
  const seen = [],
    gh = async (args) => {
      seen.push(args);
      return JSON.stringify(
        args[5].endsWith("issues/7")
          ? fixture("github", "issues-open.json")[0]
          : fixture("github", "repo.json"),
      );
    };
  const c = createGithubConnector({ fetcher: fakeFetch({}), secrets: fakeSecrets({}), gh });
  const mapping = { ...MAPPING, auth: "gh-cli" };
  await c.validate(mapping);
  await c.get(mapping, "7");
  assert.deepEqual(seen, [ghArgs("repositories/123456"), ghArgs("repositories/123456/issues/7")]);
  for (const bad of [
    [...ghArgs("repositories/1"), "-f", "title=x"],
    ["api", "--method", "POST", "-H", "Accept: application/vnd.github+json", "repositories/1"],
    [
      "api",
      "--method",
      "GET",
      "-H",
      "Accept: application/vnd.github+json",
      "repositories/1/issues/1/comments",
    ],
    ["api", "--method", "GET", "--input", "x", "repositories/1", "y"],
    ["api", "--method", "GET", "-H", "Accept: application/vnd.github+json", "graphql"],
    [
      "api",
      "--method",
      "GET",
      "-H",
      "Accept: application/vnd.github+json",
      "repositories/1/issues?state=open&per_page=50&sort=updated&x=1",
    ],
  ]) {
    assert.throws(() => assertGhArgs(bad), TrackerFailure, bad.join(" "));
  }
  let ran = 0;
  const runner = createGhRunner({
    binary: "/usr/bin/true",
    run: () => {
      ran++;
    },
  });
  await assert.rejects(runner([...ghArgs("repositories/1"), "-F", "x=y"]), TrackerFailure);
  assert.equal(ran, 0);
});

test("G6: the keychain credential is read for each request, sent only as the Authorization header, and never cached", async () => {
  const fetcher = fakeFetch(githubRoutes()),
    s = secrets(),
    c = createGithubConnector({ fetcher, secrets: s });
  await c.validate(MAPPING);
  await c.listOpen(MAPPING);
  await c.get(MAPPING, "7");
  await c.get(MAPPING, "12");
  assert.equal(s.reads.length, fetcher.calls.length);
  assert.ok(s.reads.every((n) => n === "github.com:read"));
  for (const { url, init } of fetcher.calls) {
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(url.includes(TOKEN), false);
    assert.deepEqual(
      Object.entries(init.headers)
        .filter(([, v]) => String(v).includes(TOKEN))
        .map(([k]) => k),
      ["Authorization"],
    );
  }
});

test("G7: a missing or unreadable keychain item is auth-required and no request is made", async () => {
  for (const s of [
    fakeSecrets({}),
    {
      read: async () => {
        throw new Error("Plugin secrets are not available on this host");
      },
    },
  ]) {
    const fetcher = fakeFetch(githubRoutes()),
      c = createGithubConnector({ fetcher, secrets: s });
    assert.equal((await failureOf(c.validate(MAPPING))).failure, "auth-required");
    assert.equal(fetcher.calls.length, 0);
  }
});

test("G8: the gh child environment is rebuilt without inherited tokens, and gh stderr is classified, never forwarded", () => {
  const env = ghEnvironment({
    HOME: "/Users/x",
    PATH: "/evil",
    GH_TOKEN: TOKEN,
    GITHUB_TOKEN: TOKEN,
    PASEO_PASSWORD: TOKEN,
    GH_CONFIG_DIR: "/cfg",
  });
  assert.equal(JSON.stringify(env).includes(TOKEN), false);
  assert.equal(env.PATH, "/usr/bin:/bin");
  assert.equal(env.GH_PROMPT_DISABLED, "1");
  for (const [stderr, failure] of [
    ["HTTP 401: Bad credentials", "auth-required"],
    ["HTTP 403: API rate limit exceeded", "rate-limited"],
    ["HTTP 403: Must have admin rights", "forbidden"],
    ["HTTP 404: Not Found", "not-found"],
    ["dial tcp: lookup api.github.com: no such host", "offline"],
    [`weird ${TOKEN}`, "error"],
  ]) {
    const e = classifyGhError({ stderr });
    assert.equal(e.failure, failure);
    assert.equal(e.message.includes(TOKEN), false);
  }
  assert.equal(classifyGhError({ code: "ENOENT" }).failure, "auth-required");
});

// Structural guard (mutation M8): the connectors have no working-directory, git-remote or ForgeService path,
// so a repository can only come from the journal mapping, never from a cwd an agent could change.
test("G9: tracker modules never derive a repository from a cwd, a git remote or the product ForgeService", async () => {
  const fs = await import("node:fs"),
    path = await import("node:path");
  const here = path.dirname(new URL(import.meta.url).pathname);
  const sources = fs
    .readdirSync(here)
    .filter(
      (f) =>
        f.endsWith(".mjs") &&
        !f.includes(".test.") &&
        !["test-support.mjs", "harness.mjs"].includes(f),
    );
  assert.ok(sources.length >= 6);
  for (const f of sources)
    assert.doesNotMatch(
      fs.readFileSync(path.join(here, f), "utf8"),
      /\bcwd\b|process\.cwd|['"]git['"]|ForgeService|GH_REPO|remote\.origin|\.git\//,
      f,
    );
});
