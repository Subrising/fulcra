import test from "node:test";
import assert from "node:assert/strict";
import {
  agoText,
  forgetAll,
  isDeadline,
  MEMORY_LIMIT,
  recall,
  remember,
  stallNotice,
  lastGood,
} from "./last-good";

const DEADLINE = new Error(
  "organization.fleet did not finish within 20 s; the controller or daemon is slow to answer. Refresh to try again.",
);
const T0 = Date.parse("2026-09-24T07:20:00Z"),
  MIN = 60000;

test("a read that misses its deadline shows the last good result with the plain notice", () => {
  forgetAll();
  const key = ["orca-fleet", "host-a"];
  assert.deepEqual(
    lastGood({ data: { n: 2 }, isError: false, error: null, dataUpdatedAt: T0 }, key, { now: T0 }),
    { data: { n: 2 }, notice: null, fromMemory: false },
  );
  // The query cache lost the data (a remount after garbage collection) and the next read missed its deadline.
  assert.deepEqual(
    lastGood({ data: undefined, isError: true, error: DEADLINE }, key, { now: T0 + 3 * MIN }),
    {
      data: { n: 2 },
      notice: "Last updated 3 min ago · Fulcra is slow to answer; retrying",
      fromMemory: true,
    },
  );
  assert.equal(
    lastGood({ data: undefined, isError: true, error: new Error("socket closed") }, key, {
      now: T0 + 3 * MIN,
    }).notice,
    "Last updated 3 min ago · Fulcra did not answer; retrying",
  );
  assert.equal(
    lastGood({ data: undefined, isError: false, error: null }, key, { now: T0 + MIN }).notice,
    "Last updated 1 min ago · checking for changes",
    "a first read in flight says the view is old",
  );
  assert.deepEqual(
    lastGood({ data: undefined, isError: true, error: DEADLINE }, ["orca-fleet", "host-b"], {
      now: T0,
    }),
    { data: undefined, notice: null, fromMemory: false },
    "nothing is borrowed from another host",
  );
});

test("a failure that arrives as data never replaces the last good result", () => {
  forgetAll();
  const key = ["orca-recovery"],
    failure = (d: { status: string; message?: string }) =>
      d.status === "error" ? d.message : null;
  lastGood({ data: { status: "observed" }, isError: false, error: null, dataUpdatedAt: T0 }, key, {
    now: T0,
    failure,
  });
  const stalled = lastGood(
    {
      data: { status: "error", message: "organization.recovery did not finish within 20 s" },
      isError: false,
      error: null,
    },
    key,
    { now: T0 + 2 * MIN, failure },
  );
  assert.deepEqual(stalled, {
    data: { status: "observed" },
    notice: "Last updated 2 min ago · Fulcra is slow to answer; retrying",
    fromMemory: true,
  });
  assert.deepEqual(recall(key), { data: { status: "observed" }, at: T0 });
});

test("an errored query whose own cache still holds data is shown with the notice", () => {
  forgetAll();
  assert.deepEqual(
    lastGood({ data: { n: 1 }, isError: true, error: DEADLINE, dataUpdatedAt: T0 }, ["k"], {
      now: T0 + 5 * MIN,
    }),
    {
      data: { n: 1 },
      notice: "Last updated 5 min ago · Fulcra is slow to answer; retrying",
      fromMemory: true,
    },
  );
});

test("memory is bounded, in-process only, and ages read plainly", () => {
  forgetAll();
  for (let i = 0; i <= MEMORY_LIMIT; i++) remember(["k", i], i, T0);
  assert.equal(recall(["k", 0]), null, "the oldest entry is dropped first");
  assert.deepEqual(recall(["k", MEMORY_LIMIT]), { data: MEMORY_LIMIT, at: T0 });
  assert.deepEqual(
    [agoText(10000), agoText(MIN), agoText(59 * MIN), agoText(125 * MIN)],
    ["just now", "1 min ago", "59 min ago", "2 h ago"],
  );
  assert.ok(
    isDeadline(DEADLINE) &&
      isDeadline(new Error("Plugin RPC timed out")) &&
      !isDeadline(new Error("refused")),
  );
  assert.equal(
    stallNotice(T0, T0 + 30000, DEADLINE),
    "Last updated just now · Fulcra is slow to answer; retrying",
  );
});

test("J0-9: the age comes from the observation itself when the payload carries one", () => {
  forgetAll();
  const key = ["orca-fleet", "host-a"],
    observedAt = new Date(T0 - 10 * MIN).toISOString();
  lastGood({ data: { observedAt, n: 1 }, isError: false, error: null, dataUpdatedAt: T0 }, key, {
    now: T0,
  });
  assert.equal(
    lastGood({ data: undefined, isError: true, error: DEADLINE }, key, { now: T0 + 2 * MIN })
      .notice,
    "Last updated 12 min ago · Fulcra is slow to answer; retrying",
  );
  // A payload claiming a future time never makes a result look newer than when it arrived.
  lastGood(
    {
      data: { observedAt: new Date(T0 + 60 * MIN).toISOString() },
      isError: false,
      error: null,
      dataUpdatedAt: T0,
    },
    ["k2"],
    { now: T0 },
  );
  assert.equal(recall(["k2"])?.at, T0);
});
