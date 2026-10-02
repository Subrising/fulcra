import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  BOOT_DISK_MB,
  CONSTRAINTS,
  GO,
  GUARD_PATH,
  NOGO,
  READS,
  bootDisk,
  daemonObservations,
  guardPin,
  order,
  quiescence,
  render,
  sourceDrift,
  unpushedWork,
} from "./deploy-readiness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const idle = (id) => ({ observed: { status: "idle", pending: 0 } });
const FOUR = [
  { id: "00000000-0000-0000-0000-000000002021", mode: "delegated" },
  { id: "00000000-0000-0000-0000-000000002018", mode: "delegated" },
  { id: "00000000-0000-0000-0000-000000002015", mode: "delegated" },
  { id: "00000000-0000-0000-0000-000000002010", mode: "delegated" },
  { id: "00000000-0000-0000-0000-000000002019", mode: "human" },
];
const allIdle = Object.fromEntries(
  FOUR.filter((s) => s.mode === "delegated").map((s) => [s.id, idle(s.id)]),
);

test("quiescence: a running session blocks, and a human session is not counted", () => {
  assert.equal(quiescence(FOUR, allIdle).verdict, GO);
  assert.match(quiescence(FOUR, allIdle).measured, /all 4 delegated session\(s\) idle/);
  const running = { ...allIdle, [FOUR[1].id]: { observed: { status: "running", pending: 0 } } };
  assert.equal(quiescence(FOUR, running).verdict, NOGO);
  assert.match(quiescence(FOUR, running).measured, /655cd98f status=running/);
  // pending is a separate way to be busy and must block on its own.
  const pending = { ...allIdle, [FOUR[0].id]: { observed: { status: "idle", pending: 2 } } };
  assert.equal(quiescence(FOUR, pending).verdict, NOGO);
  assert.match(quiescence(FOUR, pending).measured, /pending=2/);
  // A human session that is busy is irrelevant to the hold; only delegated work is lost on restart.
  assert.equal(
    quiescence(FOUR, { ...allIdle, [FOUR[4].id]: { observed: { status: "running" } } }).verdict,
    GO,
  );
});

// The defect class this mission keeps producing is an unknown reported as a definite. There must be no
// path from "could not look" to GO, for any check.
test("a check that could not run is NO-GO and says so, never GO", () => {
  const unreadable = { ...allIdle, [FOUR[2].id]: { __error: "timed out" } };
  const r = quiescence(FOUR, unreadable);
  assert.equal(r.verdict, NOGO);
  assert.equal(r.certainty, "unmeasured");
  assert.match(r.measured, /could not measure.*4f99d140 \(timed out\)/);
  for (const dead of [
    quiescence(null, {}),
    quiescence(FOUR, {}),
    bootDisk(null),
    bootDisk("header only"),
    guardPin(null),
    unpushedWork({}),
    unpushedWork({ count: null, branches: [] }),
  ]) {
    assert.equal(dead.verdict, NOGO, `${dead.id} passed without measuring`);
    assert.equal(dead.certainty, "unmeasured");
    assert.match(dead.measured, /^could not measure/);
  }
  // An empty delegated list is not proof of quiet: the packet expects four, so silence is unknown.
  assert.match(
    quiescence([{ id: "a", mode: "human" }], {}).measured,
    /no delegated sessions found/,
  );
});

test("boot disk: measured against the figure the packet gives, not a remembered one", () => {
  const df = (mb) =>
    `Filesystem 1M-blocks Used Available Capacity Mounted\n/dev/disk2s1s1 233752 11975 ${mb} 68% /`;
  assert.equal(BOOT_DISK_MB, 360);
  assert.equal(bootDisk(df(5864)).verdict, GO);
  assert.match(bootDisk(df(5864)).measured, /5864 MB available/);
  assert.equal(bootDisk(df(359)).verdict, NOGO, "one MB short is short");
  assert.equal(bootDisk(df(360)).verdict, GO, "exactly enough is enough");
  // The stale figure this section has twice carried would have read as a pass.
  assert.equal(bootDisk(df(304)).verdict, NOGO);
});

