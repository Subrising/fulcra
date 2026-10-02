// Fulcra J4: the connector contract (CONTRACTS §7.1) with a fake connector, and the GitHub connector against
// recorded synthetic fixtures behind a fake of the host's credential request (host-test-support.mjs). The plugin
// holds no token: no test here fakes a plaintext handle, and none reaches the network.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { createRegistry } from "./registry.mjs";
import {
  createGithubConnector,
  createGhHttp,
  assertGhArgs,
  ghArgs,
  closingNumbers,
} from "./github.mjs";
import { accountHttp, noHttp } from "./http.mjs";
import { itemProblem } from "../../shared/cc/connector-rules.mjs";
import { fakeHost, reply, assertNoCredentialLeak, HOST_SECRET } from "./host-test-support.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (name) =>
  JSON.parse(fs.readFileSync(path.join(here, "fixtures", "github", name), "utf8"));
const GH = "https://api.github.com";
const ACCOUNT = "55555555-5555-4555-8555-000000000001";
const REMOTE = { remoteId: "123456", remoteName: "acme/app", site: null };
const NOW = Date.parse("2026-09-24T14:00:00Z");
const OPEN = `${GH}/repositories/123456/issues?state=open&per_page=100&sort=updated`;
const routes = (extra = {}) => ({
  [`${GH}/repos/acme/app`]: reply(200, fx("repo.json")),
  [`${GH}/repositories/123456/issues?state=open&per_page=100&sort=updated`]: reply(
    200,
    fx("issues-open.json"),
  ),
  [`${GH}/repositories/123456/issues?state=closed&per_page=100&sort=updated&since=2026-08-25T14:00:00Z`]:
    reply(200, fx("issues-closed.json")),
  [`${GH}/repositories/123456/issues/42/timeline?per_page=100`]: reply(200, fx("timeline-42.json")),
  [`${GH}/repositories/123456/pulls/17/commits?per_page=100`]: reply(200, fx("pr-17-commits.json")),
  [`${GH}/repositories/123456/issues/17`]: reply(200, fx("issues-closed.json")[1]),
  [`${GH}/rate_limit`]: reply(200, { resources: {} }),
  ...extra,
});
// One connected GitHub account behind the fake host, and the `http` the service would hand the connector.
function hosted(extra = {}, options = {}) {
  const host = fakeHost({
    accounts: { [ACCOUNT]: { connector: "github", ...options.account } },
    routes: routes(extra),
    ...options.host,
  });
  return {
    host,
    http: accountHttp({ request: host.request, accountId: ACCOUNT, connector: "github" }),
  };
}
const fake = (extra = {}) => ({
  id: "fake",
  label: "Fake tracker",
  kinds: ["issue"],
  selfHosted: false,
  auth: ["browser", "device", "token"],
  tokenHelp: {
    createUrl: "https://tracker.example/tokens",
    scopes: ["read"],
    note: "A read-only token.",
  },
  keyPatterns: ["FAKE-\\d+"],
  sync: { pollSeconds: 60, webhook: false },
  resolveRemote: async () => ({}),
  listItems: async () => ({ items: [], cursor: null }),
  getItem: async () => ({}),
  listLinksForItem: async () => ({ commits: [], prs: [] }),
  health: async () => ({ state: "ok", retryAt: null }),
  ...extra,
});

test("R1: the registry accepts a conforming connector and refuses one without token sign-in or an operation", () => {
  const registry = createRegistry([fake()]);
  assert.deepEqual(registry.ids(), ["fake"]);
  assert.throws(
    () => createRegistry([fake({ auth: ["browser", "device"] })]),
    /token sign-in is required/,
  );
  assert.throws(() => createRegistry([fake({ id: "Fake!" })]), /invalid: id/);
  assert.throws(
    () => createRegistry([fake({ listLinksForItem: undefined })]),
    /invalid: listLinksForItem/,
  );
  assert.throws(
    () => createRegistry([fake({ sync: { pollSeconds: 5, webhook: false } })]),
    /invalid: sync/,
  );
  assert.throws(
    () =>
      createRegistry([
        fake({ tokenHelp: { createUrl: "http://tracker.example", scopes: [], note: "x" } }),
      ]),
    /invalid: tokenHelp/,
  );
  assert.throws(() => createRegistry([fake(), fake()]), /registered twice/);
  createRegistry([createGithubConnector()]);
});

