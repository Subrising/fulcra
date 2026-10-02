import test from "node:test";
import assert from "node:assert/strict";
import { pageRequest, pageResult, validCursor } from "./history.mjs";
const scope = "a".repeat(64),
  agentId = "agent",
  epoch = "epoch",
  cursor = { scope, epoch, seq: 51 };
const page = (direction = "tail", start = 51, end = 100) => ({
  agentId,
  direction,
  projection: "canonical",
  epoch,
  error: null,
  gap: false,
  reset: false,
  staleCursor: false,
  hasOlder: start > 1,
  hasNewer: direction === "before",
  startCursor: { epoch, seq: start },
  endCursor: { epoch, seq: end },
  entries: Array.from({ length: end - start + 1 }, (_, i) => ({
    seqStart: start + i,
    seqEnd: start + i,
    item: { type: "user_message", text: "PRIVATE" },
  })),
});
test("actual request direction and epoch bind both pages; continuation strictly progresses", () => {
  const tail = pageRequest(null, scope),
    first = pageResult(page(), tail, scope, agentId);
  assert.deepEqual(first, { cursor });
  const before = pageRequest(cursor, scope),
    older = page("before", 1, 50);
  assert.deepEqual(pageResult(older, before, scope, agentId), { cursor: null });
  assert.throws(() => {
    before.direction = "tail";
  });
  assert.throws(() => {
    before.cursor.seq = 900;
  });
  assert.throws(() => pageResult(older, tail, scope, agentId));
});
test("malformed and foreign continuation cannot become native requests", () => {
  for (const change of [
    { scope: "b".repeat(64) },
    { scope: 5 },
    { scope: {} },
    { epoch: "" },
    { epoch: "a".repeat(257) },
    { epoch: "bad\n" },
    { seq: -1 },
    { seq: 1.5 },
    { seq: Number.MAX_SAFE_INTEGER + 1 },
    { extra: true },
  ])
    assert.throws(() => pageRequest({ ...cursor, ...change }, scope));
  assert(!validCursor(null));
  assert(!validCursor([]));
});
test("canonical page flags, identity, bounds and sequence errors refuse instead of empty success", () => {
  const request = pageRequest(cursor, scope),
    base = page("before", 1, 50);
  for (const change of [
    { agentId: "foreign" },
    { direction: "tail" },
    { projection: "unknown" },
    { epoch: "other" },
    { error: "bad" },
    { gap: true },
    { reset: true },
    { staleCursor: true },
    { hasOlder: "true" },
    { hasNewer: null },
    { entries: null },
    { entries: Array(51).fill(base.entries[0]) },
    { startCursor: null },
    { endCursor: { epoch, seq: 49 } },
    { entries: [base.entries[1], base.entries[0]] },
    { entries: [{ seqStart: 0, seqEnd: 51 }] },
    { entries: [{ seqStart: -1, seqEnd: 0 }] },
    { entries: [{ seqStart: 1, seqEnd: 0 }] },
  ])
    assert.throws(() => pageResult({ ...base, ...change }, request, scope, agentId));
  assert.throws(() =>
    pageResult({ ...page(), hasNewer: true }, pageRequest(null, scope), scope, agentId),
  );
});
test("empty terminal pages stay empty; false older claims and zero/loop cursors refuse", () => {
  const empty = {
    ...page("before"),
    entries: [],
    startCursor: null,
    endCursor: null,
    hasOlder: false,
  };
  assert.deepEqual(pageResult(empty, pageRequest(cursor, scope), scope, agentId), { cursor: null });
  assert.throws(() =>
    pageResult({ ...empty, hasOlder: true }, pageRequest(cursor, scope), scope, agentId),
  );
  assert.throws(() =>
    pageResult(
      { ...page("before", 0, 0), hasOlder: true },
      pageRequest(cursor, scope),
      scope,
      agentId,
    ),
  );
});
test("seeded malformed sequence positions never escape their request bound", () => {
  let seed = 197;
  for (let n = 0; n < 64; n++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const bad = 51 + (seed % 1000),
      p = {
        ...page("before", 1, 1),
        entries: [{ seqStart: bad, seqEnd: bad }],
        startCursor: { epoch, seq: bad },
        endCursor: { epoch, seq: bad },
      };
    assert.throws(() => pageResult(p, pageRequest(cursor, scope), scope, agentId));
  }
});

test("cursor validation works without modern String methods and rejects lone UTF-16 surrogates", () => {
  const original = Object.getOwnPropertyDescriptor(String.prototype, "isWellFormed");
  try {
    delete String.prototype.isWellFormed;
    for (const value of ["epoch", "😄", "a".repeat(256)])
      assert(validCursor({ ...cursor, epoch: value }));
    for (const value of ["\ud800", "\udfff", "a\ud800z", "\udc00\ud800"])
      assert(!validCursor({ ...cursor, epoch: value }));
    assert.equal(pageRequest(cursor, scope).direction, "before");
  } finally {
    if (original) Object.defineProperty(String.prototype, "isWellFormed", original);
  }
});

test("projected lifecycle overlap and backward anchor bounds follow the native contract", () => {
  const p = {
    ...page("before", 1, 2),
    projection: "projected",
    window: { minSeq: 1, maxSeq: 100 },
    hasOlder: false,
    startCursor: { epoch, seq: 1 },
    endCursor: { epoch, seq: 50 },
    entries: [
      { seqStart: 1, seqEnd: 100 },
      { seqStart: 2, seqEnd: 2 },
    ],
  };
  assert.deepEqual(pageResult(p, pageRequest(cursor, scope), scope, agentId), { cursor: null });
  for (const change of [
    { window: null },
    { endCursor: { epoch, seq: 49 } },
    { entries: [{ seqStart: 1, seqEnd: 101 }] },
    { entries: [{ seqStart: 51, seqEnd: 51 }] },
  ])
    assert.throws(() =>
      pageResult({ ...p, ...change }, pageRequest(cursor, scope), scope, agentId),
    );
});
test("expanded projected tails preserve access to rows outside the display limit", () => {
  const p = {
    ...page("tail", 1, 60),
    projection: "projected",
    window: { minSeq: 1, maxSeq: 100 },
    endCursor: { epoch, seq: 100 },
    hasOlder: false,
  };
  p.entries[0].seqEnd = 100;
  assert.deepEqual(pageResult(p, pageRequest(null, scope), scope, agentId), {
    cursor: { scope, epoch, seq: 11 },
  });
});