test("guard pin: blocking to deploy and correct to have, and it says which is which", () => {
  const pinned = guardPin(`${GUARD_PATH}\n`);
  assert.equal(pinned.verdict, NOGO);
  assert.equal(pinned.certainty, "measured", "a pinned guard is a measurement, not an unknown");
  assert.match(
    pinned.note,
    /NO-GO for deploying AND the correct state for not having deployed yet/,
  );
  assert.match(pinned.note, /git checkout HEAD -- src\/control\/admission-guard\.mjs/);
  assert.equal(guardPin("").verdict, GO);
  assert.equal(
    guardPin("src/control/other.mjs\n").verdict,
    GO,
    "another dirty file is not this pin",
  );
});

// Four branches here report [ahead N] while fully pushed, because their upstreams are release/* refs.
// Tracking status would call those unpushed; containment is the question that was meant.
test("unpushed: judged by containment, so a fully pushed [ahead N] branch is not a blocker", () => {
  const contained = [
    { name: "a", sha: "1111", contained: true },
    { name: "b", sha: "2222", contained: true },
  ];
  assert.equal(unpushedWork({ count: 0, branches: contained }).verdict, GO);
  assert.match(
    unpushedWork({ count: 0, branches: contained }).measured,
    /all 2 local branch tip\(s\) contained/,
  );
  // A real unpushed commit blocks even when every tip is contained.
  assert.equal(unpushedWork({ count: 3, branches: contained }).verdict, NOGO);
  assert.match(
    unpushedWork({ count: 3, branches: contained }).measured,
    /3 commit\(s\) on HEAD are on no remote/,
  );
  // And a tip on no remote blocks even when the count is 0 -- the two are different questions.
  const loose = unpushedWork({
    count: 0,
    branches: [...contained, { name: "c", sha: "3333", contained: false }],
  });
  assert.equal(loose.verdict, NOGO);
  assert.match(loose.measured, /contained in no remote branch: c \(3333\)/);
});

test("ordering constraints are printed as constraints, not as checks that were performed", () => {
  const text = render([bootDisk("h\n/dev/d 1 1 9999 1% /")], CONSTRAINTS);
  const tail = text.slice(text.indexOf("CONSTRAINTS"));
  assert.match(tail, /not checked, because they are not measurements/);
  assert.match(tail, /guard ships WITH or BEFORE the controller/);
  assert.match(tail, /strictly worse than today/);
  // The whole point: no verdict is attached to any of them.
  assert.doesNotMatch(
    tail,
    /\bGO\b|\bNO-GO\b/,
    "a constraint must not be dressed up with a verdict",
  );
  // The two the packet names that cannot be measured from here are listed, not dropped.
  assert.ok(
    CONSTRAINTS.some((c) => /restart window/i.test(c.title)),
    "the agreed restart window is not listed",
  );
  assert.ok(
    CONSTRAINTS.some((c) => /staged plugin/i.test(c.title)),
    "the staged plugin is not listed",
  );
});

test("worst first: unmeasured outranks a measured failure, and GO comes last", () => {
  const ranked = order([
    bootDisk("h\n/d 1 1 9999 1% /"),
    guardPin(`${GUARD_PATH}\n`),
    quiescence(null, {}),
  ]);
  assert.deepEqual(
    ranked.map((r) => r.id),
    ["quiescence", "guard-pin", "boot-disk"],
  );
  const text = render(ranked);
  assert.ok(text.indexOf("UNMEASURED") < text.indexOf("Admission-guard"), "the unknown must lead");
  assert.match(
    text,
    /^NO-GO -- 2 of 3 precondition\(s\) not satisfied, 1 because they could not be measured\.$/m,
  );
});

