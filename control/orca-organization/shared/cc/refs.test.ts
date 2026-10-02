import test from "node:test";
import assert from "node:assert/strict";
import {
  JARGON,
  REF_KINDS,
  REF_MAX,
  REF_PATTERNS,
  isRef,
  noPersonal,
  parseRef,
  personalMatch,
  plainLanguageCheck,
  ref,
  sentenceCount,
  type RefKind,
} from "./refs";
import { trackerItemKey } from "../trackers";

const U = "00000000-0000-4de9-bef1-000000002002",
  V = "00000000-0000-4000-8000-000000002012",
  SHA = "34097db".padEnd(40, "0");
const VALID: Record<RefKind, string[]> = {
  project: [`project:${U}`],
  task: [`task:${U}`],
  session: [`session:${V}`],
  seat: ["seat:delivery", "seat:j0-foundation"],
  turn: [`turn:${V}/42`, `turn:${V}/seq-000123`],
  repo: [
    "repo:github:acme/app",
    "repo:bitbucket:acme/app",
    "repo:bitbucket-dc@git.example.com:PROJ/app",
    `repo:local:${U}/tally`,
  ],
  commit: [`commit:github:acme/app@${SHA}`, `commit:bitbucket-dc@git.example.com:PROJ/app@${SHA}`],
  pr: ["pr:github:acme/app#17", `pr:local:${U}/tally#1`],
  issue: [
    "issue:jira@acme.atlassian.net:10001:PROJ-123",
    "issue:github:123456:42",
    "issue:bitbucket:00000000-0000-4de9-bef1-000000002002:7",
  ],
  file: ["file:github:acme/app:src/index.ts", "file:github:acme/app:docs/Getting started.md"],
  decision: [`decision:${U}`],
  brief: [`brief:${U}@3`],
  env: [`env:${U}`],
  deploy: [`deploy:${U}`],
  promotion: [`promotion:${U}`],
  archmap: [`archmap:github:acme/app@${SHA}:system`],
  outcome: [`outcome:${U}`],
};
const INVALID: Record<RefKind, string[]> = {
  project: ["project:42", `project:${U.toUpperCase()}`, `project: ${U}`],
  task: ["task:"],
  session: [`session:${U}x`],
  seat: ["seat:Delivery", "seat:-lead", `seat:${"a".repeat(65)}`],
  turn: [`turn:${V}`, `turn:${V}/`, "turn:abc/1"],
  repo: [
    "repo:github:/acme/app",
    "repo:github:acme/../app",
    "repo:G:acme/app",
    "repo:local:acme/app",
    "repo:github@:acme/app",
  ],
  commit: [
    `commit:github:acme/app@${SHA.slice(0, 7)}`,
    `commit:github:acme/app@${SHA.toUpperCase()}`,
  ],
  pr: ["pr:github:acme/app#0", "pr:github:acme/app"],
  issue: ["issue:jira:PROJ-123", "issue:jira:10001:PROJ 123"],
  file: [
    "file:github:acme/app:/etc/hosts",
    "file:github:acme/app:src/../../secret",
    "file:github:acme/app:",
    "file:github:acme/app:a\\b",
  ],
  decision: ["decision:latest"],
  brief: [`brief:${U}`, `brief:${U}@0`],
  env: ["env:prod"],
  deploy: [`deploy:${U}@1`],
  promotion: ["promotion:"],
  archmap: [`archmap:github:acme/app@${SHA}`, `archmap:github:acme/app:system`],
  outcome: ["outcome:task"],
};

test("every kind accepts its contract examples and refuses near misses", () => {
  assert.deepEqual([...REF_KINDS].sort(), Object.keys(VALID).sort(), "one test row per kind");
  for (const kind of REF_KINDS) {
    for (const value of VALID[kind]) {
      assert.ok(REF_PATTERNS[kind].test(value), value);
      assert.equal(parseRef(value)?.kind, kind, value);
      assert.ok(ref.safeParse(value).success, value);
    }
    for (const value of INVALID[kind]) {
      assert.equal(isRef(value), false, value);
      assert.equal(parseRef(value), null, value);
    }
  }
  assert.equal(
    ref.safeParse(`file:github:acme/app:${"a/".repeat(150)}x`).success,
    false,
    "at most 300 characters",
  );
  for (const value of ["", "github:acme/app", "PROJECT:" + U, "unknown:" + U])
    assert.equal(ref.safeParse(value).success, false, value);
  for (const value of [undefined, null, 42, {}, "x".repeat(REF_MAX + 1)]) {
    assert.equal(parseRef(value), null);
    assert.equal(isRef(value), false);
  }
});

