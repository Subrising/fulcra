import test from "node:test";
import assert from "node:assert/strict";
import { buildLaunchpad, NO_FILTERS, ageOf, type LaunchpadInputs } from "./launchpad-model";
import { readSnoozed, snooze, unsnooze, snoozeChoices } from "./launchpad-snooze";

const P = "00000000-0000-46cd-9b65-000000002006",
  Q = "00000000-0000-46cd-9b65-000000002009",
  S = "00000000-0000-43e5-bd1e-000000002014";
const NOW = Date.parse("2026-09-29T10:00:00.000Z"),
  H = 3_600_000,
  D = 24 * H;
const iso = (t: number) => new Date(t).toISOString();
const item = (
  n: number,
  kind: "pr" | "issue" | "ticket",
  state: string,
  assignee: string | null,
  updated: number,
  repo = "fulcra/app",
  extra: object = {},
) => ({
  item: {
    key: `${kind === "pr" ? "pr" : "issue"}:github:${repo}#${n}`,
    connector: "github",
    kind,
    ref: `#${n}`,
    title: `Item ${n}`,
    state,
    url: `https://github.com/${repo}/${kind === "pr" ? "pull" : "issues"}/${n}`,
    updatedAt: iso(updated),
    assignee,
    labels: [],
  },
  stale: false,
  observedAt: iso(NOW),
  links: [],
  trail: [],
  ...extra,
});
const view = (items: object[]) =>
  ({ version: 1, observedAt: iso(NOW), partial: false, trackers: [], items }) as any;
const integrations = (name: string, state = "connected") =>
  ({
    version: 1,
    observedAt: iso(NOW),
    partial: false,
    hostApi: true,
    connectors: [],
    accounts: [
      {
        version: 1,
        id: P,
        connector: "github",
        site: null,
        displayName: name,
        method: "cli",
        scopes: [],
        state,
        expiresAt: null,
        lastCheckedAt: iso(NOW),
        createdAt: iso(NOW),
      },
    ],
  }) as any;
const base = (over: Partial<LaunchpadInputs> = {}): LaunchpadInputs => ({
  now: NOW,
  projects: [
    { id: P, name: "Fulcra app" },
    { id: Q, name: "Website" },
  ],
  failed: [],
  snoozedUntil: {},
  filters: NO_FILTERS,
  integrations: integrations("example-user"),
  views: {
    [P]: view([
      item(1, "pr", "open", "example-user", NOW - 2 * H),
      item(2, "issue", "open", "sam", NOW - 3 * D),
      item(3, "pr", "merged", "example-user", NOW - H),
      item(4, "issue", "in-progress", null, NOW - 9 * D),
      item(5, "pr", "open", "example-user", NOW - 30 * 60_000, "fulcra/control", {
        links: [{ from: `session:${S}`, to: "pr:github:fulcra/control#5", state: "active" }],
      }),
    ]),
    [Q]: view([
      item(9, "issue", "open", "example-user", NOW - 5 * D, "fulcra/site"),
      item(10, "ticket", "open", "example-user", NOW),
    ]),
  },
  ...over,
});

test("open pull requests and issues across every project and repo: assigned to you, or waiting on others", () => {
  const pad = buildLaunchpad(base());
  assert.deepEqual(
    pad.you.map((x) => x.ref),
    ["#5", "#1", "#9"],
    "yours, newest first, across repos and projects (login matched case-insensitively)",
  );
  assert.deepEqual(
    pad.others.map((x) => x.ref),
    ["#2", "#4"],
    "assigned to someone else, or to no one",
  );
  assert.equal(pad.total, 5, "merged and closed ones, and tickets, are not waiting on anyone");
  assert.deepEqual(pad.repos, ["fulcra/app", "fulcra/control", "fulcra/site"]);
  assert.deepEqual(
    pad.projects.map((p) => p.name),
    ["Fulcra app", "Website"],
  );
  assert.equal(pad.you[0].sessionId, S, "the linked session travels with the item");
  assert.equal(pad.you[0].project, "Fulcra app");
  assert.deepEqual(pad.gaps, []);
});

test("filters: repo, project, type and age, each narrowing both lists", () => {
  const f = (filters: object) => buildLaunchpad(base({ filters: { ...NO_FILTERS, ...filters } }));
  assert.deepEqual(
    f({ repo: "fulcra/control" }).you.map((x) => x.ref),
    ["#5"],
  );
  assert.deepEqual(
    f({ project: Q }).you.map((x) => x.ref),
    ["#9"],
  );
  assert.deepEqual(
    [...f({ kind: "issue" }).you, ...f({ kind: "issue" }).others].map((x) => x.ref),
    ["#9", "#2", "#4"],
  );
  assert.deepEqual(
    f({ age: "day" }).you.map((x) => x.ref),
    ["#5", "#1"],
  );
  assert.deepEqual(
    f({ age: "week" }).others.map((x) => x.ref),
    ["#2"],
  );
  assert.deepEqual(
    f({ age: "older" }).others.map((x) => x.ref),
    ["#4"],
  );
  assert.equal(f({ repo: "fulcra/app", age: "day" }).shown, 1);
  assert.equal(ageOf("not a date", NOW), "older");
});