test("R2: browser and device sign-in are offered only when the host says they work; token always", () => {
  const registry = createRegistry([fake()]);
  assert.deepEqual(registry.describe()[0].auth, ["token"]);
  const host = new Map([
    [
      "fake",
      [
        { method: "browser", status: "needs-broker" },
        { method: "device", status: "unavailable" },
      ],
    ],
  ]);
  assert.deepEqual(registry.describe(host)[0].auth, ["token"]);
  host.set("fake", [
    { method: "browser", status: "available" },
    { method: "device", status: "available" },
  ]);
  assert.deepEqual(registry.describe(host)[0].auth, ["browser", "device", "token"]);
});

test("G1: issues and pull requests, open and recently closed, become §7.1 items with constructed URLs", async () => {
  const { host, http } = hosted(),
    gh = createGithubConnector({ now: () => NOW });
  const r = await gh.listItems(http, { remote: REMOTE });
  const by = Object.fromEntries(r.items.map((i) => [i.ref, i]));
  assert.deepEqual(
    r.items.map((i) => [i.key, i.kind, i.state]),
    [
      ["issue:github:123456:42", "issue", "open"],
      ["pr:github:acme/app#18", "pr", "open"],
      ["issue:github:123456:40", "issue", "closed"],
      ["pr:github:acme/app#17", "pr", "merged"],
      ["pr:github:acme/app#16", "pr", "closed"],
    ],
  );
  assert.equal(
    r.partial,
    true,
    "an item from another repository is dropped and the read is partial",
  );
  for (const it of r.items) assert.equal(itemProblem(it), null, it.key);
  assert.equal(by["#42"].url, "https://github.com/acme/app/issues/42");
  assert.equal(by["#17"].url, "https://github.com/acme/app/pull/17");
  assert.equal(by["#42"].title, "Sign-in fails after an update", "bidi overrides are stripped");
  assert.deepEqual(by["#42"].labels, ["bug", "needs triage"]);
  assert.equal(
    JSON.stringify(r).includes("evil.example"),
    false,
    "a URL from the API is never used",
  );
  // Each request is the host's {path, query}: GET, the account and connector named, no query string in the path.
  assert.deepEqual(
    host.calls.map((c) => [c.accountId, c.connectorId, c.input.method, c.input.path]),
    [
      [ACCOUNT, "github", "GET", "/repositories/123456/issues"],
      [ACCOUNT, "github", "GET", "/repositories/123456/issues"],
    ],
  );
  assert.deepEqual(host.calls[0].input.query, { state: "open", per_page: "100", sort: "updated" });
  assert.deepEqual(host.calls[0].input.headers, {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  });
});

test("G2: provider links: closing pull requests and commits in this repository only", async () => {
  const { http } = hosted(),
    gh = createGithubConnector({ now: () => NOW });
  const issue = await gh.listLinksForItem(http, { remote: REMOTE, ref: "#42", kind: "issue" });
  assert.deepEqual(issue, {
    prs: ["pr:github:acme/app#17"],
    commits: [`commit:github:acme/app@${"a".repeat(40)}`],
  });
  const pr = await gh.listLinksForItem(http, { remote: REMOTE, ref: "#17", kind: "pr" });
  assert.deepEqual(pr, {
    prs: [],
    commits: [
      `commit:github:acme/app@${"a".repeat(40)}`,
      `commit:github:acme/app@${"b".repeat(40)}`,
    ],
  });
  assert.deepEqual(closingNumbers("Fixes #42, closes: #7 and resolved #8. Part of #9"), [
    "42",
    "7",
    "8",
  ]);
});

