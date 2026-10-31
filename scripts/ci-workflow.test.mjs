import assert from "node:assert/strict";
<<<<<<< HEAD
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, matchesGlob } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { relative as relativePath } from "node:path";
import test from "node:test";
import { stripTypeScriptTypes } from "node:module";
import { requiresFullSuite } from "./ci-shared-changes.mjs";
import { selectPassedCI } from "../.github/scripts/ci-check.mjs";
import { proveMerge, complete } from "../.github/scripts/ci-finished.mjs";
import { balanceTests, testListPath, BROWSER_SHARDS } from "../.github/scripts/browser-shards.mjs";
import { QUARANTINED_BROWSER_TESTS } from "../.github/scripts/browser-quarantine.mjs";
import { startStaticWeb } from "../.github/scripts/static-e2e-web.mjs";
import { browserInputPaths } from "../.github/scripts/browser-inputs.mjs";
import { watchOperation } from "../.github/scripts/watch-ci.mjs";
import { runInNewContext } from "node:vm";

test("costly Linux checks reuse preparation and still run when browsers are not selected", () => {
  const jobs = jobBlocks(readFileSync(ciWorkflowPath, "utf8"));
  for (const name of [
    "typecheck",
    "server-tests-ubuntu",
    "server-tests-ubuntu-2",
    "desktop-tests-ubuntu",
    "desktop-renderer",
    "desktop-renderer-2",
    "app-tests",
    "sdk-tests",
    "relay-grant-e2e",
    "cli-tests-1",
    "cli-tests-2",
    "cli-tests-3",
    "cli-source-tests",
  ]) {
    const source = jobs.get(name).join("\n");
    assert.match(source, /needs: \[changes, browser-prepare\]/, name);
    const expression = source.match(/^    if: \$\{\{ (.+) \}\}$/m)[1];
    assert.ok(expression.startsWith("!cancelled()"), name);
    const evaluate = (selected, cancelled, result) =>
      runInNewContext(expression, {
        cancelled: () => cancelled,
        needs: {
          changes: {
            outputs: new Proxy(
              { full: selected ? "true" : "false" },
              {
                get: (outputs, key) => outputs[key] ?? "false",
              },
            ),
          },
          "browser-prepare": { result },
        },
      });
    for (const result of ["success", "skipped"]) {
      assert.equal(evaluate(true, false, result), true, `${name}: ${result}`);
      assert.equal(evaluate(false, false, result), false, name);
      assert.equal(evaluate(true, true, result), false, name);
    }
    if (source.includes("key: build-v2-")) {
      assert.match(source, /key: build-v2-.*-node22-server-/, name);
      assert.match(source, /run: npm run build:server\n/, name);
      assert.doesNotMatch(source, /-node22-(server-deps|app-deps)-/, name);
    }
  }
  assert.match(
    jobs.get("app-tests").join("\n"),
    /Build audio types\n\s+run: npm run build --workspace=@getpaseo\/expo-two-way-audio/,
  );
});

test("both parallel browser build exits remain required", () => {
  const source = readFileSync(ciWorkflowPath, "utf8");
  const waits = source.slice(
    source.indexOf("          daemon_status=0;"),
    source.indexOf("          npm run test:e2e --workspace=@getpaseo/app -- --list"),
  );
  assert.ok(waits.includes("wait"));
  for (const [daemon, web] of [
    [0, 0],
    [7, 0],
    [0, 8],
    [7, 8],
  ]) {
    const script = `(exit ${daemon}) & daemon_pid=$!\n(exit ${web}) & web_pid=$!\n${waits}\necho BUILDS_PASSED`;
    const result = spawnSync("bash", ["-e", "-c", script], { encoding: "utf8" });
    assert.equal(result.status, daemon || web ? 1 : 0);
    assert.equal(result.stdout.includes("BUILDS_PASSED"), !daemon && !web);
  }
});

