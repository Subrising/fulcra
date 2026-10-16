import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { needsMetro } from "./browser-routing.mjs";
import BrowserReporter from "./browser-ci-reporter.mjs";

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
    "scripts/**",
  ])
    assert.ok(action.includes(input), input);
  assert.ok(!action.includes("restore-keys:"));
  assert.match(action, /cache-hit != 'true'[\s\S]*node scripts\/npm-retry.mjs ci/);
  assert.match(action, /cache-hit == 'true'[\s\S]*npm run prepare/);
  assert.ok(!action.includes("~/.npmrc"));
  assert.ok(!action.includes("~/.config"));
});
