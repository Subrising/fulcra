// Fulcra J4b: the Bitbucket Cloud and Data Center connectors against recorded synthetic fixtures behind a fake of
// the host's credential request (host-test-support.mjs). The plugin holds no credential; no test reaches the network.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { createRegistry } from "./registry.mjs";
import { createBitbucketConnector } from "./bitbucket.mjs";
import { accountHttp } from "./http.mjs";
import { itemProblem } from "../../shared/cc/connector-rules.mjs";
import { noPersonal, parseRef } from "../../shared/cc/refs.mjs";
import { fakeHost, reply, assertNoCredentialLeak } from "./host-test-support.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (dir, name) =>
  JSON.parse(fs.readFileSync(path.join(here, "fixtures", dir, name), "utf8"));
const API = "https://api.bitbucket.org",
  DC = "git.example.com";
const UUID = "00000000-0000-4908-8706-000000002005",
  REPO = `${API}/2.0/repositories/acme/{${UUID}}`;
const ACCOUNT = "77777777-7777-4777-8777-000000000001";
const NOW = Date.parse("2026-09-24T14:00:00Z"),
  SINCE = "2026-08-25T14:00:00Z";
const CLOUD_REMOTE = { remoteId: UUID, remoteName: "acme/web", site: null },
  DC_REMOTE = { remoteId: "42", remoteName: "ACME/web", site: DC };
const PRS = `${REPO}/pullrequests?state=OPEN&state=MERGED&state=DECLINED&state=SUPERSEDED&sort=-updated_on&pagelen=50&q=state = "OPEN" OR updated_on > ${SINCE}&page=1`;
const ISSUES = `${REPO}/issues?sort=-updated_on&pagelen=50&q=(state = "new" OR state = "open" OR state = "on hold") OR updated_on > ${SINCE}&page=1`;
const cloudRoutes = (extra = {}) => ({
  [`${API}/2.0/repositories/acme/web`]: reply(200, fx("bitbucket", "repo.json")),
  [PRS]: reply(200, fx("bitbucket", "pullrequests.json")),
  [ISSUES]: reply(200, fx("bitbucket", "issues.json")),
  [`${REPO}/pullrequests/5/commits?pagelen=100&page=1`]: reply(
    200,
    fx("bitbucket", "pr-5-commits.json"),
  ),
  [`${REPO}/pullrequests/5`]: reply(200, fx("bitbucket", "pullrequests.json").values[0]),
  [`${REPO}/issues/7`]: reply(200, fx("bitbucket", "issues.json").values[0]),
  [`${API}/2.0/user`]: reply(200, { uuid: "{x}" }),
  ...extra,
});
const DC_REPO = `https://${DC}/rest/api/1.0/projects/ACME/repos/web`;
const dcRoutes = (extra = {}) => ({
  [DC_REPO]: reply(200, fx("bitbucket-dc", "repo.json")),
  [`${DC_REPO}/pull-requests?state=ALL&order=NEWEST&limit=100&start=0`]: reply(
    200,
    fx("bitbucket-dc", "pull-requests.json"),
  ),
  [`${DC_REPO}/pull-requests/9/commits?limit=100&start=0`]: reply(
    200,
    fx("bitbucket-dc", "pr-9-commits.json"),
  ),
  [`https://${DC}/rest/api/1.0/profile/recent/repos?limit=1`]: reply(200, { values: [] }),
  ...extra,
});
function hosted({ id = "bitbucket", routes = cloudRoutes(), site = null, state } = {}) {
  const host = fakeHost({ accounts: { [ACCOUNT]: { connector: id, site, state } }, routes });
  return { host, http: accountHttp({ request: host.request, accountId: ACCOUNT, connector: id }) };
}
const cloud = () => createBitbucketConnector({ id: "bitbucket", now: () => NOW });
const dc = () => createBitbucketConnector({ id: "bitbucket-dc", now: () => NOW });