test("clean browser packaging omits absent optional plugins and requires tested inputs", () => {
  const root = mkdtempSync(join(tmpdir(), "browser-inputs-"));
  try {
    for (const file of [
      "packages/app/.e2e-web/index.html",
      "packages/app/.e2e-plan/manifest.json",
      "packages/server/dist/scripts/supervisor-entrypoint.js",
      "packages/cli/dist/index.js",
    ]) {
      mkdirSync(join(root, file, ".."), { recursive: true });
      writeFileSync(join(root, file), "fixture");
    }
    const paths = browserInputPaths(root);
    assert.ok(paths.includes("packages/server/dist"));
    assert.ok(paths.includes("packages/app/.e2e-web"));
    assert.ok(!paths.includes("plugins/dist"));
    assert.equal(
      spawnSync("tar", ["-czf", join(root, "inputs.tgz"), "-C", root, ...paths]).status,
      0,
    );
    mkdirSync(join(root, "plugins/dist"), { recursive: true });
    assert.ok(browserInputPaths(root).includes("plugins/dist"));
    rmSync(join(root, "packages/server/dist"), { recursive: true });
    assert.throws(() => browserInputPaths(root), /Missing browser input/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prebuilt browser clients bypass Playwright transpilation while test source stays transformed", () => {
  // The changes job runs before npm install. Evaluate the actual config with Node only.
  const source = stripTypeScriptTypes(
    readFileSync(new URL("packages/app/playwright.config.ts", repoRoot), "utf8"),
  )
    .replace(/^import .+ from .+;$/gm, "")
    .replace("export default defineConfig(", "configuration = defineConfig(");
  const config = runInNewContext(source, {
    defineConfig: (value) => value,
    devices: { "Desktop Chrome": {} },
    process: { env: {} },
    configuration: null,
  });
  const external = config.build?.external ?? [];
  for (const workspace of ["client", "protocol", "relay", "server"]) {
    assert.ok(
      external.some((pattern) =>
        matchesGlob(`/checkout/packages/${workspace}/dist/index.js`, pattern),
      ),
      `${workspace} build must use the native loader`,
    );
  }
  for (const file of [
    "/checkout/packages/client/src/daemon-client.ts",
    "/checkout/packages/app/e2e/support/fixtures.ts",
  ]) {
    assert.equal(
      external.some((pattern) => matchesGlob(file, pattern)),
      false,
      file,
    );
  }
});

test("main CI ignores a refused merge dispatch and retains CI failure detection", () => {
  const result = spawnSync("python3", ["-B", ".github/scripts/test_main_ci_state.py"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("outbound watcher sends one native notice for successful and failed runs", async () => {
  for (const conclusion of ["success", "failure", "cancelled", "timed_out"]) {
    const operation = {
      runId: 123,
      attempt: 1,
      headSha: "a".repeat(40),
      workflow: ".github/workflows/ci.yml",
      owner: "owner",
      url: "https://github.com/Subrising/fulcra/actions/runs/123",
      notice: "none",
    };
    const delivered = [],
      states = [];
    const ports = {
      wait: async (id) => assert.equal(id, 123),
      read: async () => ({
        repository: { full_name: "Subrising/fulcra" },
        id: 123,
        run_attempt: 1,
        head_sha: operation.headSha,
        path: operation.workflow,
        status: "completed",
        name: "CI",
        conclusion,
      }),
      deliver: async (owner, text) => {
        assert.equal(states.at(-1), "attempted");
        delivered.push({ owner, text });
      },
      persist: async (state) => states.push(state.notice),
    };
    await watchOperation(operation, ports);
    assert.deepEqual(states, ["attempted", "accepted"]);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].owner, "owner");
    assert.match(delivered[0].text, conclusion === "success" ? /^PASS:/ : /^FAIL:/);
    assert.ok(delivered[0].text.includes(operation.url));
    await assert.rejects(watchOperation(operation, ports), /Reconcile/);
    assert.equal(delivered.length, 1);
  }
});

test("outbound watcher reports stale completion and never retries an uncertain notice", async () => {
  const operation = {
    runId: 123,
    attempt: 1,
    headSha: "a".repeat(40),
    workflow: ".github/workflows/ci.yml",
    owner: "owner",
    url: "https://github.com/Subrising/fulcra/actions/runs/123",
    notice: "none",
  };
  const messages = [];
  const ports = {
    wait: async () => {},
    read: async () => ({ repository: { full_name: "another/repo" } }),
    persist: async () => {},
    deliver: async (_owner, text) => {
      messages.push(text);
      throw new Error("Receipt uncertain");
    },
  };
  await assert.rejects(watchOperation(operation, ports), /Receipt uncertain/);
  assert.match(messages[0], /^BLOCKED:/);
  assert.equal(operation.notice, "attempted");
  await assert.rejects(watchOperation(operation, ports), /Reconcile/);
  assert.equal(messages.length, 1);
});

test("an annotation timeout resumes the same native wait without an intermediate notice", async () => {
  const operation = {
    runId: 123,
    attempt: 1,
    headSha: "a".repeat(40),
    workflow: ".github/workflows/ci.yml",
    owner: "owner",
    url: "https://github.com/Subrising/fulcra/actions/runs/123",
    notice: "none",
  };
  let waits = 0;
  const notices = [],
    states = [];
  await watchOperation(operation, {
    wait: async (id) => {
      assert.equal(id, 123);
      waits++;
    },
    read: async () => ({
      repository: { full_name: "Subrising/fulcra" },
      id: 123,
      run_attempt: 1,
      head_sha: operation.headSha,
      path: operation.workflow,
      status: waits === 1 ? "in_progress" : "completed",
      conclusion: waits === 1 ? null : "success",
    }),
    persist: async (value) => states.push(value.notice),
    deliver: async (_owner, text) => notices.push(text),
  });
  assert.equal(waits, 2);
  assert.deepEqual(states, ["attempted", "accepted"]);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /^PASS:/);
});

test("shared dependencies and unknown root files run the full suite", () => {
  for (const path of [
    "package.json",
    "new.config",
    "scripts/check.mjs",
    "control/src/config.mjs",
    "packages/protocol/src/messages.ts",
    "packages/client/src/client.ts",
    "packages/new-package/index.ts",
    "skills/verify/SKILL.md",
  ]) {
    assert.equal(requiresFullSuite([path]), true, path);
  }
  for (const path of [
    "packages/app/src/index.tsx",
    "packages/server/src/server/session.ts",
    "packages/cli/src/index.ts",
    "docs/testing.md",
    "README.md",
  ]) {
    assert.equal(requiresFullSuite([path]), false, path);
  }
});

function browserRouting(paths) {
  const filters = loadFilters(filtersPath);
  const outputs = Object.fromEntries(
    ["routing", "workspace", "ci", "browser"].map((name) => [
      name,
      paths.some((path) => filters[name].some((pattern) => matchesGlob(path, pattern)))
        ? "true"
        : "false",
    ]),
  );
  const changes = jobBlocks(readFileSync(ciWorkflowPath, "utf8")).get("changes").join("\n");
  const context = {
    github: { event_name: "pull_request" },
    steps: {
      filter: { outputs },
      shared: { outputs: { full: String(requiresFullSuite(paths)) } },
    },
  };
  const evaluate = (name) =>
    runInNewContext(
      changes.match(new RegExp(`^      ${name}: \\$\\{\\{ (.+) \\}\\}$`, "m"))[1],
      context,
    );
  return { full: evaluate("full"), browser: evaluate("browser"), filter: outputs };
}

function requireBrowserJobs(path) {
  const routing = browserRouting([path]);
  const jobs = jobBlocks(readFileSync(ciWorkflowPath, "utf8"));
  for (const name of [
    "browser-prepare",
    "browser-recovery",
    ...Array.from({ length: BROWSER_SHARDS }, (_, index) => `playwright-${index + 1}`),
  ]) {
    const expression = jobs
      .get(name)
      .join("\n")
      .match(/^    if: \$\{\{ (.+) \}\}$/m)[1]
      .replaceAll("needs.browser-prepare", 'needs["browser-prepare"]');
    const selected = runInNewContext(expression, {
      cancelled: () => false,
      needs: {
        changes: {
          result: "success",
          outputs: { full: String(routing.full), browser: String(routing.browser) },
        },
        "browser-prepare": { result: "success" },
      },
    });
    assert.equal(selected, true, `${path}: ${name} must run`);
  }
  return routing;
}

test("M1: shared and root changes retain every browser job", () => {
  assert.equal(browserRouting(["docs/testing.md"]).browser, false);
  assert.equal(browserRouting(["README.md"]).browser, false);
  for (const path of [
    "package-lock.json",
    "package.json",
    "packages/protocol/src/messages.ts",
    "packages/client/src/index.ts",
    "packages/plugin/src/index.ts",
    "packages/server/src/server/session.ts",
    "packages/server/src/server/agent/providers/mock-load-test-agent.ts",
    "scripts/build-server.mjs",
    "unknown.config",
    ".github/actions/ci-deps/action.yml",
    ".github/workflows/ci.yml",
  ]) {
    requireBrowserJobs(path);
  }
});

test("M2: CI scripts and timing data select their real browser consumers", () => {
  for (const path of [
    ".github/scripts/run-browser-ci.mjs",
    ".github/scripts/browser-shards.mjs",
    ".github/scripts/browser-ci-reporter.mjs",
    ".github/scripts/browser-inputs.mjs",
    ".github/scripts/static-e2e-web.mjs",
    ".github/scripts/export-browser-web.sh",
    ".github/scripts/ci-built-cli.mjs",
    ".github/scripts/install-cache-inputs.mjs",
    ".github/browser-test-times.json",
  ]) {
    const routing = requireBrowserJobs(path);
    assert.equal(routing.filter.ci, "true", path);
    assert.equal(routing.full, true, path);
  }
});

test("L2: moving a shared file into app keeps the full fallback", () => {
  const root = mkdtempSync(join(tmpdir(), "ci-rename-routing-"));
  try {
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "Fulcra",
      GIT_AUTHOR_EMAIL: "fulcra@users.noreply.github.com",
      GIT_COMMITTER_NAME: "Fulcra",
      GIT_COMMITTER_EMAIL: "fulcra@users.noreply.github.com",
    };
    const git = (...args) => execFileSync("git", args, { cwd: root, env, encoding: "utf8" }).trim();
    git("init", "--initial-branch=main");
    mkdirSync(join(root, "packages/protocol/src"), { recursive: true });
    mkdirSync(join(root, "packages/app/src"), { recursive: true });
    writeFileSync(join(root, "packages/protocol/src/moved.ts"), "export const fixture = true;\n");
    git("add", ".");
    const base = git("commit-tree", git("write-tree"), "-m", "Shared source fixture");
    renameSync(
      join(root, "packages/protocol/src/moved.ts"),
      join(root, "packages/app/src/moved.ts"),
    );
    git("add", "-A");
    const head = git(
      "commit-tree",
      git("write-tree"),
      "-p",
      base,
      "-m",
      "Move shared source fixture",
    );
    const output = join(root, "outputs");
    const result = spawnSync(
      process.execPath,
      [new URL("scripts/ci-shared-changes.mjs", repoRoot).pathname],
      {
        cwd: root,
        env: { ...env, EVENT: "pull_request", BASE: base, HEAD: head, GITHUB_OUTPUT: output },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(output, "utf8"), /full=true/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("every new shard and desktop lane remains failure-sensitive", () => {
  const source = readFileSync(ciWorkflowPath, "utf8");
  const jobs = jobBlocks(source);
  const gate = jobs.get("ci-passed").join("\n");
  for (const name of [
    "desktop-renderer",
    "desktop-renderer-2",
    "server-tests-ubuntu-2",
    "cli-source-tests",
    "browser-prepare",
    "browser-recovery",
    ...Array.from({ length: BROWSER_SHARDS }, (_, i) => `playwright-${i + 1}`),
  ]) {
    assert.ok(jobs.has(name), name);
    assert.ok(gate.includes(`- ${name}\n`), name);
  }
  assert.match(source, /schedule:\s*\n\s+- cron:/);
  assert.match(source, /tags: \["v\*"\]/);
  assert.doesNotMatch(source.split("jobs:")[0], /push:\s*\n\s+branches:/);
  assert.ok(
    source
      .split("\n")
      .filter((line) => line.includes("restore-keys:"))
      .every((line) => line.includes("browser-failed-") || line.includes("metro-web-v1-")),
  );
  assert.match(source, /steps\.shared\.outputs\.full != 'false'/);
});

test("L5: the web cache key is captured before restored build outputs exist", () => {
  const source = jobBlocks(readFileSync(ciWorkflowPath, "utf8")).get("browser-prepare").join("\n");
  assert.ok(
    source.indexOf("WEB_SOURCE_HASH:") < source.indexOf("name: Restore exact server build"),
  );
  assert.match(source, /WEB_SOURCE_HASH:.*'!packages\/\*\/dist\/\*\*'/);
  assert.match(source, /WEB_SOURCE_HASH:.*'!plugins\/dist\/\*\*'/);
  const restore = source.slice(
    source.indexOf("name: Restore exact web export"),
    source.indexOf("name: Restore Metro transform cache"),
  );
  assert.match(restore, /key: \$\{\{ steps\.inputs\.outputs\.web_key \}\}/);
});

function proofFixture() {
  const sha = "a".repeat(40),
    merged = "b".repeat(40),
    tree = "c".repeat(40);
  const run = {
    id: 123,
    run_attempt: 1,
    path: ".github/workflows/merge-pr.yml",
    event: "workflow_dispatch",
    head_branch: "main",
    conclusion: "success",
    display_title: `Merge PR 1 at ${sha}`,
    repository: { full_name: "Subrising/fulcra" },
  };
  const data = {
    pr: {
      merged: true,
      base: { ref: "main", repo: run.repository },
      head: { sha, repo: run.repository },
      merge_commit_sha: merged,
    },
    merge: {
      parents: [{ sha: "d".repeat(40) }, { sha }],
      commit: {
        tree: { sha: tree },
        author: {
          name: "github-actions[bot]",
          email: "41898282+github-actions[bot]@users.noreply.github.com",
        },
        committer: { name: "GitHub", email: "noreply@github.com" },
      },
    },
    head: { commit: { tree: { sha: tree } } },
    checks: {
      total_count: 1,
      check_runs: [
        {
          name: "ci-passed",
          id: 100,
          app: { id: 15368 },
          head_sha: sha,
          status: "completed",
          conclusion: "success",
          details_url: "https://github.com/Subrising/fulcra/actions/runs/456/job/789",
        },
      ],
    },
    ci: {
      id: 456,
      run_attempt: 1,
      status: "completed",
      path: ".github/workflows/ci.yml",
      event: "pull_request",
      head_sha: sha,
      conclusion: "success",
      repository: run.repository,
      pull_requests: [{ number: 1 }],
      html_url: "https://github.com/Subrising/fulcra/actions/runs/456",
    },
  };
  const writes = [];
  const api = async (path, body) => {
    if (body) {
      writes.push(body);
      return {};
    }
    if (path === "/pulls/1") return data.pr;
    if (path === `/commits/${sha}`) return data.head;
    if (path === `/commits/${merged}`) return data.merge;
    if (path.startsWith(`/commits/${sha}/check-runs`)) return data.checks;
    if (path.startsWith(`/commits/${merged}/check-runs`))
      return { check_runs: writes.map((write) => ({ ...write, app: { id: 15368 } })) };
    if (path === "/actions/runs/456") return data.ci;
    throw new Error(`Unexpected API route ${path}`);
  };
  return { run, data, api, writes };
}

test("tested-tree proof retains successful CI provenance beside a cancelled run", async () => {
  const fixture = proofFixture();
  fixture.data.checks.check_runs.push({
    ...fixture.data.checks.check_runs[0],
    id: 101,
    conclusion: "cancelled",
    details_url: "https://github.com/Subrising/fulcra/actions/runs/999/job/123",
  });
  fixture.data.checks.total_count = 2;
  const proof = await proveMerge(fixture.run, fixture.api);
  assert.equal(proof.ciRunId, 456);
  assert.equal(proof.ciAttempt, 1);
});

test("merge proof refuses changed trees, identities, workflows and stale checks", async () => {
  const good = proofFixture();
  assert.equal((await proveMerge(good.run, good.api)).number, 1);
  for (const mutate of [
    (f) => (f.data.head.commit.tree.sha = "e".repeat(40)),
    (f) => (f.data.pr.head.sha = "e".repeat(40)),
    (f) => (f.data.pr.base.ref = "other"),
    (f) => f.data.merge.parents.pop(),
    (f) => (f.data.merge.commit.author.name = "account"),
    (f) => (f.data.checks.check_runs[0].conclusion = "failure"),
    (f) => (f.data.checks.check_runs[0].app.id = 1),
    (f) => f.data.checks.check_runs.push(f.data.checks.check_runs[0]),
    (f) => (f.data.ci.path = ".github/workflows/other.yml"),
    (f) => (f.data.ci.event = "push"),
    (f) => (f.data.ci.id = 999),
    (f) => (f.data.ci.run_attempt = 0),
    (f) => (f.data.ci.status = "in_progress"),
    (f) => (f.run.event = "pull_request"),
    (f) => (f.run.display_title = "Merge PR 1 at invalid"),
  ]) {
    const f = proofFixture();
    mutate(f);
    await assert.rejects(proveMerge(f.run, f.api));
    assert.equal(f.writes.length, 0);
  }
});

test("completion reconciles its merge gate and sends one keyed notice per invocation", async () => {
  const f = proofFixture(),
    notices = [];
  const event = { repository: f.run.repository, workflow_run: f.run };
  await complete(event, f.api, async (notice) => notices.push(notice));
  await complete(event, f.api, async (notice) => notices.push(notice));
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].conclusion, "success");
  assert.equal(notices.length, 2);
  assert.equal(notices[0].eventId, notices[1].eventId);
  await assert.rejects(
    complete(event, f.api, async () => {
      throw new Error("Receiver unavailable");
    }),
  );
});

test("bot merge completion records main green without a main CI run", async () => {
  const f = proofFixture();
  const reads = [];
  await complete(
    { repository: f.run.repository, workflow_run: f.run },
    async (path, body) => {
      if (!body) reads.push(path);
      return f.api(path, body);
    },
    async () => {},
  );
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].name, "ci-passed");
  assert.equal(f.writes[0].head_sha, f.data.pr.merge_commit_sha);
  assert.equal(f.writes[0].external_id, `tested-tree:${f.data.pr.merge_commit_sha}:456:1`);
  assert.equal(f.writes[0].details_url, f.data.ci.html_url);
  assert.deepEqual(
    reads.filter((path) => path.startsWith("/actions/")),
    ["/actions/runs/456"],
  );
  const workflow = readFileSync(
    new URL("../.github/workflows/ci-finished.yml", import.meta.url),
    "utf8",
  );
  assert.match(
    workflow,
    /workflow_run:\s*\n\s+workflows: \[Merge PR\]\s*\n\s+types: \[completed\]/,
  );
  assert.doesNotMatch(workflow.split("jobs:")[0], /^\s+(push|pull_request|pull_request_target):/m);
  assert.match(workflow, /checks: write/);
  assert.match(workflow, /ref: main/);
  assert.match(workflow, /persist-credentials: false/);
});

test("M3 and L1: main proof binds the CI run and exact attempt outside the display URL", async () => {
  const f = proofFixture();
  f.data.ci.run_attempt = 2;
  await complete({ repository: f.run.repository, workflow_run: f.run }, f.api, async () => {});
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].external_id, `tested-tree:${f.data.pr.merge_commit_sha}:456:2`);
  f.writes[0].details_url = "https://github.com/Subrising/fulcra/actions/runs/123/job/999";
  await complete({ repository: f.run.repository, workflow_run: f.run }, f.api, async () => {});
  assert.equal(f.writes.length, 1, "a replaced display URL must not duplicate the bound gate");
});
=======
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { relative as relativePath } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
>>>>>>> refs/remotes/upstream/tags/v0.14.0

const repoRoot = new URL("../", import.meta.url);
const ciWorkflowPath = new URL(".github/workflows/ci.yml", repoRoot);
const dockerWorkflowPath = new URL(".github/workflows/docker.yml", repoRoot);
const filtersPath = new URL(".github/ci-paths.yml", repoRoot);
const serverTsconfigPath = new URL("packages/server/tsconfig.server.json", repoRoot);
const desktopPackagePath = new URL("packages/desktop/package.json", repoRoot);

const gatedCiJobs = new Map([
  ["quality", { name: "quality", contracts: ["format", "quality", "relay", "sdk"] }],
  ["typecheck", { name: "typecheck", contract: "quality" }],
  ["server-tests-ubuntu", { name: "server-tests (ubuntu-latest)", contracts: ["server", "hub"] }],
<<<<<<< HEAD
  ["server-tests-macos", { name: "server-tests (macos-15, file observation)", contract: "server" }],
=======
  ["server-tests-windows", { name: "server-tests (windows-latest)", contracts: ["server", "hub"] }],
  [
    "server-integration-windows",
    { name: "server-integration (windows-latest)", contract: "server" },
  ],
  ["server-tests-macos", { name: "server-tests (macos-14, file observation)", contract: "server" }],
>>>>>>> refs/remotes/upstream/tags/v0.14.0
  ["desktop-tests-ubuntu", { name: "desktop-tests (ubuntu-latest)", contract: "desktop" }],
  ["app-tests", { name: "app-tests", contract: "app" }],
<<<<<<< HEAD
  ["sdk-tests", { name: "sdk-tests", contract: "sdk" }],
  ["playwright-1", { name: "playwright (shard 1/32)", contract: "browser" }],
  ["playwright-2", { name: "playwright (shard 2/32)", contract: "browser" }],
  ["playwright-3", { name: "playwright (shard 3/32)", contract: "browser" }],
  ["playwright-4", { name: "playwright (shard 4/32)", contract: "browser" }],
  ["relay-tests", { name: "relay-tests", contract: "relay" }],
=======
  ["playwright-1", { name: "playwright (shard 1/8)", contract: "browser" }],
  ["playwright-2", { name: "playwright (shard 2/8)", contract: "browser" }],
  ["playwright-3", { name: "playwright (shard 3/8)", contract: "browser" }],
  ["playwright-4", { name: "playwright (shard 4/8)", contract: "browser" }],
  ["playwright-5", { name: "playwright (shard 5/8)", contract: "browser" }],
  ["playwright-6", { name: "playwright (shard 6/8)", contract: "browser" }],
  ["playwright-7", { name: "playwright (shard 7/8)", contract: "browser" }],
  ["playwright-8", { name: "playwright (shard 8/8)", contract: "browser" }],
>>>>>>> refs/remotes/upstream/tags/v0.14.0
  ["cli-tests-1", { name: "cli-tests (shard 1/3)", contract: "cli" }],
  ["cli-tests-2", { name: "cli-tests (shard 2/3)", contract: "cli" }],
  ["cli-tests-3", { name: "cli-tests (shard 3/3)", contract: "cli" }],
]);

function jobBlocks(source) {
  const jobs = new Map();
  let currentJob;

  for (const line of (source.split("\njobs:\n")[1] ?? source).split("\n")) {
    const jobMatch = /^  ([a-z0-9_-]+):\s*$/.exec(line);
    if (jobMatch) {
      currentJob = jobMatch[1];
      jobs.set(currentJob, []);
      continue;
    }
    if (currentJob) jobs.get(currentJob).push(line);
  }
  return jobs;
}

function loadFilters(path) {
  const filters = {};
  let currentFilter;

  for (const line of readFileSync(path, "utf8").split("\n")) {
    const filterMatch = /^([a-z_]+):\s*$/.exec(line);
    if (filterMatch) {
      currentFilter = filterMatch[1];
      filters[currentFilter] = [];
      continue;
    }
    const patternMatch = /^  - "([^"]+)"\s*$/.exec(line);
    if (currentFilter && patternMatch) filters[currentFilter].push(patternMatch[1]);
  }
  return filters;
}

