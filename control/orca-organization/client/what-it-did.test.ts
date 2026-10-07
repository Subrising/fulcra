import test from "node:test";
import assert from "node:assert/strict";
import type { Step } from "../shared/session-steps";
import {
  diffSize,
  duration,
  stepsFromToolCalls,
  whatItDid,
  whatItDidFromSteps,
} from "./what-it-did";

let seq = 0;
const step = (over: Partial<Step>): Step => ({
  n: seq,
  seq: seq++,
  at: "2026-10-06T12:00:00.000Z",
  kind: "other",
  summary: "Used a tool",
  outcome: "done",
  changesFiles: false,
  files: [],
  command: null,
  exitCode: null,
  output: null,
  why: null,
  ref: null,
  ...over,
});
const read = (path: string) =>
  step({
    kind: "read",
    summary: `Read ${path}`,
    files: [{ path, change: "read", diff: null, ref: null }],
  });
const turn = {
  startedAt: "2026-10-06T12:00:00.000Z",
  endedAt: "2026-10-06T12:00:19.000Z",
  note: null,
};

test("a turn reads as numbered plain lines with sizes and a test badge", () => {
  const result = whatItDid(turn, [
    step({
      kind: "command",
      summary: "Looked around the project",
      command: "ls -la; git ls-files",
    }),
    read("weather.py"),
    read("README.md"),
    read("weather.py"),
    step({
      kind: "edit",
      summary: "Edited weather.py",
      changesFiles: true,
      files: [
        {
          path: "weather.py",
          change: "edited",
          diff: "--- a/weather.py\n+++ b/weather.py\n@@\n+one\n+two\n-old",
          ref: null,
        },
      ],
    }),
    step({
      kind: "create",
      summary: "Created test_weather.py",
      changesFiles: true,
      files: [{ path: "test_weather.py", change: "created", diff: null, ref: null }],
    }),
    step({
      kind: "command",
      summary: "Ran tests: 4 passed",
      command: "python3 -m unittest",
      exitCode: 0,
    }),
  ]);
  assert.deepEqual(
    result.lines.map((line) => line.text),
    [
      "Looked around the project",
      "Read weather.py and README.md",
      "Changed weather.py (+2 −1)",
      "Created test_weather.py",
      "Ran tests: 4 passed",
    ],
  );
  assert.equal(result.size, "7 steps · 19 s");
  assert.equal(result.tests, "passed");
  assert.deepEqual(result.commands, ["ls -la; git ls-files", "python3 -m unittest"]);
});

test("a failed test run is flagged and many reads are counted, not listed", () => {
  const result = whatItDid(
    {
      ...turn,
      endedAt: "bad",
      note: "Ran 1 command; changes made through commands are not listed.",
    },
    [
      read("a"),
      read("b"),
      read("c"),
      read("d"),
      read("e"),
      step({ kind: "search", summary: "Searched the project" }),
      step({ kind: "search", summary: "Searched the project" }),
      step({
        kind: "command",
        summary: "Ran tests: 2 failed",
        outcome: "failed",
        command: "npm test",
        exitCode: 1,
      }),
    ],
  );
  assert.deepEqual(result.lines, [
    { text: "Read a, b, c and 2 more files", failed: false },
    { text: "Searched the project 2 times", failed: false },
    { text: "Ran tests: 2 failed", failed: true },
  ]);
  assert.equal(result.tests, "failed");
  assert.equal(result.size, "8 steps");
  assert.match(result.note ?? "", /not listed/);
});

test("a turn without tools has no lines and no badge", () => {
  const result = whatItDid(turn, []);
  assert.deepEqual(result.lines, []);
  assert.equal(result.tests, null);
  assert.equal(result.size, "0 steps · 19 s");
});

test("sizes and durations", () => {
  assert.equal(diffSize(null), null);
  assert.deepEqual(diffSize("+++ b\n--- a\n+x\n-y\n-z"), { added: 1, removed: 2 });
  assert.equal(duration(42), "42 s");
  assert.equal(duration(125), "2 min");
  assert.equal(duration(3720), "1 h 2 min");
});

test("the chat's own tool calls read the same way, with project-relative paths", () => {
  const steps = stepsFromToolCalls(
    [
      {
        name: "Read",
        status: "completed",
        detail: { type: "read", filePath: "/work/app/weather.py" },
      },
      {
        name: "Edit",
        status: "completed",
        detail: {
          type: "edit",
          filePath: "/work/app/weather.py",
          unifiedDiff: "--- a/weather.py\n+++ b/weather.py\n@@\n+one\n-two",
        },
      },
      {
        name: "Bash",
        status: "completed",
        detail: { type: "shell", command: "npm test", output: "# pass 4\n# fail 0", exitCode: 0 },
      },
      { name: "Read", status: "completed", detail: { type: "read", filePath: "/etc/hosts" } },
    ],
    "/work/app",
  );
  const result = whatItDidFromSteps(steps, 19, null);
  assert.deepEqual(
    result.lines.map((line) => line.text),
    [
      "Read weather.py",
      "Changed weather.py (+1 −1)",
      "Ran tests: 4 passed",
      "Read a file outside the project",
    ],
  );
  assert.equal(result.size, "4 steps · 19 s");
  assert.equal(result.tests, "passed");
});