test("snoozed items leave both lists until their time, then come back", () => {
  const key = `${P}:pr:github:fulcra/app#1`;
  const pad = buildLaunchpad(base({ snoozedUntil: { [key]: NOW + H } }));
  assert.deepEqual(
    pad.you.map((x) => x.ref),
    ["#5", "#9"],
  );
  assert.deepEqual(
    pad.snoozed.map((x) => x.ref),
    ["#1"],
  );
  assert.equal(
    buildLaunchpad(base({ snoozedUntil: { [key]: NOW - 1 } })).you.length,
    3,
    "an expired snooze has no effect",
  );
});

test("it says what it cannot tell: an unmatched account, unreadable projects, stale items", () => {
  const nobody = buildLaunchpad(base({ integrations: integrations("Example User") }));
  assert.equal(nobody.you.length, 0);
  assert.equal(nobody.others.length, 5);
  assert.match(nobody.gaps.join(" "), /None of these are assigned to your connected account/);
  assert.equal(
    buildLaunchpad(base({ integrations: integrations("example-user", "expired") })).you.length,
    0,
    "only a connected account counts as you",
  );
  assert.match(
    buildLaunchpad(base({ failed: [Q] })).gaps.join(" "),
    /one project could not be read/,
  );
  const stale = base();
  (stale.views[P] as any).items[0].stale = true;
  assert.match(buildLaunchpad(stale).gaps.join(" "), /last checked a while ago/);
  assert.deepEqual(buildLaunchpad(base({ views: {} })), {
    ...buildLaunchpad(base({ views: {} })),
    you: [],
    others: [],
    total: 0,
  });
});

test("snooze is local, per host, reversible, and drops expired or malformed entries", () => {
  const host = "host-a";
  assert.deepEqual(readSnoozed(host, false, NOW), {});
  snooze(host, false, "k1", NOW + H, NOW);
  snooze(host, false, "k2", NOW + 2 * H, NOW);
  assert.deepEqual(Object.keys(readSnoozed(host, false, NOW)).sort(), ["k1", "k2"]);
  assert.deepEqual(readSnoozed("host-b", false, NOW), {}, "another host is separate");
  assert.deepEqual(Object.keys(unsnooze(host, false, "k1", NOW)), ["k2"]);
  assert.deepEqual(readSnoozed(host, false, NOW + 3 * H), {}, "expired ones fall away");
  const choices = snoozeChoices(NOW);
  assert.deepEqual(
    choices.map((c) => c.label),
    ["For 3 hours", "Until tomorrow", "For a week"],
  );
  assert.ok(choices.every((c) => c.until > NOW));
});

// ---- GR review fixes M4-M6 ----
const account = (connector: string, displayName: string, site: string | null = null) => ({
  version: 1,
  id: Q,
  connector,
  site,
  displayName,
  method: "token",
  scopes: [],
  state: "connected",
  expiresAt: null,
  lastCheckedAt: iso(NOW),
  createdAt: iso(NOW),
});
const withAccounts = (accounts: object[]): LaunchpadInputs["integrations"] => ({
  ...integrations("x"),
  accounts,
});
const jiraItem = (n: number, assignee: string) => ({
  item: {
    key: `issue:jira@acme.atlassian.net:SHOP-${n}`,
    connector: "jira",
    kind: "issue",
    ref: `SHOP-${n}`,
    title: `Jira ${n}`,
    state: "open",
    url: `https://acme.atlassian.net/browse/SHOP-${n}`,
    updatedAt: iso(NOW - H),
    assignee,
    labels: [],
  },
  stale: false,
  observedAt: iso(NOW),
  links: [],
  trail: [],
});

