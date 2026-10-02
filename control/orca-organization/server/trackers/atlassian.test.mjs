// J3 Jira and Bitbucket connectors (J3-DESIGN.md §7 phases J and B). Synthetic fixtures only.
import test from "node:test";
import assert from "node:assert/strict";
import { createJiraConnector, openJql, authorization } from "./jira.mjs";
import { createBitbucketConnector } from "./bitbucket.mjs";
import { fakeFetch, fakeSecrets, fixture, response } from "./test-support.mjs";
import { harness, P, T } from "./harness.mjs";
const SITE = "acme.atlassian.net",
  JIRA = `https://${SITE}`;
const BB = "https://api.bitbucket.org/2.0",
  UUID = "{00000000-0000-4000-8000-000000002003}",
  ENC = encodeURIComponent(UUID);
const TOKEN = "CANARY-atl-" + "q".repeat(24);
const jiraSearch = `${JIRA}/rest/api/3/search/jql?${new URLSearchParams({ jql: openJql("10001"), maxResults: "50", fields: "summary,status,labels,updated,project" })}`;
const jiraRoutes = () => ({
  [`${JIRA}/rest/api/3/project/ORCA`]: () => response(200, fixture("jira", "project-ORCA.json")),
  [`${JIRA}/rest/api/3/project/10001`]: () => response(200, fixture("jira", "project-ORCA.json")),
  [jiraSearch]: () => response(200, fixture("jira", "search-open.json")),
  [`${JIRA}/rest/api/3/issue/ORCA-12?fields=summary,status,labels,updated,project`]: () =>
    response(200, fixture("jira", "issue-ORCA-12.json")),
});
const bbRoutes = () => ({
  [`${BB}/repositories/team/repo`]: () => response(200, fixture("bitbucket", "repo.json")),
  [`${BB}/repositories/team/quiet`]: () =>
    response(200, fixture("bitbucket", "repo-no-issues.json")),
  [`${BB}/repositories/team/${ENC}`]: () => response(200, fixture("bitbucket", "repo.json")),
  [`${BB}/repositories/team/${ENC}/issues?${new URLSearchParams({ q: 'state="new" OR state="open" OR state="on hold"', sort: "-updated_on", pagelen: "50" })}`]:
    () => response(200, fixture("bitbucket", "issues-open.json")),
  [`${BB}/repositories/team/${ENC}/issues/3`]: () =>
    response(200, fixture("bitbucket", "issue-3.json")),
});
const JM = {
  projectId: P(1),
  tracker: "jira",
  auth: "keychain",
  site: SITE,
  remoteId: "10001",
  remoteName: "ORCA",
  state: "mapped",
  revision: 1,
};
const BM = {
  projectId: P(1),
  tracker: "bitbucket",
  auth: "keychain",
  site: "bitbucket.org",
  remoteId: UUID,
  remoteName: "team/repo",
  state: "mapped",
  revision: 1,
};
const failureOf = async (p) => {
  try {
    await p;
    return null;
  } catch (e) {
    return e;
  }
};

test("J1: Jira resolves the key once, then addresses the project by id with JQL built only from that id", async () => {
  const fetcher = fakeFetch(jiraRoutes()),
    c = createJiraConnector({
      fetcher,
      secrets: fakeSecrets({ [`jira:${SITE}:read`]: "me@example.com:" + TOKEN }),
    });
  assert.deepEqual(await c.resolve({ site: SITE, remoteName: "ORCA" }), {
    remoteId: "10001",
    remoteName: "ORCA",
  });
  await c.validate(JM);
  await c.listOpen(JM);
  await c.get(JM, "ORCA-12");
  assert.deepEqual(
    fetcher.calls.slice(1).map((x) => new URL(x.url).pathname),
    ["/rest/api/3/project/10001", "/rest/api/3/search/jql", "/rest/api/3/issue/ORCA-12"],
  );
  assert.equal(
    new URL(fetcher.calls[2].url).searchParams.get("jql"),
    "project = 10001 AND statusCategory != Done ORDER BY updated DESC",
  );
  assert.throws(() => openJql("10001 OR project = 2"));
  for (const { url, init } of fetcher.calls) {
    assert.equal(new URL(url).host, SITE);
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "error");
  }
});

test("J2: Jira items must belong to the mapped project id and carry its key; state follows the status category", async () => {
  const c = createJiraConnector({
    fetcher: fakeFetch(jiraRoutes()),
    secrets: fakeSecrets({ [`jira:${SITE}:read`]: "x@y:" + TOKEN }),
  });
  const r = await c.listOpen(JM);
  assert.deepEqual(
    r.items.map((i) => [i.ref, i.state]),
    [
      ["ORCA-12", "open"],
      ["ORCA-14", "closed"],
    ],
  );
  assert.equal(r.partial, true);
  assert.equal(r.items[0].title, "Ship trackers <script>x</script>");
  assert.equal(r.items[0].updatedAt, "2026-09-20T10:00:00.000Z");
  assert.equal((await failureOf(c.get(JM, "OTHER-3"))).failure, "error");
});