function filesUnder(relativeDirectory, predicate) {
  const directory = new URL(`${relativeDirectory}/`, repoRoot);
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      [relativeDirectory, relativePath(directory.pathname, entry.parentPath), entry.name]
        .filter(Boolean)
        .join("/")
        .replaceAll("\\", "/"),
    )
    .filter(predicate)
    .sort();
}

test("gated checks are statically named jobs with real job-level gating", () => {
  const workflowSource = readFileSync(ciWorkflowPath, "utf8");
  const jobs = jobBlocks(workflowSource);
  const trigger = workflowSource.split("jobs:", 1)[0];

  assert.match(trigger, /^\s+merge_group:\s*$/m);
  assert.doesNotMatch(workflowSource, /strategy:\s*\n\s+matrix:/);
  assert.doesNotMatch(workflowSource, /RUN_TESTS|Skip unaffected|No .* changes detected/);

  for (const [jobId, expected] of gatedCiJobs) {
    const job = jobs.get(jobId)?.join("\n");
    assert.ok(job, `missing static job ${jobId}`);
    assert.match(job, new RegExp(`^    name: ${expected.name.replace(/[()]/g, "\\$&")}$`, "m"));
    if (expected.contract !== "browser")
      assert.match(job, /needs\.changes\.outputs\.full != 'false'/);
    else assert.doesNotMatch(job, /needs\.changes\.outputs\.full/);
    for (const contract of expected.contracts ?? [expected.contract]) {
      assert.match(job, new RegExp(`needs\\.changes\\.outputs\\.${contract} != 'false'`));
    }
  }
});

test("pull-request checks run for every base branch, including stacked PRs", () => {
  for (const workflowPath of [
    ciWorkflowPath,
    new URL(".github/workflows/desktop-packages.yml", repoRoot),
  ]) {
    const trigger = readFileSync(workflowPath, "utf8").split("jobs:", 1)[0];
    const pullRequest = trigger.match(/^  pull_request:\n((?:    .*\n)*)/m);
    assert.ok(pullRequest, `${workflowPath.pathname} runs on pull requests`);
    assert.doesNotMatch(pullRequest[1], /branches/);
  }
});