test("M6: matched per connector on the GitHub login; a Jira display name never counts, even when it equals the login", () => {
  const pad = buildLaunchpad(
    base({
      integrations: withAccounts([
        account("github", "example-user"),
        account("jira", "example-user", "acme.atlassian.net"),
      ]),
      views: {
        [P]: view([
          item(1, "pr", "open", "example-user", NOW - 2 * H),
          jiraItem(7, "example-user"),
        ]),
      },
    }),
  );
  assert.deepEqual(
    pad.you.map((x) => x.ref),
    ["#1"],
  );
  assert.deepEqual(
    pad.others.map((x) => x.ref),
    ["SHOP-7"],
    "no pooling: the Jira name is not the GitHub login's owner",
  );
  assert.match(pad.gaps.join(" "), /Can't tell which Jira items are yours/);
  assert.equal(pad.knowsYou, true);
});

test("M6: no GitHub account and no sign-in on this Mac means nothing is yours, and the gap says why", () => {
  const pad = buildLaunchpad(base({ integrations: withAccounts([]) }));
  assert.equal(pad.you.length, 0);
  assert.equal(pad.youTotal, 0);
  assert.equal(pad.knowsYou, false);
  assert.match(
    pad.gaps.join(" "),
    /Can't tell which GitHub items are yours: this Mac isn't signed in to GitHub, and no GitHub account is connected in Settings\./,
  );
  assert.doesNotMatch(pad.gaps.join(" "), /None of these are assigned to your connected account/);
});

test("M6: a GitHub Enterprise account's login does not match github.com items", () => {
  const pad = buildLaunchpad(
    base({
      integrations: withAccounts([account("github", "example-user", "github.corp.example")]),
    }),
  );
  assert.equal(pad.you.length, 0);
  assert.match(pad.gaps.join(" "), /Can't tell which GitHub items are yours/);
});

test("M4: youTotal counts every unsnoozed item waiting on you, whatever the filters", () => {
  assert.equal(buildLaunchpad(base()).youTotal, 3);
  assert.equal(
    buildLaunchpad(base({ filters: { ...NO_FILTERS, repo: "fulcra/site" } })).youTotal,
    3,
    "filters narrow the list, not the count",
  );
  assert.equal(
    buildLaunchpad(base({ snoozedUntil: { [`${P}:pr:github:fulcra/app#1`]: NOW + H } })).youTotal,
    2,
  );
});

test("M5: status says why nothing is listed: nothing linked, never refreshed, or refreshed and empty", () => {
  const tracker = (observedAt: string | null) => ({
    mappingId: S,
    connector: "github",
    label: "GitHub",
    remoteName: "fulcra/app",
    commandLine: false,
    status: "ok",
    retryAt: null,
    observedAt,
  });
  const only = (v: object) => base({ views: { [P]: v as LaunchpadInputs["views"][string] } });
  assert.equal(buildLaunchpad(only(view([]))).status, "no-trackers");
  assert.equal(
    buildLaunchpad(only({ ...view([]), trackers: [tracker(null)] })).status,
    "never-refreshed",
  );
  assert.equal(
    buildLaunchpad(only({ ...view([]), trackers: [tracker(iso(NOW))] })).status,
    "empty",
  );
  assert.equal(buildLaunchpad(base()).status, "items");
});

// ---- U7 W4: this Mac's existing GitHub sign-in names "you" ----
const hostSignIn = (login: string, site: string | null = null) => ({
  ...account("github", login, site),
  id: P,
  method: "cli",
});
const gheItem = (n: number, assignee: string) => ({
  item: {
    key: `pr:github@ghe.corp.example:fulcra/app#${n}`,
    connector: "github",
    kind: "pr",
    ref: `#${n}`,
    title: `GHE ${n}`,
    state: "open",
    url: `https://ghe.corp.example/fulcra/app/pull/${n}`,
    updatedAt: iso(NOW - H),
    assignee,
    labels: [],
  },
  stale: false,
  observedAt: iso(NOW),
  links: [],
  trail: [],
});

test("W4: this Mac's GitHub sign-in is you: Waiting on you lists the items assigned to its login", () => {
  const pad = buildLaunchpad(base({ integrations: withAccounts([hostSignIn("example-user")]) }));
  assert.deepEqual(
    pad.you.map((x) => x.key),
    buildLaunchpad(base()).you.map((x) => x.key),
  );
  assert.equal(pad.youTotal, 3);
  assert.equal(pad.knowsYou, true);
  assert.doesNotMatch(pad.gaps.join(" "), /Can't tell which GitHub items are yours/);
});

test('W4: an account\'s "(GitHub)" suffix is not part of the login, so a connected account matches too', () => {
  const pad = buildLaunchpad(
    base({ integrations: withAccounts([account("github", "example-user (GitHub)")]) }),
  );
  assert.equal(pad.youTotal, 3);
  assert.doesNotMatch(pad.gaps.join(" "), /Can't tell which GitHub items are yours/);
});

test("W4: an Enterprise sign-in names you only on its own site", () => {
  const views = {
    [P]: view([item(1, "pr", "open", "example-user", NOW - 2 * H), gheItem(8, "example-user")]),
  };
  const pad = buildLaunchpad(
    base({ integrations: withAccounts([hostSignIn("example-user", "ghe.corp.example")]), views }),
  );
  assert.deepEqual(
    pad.you.map((x) => x.title),
    ["GHE 8"],
  );
  assert.deepEqual(
    pad.others.map((x) => x.title),
    ["Item 1"],
  );
  assert.match(pad.gaps.join(" "), /Can't tell which GitHub items are yours/);
});
