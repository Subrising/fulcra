// Fulcra J4: links with provenance (CONTRACTS §2.2) on the real controller over a temporary journal.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { ControlStore } from "./store.mjs";
import { Controller } from "./controller.mjs";
import { CcLinks } from "./cc-links.mjs";
import { rpc } from "./rpc.mjs";

const S = (n) => `44444444-4444-4444-8444-${String(n).padStart(12, "0")}`;
const T = (n) => `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;
const ISSUE = "issue:github:123456:42",
  PR = "pr:github:acme/app#17",
  COMMIT = `commit:github:acme/app@${"a".repeat(40)}`;
function setup(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-cc-links-"))),
    file = path.join(dir, "journal.sqlite");
  const store = new ControlStore(file);
  const native = new Proxy(
    {},
    {
      get: () => () => {
        throw Error("Links must not invoke the native runtime");
      },
    },
  );
  const control = new Controller({
    store,
    native,
    authority: async () => ({ id: "task", delegationAuthority: [] }),
  });
  control.ccLinks = new CcLinks(control);
  const request = rpc(control, "test-operator");
  t.after(() => {
    try {
      store.db.close();
    } catch {
      /* closed */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    store,
    control,
    op: (method, input) => request({ method, input, operator: "test-operator" }),
    request,
  };
}
const inferred = (extra = {}) => ({
  from: ISSUE,
  relation: "worked-by",
  to: `session:${S(1)}`,
  provenance: "inferred",
  confidence: "medium",
  evidence: "A commit by this session mentions #42.",
  ...extra,
});
const observe = (op, links) => op("cc-links-observe", { messageId: randomUUID(), links });

test("L1: every link method is operator-only; a capability lane cannot write or read links", async (t) => {
  const { request } = setup(t);
  for (const method of [
    "cc-links-set",
    "cc-links-remove",
    "cc-links-observe",
    "cc-links-for",
    "cc-link-history",
  ]) {
    await assert.rejects(
      request({ method, input: {}, capability: "x".repeat(43) }),
      /Operator authorization required/,
      method,
    );
  }
});

test("L2: pairs outside the allowed table are refused, both manual and automatic", async (t) => {
  const { op, store } = setup(t);
  const refusals = [
    [`session:${S(1)}`, "worked-by", ISSUE], // wrong direction
    [ISSUE, "fixes", PR], // only a PR fixes an issue
    [COMMIT, "worked-by", `session:${S(1)}`], // a commit is produced, not worked by
    [`session:${S(1)}`, "produced", ISSUE],
    [ISSUE, "worked-by", "issue:github:123456:43"],
    [ISSUE, "owns", `session:${S(1)}`],
    ["not a ref", "worked-by", `session:${S(1)}`],
  ];
  for (const [from, relation, to] of refusals) {
    await assert.rejects(
      op("cc-links-set", {
        messageId: randomUUID(),
        from,
        relation,
        to,
        evidence: "Set by hand.",
        expectedRevision: 0,
      }),
      /not allowed|cannot identify/,
      `${from} ${relation} ${to}`,
    );
  }
  const r = await observe(
    op,
    refusals.map(([from, relation, to]) => inferred({ from, relation, to })),
  );
  assert.deepEqual(r, { inserted: 0, upgraded: 0, kept: 0, refused: refusals.length });
  assert.equal(store.db.prepare("SELECT count(*) n FROM cc_links").get().n, 0);
  // The allowed ones are accepted.
  const ok = await observe(op, [
    inferred(),
    inferred({ from: `session:${S(1)}`, relation: "produced", to: COMMIT, confidence: "high" }),
    inferred({
      from: PR,
      relation: "fixes",
      to: ISSUE,
      provenance: "reported",
      confidence: "high",
    }),
  ]);
  assert.deepEqual(ok, { inserted: 3, upgraded: 0, kept: 0, refused: 0 });
});

test("L3: a manual link overrides an inferred one, and later inference never touches it", async (t) => {
  const { op } = setup(t);
  await observe(op, [inferred()]);
  const [row] = (await op("cc-links-for", { refs: [ISSUE] })).links;
  assert.equal(row.provenance, "inferred");
  const set = await op("cc-links-set", {
    messageId: randomUUID(),
    from: ISSUE,
    relation: "worked-by",
    to: `session:${S(1)}`,
    evidence: "Confirmed by the operator.",
    expectedRevision: row.revision,
  });
  assert.deepEqual(
    [set.link.provenance, set.link.confidence, set.link.revision, set.link.by],
    ["manual", "high", 2, "operator"],
  );
  // Even a stronger automatic observation keeps the manual row.
  assert.deepEqual(
    await observe(op, [
      inferred({ provenance: "reported", confidence: "high", evidence: "Trailer says so." }),
    ]),
    { inserted: 0, upgraded: 0, kept: 1, refused: 0 },
  );
  const after = (await op("cc-links-for", { refs: [ISSUE] })).links[0];
  assert.deepEqual(
    [after.provenance, after.evidence, after.revision],
    ["manual", "Confirmed by the operator.", 2],
  );
});

test("L4: a removed inferred link is never re-inferred; the operator can still set it by hand", async (t) => {
  const { op } = setup(t);
  await observe(op, [inferred()]);
  const [row] = (await op("cc-links-for", { refs: [ISSUE] })).links;
  const removed = await op("cc-links-remove", {
    messageId: randomUUID(),
    id: row.id,
    expectedRevision: row.revision,
  });
  assert.equal(removed.link.state, "removed");
  assert.deepEqual(
    await observe(op, [inferred(), inferred({ provenance: "reported", confidence: "high" })]),
    { inserted: 0, upgraded: 0, kept: 2, refused: 0 },
  );
  assert.equal((await op("cc-links-for", { refs: [ISSUE] })).links.length, 0);
  assert.equal(
    (await op("cc-links-for", { refs: [ISSUE], includeRemoved: true })).links[0].state,
    "removed",
  );
  const back = await op("cc-links-set", {
    messageId: randomUUID(),
    from: ISSUE,
    relation: "worked-by",
    to: `session:${S(1)}`,
    evidence: "Put back by the operator.",
    expectedRevision: removed.link.revision,
  });
  assert.deepEqual([back.link.state, back.link.provenance], ["active", "manual"]);
  const history = (await op("cc-link-history", row.id)).history.map((h) => h.action);
  assert.deepEqual(history, ["infer", "remove", "override"]);
});

test("L5: automatic observations upgrade only to something stronger", async (t) => {
  const { op } = setup(t);
  await observe(op, [inferred({ confidence: "medium" })]);
  assert.deepEqual(await observe(op, [inferred({ confidence: "low" })]), {
    inserted: 0,
    upgraded: 0,
    kept: 1,
    refused: 0,
  });
  assert.deepEqual(
    await observe(op, [
      inferred({ confidence: "high", evidence: "The commit was made in its folder." }),
    ]),
    { inserted: 0, upgraded: 1, kept: 0, refused: 0 },
  );
  assert.deepEqual(
    await observe(op, [
      inferred({
        provenance: "reported",
        confidence: "high",
        evidence: "The commit names this session.",
      }),
    ]),
    { inserted: 0, upgraded: 1, kept: 0, refused: 0 },
  );
  const [row] = (await op("cc-links-for", { refs: [`session:${S(1)}`] })).links;
  assert.deepEqual([row.provenance, row.confidence, row.revision], ["reported", "high", 3]);
  // An automatic write can never claim to be manual.
  assert.deepEqual(await observe(op, [inferred({ provenance: "manual", confidence: "high" })]), {
    inserted: 0,
    upgraded: 0,
    kept: 0,
    refused: 1,
  });
});

test("L6: a retried messageId returns the first result; a stale revision is refused in plain words", async (t) => {
  const { op, store } = setup(t);
  const messageId = randomUUID(),
    input = {
      messageId,
      from: PR,
      relation: "worked-by",
      to: `task:${T(1)}`,
      evidence: "Worked on under this task.",
      expectedRevision: 0,
    };
  const first = await op("cc-links-set", input),
    again = await op("cc-links-set", input);
  assert.deepEqual(again, first);
  assert.equal(store.db.prepare("SELECT count(*) n FROM cc_link_history").get().n, 1);
  await assert.rejects(
    op("cc-links-set", { ...input, messageId: randomUUID() }),
    /Changed since you looked; refresh/,
  );
  await assert.rejects(
    op("cc-links-remove", { messageId: randomUUID(), id: first.link.id, expectedRevision: 9 }),
    /Changed since you looked; refresh/,
  );
});

test("L7: evidence is one plain sentence with no personal data", async (t) => {
  const { op } = setup(t);
  for (const evidence of [
    "",
    "x".repeat(301),
    `Made in /${"Users"}/someone/work.`,
    `Mailed to someone${"@"}example.com.`,
  ]) {
    await assert.rejects(
      op("cc-links-set", {
        messageId: randomUUID(),
        from: PR,
        relation: "fixes",
        to: ISSUE,
        evidence,
        expectedRevision: 0,
      }),
      /Evidence/,
    );
  }
  assert.deepEqual(await observe(op, [inferred({ evidence: `Found in /${"Volumes"}/disk.` })]), {
    inserted: 0,
    upgraded: 0,
    kept: 0,
    refused: 1,
  });
});
