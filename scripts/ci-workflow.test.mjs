import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { relative as relativePath } from "node:path";
import test from "node:test";

const repoRoot = new URL("../", import.meta.url);
const ciWorkflowPath = new URL(".github/workflows/ci.yml", repoRoot);
const dockerWorkflowPath = new URL(".github/workflows/docker.yml", repoRoot);
const filtersPath = new URL(".github/ci-paths.yml", repoRoot);
const serverTsconfigPath = new URL("packages/server/tsconfig.server.json", repoRoot);
const desktopPackagePath = new URL("packages/desktop/package.json", repoRoot);

const gatedCiJobs = new Map([
  ["format", { name: "format", contract: "format" }],
  ["lint", { name: "lint", contract: "quality" }],
  ["typecheck", { name: "typecheck", contract: "quality" }],
  ["server-tests-ubuntu", { name: "server-tests (ubuntu-latest)", contracts: ["server", "hub"] }],
  ["server-tests-macos", { name: "server-tests (macos-14, file observation)", contract: "server" }],
  ["desktop-tests-ubuntu", { name: "desktop-tests (ubuntu-latest)", contract: "desktop" }],
  ["app-tests", { name: "app-tests", contract: "app" }],
  ["sdk-tests", { name: "sdk-tests", contract: "sdk" }],
  ["playwright-1", { name: "playwright (shard 1/4)", contract: "browser" }],
  ["playwright-2", { name: "playwright (shard 2/4)", contract: "browser" }],
  ["playwright-3", { name: "playwright (shard 3/4)", contract: "browser" }],
  ["playwright-4", { name: "playwright (shard 4/4)", contract: "browser" }],
  ["relay-tests", { name: "relay-tests", contract: "relay" }],
  ["cli-tests-1", { name: "cli-tests (shard 1/3)", contract: "cli" }],
  ["cli-tests-2", { name: "cli-tests (shard 2/3)", contract: "cli" }],
  ["cli-tests-3", { name: "cli-tests (shard 3/3)", contract: "cli" }],
]);

function jobBlocks(source) {
  const jobs = new Map();
  let currentJob;

  for (const line of source.split("\n")) {
    const jobMatch = /^  ([a-z0-9-]+):\s*$/.exec(line);
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
    assert.match(job, /needs\.changes\.outputs\.full != 'false'/);
    for (const contract of expected.contracts ?? [expected.contract]) {
      assert.match(job, new RegExp(`needs\\.changes\\.outputs\\.${contract} != 'false'`));
    }
  }
});