// The result shape J3's shared/cc/refs.mjs returns (refs.d.mts), so consumers work against either file.
test("parseRef returns the parts every job reads, in the shared shape", () => {
  assert.deepEqual(parseRef(`commit:bitbucket-dc@git.example.com:PROJ/app@${SHA}`), {
    kind: "commit",
    repoKey: "bitbucket-dc@git.example.com:PROJ/app",
    sha: SHA,
  });
  assert.deepEqual(parseRef(`pr:local:${U}/tally#12`), {
    kind: "pr",
    repoKey: `local:${U}/tally`,
    number: 12,
  });
  assert.deepEqual(parseRef("file:github:acme/app:src/a b.ts"), {
    kind: "file",
    repoKey: "github:acme/app",
    path: "src/a b.ts",
  });
  assert.deepEqual(parseRef(`turn:${V}/7`), { kind: "turn", sessionId: V, turnId: "7" });
  assert.deepEqual(parseRef(`brief:${U}@3`), { kind: "brief", projectId: U, revision: 3 });
  assert.deepEqual(parseRef(`archmap:github:acme/app@${SHA}:system`), {
    kind: "archmap",
    repoKey: "github:acme/app",
    sha: SHA,
    mapName: "system",
  });
  assert.deepEqual(parseRef("repo:github:acme/app"), { kind: "repo", repoKey: "github:acme/app" });
  assert.deepEqual(parseRef("seat:delivery"), { kind: "seat", seat: "delivery" });
  assert.deepEqual(parseRef(`decision:${U}`), { kind: "decision", id: U });
  assert.deepEqual(parseRef("issue:jira@acme.atlassian.net:10001:PROJ-123"), {
    kind: "issue",
    connector: "jira",
    site: "acme.atlassian.net",
    remoteId: "10001",
    ref: "PROJ-123",
  });
});

test("existing tracker item keys are valid issue refs as they are", () => {
  for (const key of [
    "github:123456:42",
    "jira:10001:ORCA-12",
    "bitbucket:00000000-0000-4de9-bef1-000000002002:7",
  ]) {
    assert.ok(trackerItemKey.safeParse(key).success, key);
    const parsed = parseRef(`issue:${key}`);
    assert.equal(parsed?.kind, "issue");
    assert.equal(
      parsed?.kind === "issue" && `${parsed.connector}:${parsed.remoteId}:${parsed.ref}`,
      key,
    );
  }
});

test("noPersonal refuses every §1a pattern and lets ordinary words through", () => {
  const hits: [string, string][] = [
    ["See /Users/someone/notes", "a home or volume path"],
    ["on /Volumes/disk/x", "a home or volume path"],
    ["in /home/dev", "a home or volume path"],
    ["under ~/vault", "a home or volume path"],
    ["host mini.tail1234.ts.net", "a private host name"],
    ["Connected to Someones-Mac-mini.local.", "a private host name"],
    ["mini.local:6767", "a private host name"],
    ["mail a.person@example.com", "an email address"],
    ["token ghp_abcdefgh12", "a secret token"],
    ["gho_ABCDEFGH1234", "a secret token"],
    ["github_pat_11AAbbCCdd", "a secret token"],
    ["sk-live-abc123", "a secret token"],
    ["xoxb-12345678", "a secret token"],
    ["xoxp-9abcdefgh", "a secret token"],
  ];
  for (const [text, reason] of hits) {
    assert.equal(noPersonal(text), false, text);
    assert.equal(personalMatch(text), reason, text);
  }
  for (const text of [
    "Finish the task-list first",
    "Loads config.local.json",
    "Local copy of the website",
    "The risk-free option",
    "Users and volumes",
    "Ask on Discord",
    "desk-top",
    "sk-learn",
    "ghp_short",
  ])
    assert.equal(personalMatch(text), null, text);
  for (const value of [undefined, 42, null]) assert.equal(noPersonal(value), true);
});

// CONTRACTS v1.5 §1a: the token pattern is anchored and needs a token body. Every implementation keeps this phrase.
test("regression: low-risk-first is plain text, not a token", () => {
  assert.equal(personalMatch("A low-risk-first rollout"), null);
  assert.equal(noPersonal("low-risk-first"), true);
  assert.equal(noPersonal("desk-based, risk-averse and task-scoped"), true);
});