test("J3: Jira and Bitbucket credentials are per-site read accounts, sent only as Authorization, Basic for email:token and Bearer otherwise", async () => {
  assert.equal(
    authorization("me@example.com:tok"),
    "Basic " + Buffer.from("me@example.com:tok").toString("base64"),
  );
  assert.equal(authorization("patvalue"), "Bearer patvalue");
  const js = fakeSecrets({ [`jira:${SITE}:read`]: TOKEN }),
    jf = fakeFetch(jiraRoutes());
  await createJiraConnector({ fetcher: jf, secrets: js }).listOpen(JM);
  assert.deepEqual(js.reads, [`jira:${SITE}:read`]);
  assert.equal(jf.calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  const bs = fakeSecrets({}),
    bf = fakeFetch(bbRoutes());
  assert.equal(
    (await failureOf(createBitbucketConnector({ fetcher: bf, secrets: bs }).validate(BM))).failure,
    "auth-required",
  );
  assert.deepEqual(bs.reads, ["bitbucket.org:read"]);
  assert.equal(bf.calls.length, 0);
  assert.equal(
    (
      await failureOf(
        createJiraConnector({ fetcher: jf, secrets: js }).resolve({
          site: "evil.example",
          remoteName: "ORCA",
        }),
      )
    ).failure,
    "auth-required",
  );
});

test("B1: Bitbucket resolves the name once, refuses a repository with issues disabled, then addresses the repository by UUID", async () => {
  const fetcher = fakeFetch(bbRoutes()),
    c = createBitbucketConnector({
      fetcher,
      secrets: fakeSecrets({ "bitbucket.org:read": "me@example.com:" + TOKEN }),
    });
  assert.deepEqual(await c.resolve({ remoteName: "team/repo" }), {
    remoteId: UUID,
    remoteName: "team/repo",
  });
  assert.equal((await failureOf(c.resolve({ remoteName: "team/quiet" }))).failure, "not-found");
  fetcher.calls.length = 0;
  await c.validate(BM);
  await c.listOpen(BM);
  await c.get(BM, "3");
  for (const { url, init } of fetcher.calls) {
    assert.ok(url.startsWith(`${BB}/repositories/team/${ENC}`), url);
    assert.equal(init.method, "GET");
  }
});

test("B2: Bitbucket items must belong to the pinned repository UUID; states map to open or closed", async () => {
  const c = createBitbucketConnector({
    fetcher: fakeFetch(bbRoutes()),
    secrets: fakeSecrets({ "bitbucket.org:read": TOKEN }),
  });
  const r = await c.listOpen(BM);
  assert.deepEqual(
    r.items.map((i) => [i.ref, i.state, i.labels]),
    [
      ["3", "open", ["bug", "major"]],
      ["5", "open", ["task", "minor"]],
    ],
  );
  assert.equal(r.partial, true);
  assert.equal(r.items[0].title, "Bitbucket <b>issue</b>");
  assert.equal((await c.get(BM, "3")).state, "closed");
});

test("A1: end to end through the controller: Jira and Bitbucket map, read and link with constructed URLs only", async (t) => {
  const h = harness(t, {
    routes: { ...jiraRoutes(), ...bbRoutes() },
    secretValues: { [`jira:${SITE}:read`]: TOKEN, "bitbucket.org:read": TOKEN },
    connectors: (ports) => ({
      jira: createJiraConnector(ports),
      bitbucket: createBitbucketConnector(ports),
    }),
  });
  assert.equal(
    (
      await h.service.map({
        projectId: P(1),
        tracker: "jira",
        auth: "keychain",
        site: SITE,
        remoteName: "ORCA",
        confirmRemoteId: "10001",
        expectedRevision: 0,
        note: "",
      })
    ).ok,
    true,
  );
  assert.equal(
    (
      await h.service.map({
        projectId: P(2),
        tracker: "bitbucket",
        auth: "keychain",
        site: "ignored",
        remoteName: "team/repo",
        confirmRemoteId: UUID,
        expectedRevision: 0,
        note: "",
      })
    ).ok,
    true,
  );
  assert.equal(
    (
      await h.service.map({
        projectId: P(2),
        tracker: "jira",
        auth: "gh-cli",
        site: SITE,
        remoteName: "ORCA",
        confirmRemoteId: "10001",
        expectedRevision: 1,
        note: "",
      })
    ).ok,
    false,
  );
  const jira = await h.service.read({ projectId: P(1) }),
    bb = await h.service.read({ projectId: P(2) });
  assert.deepEqual(
    jira.items.map((i) => [i.ref, i.url]),
    [
      ["ORCA-12", `https://${SITE}/browse/ORCA-12`],
      ["ORCA-14", `https://${SITE}/browse/ORCA-14`],
    ],
  );
  assert.deepEqual(
    bb.items.map((i) => [i.ref, i.url]),
    [
      ["#3", "https://bitbucket.org/team/repo/issues/3"],
      ["#5", "https://bitbucket.org/team/repo/issues/5"],
    ],
  );
  assert.equal(JSON.stringify([jira, bb]).includes("evil.example"), false);
  assert.equal(
    (
      await h.service.link({
        projectId: P(1),
        subject: { kind: "task", id: T(1) },
        itemRef: "ORCA-12",
        expectedMappingRevision: 1,
      })
    ).ok,
    true,
  );
  assert.equal(
    (
      await h.service.link({
        projectId: P(2),
        subject: { kind: "task", id: T(2) },
        itemRef: "3",
        expectedMappingRevision: 1,
      })
    ).ok,
    true,
  );
  const linked = await h.service.read({ subjects: [T(1), T(2)] });
  assert.deepEqual(linked.links.map((l) => l.itemKey).sort(), [
    "bitbucket:00000000-0000-4000-8000-000000002003:3",
    "jira:10001:ORCA-12",
  ]);
  assert.equal(JSON.stringify([jira, bb, linked, h.inputs]).includes(TOKEN), false);
});