test("G3: the plugin never holds a credential: host-mediated requests carry no auth header, and host refusals are the enum", async () => {
  const { host, http } = hosted(),
    gh = createGithubConnector({ now: () => NOW });
  const results = [
    await gh.resolveRemote(http, { remoteName: "acme/app" }),
    await gh.listItems(http, { remote: REMOTE }),
    await gh.getItem(http, { remote: REMOTE, ref: "#17" }),
    await gh.health(http),
  ];
  assert.deepEqual(results[0], { remoteId: "123456", remoteName: "acme/app", site: null });
  assert.deepEqual(results[3], { state: "ok", retryAt: null });
  assertNoCredentialLeak(assert, host, results);
  // The connector cannot add an Authorization header even if it tried: accountHttp refuses before the host sees it.
  const sent = host.calls.length;
  await assert.rejects(
    http.get("/rate_limit", {}, { Authorization: "Bearer x" }),
    (e) => e.failure === "error",
  );
  assert.equal(host.calls.length, sent, "refused in the plugin, never sent to the host");
  // Host refusals by meaning; the host's sentence is never carried out.
  const cases = [
    [{ account: { state: "revoked" } }, "auth-required"],
    [{ account: { state: "needs-reconnect" } }, "auth-required"],
    [{ host: { grants: [] } }, "error", "needs-host-update"],
    [{ host: { routes: routes({ [OPEN]: { throw: "Couldn't reach GitHub" } }) } }, "offline"],
    [
      {
        host: {
          routes: routes({
            [OPEN]: {
              throw: "Too many requests for this account in the last minute; try again shortly",
            },
          }),
        },
      },
      "rate-limited",
    ],
    [
      { host: { routes: routes({ [OPEN]: { throw: "The provider's answer was too large" } }) } },
      "invalid-response",
    ],
  ];
  for (const [options, failure, detail] of cases) {
    const h = fakeHost({
      accounts: { [ACCOUNT]: { connector: "github", ...options.account } },
      routes: routes(),
      ...options.host,
    });
    const port = accountHttp({ request: h.request, accountId: ACCOUNT, connector: "github" });
    await assert.rejects(
      gh.listItems(port, { remote: REMOTE }),
      (e) =>
        e.failure === failure &&
        (detail ? e.detail === detail : true) &&
        !/account|GitHub|minute/.test(e.message),
      JSON.stringify(options),
    );
  }
  // An account that is not this connector's, no account at all, and a host without the store.
  const other = fakeHost({
    accounts: { [ACCOUNT]: { connector: "jira", site: "acme.atlassian.net" } },
  });
  await assert.rejects(
    gh.listItems(accountHttp({ request: other.request, accountId: ACCOUNT, connector: "github" }), {
      remote: REMOTE,
    }),
    (e) => e.failure === "auth-required",
  );
  await assert.rejects(
    gh.listItems(accountHttp({ request: undefined, accountId: ACCOUNT, connector: "github" }), {
      remote: REMOTE,
    }),
    (e) => e.detail === "needs-host-update",
  );
  await assert.rejects(
    gh.listItems(noHttp(), { remote: REMOTE }),
    (e) => e.failure === "auth-required",
  );
  await assert.rejects(
    gh.listItems(null, { remote: REMOTE }),
    (e) => e.failure === "auth-required",
  );
  assert.deepEqual(
    await gh.health(
      accountHttp({
        request: fakeHost({ accounts: {} }).request,
        accountId: ACCOUNT,
        connector: "github",
      }),
    ),
    { state: "auth-required", retryAt: null },
  );
  assert.equal(HOST_SECRET.length > 20, true);
});