test("plainLanguageCheck passes a CEO sentence and names every kind of problem", () => {
  assert.deepEqual(
    plainLanguageCheck(
      "Like adding a practice copy of the website where changes are tried before customers see them.",
    ),
    [],
  );
  assert.deepEqual(
    plainLanguageCheck(`Decided in decision:${U}.`),
    ["a reference id"],
    "a ref is reported once, not also as an id",
  );
  assert.deepEqual(plainLanguageCheck(`Session ${V} stopped`), ["an id"]);
  assert.deepEqual(plainLanguageCheck("Fixed in 34097db yesterday"), ["a hash"]);
  for (const text of [
    "See src/control/grant-file.mjs",
    "Open ./docs/notes",
    "Edit admission-guard.mjs",
  ])
    assert.deepEqual(plainLanguageCheck(text), ["a file path"], text);
  for (const text of [
    "Call `role_decision_ask` now",
    "It runs parseRef() on it",
    "Uses role_decision_ask",
  ])
    assert.deepEqual(plainLanguageCheck(text), ["code formatting"], text);
  for (const text of [
    "Available 24/7",
    "Yes and/or no",
    "Released in 2026",
    "We had 1234567 visits",
    "A faded label",
    "Node.js is fine",
    "An iPhone app",
    "A low-risk-first plan",
  ])
    assert.deepEqual(plainLanguageCheck(text), [], text);
  for (const value of [undefined, "", 7]) assert.deepEqual(plainLanguageCheck(value), []);
});

test("JARGON is the seeded list and matches whole words, acronyms only in capitals", () => {
  assert.deepEqual(
    [...JARGON],
    [
      "IR",
      "RPC",
      "journal",
      "seat generation",
      "digest",
      "webhook",
      "OAuth",
      "PKCE",
      "Kubernetes",
      "recipe",
      "schema",
      "worktree",
      "idempotent",
      "blast radius",
    ],
  );
  const jargon = (text: string) =>
    plainLanguageCheck(text)
      .filter((p) => p.startsWith("the technical term"))
      .map((p) => p.slice(20, -1));
  assert.deepEqual(jargon("The IR changed and two RPCs failed"), ["IR", "RPC"]);
  assert.deepEqual(jargon("Check the Journal, the webhooks and the blast  radius"), [
    "journal",
    "webhook",
    "blast radius",
  ]);
  assert.deepEqual(jargon("Sign in with oauth and PKCE"), ["OAuth", "PKCE"]);
  assert.deepEqual(jargon("The seat generation moved; each worktree is idempotent"), [
    "seat generation",
    "worktree",
    "idempotent",
  ]);
  assert.deepEqual(
    jargon("Their IRS form, an irate user, a journalist and a digestive biscuit"),
    [],
    "no partial words, acronyms only in capitals",
  );
});

test("sentenceCount counts sentences as a reader does", () => {
  assert.deepEqual(
    ["One. Two. Three.", "One. Two. Three. Four.", "Use it e.g. the website.", "", "No stop"].map(
      sentenceCount,
    ),
    [3, 4, 1, 0, 1],
  );
});

// CONTRACTS v1.9 (J0-1): the four rules R-A found the two implementations disagreeing on, decided once.
test("v1.9: issue refs have no '#', archmap names may contain dots, '.' segments are refused, hosts are whole names", () => {
  assert.equal(isRef("issue:github:123456:42"), true);
  assert.equal(isRef("issue:github:acme/app:#42"), false);
  assert.equal(isRef(`archmap:github:acme/app@${SHA}:Core.map`), true);
  assert.equal(isRef(`archmap:github:acme/app@${SHA}:.hidden`), false);
  for (const bad of [
    "repo:github:acme/./app",
    "repo:github:acme//app",
    "file:github:acme/app:src/./a.ts",
    "file:github:acme/app:src//a.ts",
    "file:github:acme/app:src/../a.ts",
  ])
    assert.equal(isRef(bad), false, bad);
  for (const text of [
    "Edit config.local.json first",
    "Open notes.ts.net.md",
    "The settings.local.yaml file",
  ])
    assert.equal(personalMatch(text), null, text);
  for (const text of [
    "the build-box.local host",
    "reach mini.tail1234.ts.net now",
    "at mini.local.",
  ])
    assert.equal(personalMatch(text), "a private host name", text);
});
