import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { needsMetro } from "./browser-routing.mjs";
import { balanceTests, BROWSER_SHARDS } from "./browser-shards.mjs";

function identity(test, rootDir) {
  const titles = [test.title];
  let suite = test.parent;
  while (suite && suite.type !== "file") {
    if (suite.title) titles.unshift(suite.title);
    suite = suite.parent;
  }
  const file = path.relative(rootDir, test.location.file).replaceAll("\\", "/");
  return {
    key: `${path.basename(file)} › ${titles.join(" › ")}`,
    line: `[browser] › ${file} › ${titles.join(" › ")}`,
  };
}

export default class BrowserReporter {
  onError() {
    this.infrastructureError = true;
  }
  onBegin(config, suite) {
    this.rootDir = config.rootDir;
    this.tests = suite.allTests();
    if (process.env.E2E_PLAN_ONLY !== "1") {
      if (process.env.E2E_SELECTED_LIST) {
        const expected = readFileSync(process.env.E2E_SELECTED_LIST, "utf8")
          .split("\n")
          .filter((line) => line.trim() && !line.startsWith("#")).length;
        if (this.tests.length !== expected)
          throw new Error(
            `Browser selection lost coverage: expected ${expected}, found ${this.tests.length}`,
          );
      }
      return;
    }
    const history = JSON.parse(
      readFileSync(new URL("../browser-test-times.json", import.meta.url), "utf8"),
    );
    const recovery = this.tests.filter((test) => needsMetro(test));
    const regular = this.tests.filter((test) => !recovery.includes(test));
    const buckets = balanceTests(
      regular.map((test) => identity(test, this.rootDir)),
      history.seconds,
    );
    mkdirSync(".e2e-plan", { recursive: true });
    buckets.forEach((bucket, index) =>
      writeFileSync(
        `.e2e-plan/shard-${index + 1}.txt`,
        bucket.tests.map((test) => test.line).join("\n") + "\n",
      ),
    );
    writeFileSync(
      ".e2e-plan/all.txt",
      this.tests.map((test) => identity(test, this.rootDir).line).join("\n") + "\n",
    );
    writeFileSync(
      ".e2e-plan/recovery.txt",
      recovery.map((test) => identity(test, this.rootDir).line).join("\n") + "\n",
    );
    writeFileSync(
      ".e2e-plan/manifest.json",
      JSON.stringify(
        {
          total: this.tests.length,
          shards: buckets.map((bucket) => ({
            tests: bucket.tests.length,
            observedSeconds: Math.round(bucket.seconds),
          })),
        },
        null,
        2,
      ),
    );
    console.log(`Planned ${this.tests.length} tests into ${BROWSER_SHARDS} timed shards.`);
  }
  onEnd(runResult) {
    if (process.env.E2E_PLAN_ONLY === "1") return;
    mkdirSync(".e2e-retry", { recursive: true });
    this.tests ??= [];
    const failed = this.tests.filter((test) => test.outcome() === "unexpected");
    const incomplete =
      runResult.status !== "passed" &&
      (this.infrastructureError ||
        failed.length === 0 ||
        !this.tests.length ||
        this.tests.some(
          (test) =>
            test.expectedStatus !== "skipped" &&
            (test.results.length === 0 ||
              test.results.every(
                (entry) => entry.status === "skipped" || entry.status === "interrupted",
              )),
        ));
    if (incomplete)
      writeFileSync(
        ".e2e-retry/incomplete",
        "The run ended before all selected tests executed. Diagnose infrastructure before retrying.",
      );
    else rmSync(".e2e-retry/incomplete", { force: true });
    writeFileSync(
      ".e2e-retry/failed.txt",
      failed.map((test) => identity(test, this.rootDir).line).join("\n") + "\n",
    );
    writeFileSync(
      ".e2e-retry/times.json",
      JSON.stringify(
        this.tests.map((test) => ({
          ...identity(test, this.rootDir),
          seconds: test.results.reduce((sum, result) => sum + result.duration / 1000, 0),
          outcome: test.outcome(),
        })),
        null,
        2,
      ),
    );
  }
}
