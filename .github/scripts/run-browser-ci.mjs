import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { availableParallelism, totalmem } from "node:os";
import { testListPath, BROWSER_SHARDS } from "./browser-shards.mjs";

const shard = process.argv[2] === "recovery" ? "recovery" : Number(process.argv[2]);
if (shard !== "recovery" && (!Number.isInteger(shard) || shard < 1 || shard > BROWSER_SHARDS))
  throw new Error("Invalid browser shard");
const list = testListPath(shard, Number(process.env.GITHUB_RUN_ATTEMPT ?? 1), {
  exists: existsSync,
  read: (file) => readFileSync(file, "utf8"),
});
if (list === null) {
  console.log("No failed tests to retry.");
  process.exit(0);
}
console.log(
  JSON.stringify({
    node: process.version,
    cpus: availableParallelism(),
    memoryGiB: Math.round(totalmem() / 1024 ** 3),
    shard,
    cases: readFileSync(`packages/app/${list}`, "utf8").trim().split("\n").length,
  }),
);
const result = spawnSync(
  "npm",
  [
    "exec",
    "--workspace=@getpaseo/app",
    "--",
    "playwright",
    "test",
    "--project=browser",
    `--test-list=${list}`,
    "--workers=4",
    "--global-timeout=420000",
  ],
  { stdio: "inherit", env: { ...process.env, E2E_SELECTED_LIST: list } },
);
process.exit(result.status ?? 1);