test("BB1: both Bitbucket connectors register with token sign-in; Data Center lists pull requests only", () => {
  const [c, d] = createRegistry([cloud(), dc()]).describe();
  assert.deepEqual(
    [c.id, c.label, c.selfHosted, c.auth, c.kinds],
    ["bitbucket", "Bitbucket", false, ["token"], ["issue", "pr"]],
  );
  assert.deepEqual(
    [d.id, d.label, d.selfHosted, d.auth, d.kinds],
    ["bitbucket-dc", "Bitbucket Data Center", true, ["token"], ["pr"]],
  );
  assert.ok(
    c.keyPatterns.includes("[A-Z][A-Z0-9]+-\\d+") && d.keyPatterns.includes("[A-Z][A-Z0-9]+-\\d+"),
  );
  assert.ok(c.tokenHelp.scopes.every((s) => s.startsWith("read:")));
  for (const x of [c, d]) assert.ok(noPersonal(x.tokenHelp.note), x.id);
});

test("BB2: Cloud resolve strips the UUID braces so the id fits an issue ref; later calls address the UUID", async () => {
  const { host, http } = hosted();
  const r = await cloud().resolveRemote(http, { remoteName: "acme/web" });
  assert.deepEqual(r, { remoteId: UUID, remoteName: "acme/web", site: null });
  assert.equal(parseRef(`issue:bitbucket:${r.remoteId}:7`)?.kind, "issue");
  await assert.rejects(
    cloud().resolveRemote(http, { remoteName: "acme/../web" }),
    (e) => e.failure === "not-found",
  );
  await assert.rejects(
    cloud().resolveRemote(http, { remoteName: "acme" }),
    (e) => e.failure === "not-found",
  );
  await cloud().listItems(http, { remote: CLOUD_REMOTE });
  assert.ok(
    host.calls
      .slice(1)
      .every((c) => c.input.path.startsWith(`/2.0/repositories/acme/%7B${UUID}%7D/`)),
    "encoded braces, accepted by the host",
  );
});

test("BB3: Cloud pull requests and issues, open and recently finished, become §7.1 items; ticket text travels aside", async () => {
  const { host, http } = hosted();
  const r = await cloud().listItems(http, { remote: CLOUD_REMOTE });
  assert.deepEqual(
    r.items.map((i) => [i.key, i.kind, i.ref, i.state]),
    [
      ["pr:bitbucket:acme/web#5", "pr", "PR #5", "open"],
      ["pr:bitbucket:acme/web#4", "pr", "PR #4", "merged"],
      [`issue:bitbucket:${UUID}:7`, "issue", "#7", "open"],
    ],
  );
  assert.equal(
    r.partial,
    true,
    "a pull request into another repository is dropped and the read is partial",
  );
  for (const it of r.items) assert.equal(itemProblem(it), null, it.key);
  assert.deepEqual(
    [r.items[0].url, r.items[2].url, r.items[2].assignee, r.items[2].labels],
    [
      "https://bitbucket.org/acme/web/pull-requests/5",
      "https://bitbucket.org/acme/web/issues/7",
      "Test User C",
      ["bug", "major"],
    ],
  );
  assert.equal(
    JSON.stringify(r.items).includes("evil.example.com"),
    false,
    "a URL from the API is never used",
  );
  assert.equal(r.texts["pr:bitbucket:acme/web#5"], "Sign-in fix\nfeature/ACME-12-sign-in");
  assert.deepEqual(host.calls[0].input.query.state, ["OPEN", "MERGED", "DECLINED", "SUPERSEDED"]);
  assertNoCredentialLeak(assert, host, r);
});

test("BB4: a repository without issues answers 404 for them: pull requests still read; other failures fail", async () => {
  const { http } = hosted({ routes: cloudRoutes({ [ISSUES]: reply(404, { type: "error" }) }) });
  const r = await cloud().listItems(http, { remote: CLOUD_REMOTE });
  assert.deepEqual(
    r.items.map((i) => i.kind),
    ["pr", "pr"],
  );
  const limited = hosted({
    routes: cloudRoutes({ [ISSUES]: reply(429, {}, { "retry-after": "30" }) }),
  });
  await assert.rejects(
    cloud().listItems(limited.http, { remote: CLOUD_REMOTE }),
    (e) => e.failure === "rate-limited" && e.retryAfterMs === 30000,
  );
});

