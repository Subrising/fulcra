import test from "node:test";
import assert from "node:assert/strict";
import { createAskJobs, MAX_RUNNING_ASKS, KEEP_ASK_JOBS_MS } from "./ask-jobs";

const result = { output: "hi", account: "Work", model: "claude-haiku-5-5", costUsd: 0.001 };
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("an ask runs, then gives its result by id", async () => {
  let release!: () => void;
  const jobs = createAskJobs<{ prompt: string }>({
    run: () => new Promise((resolve) => (release = () => resolve(result))),
  });
  const { id } = jobs.start({ prompt: "x" });
  assert.deepEqual(jobs.result(id), { state: "running" });
  release();
  await tick();
  assert.deepEqual(jobs.result(id), { state: "done", result });
});

test("a failed ask keeps its error code and message, and an unknown id says so", async () => {
  const jobs = createAskJobs<object>({
    run: () =>
      Promise.reject(
        Object.assign(new Error("Every usable account is at its limit"), { code: "ALL_LIMITED" }),
      ),
  });
  const { id } = jobs.start({});
  await tick();
  assert.deepEqual(jobs.result(id), {
    state: "failed",
    error: { code: "ALL_LIMITED", message: "Every usable account is at its limit" },
  });
  assert.equal(jobs.result("00000000-0000-4000-8000-000000000000").error?.code, "UNKNOWN_JOB");
});

test("a start past the running limit is refused, and old finished jobs are dropped", async () => {
  let time = 0;
  const jobs = createAskJobs<object>({ run: () => new Promise(() => {}), now: () => time });
  for (let i = 0; i < MAX_RUNNING_ASKS; i++) jobs.start({});
  assert.throws(() => jobs.start({}), /Too many asks/);
  const quick = createAskJobs<object>({ run: async () => result, now: () => time });
  const { id } = quick.start({});
  await tick();
  time = KEEP_ASK_JOBS_MS + 1;
  quick.start({});
  assert.equal(quick.result(id).error?.code, "UNKNOWN_JOB");
});

// 0.2.17 review: the credential of the selected account must not cross the job boundary in a result or an error.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { askOnce, scrubCredential, TOO_DEEP } from "./ask.mjs";
import { addAccount } from "./accounts.mjs";

test("a child that prints the account credential leaks it into no job result and no job error", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fulcra-ask-jobs-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const account = await addAccount(root, { provider: "claude", name: "Work" }, Date.now());
  const token = `sk-ant-oat01-${account.id}-SECRET`;
  const keychain = { get: async () => token };
  // The credential 40 levels down, as a value or as a key.
  const deep = (secret: string, asKey: boolean) => {
    let value: unknown = asKey ? { [secret]: 1 } : { leaf: secret };
    for (let i = 0; i < 40; i++) value = { next: value };
    return value;
  };
  const leak = {
    good: async () => ({ is_error: false, result: `answer ${token}`, modelUsage: { [token]: {} } }),
    bad: async () => ({ is_error: true, api_error_status: 500, result: `diagnostic ${token}` }),
    structured: async () => ({ is_error: false, structured_output: { note: token } }),
    deepValue: async () => ({
      is_error: false,
      result: "ok",
      structured_output: deep(token, false),
    }),
    deepKey: async () => ({ is_error: false, result: "ok", structured_output: deep(token, true) }),
    thrown: async () => {
      throw new Error(`spawn text ${token}`);
    },
  };
  for (const [name, spawnClaude] of Object.entries(leak)) {
    const schema =
      name === "structured" || name.startsWith("deep") ? { type: "object" } : undefined;
    let finished!: Promise<unknown>;
    const jobs = createAskJobs<{ prompt: string; model: string; schema?: unknown }>({
      run: (input) => {
        const pending = askOnce({ root, keychain, input, spawnClaude });
        finished = pending.catch(() => undefined);
        return pending;
      },
    });
    const { id } = jobs.start({ prompt: "x", model: "claude-haiku-5-5", schema });
    // Await the real runner, then allow the job store to record its outcome.
    await finished;
    await tick();
    const view = jobs.result(id);
    if (name.startsWith("deep")) {
      assert.equal(view.state, "failed", name);
      assert.equal(view.error?.code, "OUTPUT_SCHEMA_FAILED", name);
      assert.equal(view.result, undefined, name);
      const cleaned = JSON.stringify(scrubCredential(deep(token, name === "deepKey"), token));
      assert.equal(cleaned.includes(TOO_DEEP), true, name);
      assert.equal(cleaned.includes(token), false, name);
    } else if (name === "structured") {
      assert.equal(view.state, "done");
      assert.deepEqual(view.result?.output, { note: "[redacted]" });
    } else assert.notEqual(view.state, "running", name);
    assert.equal(
      JSON.stringify(view).includes(token),
      false,
      `${name}: the job view holds the credential`,
    );
  }
});

test("billing errors remain visible after the in-memory ask job is lost", async (t) => {
  const { readBilling } = await import("./account-billing.mjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "api-ask-billing-job-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const account = await addAccount(root, { provider: "claude", name: "personal-workspace-api" });
  let finished!: Promise<unknown>;
  const jobs = createAskJobs<{ prompt: string; model: string }>({
    run: (input) => {
      const call = askOnce({
        root,
        input,
        keychain: { get: async () => "sk-ant-api03-fixture-only-secret" },
        spawnClaude: async () => ({
          is_error: true,
          result: "credit balance too low sk-ant-api03-fixture-only-secret",
        }),
      });
      finished = call.catch(() => undefined);
      return call;
    },
  });
  const { id } = jobs.start({ prompt: "private", model: "claude-sonnet-5-5" });
  await finished;
  await tick();
  assert.equal(jobs.result(id).error?.code, "BILLING_ERROR");
  const freshJobs = createAskJobs({ run: async () => result });
  assert.equal(freshJobs.result(id).error?.code, "UNKNOWN_JOB");
  assert.equal(readBilling(root).events[0].type, "ask.billing_error");
  assert.equal(readBilling(root).events[0].accountId, account.id);
  assert.equal(
    JSON.stringify(readBilling(root)).includes("sk-ant-api03-fixture-only-secret"),
    false,
  );
});