test("change gating allows superseded workflow runs to cancel", () => {
  for (const workflowPath of [ciWorkflowPath, dockerWorkflowPath]) {
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
  assert.match(server, /npm run test --workspace=@getpaseo\/server/);
  // FU-90: the Command Centre plugin is packaged in CI, inside the typecheck check.
  assert.match(jobs.get("typecheck")?.join("\n") ?? "", /node scripts\/build-command-centre\.mjs/);
  assert.ok(!jobs.has("hub-cli-contract"));

  assert.match(desktop, /test:e2e:renderer/);
  assert.match(desktop, /test:e2e:browser-tabs/);
  assert.match(desktop, /npm run test --workspace=@getpaseo\/desktop/);
  assert.ok(!jobs.has("desktop-browser-bridge"));
  assert.ok(!jobs.has("playwright-desktop"));
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
    ci: [".github/actions/**", ".github/workflows/ci.yml"],
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
      "packages/app/src/device/plugin-device.electron.ts",
      "packages/app/src/plugins/bundle-trust-policy.electron.ts",
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
      "packages/server/src/server/agent/provider-snapshot-manager.ts",
      "packages/server/src/server/session/provider/provider-catalog-session.ts",
      "packages/client/src/compat/normalize-provider-models.ts",
      "packages/protocol/src/client-capabilities.ts",
      "packages/server/src/server/agent/provider-registry.ts",
      "packages/server/src/server/agent/agent-sdk-types.ts",
      "packages/server/src/server/agent/providers/codex-app-server-agent.ts",
      "packages/server/src/server/agent/providers/claude/agent.ts",
      "packages/server/src/server/agent/plugin-provider.ts",
      "packages/server/src/server/plugins/{index,plugin-process,plugin-process-protocol,runtime}.ts",
      "packages/server/src/executable-resolution/**",
      "packages/plugin/src/server/provider.ts",
      "packages/app/src/!(desktop)/**",
      "packages/app/e2e/browser/**",
      "packages/app/e2e/support/**",
      "packages/app/assets/**",
      "packages/app/public/**",
      "packages/app/index.ts",
      "packages/app/*config.{cjs,js,ts}",
      "packages/app/package.json",
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
  const electronModules = filesUnder("packages/app/src", (path) => /\.electron\.tsx?$/.test(path));

  assert.ok(browserSpecs.length > 0);
  assert.ok(desktopSpecs.length > 0);
  assert.ok(browserSpecs.every((path) => path.startsWith("packages/app/e2e/browser/")));
  assert.ok(desktopSpecs.every((path) => path.startsWith("packages/desktop/e2e/")));
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
    "packages/app/src/device/plugin-device.electron.ts",
    "packages/app/src/plugins/bundle-trust-policy.electron.ts",
    "packages/server/src/server/browser-tools/**",
    "packages/app/e2e/support/**",
    "packages/app/*config.{cjs,js,ts}",
    "packages/app/package.json",
  ]);
  assert.deepEqual(filters.browser, [
    "packages/server/src/server/agent/provider-snapshot-manager.ts",
    "packages/server/src/server/session/provider/provider-catalog-session.ts",
    "packages/client/src/compat/normalize-provider-models.ts",
    "packages/protocol/src/client-capabilities.ts",
    "packages/server/src/server/agent/provider-registry.ts",
    "packages/server/src/server/agent/agent-sdk-types.ts",
    "packages/server/src/server/agent/providers/codex-app-server-agent.ts",
    "packages/server/src/server/agent/providers/claude/agent.ts",
    "packages/server/src/server/agent/plugin-provider.ts",
    "packages/server/src/server/plugins/{index,plugin-process,plugin-process-protocol,runtime}.ts",
    "packages/server/src/executable-resolution/**",
    "packages/plugin/src/server/provider.ts",
    "packages/app/src/!(desktop)/**",
    "packages/app/e2e/browser/**",
    "packages/app/e2e/support/**",
    "packages/app/assets/**",
    "packages/app/public/**",
    "packages/app/index.ts",
    "packages/app/*config.{cjs,js,ts}",
    "packages/app/package.json",
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

test("merge workflow grants only the two required write permissions", () => {
  const source = mergeWorkflow();
  assert.match(source, /permissions:\n  contents: write\n  pull-requests: write\n\n/);
  assert.equal((source.match(/permissions:/g) ?? []).length, 1);
  assert.match(source, /persist-credentials: false/);
  assert.match(source, /group: merge-pr-main/);
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
console.log(JSON.stringify(a.includes('PUT') ? f.merged : a.some(x=>x.includes('/commits/')) ? f.commit : f.pr));
`,
    );
    executable(
      join(bin, "curl"),
      `#!/usr/bin/env node
console.log(JSON.stringify(JSON.parse(require('node:fs').readFileSync(process.env.FIXTURE)).checks));
`,
    );
    const sha = "a".repeat(40);
    const base = {
      pr: {
        state: "open",
        base: { ref: "main" },
        head: { sha },
        draft: false,
        title: "Safe title",
      },
      checks: {
        check_runs: [
          {
            name: "ci-passed",
            app: { id: 15368 },
            head_sha: sha,
            status: "completed",
            conclusion: "success",
          },
        ],
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
    for (const change of [
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

test("source release uses one workflow wait and refuses unsafe candidates", () => {
  const source = readFileSync(new URL(".github/scripts/release.sh", repoRoot), "utf8");
  assert.doesNotMatch(source, /pulls\/[^"\s]+\/merge["\s]|gh pr merge|refs\/heads\/main/);
  assert.equal((source.match(/gh run watch /g) ?? []).length, 1);
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
else if(a[0]==='run') process.exit(0);
else if(a[0]==='release'){if(a[1]==='create')fs.writeFileSync(p+'/released','');else console.log(a.includes('assets,isDraft,tagName')?'true':'v1.0.0');}
else if(a.includes('repos/Subrising/fulcra/actions/workflows?per_page=100'))console.log(JSON.stringify([{workflows:['desktop-release','android-apk-release','release-notes-sync','deploy-app'].map(name=>({path:'.github/workflows/'+name+'.yml',state:process.env.BAD_PUBLISHER?'active':'disabled_manually'}))}]));
else if(a[1].includes('/pulls/'))console.log(JSON.stringify({state:'open',base:{ref:'main'},head:{sha:f.sha},draft:false,merged:fs.existsSync(p+'/dispatched'),merge_commit_sha:f.merged}));
else if(a[1].includes('/check-runs'))console.log(JSON.stringify({check_runs:[{name:'ci-passed',app:{id:15368},head_sha:f.sha,status:'completed',conclusion:process.env.BAD_CI?'failure':'success'}]}));
else if(a[1].includes('/git/ref/heads/main'))console.log(f.merged);
else process.exit(2);
`,
    );
    const script = new URL(".github/scripts/release.sh", repoRoot).pathname;
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
    assert.equal(existsSync(join(root, "released")), true);
    assert.equal(git("rev-parse", "v1.0.1^{}"), merged);
    const calls = readFileSync(join(root, "calls"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(calls.filter((a) => a[0] === "workflow").length, 1);
    assert.equal(calls.filter((a) => a[0] === "run").length, 1);
    assert.equal(
      calls.some((a) => a.some((x) => x.endsWith("/merge"))),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