test("BB5: links: a pull request lists its commits; getItem tells issues and pull requests apart", async () => {
  const { http } = hosted();
  assert.deepEqual(
    await cloud().listLinksForItem(http, { remote: CLOUD_REMOTE, ref: "PR #5", kind: "pr" }),
    {
      commits: [
        `commit:bitbucket:acme/web@${"c".repeat(40)}`,
        `commit:bitbucket:acme/web@${"d".repeat(40)}`,
      ],
      prs: [],
    },
  );
  assert.deepEqual(
    await cloud().listLinksForItem(http, { remote: CLOUD_REMOTE, ref: "#7", kind: "issue" }),
    { commits: [], prs: [] },
  );
  assert.equal(
    (await cloud().getItem(http, { remote: CLOUD_REMOTE, ref: "PR #5" })).key,
    "pr:bitbucket:acme/web#5",
  );
  assert.equal(
    (await cloud().getItem(http, { remote: CLOUD_REMOTE, ref: "#7" })).key,
    `issue:bitbucket:${UUID}:7`,
  );
  await assert.rejects(
    cloud().getItem(http, { remote: CLOUD_REMOTE, ref: "#7/../../x" }),
    (e) => e.failure === "error",
  );
  assert.deepEqual(await cloud().health(http), { state: "ok", retryAt: null });
});

test("BB6: Data Center: resolve pins the numeric id; pull requests, commits and the site in every ref", async () => {
  const { host, http } = hosted({ id: "bitbucket-dc", site: DC, routes: dcRoutes() });
  assert.deepEqual(
    await dc().resolveRemote(http, { remoteName: "ACME/web", site: "Git.Example.com" }),
    { remoteId: "42", remoteName: "ACME/web", site: DC },
  );
  await assert.rejects(
    dc().resolveRemote(http, { remoteName: "ACME/web", site: null }),
    (e) => e.failure === "error",
  );
  const r = await dc().listItems(http, { remote: DC_REMOTE });
  assert.deepEqual(
    r.items.map((i) => [i.key, i.ref, i.state]),
    [
      ["pr:bitbucket-dc@git.example.com:ACME/web#9", "PR #9", "open"],
      ["pr:bitbucket-dc@git.example.com:ACME/web#8", "PR #8", "merged"],
    ],
  );
  assert.equal(r.partial, true, "a pull request into repository 43 is dropped");
  assert.equal(r.items[0].url, "https://git.example.com/projects/ACME/repos/web/pull-requests/9");
  assert.equal(
    r.texts["pr:bitbucket-dc@git.example.com:ACME/web#9"],
    "Tidy the sign-in form\nbugfix/ACME-11-form",
  );
  for (const it of r.items) assert.equal(itemProblem(it), null, it.key);
  assert.deepEqual(
    await dc().listLinksForItem(http, { remote: DC_REMOTE, ref: "PR #9", kind: "pr" }),
    { commits: [`commit:bitbucket-dc@git.example.com:ACME/web@${"e".repeat(40)}`], prs: [] },
  );
  await assert.rejects(
    dc().getItem(http, { remote: DC_REMOTE, ref: "#9" }),
    (e) => e.failure === "not-found",
    "Data Center has no issues",
  );
  assert.deepEqual(dc().issueRefsIn(DC_REMOTE, "fixes #3"), []);
  assert.deepEqual(await dc().health(http), { state: "ok", retryAt: null });
  assert.ok(
    host.calls.every(
      (c) => c.connectorId === "bitbucket-dc" && c.input.path.startsWith("/rest/api/1.0/"),
    ),
  );
  assertNoCredentialLeak(assert, host, r);
});

