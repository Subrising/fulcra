import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { cleanTestEnv } from "./clean-test-env.mjs";

const scripts = path.dirname(fileURLToPath(import.meta.url));

test("removes FULCRA_* and live daemon values, keeps the rest", () => {
  const env = {
    FULCRA_COMMAND_CENTRE: "1",
    FULCRA_LEDGER_DIR: "/live",
    PASEO_HOME: "/live/.paseo",
    PASEO_AGENT_ID: "a",
    PASEO_MEMORY_GUARD: "off",
    PATH: "/bin",
  };
  const removed = cleanTestEnv(env);
  assert.deepEqual(removed.sort(), [
    "FULCRA_COMMAND_CENTRE",
    "FULCRA_LEDGER_DIR",
    "PASEO_AGENT_ID",
    "PASEO_HOME",
  ]);
  assert.deepEqual(env, { PASEO_MEMORY_GUARD: "off", PATH: "/bin" });
});

test("keeps FULCRA_TEST_* and names in FULCRA_TEST_KEEP_ENV", () => {
  const env = {
    FULCRA_TEST_HOST: "x",
    FULCRA_REPRO_FIXTURE: "/fixture",
    FULCRA_ACCOUNT_ID: "live",
    FULCRA_TEST_KEEP_ENV: "FULCRA_REPRO_FIXTURE, OTHER",
  };
  cleanTestEnv(env);
  assert.deepEqual(Object.keys(env).sort(), [
    "FULCRA_REPRO_FIXTURE",
    "FULCRA_TEST_HOST",
    "FULCRA_TEST_KEEP_ENV",
  ]);
});

test("node --test preload: a leaked variable does not reach the test", () => {
  const probe = "process.stdout.write(String(process.env.FULCRA_COMMAND_CENTRE))";
  const env = { ...process.env, FULCRA_COMMAND_CENTRE: "1" };
  const run = (args) =>
    execFileSync(process.execPath, [...args, "-e", probe], { env, encoding: "utf8" });
  assert.equal(run([]), "1");
  assert.equal(run(["--import", path.join(scripts, "clean-test-env-preload.mjs")]), "undefined");
});
