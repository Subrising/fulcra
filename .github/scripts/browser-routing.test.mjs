import assert from "node:assert/strict";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { needsMetro } from "./browser-routing.mjs";
import BrowserReporter from "./browser-ci-reporter.mjs";
import { balanceTests } from "./browser-shards.mjs";
import { installCacheSafe } from "./install-cache-inputs.mjs";

test("unknown install lifecycle inputs use fresh installs instead of cached dependencies", () => {
  const root = mkdtempSync(path.join(tmpdir(), "install-inputs-"));
  const manifest = {
    workspaces: ["packages/member"],
    scripts: {
      postinstall: "node scripts/postinstall-patches.mjs",
      prepare: "node scripts/install-git-hooks.mjs",
    },
  };
  const save = (file, value) => writeFileSync(path.join(root, file), JSON.stringify(value));
  try {
    mkdirSync(path.join(root, "packages/member"), { recursive: true });
    save("package.json", manifest);
    save("packages/member/package.json", {});
    assert.equal(installCacheSafe(root), true);
    save("packages/member/package.json", { scripts: { postinstall: "node new-install.mjs" } });
    assert.equal(installCacheSafe(root), false);
    save("packages/member/package.json", {});
    save("package.json", {
      ...manifest,
      scripts: { ...manifest.scripts, prepare: "node other-input.mjs" },
    });
    assert.equal(installCacheSafe(root), false);
    save("package.json", { ...manifest, workspaces: ["tools/member"] });
    assert.equal(installCacheSafe(root), false);
    save("package.json", { ...manifest, workspaces: ["packages/*"] });
    assert.equal(installCacheSafe(root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ordinary files share setup while slow files still split without losing cases", () => {
  const ordinary = Array.from({ length: 8 }, (_, file) =>
    Array.from({ length: 6 }, (unused, index) => ({
      file: `${file}.spec.ts`,
      key: `${file}.spec.ts › ${index}`,
      line: `${file}/${index}`,
    })),
  ).flat();
  const weights = Object.fromEntries(ordinary.map((item) => [item.key, 1]));
  const groups = balanceTests(ordinary, weights, 4);
  for (let file = 0; file < 8; file++) {
    assert.equal(
      groups.filter((group) => group.tests.some((item) => item.file === `${file}.spec.ts`)).length,
      1,
    );
  }
  assert.equal(groups.flatMap((group) => group.tests).length, ordinary.length);
  const slow = Array.from({ length: 32 }, (_, index) => ({
    file: "slow.spec.ts",
    key: `slow.spec.ts › ${index}`,
    line: `slow/${index}`,
  }));
  const split = balanceTests(slow, Object.fromEntries(slow.map((item) => [item.key, 10])), 4);
  assert.ok(split.every((group) => group.tests.length > 0 && group.seconds <= 120));
  assert.equal(
    new Set(split.flatMap((group) => group.tests.map((item) => item.key))).size,
    slow.length,
  );
});

test("infrastructure and teardown failures cannot become empty successful retries", () => {
  const root = mkdtempSync(path.join(tmpdir(), "browser-retry-errors-"));
  const cwd = process.cwd();
  try {
    process.chdir(root);
    for (const { status, failed, globalError, incomplete } of [
      { status: "passed", failed: false, globalError: false, incomplete: false },
      { status: "failed", failed: true, globalError: false, incomplete: false },
      { status: "timedout", failed: false, globalError: false, incomplete: true },
      { status: "failed", failed: true, globalError: true, incomplete: true },
    ]) {
      const reporter = new BrowserReporter();
      reporter.rootDir = root;
      reporter.tests = [
        {
          title: "case",
          location: { file: path.join(root, "example.spec.ts") },
          expectedStatus: "passed",
          results: [{ status: failed ? "failed" : "passed", duration: 1 }],
          outcome: () => (failed ? "unexpected" : "expected"),
        },
      ];
      if (globalError) reporter.onError(new Error("fixture teardown failed"));
      reporter.onEnd({ status });
      assert.equal(existsSync(".e2e-retry/incomplete"), incomplete);
      assert.equal(Boolean(readFileSync(".e2e-retry/failed.txt", "utf8").trim()), failed);
    }
  } finally {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  }
});

test("profiling and recovery contracts retain Metro and every other case stays sharded", () => {
  const root = mkdtempSync(path.join(tmpdir(), "browser-routing-"));
  const cwd = process.cwd();
  const previous = process.env.E2E_PLAN_ONLY;
  const cases = [
    ["root-error-recovery.spec.ts", "recovers"],
    ["viewed-agent-timelines.spec.ts", "a hidden retained chat stays current without rendering"],
    ["agent-stream-smoothness.spec.ts", "reveals bursty model output at a steady rate"],
    ...Array.from({ length: 40 }, (_, i) => ["regular.spec.ts", `case ${i}`]),
    ["viewed-agent-timelines.spec.ts", "two visible split chats both stay current"],
  ].map(([file, title]) => ({ title, location: { file: path.join(root, file) } }));
  try {
    process.chdir(root);
    process.env.E2E_PLAN_ONLY = "1";
    new BrowserReporter().onBegin({ rootDir: root }, { allTests: () => cases });
    const metro = readFileSync(".e2e-plan/recovery.txt", "utf8").trim().split("\n");
    assert.equal(metro.length, 3);
    const regular = readdirSync(".e2e-plan")
      .filter((file) => file.startsWith("shard-"))
      .flatMap((file) => readFileSync(path.join(".e2e-plan", file), "utf8").trim().split("\n"));
    assert.equal(regular.length, cases.length - metro.length);
    assert.equal(new Set([...metro, ...regular]).size, cases.length);
    for (const entry of cases) {
      const line = `[browser] › ${path.basename(entry.location.file)} › ${entry.title}`;
      assert.equal(metro.includes(line), needsMetro(entry));
      assert.equal(regular.includes(line), !needsMetro(entry));
    }
  } finally {
    process.chdir(cwd);
    if (previous === undefined) delete process.env.E2E_PLAN_ONLY;
    else process.env.E2E_PLAN_ONLY = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("installed dependency caches require exact platform and install inputs", () => {
  const action = readFileSync(new URL("../actions/ci-deps/action.yml", import.meta.url), "utf8");
  for (const input of [
    "runner.os",
    "runner.arch",
    "ImageOS",
    "node22-npm11",
    "package-lock.json",
    "patches/**",
    "scripts/postinstall-patches.mjs",
    "scripts/install-git-hooks.mjs",
    "scripts/npm-retry.mjs",
    "install-cache-inputs.mjs",
  ])
    assert.ok(action.includes(input), input);
  assert.ok(!action.includes("restore-keys:"));
  assert.ok(!action.includes("'scripts/**'"));
  assert.match(action, /id: dependencies\n\s+if: steps\.lifecycle\.outputs\.reusable == 'true'/);
  assert.match(
    action,
    /if: steps\.lifecycle\.outputs\.reusable == 'true' && steps\.dependencies\.outputs\.cache-hit != 'true'\n\s+uses: actions\/cache\/save/,
  );
  assert.match(action, /cache-hit != 'true'[\s\S]*node scripts\/npm-retry.mjs ci/);
  assert.match(action, /cache-hit == 'true'[\s\S]*npm run prepare/);
  assert.ok(!action.includes("~/.npmrc"));
  assert.ok(!action.includes("~/.config"));
});