test("BB7: issue keys and local clone origins, for both", () => {
  assert.deepEqual(cloud().issueRefsIn(CLOUD_REMOTE, "Fix #7 and #12; not a&#9; or path/#3"), [
    `issue:bitbucket:${UUID}:7`,
    `issue:bitbucket:${UUID}:12`,
  ]);
  for (const o of [
    "https://bitbucket.org/acme/web.git",
    "https://someone@bitbucket.org/acme/web.git",
    "git@bitbucket.org:acme/web.git",
    "ssh://git@bitbucket.org/Acme/Web",
  ])
    assert.equal(cloud().matchesOrigin(CLOUD_REMOTE, o), true, o);
  for (const o of [
    "https://bitbucket.org/acme/web-other.git",
    "https://evil.example.com/acme/web.git",
  ])
    assert.equal(cloud().matchesOrigin(CLOUD_REMOTE, o), false, o);
  for (const o of [
    "https://git.example.com/scm/acme/web.git",
    "https://git.example.com/bitbucket/scm/ACME/web.git",
    "ssh://git@git.example.com:7999/acme/web.git",
  ])
    assert.equal(dc().matchesOrigin(DC_REMOTE, o), true, o);
  for (const o of [
    "https://git.example.org/scm/acme/web.git",
    "https://git.example.com/scm/acme/other.git",
  ])
    assert.equal(dc().matchesOrigin(DC_REMOTE, o), false, o);
  assert.equal(cloud().repoKeyFor(CLOUD_REMOTE), "bitbucket:acme/web");
  assert.equal(dc().repoKeyFor(DC_REMOTE), "bitbucket-dc@git.example.com:ACME/web");
});

test("BB8: sign-in problems are the enum; the host sentence is never carried", async () => {
  for (const state of ["revoked", "needs-reconnect"]) {
    await assert.rejects(
      cloud().listItems(hosted({ state }).http, { remote: CLOUD_REMOTE }),
      (e) => e.failure === "auth-required" && !/account|Integrations/.test(e.message),
      state,
    );
  }
  const gone = hosted({ routes: cloudRoutes({ [PRS]: reply(401, {}) }) });
  await assert.rejects(
    cloud().listItems(gone.http, { remote: CLOUD_REMOTE }),
    (e) => e.failure === "auth-required",
  );
  const forbidden = hosted({
    id: "bitbucket-dc",
    site: DC,
    routes: dcRoutes({
      [`${DC_REPO}/pull-requests?state=ALL&order=NEWEST&limit=100&start=0`]: reply(403, {}),
    }),
  });
  await assert.rejects(
    dc().listItems(forbidden.http, { remote: DC_REMOTE }),
    (e) => e.failure === "forbidden",
  );
});

test("R-E-6: pull requests or issues beyond the pager's bound make the read partial", async () => {
  // Only this repository's pull requests, so nothing but the pager's bound can make the read partial.
  const page = (n) => ({
    ...fx("bitbucket", "pullrequests.json"),
    values: fx("bitbucket", "pullrequests.json").values.slice(0, 2),
    page: n,
    next: "https://api.bitbucket.org/2.0/more",
  });
  const P2 = PRS.replace("&page=1", "&page=2");
  const { http } = hosted({
    routes: cloudRoutes({
      [PRS]: reply(200, page(1)),
      [P2]: reply(200, page(2)),
      [ISSUES]: reply(404, {}),
    }),
  });
  assert.equal((await cloud().listItems(http, { remote: CLOUD_REMOTE })).partial, true);
  const ISSUES2 = ISSUES.replace("&page=1", "&page=2"),
    issues = (n) => ({
      ...fx("bitbucket", "issues.json"),
      page: n,
      next: "https://api.bitbucket.org/2.0/more",
    });
  const clean = {
    ...fx("bitbucket", "pullrequests.json"),
    values: fx("bitbucket", "pullrequests.json").values.slice(0, 2),
  };
  const { http: h2 } = hosted({
    routes: cloudRoutes({
      [PRS]: reply(200, clean),
      [ISSUES]: reply(200, issues(1)),
      [ISSUES2]: reply(200, issues(2)),
    }),
  });
  assert.equal(
    (await cloud().listItems(h2, { remote: CLOUD_REMOTE })).partial,
    true,
    "issues beyond the bound too",
  );
  const { http: h3 } = hosted({ routes: cloudRoutes({ [PRS]: reply(200, clean) }) });
  assert.equal(
    (await cloud().listItems(h3, { remote: CLOUD_REMOTE })).partial,
    false,
    "everything read, nothing refused",
  );
});