test("G4: the gh command-line login is the other http: one fixed GET template; anything else is refused before running", async () => {
  const argv = [];
  const cli = createGhHttp(async (args) => {
    argv.push(args);
    return JSON.stringify(
      args[5].includes("state=open") ? fx("issues-open.json") : fx("issues-closed.json"),
    );
  });
  const gh = createGithubConnector({ now: () => NOW });
  const r = await gh.listItems(cli, { remote: REMOTE });
  assert.equal(r.items.length, 5);
  assert.deepEqual(argv[0], [
    "api",
    "--method",
    "GET",
    "-H",
    "Accept: application/vnd.github+json",
    "repositories/123456/issues?state=open&per_page=100&sort=updated",
  ]);
  for (const bad of [
    [...argv[0], "-f", "x=1"],
    ["api", "--method", "POST", ...argv[0].slice(3)],
    [...argv[0].slice(0, 5), "repositories/123456/issues/1/comments"],
    [...argv[0].slice(0, 5), "graphql"],
  ]) {
    assert.throws(
      () => assertGhArgs(bad),
      (e) => e.failure === "error",
    );
  }
  assert.throws(
    () => ghArgs("/repositories/123456/issues/1/comments"),
    (e) => e.failure === "error",
  );
  await assert.rejects(
    gh.listItems(createGhHttp(undefined), { remote: REMOTE }),
    (e) => e.failure === "auth-required",
  );
  // Provider statuses are the enum, and rate limits carry the retry.
  const { http } = hosted({
    [`${GH}/repositories/123456/issues?state=open&per_page=100&sort=updated`]: reply(
      403,
      {},
      { "x-ratelimit-remaining": "0", "retry-after": "120" },
    ),
  });
  await assert.rejects(
    gh.listItems(http, { remote: REMOTE }),
    (e) => e.failure === "rate-limited" && e.retryAfterMs === 120000,
  );
  const gone = hosted({
    [`${GH}/repositories/123456/issues?state=open&per_page=100&sort=updated`]: reply(401, {
      message: "Bad credentials",
    }),
  });
  await assert.rejects(
    gh.listItems(gone.http, { remote: REMOTE }),
    (e) => e.failure === "auth-required",
  );
});

test("G5: ticket keys and the local clone origin", () => {
  const gh = createGithubConnector();
  assert.deepEqual(
    gh.issueRefsIn(REMOTE, "Handle the #42 case (see #7); not a&#39; entity or path/#3"),
    ["issue:github:123456:42", "issue:github:123456:7"],
  );
  for (const origin of [
    "https://github.com/acme/app.git",
    "git@github.com:acme/app.git",
    "ssh://git@github.com/Acme/App",
    "https://github.com/acme/app",
  ])
    assert.equal(gh.matchesOrigin(REMOTE, origin), true, origin);
  for (const origin of [
    "https://github.com/acme/app-other.git",
    "https://evil.example/acme/app.git",
    "https://github.com/other/app",
  ])
    assert.equal(gh.matchesOrigin(REMOTE, origin), false, origin);
});

test("R-E-6: a full page may have more behind it, so the read says it is partial", async () => {
  const row = (n) => ({
    ...fx("issues-open.json")[0],
    number: n,
    title: `Issue ${n}`,
    updated_at: "2026-09-24T10:00:00Z",
  });
  const full = Array.from({ length: 100 }, (_, i) => row(i + 1));
  const { http } = hosted({
    [OPEN]: reply(200, full),
    [`${GH}/repositories/123456/issues?state=closed&per_page=100&sort=updated&since=2026-08-25T14:00:00Z`]:
      reply(200, []),
  });
  const r = await createGithubConnector({ now: () => NOW }).listItems(http, { remote: REMOTE });
  assert.deepEqual([r.items.length, r.partial, r.cursor], [100, true, null]);
  const { http: small } = hosted({
    [OPEN]: reply(200, full.slice(0, 3)),
    [`${GH}/repositories/123456/issues?state=closed&per_page=100&sort=updated&since=2026-08-25T14:00:00Z`]:
      reply(200, []),
  });
  assert.equal(
    (await createGithubConnector({ now: () => NOW }).listItems(small, { remote: REMOTE })).partial,
    false,
    "a short page is complete",
  );
});
