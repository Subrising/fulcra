// Fulcra J4: commit provenance (CONTRACTS §2.2) on a temporary git repository with trailers, branches and
// ticket keys, read through the real read-only git runner. No network.
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { createGitRunner, assertGitArgs, gitCommands } from "./git.mjs";
import { scanProject, chainLinks } from "./provenance.mjs";
import { createRegistry } from "./registry.mjs";
import { createGithubConnector } from "./github.mjs";
import { createJiraConnector } from "./jira.mjs";

const P1 = "22222222-2222-4222-8222-000000000001";
const S1 = "44444444-4444-4444-8444-000000000001",
  S2 = "44444444-4444-4444-8444-000000000002",
  S3 = "44444444-4444-4444-8444-000000000003";
const T1 = "33333333-3333-4333-8333-000000000001",
  T2 = "33333333-3333-4333-8333-000000000002";
const UNKNOWN = "99999999-9999-4999-8999-000000000009";
const NOW = Date.now(),
  H = 3600000;
const registry = createRegistry([createGithubConnector(), createJiraConnector({ id: "jira" })]);
const MAPPING = { connector: "github", remoteId: "123456", remoteName: "acme/app", site: null };
function repo(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-j4-prov-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const job = path.join(root, "job-a"),
    work = path.join(job, "control");
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(path.join(root, "job-b"));
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  const git = (args, at) =>
    execFileSync(
      "/usr/bin/git",
      [
        "-C",
        work,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      {
        env: {
          ...env,
          ...(at
            ? {
                GIT_AUTHOR_DATE: new Date(at).toISOString(),
                GIT_COMMITTER_DATE: new Date(at).toISOString(),
              }
            : {}),
        },
        encoding: "utf8",
      },
    );
  const commit = (message, at) => {
    git(["commit", "--allow-empty", "-q", "-m", message], at);
    return git(["rev-parse", "HEAD"]).trim();
  };
  git(["init", "-q", "-b", "main"]);
  git(["remote", "add", "origin", "https://github.com/acme/app.git"]);
  const base = commit("Base of the project", NOW - 6 * 24 * H);
  git(["checkout", "-q", "-b", "cc/j4-trackers"]);
  const shas = {
    base,
    trailers: commit(
      `Add the sign-in check\n\nFulcra-Task: ${T1}\nFulcra-Session: ${S1}`,
      NOW - 1 * H,
    ),
    mismatched: commit(`Tidy the list\n\nFulcra-Session: ${UNKNOWN}`, NOW - 0.8 * H),
    outside: commit(`Older work on the branch\n\nFulcra-Task: ${UNKNOWN}`, NOW - 5 * 24 * H),
    ticket: commit("Handle the expired sign-in case from #42", NOW - 0.5 * H),
  };
  return { root, job, work, shas };
}
const byTriple = (links) =>
  Object.fromEntries(
    links.map((l) => [`${l.from} ${l.relation} ${l.to}`, `${l.provenance}/${l.confidence}`]),
  );
const commit = (sha) => `commit:github:acme/app@${sha}`;

test("V1: trailers, folder and time window, branch and ticket keys each give the contract provenance", async (t) => {
  const { root, job, shas } = repo(t);
  const sessions = [
    { id: S1, task: T1, cwd: job },
    { id: S2, task: T2, cwd: path.join(root, "job-b") },
  ];
  const windows = new Map([
    [S1, { from: NOW - 2 * H, to: NOW }],
    [S2, { from: NOW - 2 * H, to: NOW }],
  ]);
  const r = await scanProject({
    projectId: P1,
    sessions,
    knownSessions: new Set([S1, S2]),
    knownTasks: new Set([T1, T2]),
    windows,
    mappings: [MAPPING],
    registry,
    git: createGitRunner(),
    fs: fsp,
  });
  assert.equal(r.repositories, 1);
  assert.deepEqual(byTriple(r.links), {
    [`session:${S1} produced ${commit(shas.trailers)}`]: "reported/high",
    [`task:${T1} produced ${commit(shas.trailers)}`]: "reported/high",
    // The trailer names no known session, so it counts as absent: the folder and window decide.
    [`session:${S1} produced ${commit(shas.mismatched)}`]: "inferred/high",
    [`task:${T1} produced ${commit(shas.mismatched)}`]: "inferred/medium",
    // Outside the session's window, with an unknown task trailer: only the branch maps it to the task.
    [`task:${T1} produced ${commit(shas.outside)}`]: "inferred/medium",
    [`session:${S1} produced ${commit(shas.ticket)}`]: "inferred/high",
    [`task:${T1} produced ${commit(shas.ticket)}`]: "inferred/medium",
    [`issue:github:123456:42 worked-by session:${S1}`]: "inferred/medium",
    [`issue:github:123456:42 worked-by task:${T1}`]: "inferred/medium",
  });
  assert.equal(
    r.links.some((l) => l.to.endsWith(shas.base)),
    false,
    "a commit on main outside every window is not attributed",
  );
  assert.equal(JSON.stringify(r.links).includes(root), false, "no local path is ever stored");
});

test("V2: without a window, or with two sessions in one folder, a commit is never high", async (t) => {
  const { job, shas } = repo(t);
  const known = {
    knownSessions: new Set([S1, S3]),
    knownTasks: new Set([T1]),
    mappings: [MAPPING],
    registry,
    git: createGitRunner(),
    fs: fsp,
  };
  const noWindow = await scanProject({
    projectId: P1,
    sessions: [{ id: S1, task: T1, cwd: job }],
    windows: new Map(),
    ...known,
  });
  assert.equal(
    byTriple(noWindow.links)[`session:${S1} produced ${commit(shas.ticket)}`],
    undefined,
  );
  const shared = await scanProject({
    projectId: P1,
    sessions: [
      { id: S1, task: T1, cwd: job },
      { id: S3, task: T1, cwd: job },
    ],
    windows: new Map([
      [S1, { from: NOW - 2 * H, to: NOW }],
      [S3, { from: NOW - 2 * H, to: NOW }],
    ]),
    ...known,
  });
  assert.equal(byTriple(shared.links)[`session:${S1} produced ${commit(shas.ticket)}`], undefined);
  assert.equal(
    byTriple(shared.links)[`session:${S1} produced ${commit(shas.trailers)}`],
    "reported/high",
    "a trailer still decides",
  );
  // An unmapped repository gets a local key under the project.
  const local = await scanProject({
    projectId: P1,
    sessions: [{ id: S1, task: T1, cwd: job }],
    windows: new Map(),
    ...known,
    mappings: [],
  });
  assert.ok(
    local.links.every(
      (l) => !l.to.startsWith("commit:") || l.to.startsWith(`commit:local:${P1}/control@`),
    ),
  );
});

test("V3: a pull request is worked by the producers of its commits", async (t) => {
  const { job, shas } = repo(t);
  const r = await scanProject({
    projectId: P1,
    sessions: [{ id: S1, task: T1, cwd: job }],
    knownSessions: new Set([S1]),
    knownTasks: new Set([T1]),
    windows: new Map([[S1, { from: NOW - 2 * H, to: NOW }]]),
    mappings: [MAPPING],
    registry,
    git: createGitRunner(),
    fs: fsp,
  });
  const chained = chainLinks(
    "pr:github:acme/app#17",
    [commit(shas.trailers), commit(shas.ticket), commit("f".repeat(40))],
    r.producersByCommit,
  );
  assert.deepEqual(byTriple(chained), {
    [`pr:github:acme/app#17 worked-by session:${S1}`]: "inferred/high",
    [`pr:github:acme/app#17 worked-by task:${T1}`]: "inferred/high",
  });
});

test("V4: git runs only the read-only templates", () => {
  for (const args of [
    ["fetch"],
    ["checkout", "main"],
    ["log", "--format=%H", "HEAD"],
    [...gitCommands.log(), "--output=/tmp/x"],
    gitCommands.unique("main;rm"),
    ["config", "core.hooksPath"],
  ]) {
    assert.throws(() => assertGitArgs("/repo", args), /Refused git command/, args.join(" "));
  }
  assert.throws(() => assertGitArgs("relative/dir", gitCommands.log()), /Refused/);
  const argv = assertGitArgs("/repo", gitCommands.unique("cc/j4-trackers"));
  assert.deepEqual(argv.slice(0, 9), [
    "-C",
    "/repo",
    "--no-optional-locks",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "log.showSignature=false",
  ]);
});

test("V-J: a Jira project has no repository, so its ticket keys in any repository's commits and branch link the ticket", async (t) => {
  const { job, work } = repo(t);
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: job,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  const git = (args) =>
    execFileSync(
      "/usr/bin/git",
      [
        "-C",
        work,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { env, encoding: "utf8" },
    );
  git(["checkout", "-q", "-b", "feature/ACME-7-retry"]);
  git([
    "commit",
    "--allow-empty",
    "-q",
    "-m",
    `ACME-12 retry the sign-in, not OTHER-3\n\nFulcra-Session: ${S1}`,
  ]);
  const JIRA = {
    connector: "jira",
    remoteId: "10001",
    remoteName: "ACME",
    site: "acme.atlassian.net",
  };
  const r = await scanProject({
    projectId: P1,
    sessions: [{ id: S1, task: T1, cwd: job }],
    knownSessions: new Set([S1]),
    knownTasks: new Set([T1]),
    windows: new Map(),
    mappings: [JIRA],
    registry,
    git: createGitRunner(),
    fs: fsp,
  });
  const links = byTriple(r.links);
  assert.equal(
    links[`issue:jira@acme.atlassian.net:10001:ACME-12 worked-by session:${S1}`],
    "inferred/medium",
    "the commit subject",
  );
  assert.equal(
    links[`issue:jira@acme.atlassian.net:10001:ACME-7 worked-by session:${S1}`],
    "inferred/medium",
    "the branch name",
  );
  assert.equal(
    Object.keys(links).some((k) => k.includes("OTHER-3")),
    false,
    "a key of an unmapped project is not a link",
  );
  // With no mapped GitHub repository, the commit keeps a local repository key; the Jira keys still count.
  assert.ok(
    Object.keys(links).some((k) => k.startsWith(`session:${S1} produced commit:local:${P1}/`)),
  );
});

test("R-E-7 and R-E-8: a branch ticket key speaks only for the branch's own commits; keys in a commit body count", async (t) => {
  const { job, work, shas } = repo(t);
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: job,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  const git = (args) =>
    execFileSync(
      "/usr/bin/git",
      [
        "-C",
        work,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { env, encoding: "utf8" },
    );
  // A branch named for ACME-99 on top of cc/j4-trackers, whose commits S1 made with trailers.
  git(["checkout", "-q", "-b", "feature/ACME-99-retry"]);
  git([
    "commit",
    "--allow-empty",
    "-q",
    "-m",
    `Retry the sign-in\n\nAlso tidies what ACME-5 asked for.\n\nFulcra-Session: ${S2}`,
  ]);
  const own = git(["rev-parse", "HEAD"]).trim();
  const JIRA = {
    connector: "jira",
    remoteId: "10001",
    remoteName: "ACME",
    site: "acme.atlassian.net",
  };
  const r = await scanProject({
    projectId: P1,
    sessions: [{ id: S1, task: T1, cwd: job }],
    knownSessions: new Set([S1, S2]),
    knownTasks: new Set([T1]),
    windows: new Map(),
    mappings: [JIRA],
    registry,
    git: createGitRunner(),
    fs: fsp,
  });
  const links = byTriple(r.links),
    key = (n) => `issue:jira@acme.atlassian.net:10001:ACME-${n}`;
  assert.equal(
    links[`${key(99)} worked-by session:${S2}`],
    "inferred/medium",
    "the branch's own commit",
  );
  assert.equal(
    links[`${key(5)} worked-by session:${S2}`],
    "inferred/medium",
    "a key in the commit body (R-E-8)",
  );
  assert.equal(
    links[`${key(99)} worked-by session:${S1}`],
    undefined,
    "S1 committed before the branch existed (R-E-7)",
  );
  assert(shas.trailers && own);
});