test("every check prints the command that produced its number", () => {
  const all = [
    quiescence(FOUR, allIdle),
    bootDisk("h\n/d 1 1 9999 1% /"),
    guardPin(""),
    unpushedWork({ count: 0, branches: [] }),
  ];
  for (const r of all) {
    assert.ok(r.command?.trim(), `${r.id} prints no command`);
    assert.ok(r.consequence?.length > 30, `${r.id} has no real consequence line`);
  }
  const text = render(all);
  assert.equal(
    text.match(/^ {7}command: /gm)?.length,
    4,
    "every check must print its command in the report",
  );
  assert.match(text, /df -m \//);
  assert.match(text, /git rev-list --count HEAD --not --remotes/);
});

// A wrong RPC name is trusted because it was printed. Checked against the server's own case list.
test("every RPC this tool uses exists in rpc.mjs, and none of them writes", () => {
  const rpc = fs.readFileSync(path.join(here, "rpc.mjs"), "utf8");
  const known = new Set([...rpc.matchAll(/case '([a-z-]+)':/g)].map((m) => m[1]));
  assert.ok(known.size > 20, `only ${known.size} RPC cases parsed`);
  assert.deepEqual(
    READS.filter((r) => !known.has(r)),
    [],
    "this tool names an RPC the server does not serve",
  );
  // `observe` is controller.inspect(), which takes sessions over. It must not come back.
  assert.deepEqual(READS, ["list"]);
  assert.ok(
    !READS.includes("observe"),
    "observe takes delegated sessions over; quiescence asks the daemon",
  );
  // No side effects: the module must never name a mutating method, not even in a string.
  const src = fs.readFileSync(path.join(here, "deploy-readiness.mjs"), "utf8");
  const forbidden = [
    "operator-send",
    "roles-adopt",
    "channels-open",
    "channels-close",
    "bindings-assign",
    "roles-allowance-set",
    "manager-promote",
    "management-ack",
    "leadership-transfer",
  ];
  assert.deepEqual(
    forbidden.filter((f) => src.includes(`'${f}'`)),
    [],
    "a mutating RPC is named in this tool",
  );
  assert.deepEqual(
    [...src.matchAll(/ask\('([a-z-]+)'/g)].map((m) => m[1]).filter((m) => !READS.includes(m)),
    [],
    "the tool calls an RPC it did not declare as a read",
  );
});

test("quiescence is measured without taking any session over", async () => {
  const src = fs.readFileSync(path.join(here, "deploy-readiness.mjs"), "utf8");
  // The whole point of the change: the controller's observe RPC is never called for quiescence.
  assert.deepEqual(
    [...src.matchAll(/ask\('([a-z-]+)'/g)].map((m) => m[1]),
    ["list"],
    "the only controller call left is list, which is a journal read",
  );
  assert.doesNotMatch(src, /ask\('observe'/, "observe takes delegated sessions over");
  // The old warning must be gone -- and gone because it stopped being true, which is what the tests
  // above and below establish. The note must not keep threatening a cost the tool no longer imposes.
  const note = quiescence(FOUR, Object.fromEntries(FOUR.map((s) => [s.id, idle(s.id)]))).note ?? "";
  assert.doesNotMatch(
    note,
    /ENDS the delegation/,
    "the tool no longer ends delegations; the note must not say it does",
  );
  assert.match(note, /without taking the session over/);
  assert.match(
    note,
    /Re-measure immediately before the restart/,
    "the honest half of the note stays",
  );
});

test("an unreachable daemon is NO-GO, never GO", async () => {
  const ids = FOUR.filter((s) => s.mode === "delegated").map((s) => s.id);
  const observations = await daemonObservations(ids, {
    connect: async () => {
      throw new Error("connect ECONNREFUSED");
    },
  });
  assert.deepEqual(
    Object.keys(observations).sort(),
    [...ids].sort(),
    "every id must be accounted for",
  );
  const verdict = quiescence(FOUR, observations);
  assert.equal(verdict.verdict, NOGO);
  assert.equal(verdict.certainty, "unmeasured");
  assert.match(verdict.measured, /could not measure.*daemon unreachable: connect ECONNREFUSED/);
});

test("a daemon that answers gives a verdict, and one bad agent is still not a pass", async () => {
  const ids = FOUR.filter((s) => s.mode === "delegated").map((s) => s.id);
  const connect = (statuses) => async () => ({
    status: async (id) => {
      const value = statuses[id];
      if (!value) throw new Error("no daemon snapshot for this agent");
      return value;
    },
    close: async () => {},
  });
  const allIdle = Object.fromEntries(ids.map((id) => [id, { status: "idle", pending: 0 }]));
  assert.equal(
    quiescence(FOUR, await daemonObservations(ids, { connect: connect(allIdle) })).verdict,
    GO,
  );
  // Busy and pending each block on their own, read from the daemon's own fields.
  assert.equal(
    quiescence(
      FOUR,
      await daemonObservations(ids, {
        connect: connect({ ...allIdle, [ids[1]]: { status: "running", pending: 0 } }),
      }),
    ).verdict,
    NOGO,
  );
  assert.equal(
    quiescence(
      FOUR,
      await daemonObservations(ids, {
        connect: connect({ ...allIdle, [ids[0]]: { status: "idle", pending: 2 } }),
      }),
    ).verdict,
    NOGO,
  );
  // One agent the daemon cannot describe is an unknown, not a pass.
  const partial = quiescence(
    FOUR,
    await daemonObservations(ids, { connect: connect({ ...allIdle, [ids[2]]: undefined }) }),
  );
  assert.equal(partial.verdict, NOGO);
  assert.equal(partial.certainty, "unmeasured");
});

// A detached worktree makes `git branch` emit "(HEAD detached at ...)", which parsed as a branch named
// "(no" with sha "branch)" and was reported as an unpushed tip. The tool invented its own NO-GO. The
// collection site now uses for-each-ref refs/heads; this guards the parse regardless of the caller.
test('an unparsable branch row is "could not measure", not a finding', () => {
  const r = unpushedWork({
    count: 0,
    branches: [{ name: "(no", sha: "branch)", contained: false }],
  });
  assert.equal(r.verdict, NOGO, "a parse fault must not pass as GO");
  assert.match(
    r.measured,
    /unparsable/,
    "it must say the enumeration is wrong, not that work is unpushed",
  );
  assert.doesNotMatch(
    r.measured,
    /contained in no remote/,
    "reporting a parse fault as unpushed work is the bug",
  );
  // And a real row still measures normally, so the guard has not swallowed the check.
  assert.equal(
    unpushedWork({ count: 0, branches: [{ name: "main", sha: "aae5f97e", contained: true }] })
      .verdict,
    GO,
  );
});

// The check that would have prevented the 2026-09-22 outage. Its value is entirely in refusing, so the
// refusals are what is pinned here.
// The distinction that was got wrong in production: a module differing from the baseline is either
// deployed or drifted, and those demand opposite responses.
test("a module that differs BECAUSE the guard is deployed in it is a GO, not drift", () => {
  const base = { "agent-manager.js": "pristineA", "../session.js": "pristineB" };
  const live = { "agent-manager.js": "patchedA", "../session.js": "patchedB" };
  const allPatched = sourceDrift(live, base, { "agent-manager.js": true, "../session.js": true });
  assert.equal(allPatched.verdict, GO, "a deployed guard must not be reported as drift");
  assert.match(allPatched.measured, /DEPLOYED/);
  assert.match(allPatched.note ?? "", /pristine digests/);

  // One patched, one genuinely moved upstream: the drifted one decides the verdict and is named.
  const mixed = sourceDrift(live, base, { "agent-manager.js": true });
  assert.equal(mixed.verdict, NOGO);
  assert.match(mixed.measured, /do NOT carry the guard/);
  assert.match(mixed.measured, /\.\.\/session\.js/);
  assert.match(mixed.measured, /1 other\(s\) are patched and fine/);
});

test("drifted released modules are a NO-GO, and unreadable ones are not silently a pass", () => {
  const base = { "agent-manager.js": "aaa", "../session.js": "bbb" };
  const ok = sourceDrift({ "agent-manager.js": "aaa", "../session.js": "bbb" }, base);
  assert.equal(ok.verdict, GO);
  assert.match(ok.measured, /all 2 module\(s\) match/);

  const drifted = sourceDrift({ "agent-manager.js": "aaa", "../session.js": "CHANGED" }, base);
  assert.equal(drifted.verdict, NOGO);
  assert.match(drifted.measured, /1 of 2 module\(s\) changed/);
  assert.match(drifted.measured, /\.\.\/session\.js/, "name the module, or the reader cannot act");
  assert.match(drifted.note ?? "", /Re-anchor/);

  // A module that could not be read is `null`, which must not compare equal to a digest by accident.
  assert.equal(
    sourceDrift({ "agent-manager.js": null, "../session.js": "bbb" }, base).verdict,
    NOGO,
  );
  // Could not measure at all -> NO-GO, never GO. No path from ignorance to green.
  assert.equal(sourceDrift(null, base).verdict, NOGO);
  assert.equal(sourceDrift({}, null).verdict, NOGO);
  // An empty baseline means the parse is wrong, not that the product is clean.
  assert.equal(sourceDrift({}, {}).verdict, NOGO);
  assert.match(sourceDrift({}, {}).measured, /parse is wrong/);
});
