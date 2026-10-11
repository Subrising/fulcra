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
