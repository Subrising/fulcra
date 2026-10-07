import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanupErrorWords,
  doneSummary,
  groupPlanned,
  keepTimeNote,
  settle,
  type CleanupItem,
} from "./cleanup-now";

const MB = 1048576;
const item = (over: Partial<CleanupItem>): CleanupItem => ({
  id: "x",
  action: "archive",
  state: "planned",
  reason: "Finished job",
  bytes: 0,
  ...over,
});

test("planned items group as archive, close, remove, with counts and freed space", () => {
  const groups = groupPlanned([
    item({ id: "w1", action: "worktree", bytes: 3 * MB }),
    item({ id: "r1", action: "reap" }),
    item({ id: "a1" }),
    item({ id: "a2" }),
    item({ id: "w2", action: "worktree", bytes: 2 * MB }),
  ]);
  assert.deepEqual(
    groups.map((g) => [g.action, g.title, g.items.length]),
    [
      ["archive", "Archive 2 finished jobs", 2],
      ["reap", "Close 1 idle session (history and owner kept)", 1],
      ["worktree", "Remove 2 job folders · 5.0 MB", 2],
    ],
  );
  assert.deepEqual(groupPlanned([]), []);
});

test("done summary names what changed and how many were kept", () => {
  assert.equal(
    doneSummary([
      item({ state: "complete" }),
      item({ action: "reap", state: "complete" }),
      item({ action: "worktree", state: "complete", bytes: 2 * 1073741824 }),
      item({ action: "worktree", state: "needs-attention", bytes: 5 * MB }),
    ]),
    "Done: 1 job archived, 1 idle session closed, 2.0 GB freed. 1 item was kept; see below.",
  );
  assert.equal(
    doneSummary([item({ state: "skipped" }), item({ state: "skipped" })]),
    "Nothing was changed. 2 items were kept; see below.",
  );
  assert.equal(doneSummary([]), "Nothing was changed.");
});

test("errors and the keep-time note read plainly", () => {
  assert.match(cleanupErrorWords(Error("Preview expired; start again")), /Preview again/);
  assert.match(cleanupErrorWords(Error("Cleanup expired; start again")), /Preview again/);
  assert.match(cleanupErrorWords(Error("Clean-up is already running")), /already running/);
  assert.equal(cleanupErrorWords("boom"), "Could not finish. Preview again and retry.");
  assert.match(keepTimeNote("never") ?? "", /not removed, even by Clean up now/);
  assert.equal(keepTimeNote(7), null);
});

test("settle follows a pending operation until it has a value", async () => {
  const polled: string[] = [];
  let waits = 0;
  const value = await settle(
    async () => ({ pending: true as const, operationId: "op" }),
    async (operationId) => {
      polled.push(operationId);
      return polled.length < 2
        ? { pending: true as const, operationId }
        : { pending: false as const, operationId, value: 42 };
    },
    async () => {
      waits += 1;
    },
  );
  assert.equal(value, 42);
  assert.deepEqual(polled, ["op", "op"]);
  assert.equal(waits, 2);
});