test("change gating allows superseded workflow runs to cancel", () => {
<<<<<<< HEAD
  for (const workflowPath of [ciWorkflowPath, dockerWorkflowPath]) {
=======
  const ci = readFileSync(ciWorkflowPath, "utf8");
  assert.match(
    ci,
    /^concurrency:\n  group: ci-\$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}\n  cancel-in-progress: true$/m,
    "a newer push to any ref, main included, cancels the superseded run",
  );
  for (const workflowPath of [ciWorkflowPath, dockerWorkflowPath, nixWorkflowPath]) {
>>>>>>> refs/remotes/upstream/tags/v0.14.0
    const source = readFileSync(workflowPath, "utf8");
    assert.doesNotMatch(
      source,
      /\$\{\{\s*always\(\)/,
      "always() keeps jobs alive after concurrency cancellation; use !cancelled() for fail-open gating",
    );
  }
});

test("focused contracts stay inside existing required checks", () => {
  const jobs = jobBlocks(readFileSync(ciWorkflowPath, "utf8"));
  const changes = jobs.get("changes")?.join("\n") ?? "";
  const server = jobs.get("server-tests-ubuntu")?.join("\n") ?? "";
  const desktop = jobs.get("desktop-tests-ubuntu")?.join("\n") ?? "";

  assert.match(changes, /scripts\/daemon-launch-contract\.test\.mjs/);
  assert.doesNotMatch(changes, /Install dependencies|npm run build/);

  assert.match(server, /test:hub-cli-contract/);
  assert.match(server, /npm run test:unit --workspace=@getpaseo\/server/);
  assert.match(server, /npm run test:integration --workspace=@getpaseo\/server/);
  // FU-90: the Command Centre plugin is packaged in CI, inside the typecheck check.
  assert.match(jobs.get("typecheck")?.join("\n") ?? "", /node scripts\/build-command-centre\.mjs/);
  assert.ok(!jobs.has("hub-cli-contract"));

  assert.match(desktop, /test:e2e:renderer/);
  assert.match(desktop, /test:e2e:browser-tabs/);
  assert.match(desktop, /npm run test --workspace=@getpaseo\/desktop/);
  assert.ok(!jobs.has("desktop-browser-bridge"));
  assert.ok(!jobs.has("playwright-desktop"));
});

test("ordinary CI keeps app tests without prebuilding Android modules", () => {
  const source = readFileSync(ciWorkflowPath, "utf8");
  const app = jobBlocks(source).get("app-tests").join("\n");
  assert.match(app, /npm run build:app-deps/);
  assert.match(app, /npm run test --workspace=@getpaseo\/app/);
  assert.doesNotMatch(source, /test:android|expo prebuild|gradlew|actions\/setup-java/);
});

test("server builds exclude test utilities at every domain depth", () => {
  const tsconfig = JSON.parse(readFileSync(serverTsconfigPath, "utf8"));
  assert.ok(tsconfig.exclude.includes("src/server/**/test-utils/**"));
  assert.ok(!tsconfig.exclude.includes("src/server/test-utils/**"));
});

test("PR routing declares stable behavior ownership", () => {
  const filters = loadFilters(filtersPath);
  assert.deepEqual(filters, {
    routing: [".github/ci-paths.yml"],
    workspace: [
      ".mise.toml",
      ".tool-versions",
      "package.json",
      "package-lock.json",
      "patches/**",
      "scripts/**",
      "tsconfig.json",
      "tsconfig.base.json",
      "vitest.config.ts",
    ],
    ci: [
      ".github/actions/**",
      ".github/workflows/ci.yml",
      ".github/scripts/**",
      ".github/browser-test-times.json",
    ],
    format: [
      ".agents/**/*.{cjs,css,html,js,json,jsonc,jsx,md,mjs,ts,tsx,yaml,yml}",
      ".github/**/*.{cjs,css,html,js,json,jsonc,jsx,md,mjs,ts,tsx,yaml,yml}",
      "**/*.{cjs,css,html,js,json,jsonc,jsx,md,mjs,ts,tsx,yaml,yml}",
      "packages/expo-two-way-audio/**",
    ],
    quality: ["**/*.{cjs,js,json,jsx,mjs,ts,tsx}", "packages/expo-two-way-audio/**"],
    hub: ["packages/cli/src/commands/hub/**", "packages/server/src/server/hub/**"],
    server: [
      "plugins/**",
      "control/**",
      "packages/server/**",
      "packages/app/e2e/support/fixtures/recording.*",
    ],
    desktop: [
      "packages/desktop/**",
      "packages/app/src/desktop/**",
<<<<<<< HEAD
      "packages/app/src/device/plugin-device.electron.ts",
      "packages/app/src/plugins/bundle-trust-policy.electron.ts",
=======
      "packages/app/src/**/*.electron.{ts,tsx}",
>>>>>>> refs/remotes/upstream/tags/v0.14.0
      "packages/server/src/server/browser-tools/**",
      "packages/app/e2e/support/**",
      "packages/app/*config.{cjs,js,ts}",
      "packages/app/package.json",
    ],
    app: ["packages/app/**", "packages/expo-two-way-audio/**"],
    sdk: [
      "packages/plugin/**",
      "plugin-examples/**",
      "public-docs/plugins/**",
      "packages/client/**",
      "packages/highlight/**",
      "packages/protocol/**",
    ],
    browser: [
      "packages/app/**",
      "packages/server/**",
      "packages/expo-two-way-audio/**",
      "control/orca-organization/client/**",
      "control/orca-organization/shared/**",
    ],
    relay: ["packages/relay/**"],
    cli: ["packages/cli/**"],
  });
});

test("cross-package invariants live in the suite that owns them", () => {
  const cliTests = filesUnder("packages/cli", (path) => path.endsWith(".test.ts"));
  assert.ok(cliTests.length > 0);
  for (const path of cliTests) {
    assert.doesNotMatch(
      readFileSync(new URL(path, repoRoot), "utf8"),
      /server\/src\/server\/test-utils/,
      path,
    );
  }

  const protocolWireCompatibility = new URL(
    "packages/protocol/src/messages.wire-compat.test.ts",
    repoRoot,
  );
  assert.match(readFileSync(protocolWireCompatibility, "utf8"), /wire schema compatibility/);
});

test("browser and desktop tests have exclusive, directory-owned suites", () => {
  const filters = loadFilters(filtersPath);
  const browserSpecs = filesUnder("packages/app/e2e", (path) => path.endsWith(".spec.ts"));
  const desktopSpecs = filesUnder("packages/desktop/e2e", (path) => path.endsWith(".spec.ts"));

  assert.ok(browserSpecs.length > 0);
  assert.ok(desktopSpecs.length > 0);
  assert.ok(browserSpecs.every((path) => path.startsWith("packages/app/e2e/browser/")));
  assert.ok(desktopSpecs.every((path) => path.startsWith("packages/desktop/e2e/")));
<<<<<<< HEAD
  const nativePolicyModules = new Set([
    "packages/app/src/device/plugin-device.electron.ts",
    "packages/app/src/plugins/bundle-trust-policy.electron.ts",
  ]);
  assert.ok(
    electronModules.every(
      (path) => path.startsWith("packages/app/src/desktop/") || nativePolicyModules.has(path),
    ),
  );
  for (const path of nativePolicyModules) {
    assert.ok(electronModules.includes(path), `missing native policy module ${path}`);
    assert.ok(filters.desktop.includes(path), `native policy module lacks desktop CI ${path}`);
  }
=======
>>>>>>> refs/remotes/upstream/tags/v0.14.0

  const desktopPackage = JSON.parse(readFileSync(desktopPackagePath, "utf8"));
  assert.match(desktopPackage.scripts.test, /--exclude ["']e2e\/\*\*["']/);

  for (const path of browserSpecs) {
    assert.doesNotMatch(
      readFileSync(new URL(path, repoRoot), "utf8"),
      /paseoDesktop|injectDesktopBridge/,
    );
  }
  for (const path of desktopSpecs) {
    assert.ok(path.startsWith("packages/desktop/e2e/"));
  }

  const routingSource = readFileSync(filtersPath, "utf8");
  assert.doesNotMatch(routingSource, /desktop_bridge|playwright_desktop|browser-\*|browser-\*\//);
  assert.deepEqual(filters.desktop, [
    "packages/desktop/**",
    "packages/app/src/desktop/**",
<<<<<<< HEAD
    "packages/app/src/device/plugin-device.electron.ts",
    "packages/app/src/plugins/bundle-trust-policy.electron.ts",
=======
    "packages/app/src/**/*.electron.{ts,tsx}",
>>>>>>> refs/remotes/upstream/tags/v0.14.0
    "packages/server/src/server/browser-tools/**",
    "packages/app/e2e/support/**",
    "packages/app/*config.{cjs,js,ts}",
    "packages/app/package.json",
  ]);
  assert.deepEqual(filters.browser, [
    "packages/app/**",
    "packages/server/**",
    "packages/expo-two-way-audio/**",
    "control/orca-organization/client/**",
    "control/orca-organization/shared/**",
  ]);
});

test("packaging runs on main without allocating pull-request runners", () => {
  for (const workflowPath of [dockerWorkflowPath]) {
    const source = readFileSync(workflowPath, "utf8");
    const trigger = source.split("jobs:", 1)[0];
    assert.match(trigger, /push:\s*\n\s+branches: \[main\]/);
    assert.doesNotMatch(trigger, /pull_request/);
    assert.doesNotMatch(source, /dorny\/paths-filter/);
  }
});

<<<<<<< HEAD
const mergeWorkflow = () =>
  readFileSync(new URL(".github/workflows/merge-pr.yml", repoRoot), "utf8");
function mergeStep(name) {
  const block = mergeWorkflow().split(`      - name: ${name}\n`)[1]?.split("\n      - ")[0];
  assert.ok(block, `missing merge step: ${name}`);
  return block
    .split("        run: |\n")[1]
    .split("\n")
    .map((line) => line.replace(/^          /, ""))
    .join("\n");
}
function executable(path, source) {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

test("merge workflow limits writes and authenticates check reads", () => {
  const source = mergeWorkflow();
  assert.match(
    source,
    /permissions:\n  contents: write\n  pull-requests: write\n  checks: read\n  actions: read\n\n/,
  );
  assert.equal((source.match(/permissions:/g) ?? []).length, 1);
  assert.match(source, /persist-credentials: false/);
  assert.match(source, /group: merge-pr-main/);
  assert.match(mergeStep("Check the PR, tested SHA, and merge title"), /gh api .*check-runs/);
  assert.doesNotMatch(source, /curl/);
  assert.ok(
    source.indexOf("- name: Check candidate commit identities") <
      source.indexOf("- name: Merge with the workflow token"),
  );
  assert.ok(
    source.indexOf("- name: Scan candidate commit metadata") <
      source.indexOf("- name: Merge with the workflow token"),
  );
  assert.match(mergeStep("Scan candidate commit metadata"), /--commits "origin\/main\.\.\$SHA"/);
  assert.match(
    mergeStep("Scan the merge commit and source"),
    /node "\$RUNNER_TEMP\/check-machine-data.mjs" --commits "\$MERGED\^1\.\.\$MERGED"/,
  );
});

test("merge workflow rejects unsafe callers, PRs, CI results, and identities", () => {
  const root = mkdtempSync(join(tmpdir(), "fulcra-merge-test-"));
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, ".github", "scripts"), { recursive: true });
    writeFileSync(
      join(root, ".github", "scripts", "ci-check.mjs"),
      readFileSync(new URL(".github/scripts/ci-check.mjs", repoRoot)),
    );
    writeFileSync(
      join(root, "scripts/check-machine-data.mjs"),
      readFileSync(new URL("scripts/check-machine-data.mjs", repoRoot)),
    );
    const fixture = join(root, "fixture.json");
    const calls = join(root, "calls.jsonl");
    executable(
      join(bin, "gh"),
      `#!/usr/bin/env node
const fs=require('node:fs'); const f=JSON.parse(fs.readFileSync(process.env.FIXTURE)); const a=process.argv.slice(2);
fs.appendFileSync(process.env.CALLS,JSON.stringify(a)+'\\n');
console.log(JSON.stringify(a.includes('PUT') ? f.merged : a.some(x=>x.includes('/check-runs')) ? f.checks : a.some(x=>x.includes('/actions/runs/')) ? (f.runs?.[a.at(-1).split('/').at(-1)] ?? f.ci) : a.some(x=>x.includes('/commits/')) ? f.commit : f.pr));
`,
    );
    const sha = "a".repeat(40);
    const base = {
      pr: {
        state: "open",
        base: { ref: "main", repo: { full_name: "Subrising/fulcra" } },
        head: { sha, repo: { full_name: "Subrising/fulcra" } },
        draft: false,
        title: "Safe title",
      },
      checks: {
        total_count: 1,
        check_runs: [
          {
            name: "ci-passed",
            id: 100,
            app: { id: 15368 },
            head_sha: sha,
            status: "completed",
            conclusion: "success",
            details_url: "https://github.com/Subrising/fulcra/actions/runs/456/job/789",
          },
        ],
      },
      ci: {
        id: 456,
        run_attempt: 1,
        status: "completed",
        conclusion: "success",
        path: ".github/workflows/ci.yml",
        event: "pull_request",
        head_sha: sha,
        repository: { full_name: "Subrising/fulcra" },
      },
      merged: { merged: true, sha: "b".repeat(40) },
      commit: {
        commit: {
          author: {
            name: "github-actions[bot]",
            email: "41898282+github-actions[bot]@users.noreply.github.com",
          },
          committer: { name: "GitHub", email: "noreply@github.com" },
        },
      },
    };
    const env = {
      ...process.env,
      GH_TOKEN: "FU182_FAKE_TOKEN_NEVER_AUTHENTICATE",
      PATH: `${bin}:${process.env.PATH}`,
      GH_REPO: "Subrising/fulcra",
      PR: "1",
      SHA: sha,
      MERGED: "b".repeat(40),
      ACTOR: "Subrising",
      TRIGGERING_ACTOR: "Subrising",
      OWNER: "Subrising",
      EVENT: "workflow_dispatch",
      REF: "refs/heads/main",
      RUNNER_TEMP: root,
      GITHUB_API_URL: "https://api.github.com",
      FULCRA_PRIVATE_PATTERNS: "i\tDO_NOT_PUBLISH",
      FIXTURE: fixture,
      CALLS: calls,
      GITHUB_OUTPUT: join(root, "output"),
    };
    const run = (name, data = base, overrides = {}) => {
      writeFileSync(fixture, JSON.stringify(data));
      return spawnSync("bash", ["-c", mergeStep(name)], {
        cwd: root,
        env: { ...env, ...overrides },
        encoding: "utf8",
      }).status;
    };
    assert.equal(run("Check the caller and inputs"), 0);
    for (const overrides of [
      { ACTOR: "other-user" },
      { TRIGGERING_ACTOR: "other-user" },
      { GH_REPO: "other/repo" },
      { PR: "1;exit 0" },
      { SHA: "abc" },
      { REF: "refs/heads/other" },
      { FULCRA_PRIVATE_PATTERNS: "" },
      { EVENT: "pull_request", HEAD_REF: "other", HEAD_REPO: "Subrising/fulcra" },
    ]) {
      assert.notEqual(
        run("Check the caller and inputs", base, overrides),
        0,
        JSON.stringify(overrides),
      );
    }
    // Both the temporary bootstrap and the final dispatch must use the same guards.
    if (mergeWorkflow().includes("fu182-bootstrap"))
      assert.equal(
        run("Check the caller and inputs", base, {
          EVENT: "pull_request",
          HEAD_REF: "fix/merge-bot",
          HEAD_REPO: "Subrising/fulcra",
        }),
        0,
      );
    assert.equal(run("Check the PR, tested SHA, and merge title"), 0);
    const superseded = structuredClone(base);
    superseded.checks.check_runs.push({
      ...base.checks.check_runs[0],
      id: 101,
      conclusion: "cancelled",
    });
    superseded.checks.total_count = 2;
    assert.equal(run("Check the PR, tested SHA, and merge title", superseded), 0);
    const otherApp = structuredClone(base);
    otherApp.checks.check_runs.push({
      ...base.checks.check_runs[0],
      id: 101,
      app: { id: 1 },
      conclusion: "failure",
    });
    otherApp.checks.total_count = 2;
    assert.equal(run("Check the PR, tested SHA, and merge title", otherApp), 0);
    for (const event of ["workflow_dispatch", "push"]) {
      const dispatched = structuredClone(superseded);
      dispatched.checks.check_runs[0].conclusion = "cancelled";
      dispatched.checks.check_runs[1].conclusion = "success";
      dispatched.ci.event = event;
      assert.notEqual(run("Check the PR, tested SHA, and merge title", dispatched), 0);
    }
    for (const change of [
      (f) => (f.pr.head.repo.full_name = "outside/fork"),
      (f) => (f.pr.head.repo = null),
      (f) => delete f.pr.head.repo,
      (f) => (f.pr.base.repo.full_name = "outside/fork"),
      (f) => (f.ci.path = ".github/workflows/other.yml"),
      (f) => (f.ci.head_sha = "c".repeat(40)),
      (f) => (f.ci.event = "workflow_dispatch"),
      (f) => delete f.checks.total_count,
      (f) => (f.checks.check_runs[0].app = null),
      (f) => (f.checks.check_runs[0].conclusion = "skipped"),
      (f) => (f.pr.draft = true),
      (f) => (f.pr.base.ref = "next"),
      (f) => (f.pr.head.sha = "c".repeat(40)),
      (f) => (f.pr.state = "closed"),
      (f) => (f.pr.title = "DO_NOT_PUBLISH"),
      (f) => (f.checks.check_runs = []),
      (f) => (f.checks.check_runs[0].head_sha = "c".repeat(40)),
      (f) => (f.checks.check_runs[0].conclusion = "failure"),
      (f) => (f.checks.check_runs[0].status = "in_progress"),
      (f) => (f.checks.check_runs[0].app.id = 1),
      (f) => f.checks.check_runs.push(f.checks.check_runs[0]),
    ]) {
      const data = structuredClone(base);
      change(data);
      assert.notEqual(run("Check the PR, tested SHA, and merge title", data), 0);
    }
    const literalTitle = structuredClone(base);
    literalTitle.pr.title = "Literal $(touch injected) `touch injected`";
    assert.equal(run("Check the PR, tested SHA, and merge title", literalTitle), 0);
    assert.equal(run("Merge with the workflow token", literalTitle), 0);
    assert.equal(existsSync(join(root, "injected")), false);
    const mergeCall = readFileSync(calls, "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse)
      .find((args) => args.includes("PUT"));
    assert.ok(mergeCall.includes(`commit_title=Fulcra ${literalTitle.pr.title} (#1)`));
    assert.ok(mergeCall.includes("commit_message="));
    assert.ok(mergeCall.includes(`sha=${sha}`));
    assert.ok(mergeCall.includes("merge_method=merge"));
    assert.equal(run("Check the merge identity"), 0);
    for (const change of [
      (f) => (f.commit.commit.author.name = "other-user"),
      (f) => (f.commit.commit.author.email = "invalid"),
      (f) => (f.commit.commit.committer.name = "Subrising"),
      (f) => (f.commit.commit.committer.email = "invalid"),
    ]) {
      const data = structuredClone(base);
      change(data);
      assert.notEqual(run("Check the merge identity", data), 0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function identityFixture({ upstreamMessage = "Upstream ancestor fixture" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "fulcra-identities-test-"));
  const project = join(root, "project"),
    upstream = join(root, "upstream.git"),
    bin = join(root, "bin");
  mkdirSync(project);
  mkdirSync(bin);
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Fulcra",
    GIT_AUTHOR_EMAIL: "fulcra@users.noreply.github.com",
    GIT_COMMITTER_NAME: "Fulcra",
    GIT_COMMITTER_EMAIL: "fulcra@users.noreply.github.com",
    RUNNER_TEMP: root,
    FULCRA_PRIVATE_PATTERNS: "i\tDO_NOT_PUBLISH",
  };
  const gitAt = (cwd, ...args) =>
    execFileSync(realGit, args, {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const git = (...args) => gitAt(project, ...args);
  git("init", "--initial-branch=main");
  writeFileSync(join(project, "fixture"), "Identity fixture.\n");
  git("add", ".");
  git("commit", "-qm", "Identity fixture base");
  const main = git("rev-parse", "HEAD"),
    tree = git("rev-parse", "HEAD^{tree}");
  gitAt(root, "clone", "--bare", project, upstream);
  const createAt = (cwd, parent, message, identity = {}) =>
    execFileSync(realGit, ["commit-tree", tree, "-p", parent, "-m", message], {
      cwd,
      env: { ...env, ...identity },
      encoding: "utf8",
    }).trim();
  const upstreamIdentity = {
    GIT_AUTHOR_NAME: "Upstream Fixture",
    GIT_AUTHOR_EMAIL: "upstream@fixture.invalid",
    GIT_COMMITTER_NAME: "Upstream Fixture",
    GIT_COMMITTER_EMAIL: "upstream@fixture.invalid",
  };
  const ancestor = createAt(upstream, main, upstreamMessage, upstreamIdentity);
  const release = createAt(upstream, ancestor, "Upstream release fixture", upstreamIdentity);
  gitAt(upstream, "tag", "-a", "v0.11.4", "-m", "Release fixture", release);
  git("fetch", "--no-tags", upstream, "refs/tags/v0.11.4:refs/fixture/upstream-release");
  git("update-ref", "refs/remotes/origin/main", main);
  git("remote", "add", "origin", project);
  const calls = join(root, "calls.jsonl");
  executable(
    join(bin, "git"),
    `#!/usr/bin/env node
const fs=require('node:fs');const {spawnSync}=require('node:child_process');const a=process.argv.slice(2);
fs.appendFileSync(process.env.CALLS,JSON.stringify(a)+'\\n');
if(a[0]==='fetch'){
 const at=a.indexOf('https://github.com/getpaseo/paseo.git');
 if(at>=0){if(process.env.FAIL_UPSTREAM_FETCH==='1')process.exit(1);a[at]=process.env.FIXTURE_UPSTREAM;}
 else if(!a.includes('origin'))process.exit(2);
}
const r=spawnSync(process.env.REAL_GIT,a,{stdio:'inherit'});process.exit(r.status??1);
`,
  );
  writeFileSync(
    join(root, "check-machine-data.mjs"),
    readFileSync(new URL("scripts/check-machine-data.mjs", repoRoot)),
  );
  return {
    ancestor,
    release,
    upstreamIdentity,
    git,
    create: (identity = {}) => createAt(project, main, "Candidate fixture", identity),
    prerelease(tag) {
      const sha = createAt(upstream, release, `Prerelease fixture ${tag}`, upstreamIdentity);
      gitAt(upstream, "tag", tag, sha);
      git("fetch", "--no-tags", upstream, `refs/tags/${tag}:refs/fixture/${tag}`);
      return sha;
    },
    deleteFinalTag: () => gitAt(upstream, "tag", "-d", "v0.11.4"),
    calls: () => readFileSync(calls, "utf8"),
    run(name, sha, overrides = {}) {
      git("update-ref", "refs/heads/candidate", sha);
      return spawnSync("bash", ["-c", mergeStep(name)], {
        cwd: project,
        encoding: "utf8",
        env: {
          ...env,
          SHA: sha,
          PATH: `${bin}:${env.PATH}`,
          REAL_GIT: realGit,
          FIXTURE_UPSTREAM: upstream,
          CALLS: calls,
          ...overrides,
        },
      });
    },
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("workflow identity gate accepts the allowlist and rejects other commit identities", () => {
  const f = identityFixture();
  const run = (identity) => f.run("Check candidate commit identities", f.create(identity));
  try {
    assert.equal(run({}).status, 0);
    assert.equal(
      run({
        GIT_AUTHOR_NAME: "github-actions[bot]",
        GIT_AUTHOR_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
        GIT_COMMITTER_NAME: "GitHub",
        GIT_COMMITTER_EMAIL: "noreply@github.com",
      }).status,
      0,
    );
    for (const identity of [
      { GIT_AUTHOR_NAME: "unlisted" },
      { GIT_AUTHOR_EMAIL: "invalid" },
      { GIT_COMMITTER_NAME: "unlisted" },
      { GIT_COMMITTER_EMAIL: "invalid" },
    ])
      assert.notEqual(run(identity).status, 0);
  } finally {
    f.close();
  }
});

test("workflow identity gate accepts an upstream ancestor of a fetched release tag", () => {
  const f = identityFixture();
  try {
    assert.notEqual(f.ancestor, f.release);
    const result = f.run("Check candidate commit identities", f.ancestor);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    f.close();
  }
});

test("workflow identity gate trusts only final release tag names", () => {
  const f = identityFixture();
  try {
    for (const tag of ["v0.12.0-beta.1", "v0.12.0-rc.1", "v0.12.0+build.1", "v0.12"]) {
      const sha = f.prerelease(tag);
      assert.notEqual(f.run("Check candidate commit identities", sha).status, 0, tag);
    }
    assert.equal(f.run("Check candidate commit identities", f.ancestor).status, 0);
    f.deleteFinalTag();
    assert.notEqual(f.run("Check candidate commit identities", f.ancestor).status, 0);
  } finally {
    f.close();
  }
});

test("workflow identity gate skips upstream fetch for approved identities during an outage", () => {
  const f = identityFixture();
  try {
    for (const identity of [
      {},
      {
        GIT_AUTHOR_NAME: "github-actions[bot]",
        GIT_AUTHOR_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
        GIT_COMMITTER_NAME: "GitHub",
        GIT_COMMITTER_EMAIL: "noreply@github.com",
      },
    ]) {
      const result = f.run("Check candidate commit identities", f.create(identity), {
        FAIL_UPSTREAM_FETCH: "1",
      });
      assert.equal(result.status, 0, result.stderr);
    }
    assert.doesNotMatch(f.calls(), /https:\/\/github\.com\/getpaseo\/paseo\.git/);
  } finally {
    f.close();
  }
});

test("workflow identity gate refuses a non-Fulcra commit outside upstream releases", () => {
  const f = identityFixture();
  try {
    const sha = f.create({ GIT_AUTHOR_NAME: "Other Fixture" });
    assert.notEqual(f.run("Check candidate commit identities", sha).status, 0);
  } finally {
    f.close();
  }
});

test("workflow identity gate refuses a matching upstream name without ancestry", () => {
  const f = identityFixture();
  try {
    const sha = f.create(f.upstreamIdentity);
    assert.notEqual(sha, f.ancestor);
    assert.notEqual(f.run("Check candidate commit identities", sha).status, 0);
  } finally {
    f.close();
  }
});

test("workflow identity gate refuses an upstream fetch failure without using cached refs", () => {
  const f = identityFixture();
  try {
    assert.equal(f.run("Check candidate commit identities", f.ancestor).status, 0);
    assert.notEqual(
      f.run("Check candidate commit identities", f.ancestor, { FAIL_UPSTREAM_FETCH: "1" }).status,
      0,
    );
  } finally {
    f.close();
  }
});

test("workflow identity gate ignores fork-only tags and clears stale verification refs", () => {
  const f = identityFixture();
  try {
    const sha = f.create(f.upstreamIdentity);
    f.git("tag", "v99.0.0", sha);
    f.git("update-ref", "refs/verified-paseo-release-tags/v99.0.0", sha);
    assert.notEqual(f.run("Check candidate commit identities", sha).status, 0);
  } finally {
    f.close();
  }
});

test("candidate scanner still refuses personal data in an accepted upstream ancestor", () => {
  const f = identityFixture({ upstreamMessage: "DO_NOT_PUBLISH" });
  try {
    const identity = f.run("Check candidate commit identities", f.release);
    assert.equal(identity.status, 0, identity.stderr);
    const scan = f.run("Scan candidate commit metadata", f.release);
    assert.notEqual(scan.status, 0);
    assert.match(scan.stderr, /private-1/);
    assert.ok(scan.stderr.includes(f.ancestor.slice(0, 12)));
    assert.ok(!scan.stderr.includes("DO_NOT_PUBLISH"));
  } finally {
    f.close();
  }
});

test("L3: source release rejects tag publishers and job-level write permissions", () => {
  const source = readFileSync(new URL(".github/scripts/release.sh", repoRoot), "utf8");
  const code = source.split("<<'RUBY'\n")[1].split("\nRUBY")[0];
  const root = mkdtempSync(join(tmpdir(), "fulcra-triggers-test-"));
  try {
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "Fulcra",
      GIT_AUTHOR_EMAIL: "fulcra@users.noreply.github.com",
      GIT_COMMITTER_NAME: "Fulcra",
      GIT_COMMITTER_EMAIL: "fulcra@users.noreply.github.com",
    };
    const git = (...args) =>
      execFileSync("git", args, {
        cwd: root,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    git("init", "--initial-branch=main");
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    const defaultPath = ".github/workflows/future-publisher.yaml";
    const cases = [
      ["on: {push: {branches: [main]}}\n", "active", true],
      ["on: {push: {branches-ignore: [archive]}}\n", "active", true],
      ["on: [workflow_dispatch, pull_request]\n", "active", true],
      ["on: {workflow_dispatch: {inputs: {tags: {type: string}}}}\n", "active", true],
      ["on: release\n", "disabled_manually", true],
      ["on: release\n", "active", false],
      ["'on': [workflow_dispatch, release]\n", "active", false],
      ["on: {release: {types: [published]}}\n", "active", false],
      ["on:\n  push:\n    tags: [v*]\n", "active", false],
      ['"on": {push: {"tags": ["v*"]}}\n', "active", false],
      ["filters: &filters {tags: ['v*']}\non: {push: *filters}\n", "active", false],
      ["on: {push: {tags-ignore: ['*']}}\n", "active", false],
      ["on: push\n", "active", false],
      ["on: [push, workflow_dispatch]\n", "active", false],
      ["on:\n  push:\n", "active", false],
      ["on: {push: {paths: ['src/**']}}\n", "active", false],
      ["on: create\n", "active", false],
      ["on: [release\n", "active", false],
      ["on: workflow_dispatch\n---\non: release\n", "active", false],
      ["on: release\n", null, false],
      ["on: {push: {branches: [main]}}\n", null, true],
    ];
    const ciTag = (permissions) =>
      `on: {push: {tags: ['v*']}}\npermissions: {contents: read}\njobs:\n  validate:\n${permissions === null ? "" : `    permissions: ${permissions}\n`}    runs-on: ubuntu-latest\n    steps: []\n`;
    for (const [permissions, allowed] of [
      [null, true],
      ["{}", true],
      ["read-all", true],
      ["{checks: read, contents: none}", true],
      ["{contents: write}", false],
      ["{checks: write}", false],
      ["{id-token: write}", false],
      ["write-all", false],
    ]) {
      cases.push([ciTag(permissions), "active", allowed, ".github/workflows/ci.yml"]);
    }
    cases.push([
      ciTag(null) +
        "  publish:\n    permissions: {contents: write}\n    runs-on: ubuntu-latest\n    steps: []\n",
      "active",
      false,
      ".github/workflows/ci.yml",
    ]);
    for (const [yaml, state, allowed, path = defaultPath] of cases) {
      for (const file of readdirSync(join(root, ".github/workflows")))
        rmSync(join(root, ".github/workflows", file));
      writeFileSync(join(root, path), yaml);
      git("add", ".github/workflows");
      const sha = git("commit-tree", git("write-tree"), "-m", "Workflow trigger fixture");
      // A second page proves that the check includes every workflow page.
      const workflows = state ? [{ path, state }] : [];
      const metadata = join(root, "workflows.json");
      writeFileSync(
        metadata,
        JSON.stringify([
          { workflows: [{ path: ".github/workflows/deleted.yml", state: "active" }] },
          { workflows },
        ]),
      );
      const result = spawnSync("ruby", ["-rjson", "-ryaml", "-ropen3", "-", metadata, sha], {
        cwd: root,
        env,
        input: code,
        encoding: "utf8",
      });
      assert.equal(result.status === 0, allowed, `${yaml}: ${result.stderr}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("source release returns after dispatch and resumes only from a matching completion", () => {
  const source = readFileSync(new URL(".github/scripts/release.sh", repoRoot), "utf8");
  assert.doesNotMatch(source, /pulls\/[^"\s]+\/merge["\s]|gh pr merge|refs\/heads\/main/);
  assert.doesNotMatch(source, /gh run watch /);
  const root = mkdtempSync(join(tmpdir(), "fulcra-release-test-"));
  try {
    const remote = join(root, "origin.git"),
      checkout = join(root, "repo"),
      bin = join(root, "bin");
    mkdirSync(bin);
    mkdirSync(checkout);
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const env = {
      ...process.env,
      GH_TOKEN: "FU182_FAKE_TOKEN_NEVER_AUTHENTICATE",
      GIT_AUTHOR_NAME: "Fulcra",
      GIT_AUTHOR_EMAIL: "fulcra@users.noreply.github.com",
      GIT_COMMITTER_NAME: "Fulcra",
      GIT_COMMITTER_EMAIL: "fulcra@users.noreply.github.com",
      FULCRA_RELEASE_REPO: checkout,
      PASEO_AGENT_ID: "",
      FULCRA_CI_OWNER: "",
      ROOT: root,
      REAL_GIT: realGit,
      PATH: `${bin}:${process.env.PATH}`,
    };
    const git = (...args) =>
      execFileSync(realGit, args, {
        cwd: checkout,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    git("init", "--bare", "--initial-branch=main", remote);
    git("init", "--initial-branch=main");
    git("remote", "add", "origin", remote);
    mkdirSync(join(checkout, "scripts"));
    mkdirSync(join(checkout, "local"));
    writeFileSync(
      join(checkout, "scripts/check-machine-data.mjs"),
      readFileSync(new URL("scripts/check-machine-data.mjs", repoRoot)),
    );
    writeFileSync(join(checkout, "local/personal-patterns.tsv"), "i\tDO_NOT_PUBLISH\n");
    writeFileSync(join(checkout, ".gitignore"), "local/\n");
    mkdirSync(join(checkout, ".github/workflows"), { recursive: true });
    writeFileSync(join(checkout, ".github/workflows/ci.yml"), "on: {push: {branches: [main]}}\n");
    writeFileSync(join(checkout, ".github/workflows/new-publisher.yml"), "on: release\n");
    git("add", ".");
    git("commit", "-qm", "Release fixture base");
    git("tag", "v1.0.0");
    const main = git("rev-parse", "HEAD");
    git("push", "-q", "origin", "main", "refs/tags/v1.0.0");
    writeFileSync(join(checkout, "RELEASE-NOTES-1.0.1.md"), "Fixture release.\n");
    git("add", ".");
    git("commit", "-qm", "Release fixture candidate");
    const sha = git("rev-parse", "HEAD"),
      tree = git("rev-parse", "HEAD^{tree}");
    const merged = execFileSync(
      realGit,
      ["commit-tree", tree, "-p", main, "-p", sha, "-m", "Fulcra fixture merge"],
      {
        cwd: checkout,
        env: {
          ...env,
          GIT_AUTHOR_NAME: "github-actions[bot]",
          GIT_AUTHOR_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
          GIT_COMMITTER_NAME: "GitHub",
          GIT_COMMITTER_EMAIL: "noreply@github.com",
        },
        encoding: "utf8",
      },
    ).trim();
    git(
      "--git-dir",
      remote,
      "fetch",
      "-q",
      checkout,
      `${sha}:refs/pull/1/head`,
      `${merged}:refs/pull/1/merge`,
    );
    writeFileSync(join(root, "fixture.json"), JSON.stringify({ main, sha, merged }));
    executable(
      join(bin, "git"),
      `#!/usr/bin/env node
const {spawnSync}=require('node:child_process'); const a=process.argv.slice(2);
if(a.join(' ')==='remote get-url origin'){console.log('https://github.com/Subrising/fulcra.git');process.exit(0)}
const r=spawnSync(process.env.REAL_GIT,a,{stdio:'inherit'}); process.exit(r.status??1);
`,
    );
    executable(
      join(bin, "gh"),
      `#!/usr/bin/env node
const fs=require('node:fs'),{execFileSync}=require('node:child_process'),p=process.env.ROOT,a=process.argv.slice(2),f=JSON.parse(fs.readFileSync(p+'/fixture.json'));
fs.appendFileSync(p+'/calls',JSON.stringify(a)+'\\n');
if(a[0]==='workflow'){fs.writeFileSync(p+'/dispatched','');execFileSync(process.env.REAL_GIT,['--git-dir',p+'/origin.git','fetch','-q',process.cwd(),f.merged+':refs/heads/main']);console.log('https://github.com/Subrising/fulcra/actions/runs/123');}
else if(a[1].includes('/actions/runs/'))console.log(JSON.stringify({path:'.github/workflows/merge-pr.yml',event:'workflow_dispatch',head_branch:'main',status:'completed',conclusion:process.env.BAD_MERGE?'failure':'success',display_title:'Merge PR 1 at '+f.sha,repository:{full_name:'Subrising/fulcra'}}));
else if(a[0]==='release'){if(a[1]==='create')fs.writeFileSync(p+'/released','');else console.log(a.includes('assets,isDraft,tagName')?'true':'v1.0.0');}
else if(a.includes('repos/Subrising/fulcra/actions/workflows?per_page=100'))console.log(JSON.stringify([{workflows:[{path:'.github/workflows/ci.yml',state:'active'},{path:'.github/workflows/new-publisher.yml',state:process.env.BAD_PUBLISHER?'active':'disabled_manually'}]}]));
else if(a[1].includes('/pulls/'))console.log(JSON.stringify({state:'open',base:{ref:'main'},head:{sha:f.sha},draft:false,merged:fs.existsSync(p+'/dispatched'),merge_commit_sha:f.merged}));
else if(a[1].includes('/check-runs'))console.log(JSON.stringify({check_runs:[{name:'ci-passed',app:{id:15368},head_sha:f.sha,status:'completed',conclusion:process.env.BAD_CI?'failure':'success'}]}));
else if(a[1].includes('/git/ref/heads/main'))console.log(f.merged);
else process.exit(2);
`,
    );
    const script = new URL(".github/scripts/release.sh", repoRoot).pathname;
    for (const ownerEnv of [{ FULCRA_CI_OWNER: "8a195a05" }, { PASEO_AGENT_ID: "8a195a05" }]) {
      const invalidOwner = spawnSync("bash", [script, "1.0.1", "1", sha], {
        cwd: checkout,
        env: { ...env, ...ownerEnv },
        encoding: "utf8",
      });
      assert.notEqual(invalidOwner.status, 0);
      assert.match(invalidOwner.stderr, /CI owner must be a full lowercase session UUID/);
      assert.equal(existsSync(join(root, "dispatched")), false);
      assert.equal(
        existsSync(join(root, "calls")),
        false,
        "L6: owner validation must precede GitHub calls",
      );
    }
    const bad = spawnSync("bash", [script, "1.0.1", "1", sha], {
      cwd: checkout,
      env: { ...env, BAD_CI: "1" },
      encoding: "utf8",
    });
    assert.notEqual(bad.status, 0);
    assert.equal(existsSync(join(root, "dispatched")), false);
    const publisher = spawnSync("bash", [script, "1.0.1", "1", sha], {
      cwd: checkout,
      env: { ...env, BAD_PUBLISHER: "1" },
      encoding: "utf8",
    });
    assert.notEqual(publisher.status, 0);
    assert.equal(existsSync(join(root, "dispatched")), false);
    const good = spawnSync("bash", [script, "1.0.1", "1", sha], {
      cwd: checkout,
      env,
      encoding: "utf8",
    });
    assert.equal(good.status, 0, `${good.stdout}\n${good.stderr}`);
    assert.equal(existsSync(join(root, "released")), false);
    assert.match(good.stdout, /merge_dispatched=123/);
    assert.match(good.stdout, /Resume only after the completion event/);
    const resumeArgs = [script, "1.0.1", "1", sha, "--after-merge", "123"];
    const failedMerge = spawnSync("bash", resumeArgs, {
      cwd: checkout,
      env: { ...env, BAD_MERGE: "1" },
      encoding: "utf8",
    });
    assert.notEqual(failedMerge.status, 0);
    assert.equal(existsSync(join(root, "released")), false);
    const resumed = spawnSync("bash", resumeArgs, { cwd: checkout, env, encoding: "utf8" });
    assert.equal(resumed.status, 0, `${resumed.stdout}\n${resumed.stderr}`);
    assert.equal(existsSync(join(root, "released")), true);
    assert.equal(git("rev-parse", "v1.0.1^{}"), merged);
    const calls = readFileSync(join(root, "calls"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(calls.filter((a) => a[0] === "workflow").length, 1);
    assert.equal(calls.filter((a) => a[0] === "run").length, 0);
    assert.equal(
      calls.some((a) => a.some((x) => x.endsWith("/merge"))),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("timed browser planning assigns every case once and splits a slow file", () => {
  const tests = Array.from({ length: 64 }, (_, index) => ({
    file: "slow.spec.ts",
    key: `same-file case ${index}`,
    line: `case ${index}`,
  }));
  const seconds = Object.fromEntries(tests.map((item, index) => [item.key, index < 16 ? 100 : 10]));
  const shards = balanceTests(tests, seconds);
  assert.equal(shards.length, BROWSER_SHARDS);
  assert.equal(shards.flatMap((shard) => shard.tests).length, 64);
  assert.equal(new Set(shards.flatMap((shard) => shard.tests.map((item) => item.key))).size, 64);
  assert.ok(Math.max(...shards.map((shard) => shard.seconds)) <= 130);
});

test("a browser job retry selects only failures and fails closed without them", () => {
  const files = new Map([
    ["packages/app/.e2e-plan/shard-1.txt", "first\nsecond"],
    ["packages/app/.e2e-retry/failed.txt", "second"],
  ]);
  const ports = { exists: (file) => files.has(file), read: (file) => files.get(file) };
  assert.equal(testListPath(1, 1, ports), ".e2e-plan/shard-1.txt");
  assert.equal(testListPath(1, 2, ports), ".e2e-retry/failed.txt");
  files.delete("packages/app/.e2e-retry/failed.txt");
  assert.throws(() => testListPath(1, 2, ports), /Refusing to rerun a whole shard/);
  files.set("packages/app/.e2e-retry/failed.txt", "");
  assert.equal(testListPath(1, 2, ports), null);
  files.set("packages/app/.e2e-retry/incomplete", "failed setup");
  assert.throws(() => testListPath(1, 2, ports), /incomplete/);
});

test("quarantined browser cases run outside the required gate", () => {
  const files = new Map([["packages/app/.e2e-plan/quarantine.txt", "flaky"]]);
  const ports = { exists: (file) => files.has(file), read: (file) => files.get(file) };
  assert.equal(testListPath("quarantine", 1, ports), ".e2e-plan/quarantine.txt");
  files.set("packages/app/.e2e-plan/quarantine.txt", "");
  assert.equal(testListPath("quarantine", 1, ports), null);
  for (const [key, item] of QUARANTINED_BROWSER_TESTS) {
    assert.match(key, /^[\w.-]+\.spec\.ts › /);
    assert.match(item, /^FU-\d+$/);
  }
  const jobs = jobBlocks(readFileSync(ciWorkflowPath, "utf8"));
  const quarantine = jobs.get("browser-quarantine").join("\n");
  assert.match(quarantine, /^ {4}continue-on-error: true$/m);
  assert.match(quarantine, /PLAYWRIGHT_ARTIFACT: quarantine/);
  assert.ok(!jobs.get("ci-passed").join("\n").includes("- browser-quarantine\n"));
});

test("a failed browser input download is attempted once more", () => {
  const steps = jobBlocks(readFileSync(ciWorkflowPath, "utf8")).get("playwright-1").join("\n");
  assert.match(steps, /id: browser-inputs\n\s+continue-on-error: true/);
  assert.match(
    steps,
    /Restore shared browser inputs again\n\s+if: \$\{\{ steps\.browser-inputs\.outcome == 'failure' \}\}/,
  );
});

test("prebuilt web server serves SPA routes without masking missing bundle assets", async () => {
  const root = mkdtempSync(join(tmpdir(), "browser-static-"));
  writeFileSync(join(root, "index.html"), "<main>built app</main>");
  writeFileSync(join(root, "app.js"), "console.log(1)");
  const server = await startStaticWeb(root);
  try {
    const origin = `http://127.0.0.1:${server.port}`;
    assert.equal(await (await fetch(`${origin}/host/workspace`)).text(), "<main>built app</main>");
    assert.equal((await fetch(`${origin}/missing.js`)).status, 404);
    assert.match((await fetch(`${origin}/app.js`)).headers.get("content-type"), /javascript/);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("FU-371: shared merge admission rejects a fork PR even with the tested SHA", async () => {
  const { assertPRHead } = await import("../.github/scripts/ci-check.mjs");
  const { pr } = proofFixture().data;
  assert.doesNotThrow(() => assertPRHead(pr, pr.head.sha));
  for (const repo of [{ full_name: "outside/fork" }, null, undefined]) {
    assert.throws(() => assertPRHead({ ...pr, head: { ...pr.head, repo } }, pr.head.sha));
  }
  assert.throws(() =>
    assertPRHead({ ...pr, base: { ...pr.base, repo: { full_name: "outside/fork" } } }, pr.head.sha),
  );
  assert.throws(() => assertPRHead(pr, "f".repeat(40)));
});

test("CI selection ignores cancelled runs and refuses failures or incomplete checks", async () => {
  const fixture = proofFixture();
  const sha = fixture.data.pr.head.sha;
  const success = fixture.data.checks.check_runs[0];
  const select = (check_runs, extra = {}) =>
    selectPassedCI({ total_count: check_runs.length, check_runs, ...extra }, sha, fixture.api);
  const cancelled = { ...success, id: 101, conclusion: "cancelled" };
  assert.equal((await select([success, cancelled])).gate, success);
  const latest = { ...success, id: 102 };
  assert.equal((await select([success, latest, cancelled])).gate, latest);
  for (const other of [
    { ...cancelled, conclusion: "failure" },
    { ...cancelled, status: "in_progress", conclusion: null },
    { ...cancelled, conclusion: "timed_out" },
    { ...cancelled, conclusion: "neutral" },
    { ...cancelled, conclusion: "skipped" },
    { ...cancelled, head_sha: "b".repeat(40) },
    { ...cancelled, id: undefined },
    success,
  ])
    await assert.rejects(select([success, other]));
  await assert.rejects(select([]));
  await assert.rejects(select([cancelled]));
  await assert.rejects(select([{ ...success, app: { id: 1 } }]));
  await assert.rejects(select([{ ...success, app: null }]), /Missing CI check app identity/);
  for (const total_count of [undefined, null, -1, 0, 101])
    await assert.rejects(select([success], { total_count }), /Incomplete CI check results/);
});

test("merge admission and tested-tree proof enforce the same PR CI provenance", async () => {
  for (const scenario of [
    "cancelled-dispatch",
    "cancelled-other-workflow",
    "real-newer-dispatch",
    "skipped",
    "stale-check",
    "stale-run",
    "other-app-failure",
  ]) {
    const fixture = proofFixture();
    const real = fixture.data.checks.check_runs[0];
    const other = {
      ...real,
      id: 101,
      details_url: "https://github.com/Subrising/fulcra/actions/runs/999/job/888",
    };
    const otherRun = { ...fixture.data.ci, id: 999, event: "workflow_dispatch" };
    fixture.data.checks.check_runs = [real, other];
    if (scenario.startsWith("cancelled-")) real.conclusion = "cancelled";
    if (scenario === "cancelled-other-workflow") {
      otherRun.event = "pull_request";
      otherRun.path = ".github/workflows/other.yml";
    }
    if (scenario === "skipped") real.conclusion = "skipped";
    if (scenario === "stale-check") real.head_sha = "e".repeat(40);
    if (scenario === "stale-run") fixture.data.ci.head_sha = "e".repeat(40);
    if (["skipped", "stale-check", "stale-run"].includes(scenario))
      fixture.data.checks.check_runs = [real];
    if (scenario === "other-app-failure") {
      other.app = { id: 1 };
      other.conclusion = "failure";
    }
    fixture.data.checks.total_count = fixture.data.checks.check_runs.length;
    const api = async (route) => (route === "/actions/runs/999" ? otherRun : fixture.api(route));
    const admission = () => selectPassedCI(fixture.data.checks, fixture.data.pr.head.sha, api);
    if (scenario === "other-app-failure") {
      assert.equal((await admission()).run.id, 456);
      assert.equal((await proveMerge(fixture.run, api)).ciRunId, 456);
    } else {
      await assert.rejects(admission(), undefined, scenario);
      await assert.rejects(proveMerge(fixture.run, api), undefined, scenario);
    }
  }
});

test("bundled skill bytes stay unchanged with Windows checkout conversion", () => {
  const root = mkdtempSync(join(tmpdir(), "fulcra-skill-eol-"));
  try {
    const git = (...args) =>
      execFileSync("git", ["-c", "core.autocrlf=true", ...args], { cwd: root, stdio: "pipe" });
    git("init", "--quiet");
    cpSync(new URL(".gitattributes", repoRoot), join(root, ".gitattributes"));
    cpSync(new URL("skills/", repoRoot), join(root, "skills"), { recursive: true });
    git("add", ".");
    rmSync(join(root, "skills"), { recursive: true });
    git("checkout-index", "--all", "--force");
    mkdirSync(join(root, "scripts"));
    cpSync(
      new URL("scripts/record-bundled-skill-hashes.mjs", repoRoot),
      join(root, "scripts", "record-bundled-skill-hashes.mjs"),
    );
    const result = spawnSync(
      process.execPath,
      ["scripts/record-bundled-skill-hashes.mjs", "--check"],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      readFileSync(join(root, "skills", ".bundled-skill-hashes.json")).includes(13),
      false,
    );
    // Prove that this Git checkout exercises conversion when the rule is absent.
    writeFileSync(join(root, ".gitattributes"), "");
    git("add", ".gitattributes");
    rmSync(join(root, "skills"), { recursive: true });
    git("checkout-index", "--all", "--force");
    const converted = spawnSync(
      process.execPath,
      ["scripts/record-bundled-skill-hashes.mjs", "--check"],
      { cwd: root, encoding: "utf8" },
    );
    assert.notEqual(converted.status, 0);
    assert.match(converted.stderr, /Record the current bundled skill hashes/);
  } finally {
    rmSync(root, { recursive: true, force: true });
=======
test("desktop packaging smokes main pushes and only the pull requests that touch packaging", () => {
  const source = readFileSync(new URL(".github/workflows/desktop-packages.yml", repoRoot), "utf8");
  const trigger = source.split("jobs:", 1)[0];
  assert.match(trigger, /push:\s*\n\s+branches: \[main\]/);
  assert.match(trigger, /pull_request:\s*\n\s+paths:/);
  assert.match(trigger, /- "packages\/desktop\/\*\*"/);
  assert.doesNotMatch(source, /dorny\/paths-filter/);
  for (const action of ["actions/checkout", "actions/setup-node", "actions/upload-artifact"]) {
    assert.match(source, new RegExp(`${action}@[0-9a-f]{40} # v\\d+\\.\\d+\\.\\d+`));
>>>>>>> refs/remotes/upstream/tags/v0.14.0
  }
});

test("stable iOS releases upload once and distribute to external testers before App Store review", () => {
  const source = readFileSync(
    new URL("packages/app/.eas/workflows/release-mobile.yml", repoRoot),
    "utf8",
  );
  const jobs = jobBlocks(source);
  const uploads = [...jobs.entries()].filter(
    ([, lines]) =>
      lines.some((line) => /^    type: (submit|testflight)$/.test(line)) &&
      lines.some((line) => line.includes("needs.build_ios.outputs.build_id")),
  );
  assert.equal(uploads.length, 1, "the iOS binary must be uploaded exactly once");
  const [distributionId, distributionLines] = uploads[0];
  const distribution = distributionLines.join("\n");
  assert.match(distribution, /^    type: testflight$/m);
  assert.match(distribution, /external_groups:\s*\n\s+- Paseo Beta/);
  assert.match(distribution, /^      submit_beta_review: true$/m);

  const review = jobs.get("submit_ios_for_review").join("\n");
  assert.match(review, new RegExp(`needs: \\[build_ios, ${distributionId}\\]`));
  assert.match(review, /APP_VERSION="\$\{\{ needs\.build_ios\.outputs\.app_version \}\}"/);
  assert.match(
    review,
    /APP_BUILD_VERSION="\$\{\{ needs\.build_ios\.outputs\.app_build_version \}\}"/,
  );
  assert.match(review, /bundle exec fastlane ios submit_review/);
});

test("eight Playwright shards share two-worker coverage", () => {
  const source = readFileSync(ciWorkflowPath, "utf8");
  const jobs = jobBlocks(source);
  assert.equal(jobs.size, 21);
  for (let shard = 1; shard <= 8; shard++) {
    const job = jobs.get(`playwright-${shard}`).join("\n");
    assert.match(job, new RegExp(`PLAYWRIGHT_SHARD: "${shard}/8"`));
    assert.match(job, new RegExp(`PLAYWRIGHT_ARTIFACT: "${shard}"`));
    assert.match(
      job,
      shard === 1 ? /steps: &playwright_test_steps/ : /steps: \*playwright_test_steps/,
    );
  }
  const shared = jobs.get("playwright-1").join("\n");
  assert.match(shared, /E2E_WORKERS: "2"/);
  const weights = /PWTEST_SHARD_WEIGHTS: "([\d:]+)"/.exec(shared)[1].split(":").map(Number);
  assert.equal(weights.length, 8);
  assert.ok(weights.every((weight) => weight > 0));
  assert.match(shared, /npm run test:e2e --workspace=@getpaseo\/app -- --shard=/);

  // No fan-in result job: a gate needs its own runner and under contention it
  // queued 8m08s behind the last shard. Required checks name the shards directly.
  assert.equal(jobs.has("playwright"), false);
});

test("quality preserves commands and routes each domain independently after failures", () => {
  const jobs = jobBlocks(readFileSync(ciWorkflowPath, "utf8"));
  const quality = jobs.get("quality").join("\n");
  assert.doesNotMatch(quality, /^\s+continue-on-error:/m);
  const commands = {
    format: ["npm run format:check"],
    quality: [
      "npx --yes lockfile-lint --path package-lock.json --type npm --allowed-hosts npm --validate-https --validate-integrity",
      "npm audit signatures",
      "npm run lint",
      "node --test scripts/oxlint/paseo-plugin.test.mjs",
    ],
    relay: ["npm run build:relay", "npm run test --workspace=@getpaseo/relay"],
    sdk: [
      "npm run build:relay && npm run build:client",
      "npm run build:plugin",
      "npm run test --workspace=@getpaseo/plugin",
      "npm run test --workspace=@getpaseo/protocol",
      "npm run test --workspace=@getpaseo/client",
      "npm run test --workspace=@getpaseo/highlight",
      "npm run typecheck:examples --workspace=@getpaseo/client",
    ],
  };
  const checks = [...quality.matchAll(/        if: \$\{\{ (.+) \}\}\n        run: (.+)/g)];
  assert.deepEqual(
    checks.map(([, , command]) => command),
    Object.values(commands).flat(),
  );
  const domains = Object.keys(commands);
  function accepts(expression, outputs, { cancelled = false, installed = true } = {}) {
    // Prior checks have failed: success() is false. Explicit !cancelled() must
    // override Actions' default success condition so later domains still run.
    assert.match(expression, /!cancelled\(\)/);
    return runInNewContext(expression, {
      needs: { changes: { outputs } },
      steps: { install: { outcome: installed ? "success" : "failure" } },
      cancelled: () => cancelled,
      success: () => false,
    });
  }
  const disabled = { full: "false", ...Object.fromEntries(domains.map((key) => [key, "false"])) };
  const jobCondition = /    if: \$\{\{ (.+) \}\}/.exec(quality)[1];
  assert.equal(accepts(jobCondition, disabled), false);
  for (const selected of domains) {
    const outputs = { ...disabled, [selected]: "true" };
    assert.equal(accepts(jobCondition, outputs), true);
    for (const [, expression, command] of checks) {
      assert.equal(accepts(expression, outputs), commands[selected].includes(command), command);
    }
  }
  for (const [, expression] of checks) {
    assert.equal(accepts(expression, { ...disabled, full: "true" }), true);
    assert.equal(accepts(expression, {}), true, "missing routing outputs fail open");
    assert.equal(accepts(expression, {}, { cancelled: true }), false);
    assert.equal(accepts(expression, {}, { installed: false }), false);
  }
  assert.equal(accepts(jobCondition, {}, { cancelled: true }), false);
});

test("Windows units and integration run independently with complete routed coverage", () => {
  const source = readFileSync(ciWorkflowPath, "utf8");
  const jobs = jobBlocks(source);
  const ubuntu = jobs.get("server-tests-ubuntu").join("\n");
  const windows = jobs.get("server-tests-windows").join("\n");
  const integration = jobs.get("server-integration-windows").join("\n");
  assert.match(ubuntu, /run: npm run test --workspace=@getpaseo\/server/);
  assert.match(windows, /run: npm run test:unit --workspace=@getpaseo\/server/);
  assert.doesNotMatch(windows, /run: npm run test(?: |:integration)/);
  assert.match(integration, /run: npm run test:integration --workspace=@getpaseo\/server/);
  assert.doesNotMatch(integration, /test:unit|server_plugin_tests|server_hub_contract/);
  for (const job of [windows, integration]) {
    assert.match(job, /^    needs: changes$/m, "both phases become eligible independently");
    assert.match(job, /^    runs-on: windows-latest$/m);
    assert.doesNotMatch(job, /continue-on-error|maxWorkers|--exclude/);
    for (const step of [
      "server_capacity",
      "server_checkout",
      "server_node",
      "server_fetch",
      "server_install",
      "server_agent_clis",
      "server_build",
    ]) {
      assert.match(ubuntu, new RegExp(`&${step}\\b`));
      assert.match(job, new RegExp(`- \\*${step}\\b`));
    }
    assert.match(job, /env: \*server_test_env/);
  }
  assert.match(windows, /- \*server_plugin_tests/);
  assert.match(windows, /- \*server_hub_contract/);
  assert.match(ubuntu, /run: npm run test --workspace=@getpaseo\/builtin-plugins/);
  assert.match(ubuntu, /run: npm run test:hub-cli-contract --workspace=@getpaseo\/server/);

  const scripts = JSON.parse(
    readFileSync(new URL("packages/server/package.json", repoRoot), "utf8"),
  ).scripts;
  assert.equal(scripts.test, "npm run test:unit && npm run test:integration");
  assert.equal(scripts["test:unit"], 'vitest run --fileParallelism --exclude "**/*.e2e.test.ts"');
  const invocations = scripts["test:integration"].split(" && ");
  // Each vitest start costs about half a minute on Windows, so the
  // name-filtered files share one invocation and one combined filter.
  assert.equal(invocations.length, 2);
  assert.ok(invocations.every((command) => command.startsWith("vitest run --maxWorkers=1 ")));
  assert.doesNotMatch(invocations[0], / -t /);
  assert.equal(
    invocations[1],
    'vitest run --maxWorkers=1 src/server/agent/providers/omp/history.e2e.test.ts src/server/daemon-e2e/git-operations.e2e.test.ts src/server/session.create-agent-worktree-autoarchive.e2e.test.ts src/server/agent/providers/opencode-bridge.local.e2e.test.ts src/server/daemon-e2e/relay-transport.e2e.test.ts -t "merges into|creates a worktree and auto-archives both|versioned runtime|oversized attachments|connected hosts|password-protected daemon refuses|replays selected OMP history"',
  );
  const serverConfig = readFileSync(new URL("packages/server/vitest.config.ts", repoRoot), "utf8");
  assert.doesNotMatch(serverConfig, /maxWorkers/);

  function condition(job) {
    return /    if: \$\{\{ (.+) \}\}/.exec(job)[1];
  }
  function selected(expression, outputs, cancelled = false) {
    return runInNewContext(expression, {
      needs: { changes: { outputs } },
      cancelled: () => cancelled,
    });
  }
  const unitCondition = condition(windows);
  const integrationCondition = condition(integration);
  const unitStep = /      - name: Run server unit tests\n        if: \$\{\{ (.+) \}\}/.exec(
    windows,
  )[1];
  const hubStep =
    /      - &server_hub_contract\n        name: Run Hub CLI\/daemon contract\n        if: \$\{\{ (.+) \}\}/.exec(
      ubuntu,
    )[1];
  const pluginStep =
    /      - &server_plugin_tests\n        name: Run built-in plugin tests\n        if: \$\{\{ (.+) \}\}/.exec(
      ubuntu,
    )[1];
  for (const [outputs, units, integrations, hub] of [
    [{ full: "true", server: "false", hub: "false" }, true, true, false],
    [{ full: "false", server: "true", hub: "false" }, true, true, false],
    [{ full: "false", server: "false", hub: "true" }, true, false, true],
    [{ full: "false", server: "false", hub: "false" }, false, false, false],
    [{}, true, true, false],
  ]) {
    assert.equal(selected(unitCondition, outputs), units);
    assert.equal(selected(integrationCondition, outputs), integrations);
    assert.equal(selected(unitStep, outputs), integrations);
    assert.equal(selected(pluginStep, outputs), integrations);
    assert.equal(selected(hubStep, outputs), hub);
    assert.equal(selected(unitCondition, outputs, true), false);
    assert.equal(selected(integrationCondition, outputs, true), false);
  }
});

test("macOS release retries only transient stapling failures without rebuilding the signed app", async (t) => {
  const workflow = readFileSync(new URL(".github/workflows/desktop-release.yml", repoRoot), "utf8");
  const wrapper = workflow
    .match(/<<'STAPLER'\n([\s\S]*?)\n          STAPLER/)[1]
    .replace(/^          /gm, "");
  const networkError =
    'Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."';
  const cases = [
    {
      name: "success",
      outcomes: [0],
      output: "stapled",
      command: "stapler",
      expected: 0,
      attempts: 1,
    },
    {
      name: "transient then success",
      outcomes: [68, 0],
      output: networkError,
      command: "stapler",
      expected: 0,
      attempts: 2,
    },
    {
      name: "exhausted network retries",
      outcomes: [68, 68, 68, 68, 0],
      output: networkError,
      command: "stapler",
      expected: 68,
      attempts: 4,
    },
    {
      name: "non-network staple error",
      outcomes: [68, 0],
      output: "ticket not found",
      command: "stapler",
      expected: 68,
      attempts: 1,
    },
    {
      name: "different exit code",
      outcomes: [1, 0],
      output: networkError,
      command: "stapler",
      expected: 1,
      attempts: 1,
    },
    {
      name: "notary submission is not retried",
      outcomes: [68, 0],
      output: networkError,
      command: "notarytool",
      expected: 68,
      attempts: 1,
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, () => {
      const directory = mkdtempSync(join(tmpdir(), "stapler-retry-"));
      try {
        const statePath = join(directory, "state.json");
        const realXcrun = join(directory, "real-xcrun");
        const wrapperPath = join(directory, "xcrun");
        writeFileSync(wrapperPath, wrapper, { mode: 0o755 });
        writeFileSync(join(directory, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        writeFileSync(
          statePath,
          JSON.stringify({ outcomes: scenario.outcomes, output: scenario.output, calls: [] }),
        );
        writeFileSync(
          realXcrun,
          `#!/usr/bin/env node
const fs = require("node:fs");
const state = JSON.parse(fs.readFileSync(process.env.STAPLER_STATE, "utf8"));
state.calls.push(process.argv.slice(2));
const code = state.outcomes.shift();
fs.writeFileSync(process.env.STAPLER_STATE, JSON.stringify(state));
console.log(state.output);
process.exit(code);
`,
          { mode: 0o755 },
        );
        const args = [scenario.command, "staple", "-v", "Paseo signed.app"];
        const result = spawnSync("bash", [wrapperPath, ...args], {
          encoding: "utf8",
          env: {
            ...process.env,
            PASEO_REAL_XCRUN: realXcrun,
            STAPLER_STATE: statePath,
            PATH: `${directory}:${process.env.PATH}`,
          },
          timeout: 5000,
        });
        assert.equal(result.status, scenario.expected, result.stdout + result.stderr);
        const state = JSON.parse(readFileSync(statePath, "utf8"));
        assert.deepEqual(
          state.calls,
          Array.from({ length: scenario.attempts }, () => args),
        );
        assert.match(result.stdout, /stapled|network connection was lost|ticket not found/);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});
