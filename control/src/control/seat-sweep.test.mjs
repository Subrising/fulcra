// STAGE2-DESIGN.md s3: the automatic seat sweep, R9, the mode file, and the operator path under R9.
//
// The native side is a fake (as in boot-reestablishment.test.mjs), but the human-input evidence is REAL:
// every boot's log is written by the actual guard source run as a child "daemon" (human-log.fixture.mjs).
// So these tests prove the controller half end to end against genuine logs; the guard half is proven in
// human-log.test.mjs. Test names carry the mutation each one kills (STAGE2-DESIGN.md s8).
import { requireUnpinnedAdmissionGuard } from "./admission-guard-precondition.mjs";
requireUnpinnedAdmissionGuard();
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { FENCE_PROTOCOL } from "./native-fence.mjs";
import { ControlStore } from "./store.mjs";
import { Controller } from "./controller.mjs";
import { Bindings } from "./bindings.mjs";
import { COMPANY, PROGRAMME } from "./authority.mjs";
import { rpc } from "./rpc.mjs";
import {
  reestablishable,
  REESTABLISH,
  REVOKE,
  DECLINE,
  OPERATOR,
  SWEEP,
} from "./boot-reestablishment.mjs";
import { sweepSeats, sweepMode, sweepCandidates, MODE_FILE } from "./seat-sweep.mjs";
import { home, runBoot, humanDir, armed, OLD_GUARD } from "./human-log.fixture.mjs";
import { disarmHumanChain } from "./human-log.mjs";
import { unverifiedListener } from "./activation.mjs";
import net from "node:net";
import { spawnSync } from "node:child_process";

const P = (n) => `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`;
const T = (n) => `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;
const issue = (id) => ({
  id,
  companyId: COMPANY,
  parentId: id === PROGRAMME ? null : PROGRAMME,
  assigneeUserId: "local-board",
  assigneeAgentId: null,
  status: "in_progress",
});

function fixture(t) {
  const h = home(t, "orca-c2-sweep-");
  const store = new ControlStore(path.join(h, "journal.sqlite"));
  t.after(() => store.close());
  const states = new Map();
  let boot = randomUUID(),
    hooks = {};
  const observe = (id) => ({
    boot,
    fenceProtocol: FENCE_PROTOCOL,
    saturated: false,
    humanAt: 0,
    status: "idle",
    pending: 0,
    lastPromptId: null,
    lastUserAt: null,
    archivedAt: null,
    ...states.get(id),
  });
  const native = {
    route: () => undefined,
    inspect: async (id) => {
      if (states.get(id)?.gone) throw Error("Session unavailable");
      const seen = (hooks.inspects = (hooks.inspects ?? 0) + 1);
      await hooks.onInspect?.(id, seen);
      return observe(id);
    },
    send: async (id, _text, messageId) => {
      states.set(id, { ...states.get(id), lastPromptId: messageId });
    },
  };
  const control = new Controller({
    store,
    native,
    authority: async (id) => issue(id),
    humanLogDir: humanDir(h),
  });
  control.bindings = new Bindings(
    control,
    async () => ({
      observedAt: "2026-09-23T00:00:00.000Z",
      available: true,
      partial: false,
      projects: [1, 2, 3].map((n) => ({
        id: P(n),
        name: "P" + n,
        description: null,
        status: "in_progress",
      })),
      membership: [1, 2, 3].map((n) => ({ taskId: T(n), projectId: P(n) })),
      note: "test project source",
    }),
    path.join(h, "grants", "role"),
  );
  const request = rpc(control, "test-operator");
  const set = (id, patch) => states.set(id, { ...states.get(id), ...patch });
  let seats = 0;
  // A seated, delegated project orchestrator, granted at the current boot.
  const seat = async ({ humanAt = 0 } = {}) => {
    const n = ++seats,
      id = randomUUID();
    store.created(id, T(n), path.join(h, id));
    states.set(id, { humanAt });
    await control.bindings.assign({
      role: "project-orchestrator",
      seat: P(n),
      sessionId: id,
      expectedSessionGeneration: store.get(id).generation,
      expectedRevision: 0,
      note: "Owns delivery of this project",
    });
    await control.handback(id, "Delegated before the daemon restart");
    return id;
  };
  // A daemon restart: the in-memory counter resets for every session and the boot changes.
  const restart = (next) => {
    boot = next;
    for (const [id, s] of states) states.set(id, { ...s, humanAt: 0 });
  };
  const mode = (value, perm = 0o600) => {
    fs.rmSync(path.join(h, MODE_FILE), { force: true });
    fs.writeFileSync(path.join(h, MODE_FILE), value, { mode: perm });
    fs.chmodSync(path.join(h, MODE_FILE), perm);
  };
  const sweep = () => sweepSeats(control, { home: h, currentBoot: () => boot });
  const sweeps = (id) =>
    store.db.prepare("SELECT * FROM seat_sweeps WHERE session=? ORDER BY rowid").all(id);
  const operatorAttempts = (id) =>
    store.db.prepare("SELECT * FROM boot_reestablishments WHERE session=?").all(id);
  const hook = (fn) => {
    hooks.inspects = 0;
    hooks.onInspect = fn;
  };
  return {
    h,
    store,
    control,
    request,
    set,
    seat,
    restart,
    mode,
    sweep,
    sweeps,
    operatorAttempts,
    hook,
    boot: () => boot,
    setBoot: (b) => {
      boot = b;
    },
    reestablish: (id) =>
      request({
        method: "reestablish",
        operator: "test-operator",
        input: { sessionId: id, reason: "Operator re-pins this seat after the restart" },
      }),
    transfers: (id) =>
      Number(store.db.prepare("SELECT count(*) n FROM transfers WHERE session=?").get(id).n),
  };
}

// Grant in boot A (the boot the fixture starts at), run A as a real guard boot with the given inputs, then
// restart into boot B, which anchors A. Returns the seat and the two boots.
async function grantedThenRestarted(t, { inputs = [], end = "exit", humanAt = 0 } = {}) {
  const f = fixture(t),
    A = f.boot();
  const id = await f.seat({ humanAt });
  runBoot(f.h, { boot: A, inputs: inputs.map((x) => (x === "SEAT" ? id : x)), end });
  const B = randomUUID();
  runBoot(f.h, { boot: B });
  f.restart(B);
  return { ...f, id, A, B };
}

test("happy path: a clean, sealed, anchored history re-pins the seat automatically, and only once per boot (S16)", async (t) => {
  const f = await grantedThenRestarted(t, { inputs: [randomUUID()] });
  const before = f.store.get(f.id);
  f.mode("on");
  const out = await f.sweep();
  assert.equal(out.mode, "on");
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].reestablished, true);
  assert.equal(out.results[0].trigger, SWEEP);
  const after = f.store.get(f.id);
  assert.equal(after.boot, f.B);
  assert.equal(after.grantedAt, 1);
  assert.equal(after.mode, "delegated");
  assert.equal(after.generation, before.generation);
  assert.equal(f.transfers(f.id), 1);
  assert.equal(f.sweeps(f.id).at(-1).outcome, "reestablished");
  assert.deepEqual(f.operatorAttempts(f.id), [], "the sweep never spends the operator’s attempt");
  // Idempotent: nothing left to do at this boot.
  assert.deepEqual((await f.sweep()).results, []);
  // And the one-attempt rule is the unique index, not only the candidate query (S16).
  f.store.db.prepare("UPDATE sessions SET boot=? WHERE id=?").run(f.A, f.id);
  await assert.rejects(f.control.sweepSeat(f.id), /already been attempted/);
});

test("M20: an interrupt-only human input before the restart revokes the seat, though the timeline is unchanged (S14)", async (t) => {
  const f = await grantedThenRestarted(t, { inputs: ["SEAT"] });
  f.mode("on");
  const [result] = (await f.sweep()).results;
  assert.match(result.error, /human input reached this session/);
  assert.equal(f.store.get(f.id).mode, "human", "revoked, not merely declined (S14)");
  assert.equal(f.store.get(f.id).boot, f.A);
  assert.equal(f.sweeps(f.id).at(-1).outcome, "revoked");
});

test("D4: a dirty log revokes under the OPERATOR trigger too", async (t) => {
  const f = await grantedThenRestarted(t, { inputs: ["SEAT"] });
  await assert.rejects(f.reestablish(f.id), /human input reached this session/);
  assert.equal(f.store.get(f.id).mode, "human");
  assert.equal(f.operatorAttempts(f.id).at(-1).outcome, "revoked");
});

test("S6: only inputs at or after the grant count", async (t) => {
  // Granted at humanAt 1 (grantedAt 2): the first input in A was before the grant, the second after it.
  const pre = await grantedThenRestarted(t, { humanAt: 1, inputs: ["SEAT"] });
  assert.equal(pre.store.get(pre.id).grantedAt, 2);
  pre.mode("on");
  await pre.sweep();
  assert.equal(pre.store.get(pre.id).boot, pre.B, "a pre-grant input does not revoke");
  const post = await grantedThenRestarted(t, { humanAt: 1, inputs: ["SEAT", "SEAT"] });
  post.mode("on");
  await post.sweep();
  assert.equal(post.store.get(post.id).mode, "human");
});

test("S8: an input in an intermediate boot revokes, and the chain is walked across it", async (t) => {
  const f = fixture(t),
    A = f.boot(),
    id = await f.seat();
  runBoot(f.h, { boot: A });
  const B = randomUUID();
  runBoot(f.h, { boot: B, inputs: [id] });
  const C = randomUUID();
  runBoot(f.h, { boot: C });
  f.restart(C);
  f.mode("on");
  await f.sweep();
  assert.equal(f.store.get(id).mode, "human");
  // The same history with the input removed re-pins across both hops.
  const g = fixture(t),
    A2 = g.boot(),
    id2 = await g.seat();
  runBoot(g.h, { boot: A2 });
  runBoot(g.h, { boot: randomUUID() });
  const C2 = randomUUID();
  runBoot(g.h, { boot: C2 });
  g.restart(C2);
  g.mode("on");
  await g.sweep();
  assert.equal(g.store.get(id2).boot, C2);
});

test("M21 / S9 / S17: with no evidence (first restart after deploy) the sweep declines, and the operator can still act", async (t) => {
  const f = fixture(t),
    A = f.boot(),
    id = await f.seat();
  const B = randomUUID();
  f.restart(B); // A ran the OLD guard: no log exists at all
  f.mode("on");
  const [result] = (await f.sweep()).results;
  assert.match(result.error, /cannot vouch/);
  assert.equal(f.store.get(id).mode, "delegated", "declined: nothing written");
  assert.equal(f.store.get(id).boot, A, "still boot-stale, so still fenced");
  assert.equal(f.sweeps(id).at(-1).outcome, "declined");
  // Stage 1 is unchanged for the operator: a human authorises when the evidence is incomplete (S17: the
  // sweep's decline did not spend this attempt).
  const out = await f.reestablish(id);
  assert.equal(out.reestablished, true);
  assert.equal(out.trigger, OPERATOR);
  assert.equal(f.store.get(id).boot, B);
});

test("S13 / S5 at the sweep: an unsealed or tampered grant boot declines", async (t) => {
  const k = await grantedThenRestarted(t, { end: "kill" });
  k.mode("on");
  assert.match((await k.sweep()).results[0].error, /no exit seal/);
  assert.equal(k.store.get(k.id).mode, "delegated");
  const e = await grantedThenRestarted(t);
  const file = path.join(humanDir(e.h), e.A + ".log"),
    [header, seal] = fs.readFileSync(file, "utf8").split("\n");
  fs.writeFileSync(file, [header, JSON.stringify({ a: randomUUID(), n: 1 }), seal, ""].join("\n"));
  e.mode("on");
  assert.match((await e.sweep()).results[0].error, /changed after its successor anchored it/);
  assert.equal(e.store.get(e.id).boot, e.A);
});

test("S19: the sweep is off unless the mode file is present, private, regular and exact", async (t) => {
  const f = await grantedThenRestarted(t);
  assert.equal(sweepMode(f.h).mode, "off");
  assert.deepEqual((await f.sweep()).results, []);
  for (const [value, perm] of [
    ["ON", 0o600],
    ["on\nextra", 0o600],
    ["on", 0o644],
    ["", 0o600],
    ["off", 0o600],
  ]) {
    f.mode(value, perm);
    assert.equal(sweepMode(f.h).mode, "off", JSON.stringify([value, perm.toString(8)]));
    assert.deepEqual((await f.sweep()).results, []);
  }
  fs.rmSync(path.join(f.h, MODE_FILE));
  fs.writeFileSync(path.join(f.h, "real-mode"), "on", { mode: 0o600 });
  fs.symlinkSync(path.join(f.h, "real-mode"), path.join(f.h, MODE_FILE));
  assert.equal(sweepMode(f.h).mode, "off", "a symlink is not the prime’s file");
  fs.rmSync(path.join(f.h, MODE_FILE));
  assert.equal(f.store.get(f.id).boot, f.A, "nothing was swept");
  assert.deepEqual(f.sweeps(f.id), []);
  f.mode("on\n"); // trailing newline from `echo on >` is fine
  await f.sweep();
  assert.equal(f.store.get(f.id).boot, f.B);
});

test("S20: report mode records what it would do and writes no session row", async (t) => {
  const clean = await grantedThenRestarted(t),
    dirty = await grantedThenRestarted(t, { inputs: ["SEAT"] });
  for (const f of [clean, dirty]) {
    const before = f.store.get(f.id);
    f.mode("report");
    const [result] = (await f.sweep()).results;
    assert.equal(result.report, true);
    assert.deepEqual(f.store.get(f.id), before, "report mode changes no session row");
    assert.equal(f.transfers(f.id), 1);
  }
  assert.equal(clean.sweeps(clean.id).at(-1).outcome, "report-reestablish");
  assert.equal(dirty.sweeps(dirty.id).at(-1).outcome, "report-revoke");
  assert.equal(dirty.store.get(dirty.id).mode, "delegated", "no takeover in report mode");
});

test("candidates: only boot-stale, delegated, seated sessions not yet swept at this boot", async (t) => {
  const f = fixture(t),
    A = f.boot();
  const stale = await f.seat(),
    human = await f.seat();
  f.control.takeover(human, "Operator took this one over");
  const unseated = randomUUID();
  f.store.created(unseated, T(3), path.join(f.h, unseated));
  f.set(unseated, {});
  await f.control.handback(unseated, "Delegated but holds no seat");
  f.restart(randomUUID());
  const fresh = await f.seat(); // granted at the current boot
  assert.deepEqual(sweepCandidates(f.store.db, f.boot()), [stale]);
  assert.ok(A && fresh);
});

test("a human input during the sweep revokes (between the two observations)", async (t) => {
  const f = await grantedThenRestarted(t);
  f.mode("on");
  f.hook(async (id, seen) => {
    if (seen === 2) f.set(id, { humanAt: 1 });
  });
  assert.match((await f.sweep()).results[0].error, /changed during re-establishment/);
  assert.equal(f.store.get(f.id).mode, "human");
});

test("a crash after the claim burns this boot’s sweep attempt, fail-closed", async (t) => {
  const f = await grantedThenRestarted(t);
  f.mode("on");
  f.hook(async (_id, seen) => {
    if (seen === 2) throw Error("controller died here");
  });
  assert.match((await f.sweep()).results[0].error, /controller died here/);
  assert.equal(f.sweeps(f.id).at(-1).outcome, "attempted");
  f.hook(async () => {});
  assert.deepEqual((await f.sweep()).results, [], "never retried at this boot");
  assert.equal(f.store.get(f.id).boot, f.A);
  assert.equal(f.store.get(f.id).mode, "delegated");
  // The operator path is still open.
  assert.equal((await f.reestablish(f.id)).reestablished, true);
});

test("the sweep and a manual reestablish cannot both act: exclusive() refuses the second without claiming", async (t) => {
  const f = await grantedThenRestarted(t);
  f.mode("on");
  let release;
  const held = new Promise((r) => {
    release = r;
  });
  f.hook(async (_id, seen) => {
    if (seen === 1) await held;
  });
  const operator = f.reestablish(f.id);
  const swept = f.sweep();
  const [result] = (await swept).results;
  assert.match(result.error, /already in flight/);
  assert.deepEqual(f.sweeps(f.id), [], "the losing sweep claimed nothing");
  release();
  assert.equal((await operator).reestablished, true);
  assert.deepEqual((await f.sweep()).results, [], "already re-pinned: no longer a candidate");
});

test("a holder session that no longer exists is never revived and claims nothing", async (t) => {
  const f = await grantedThenRestarted(t);
  f.set(f.id, { gone: true });
  f.mode("on");
  assert.match((await f.sweep()).results[0].error, /Session unavailable/);
  assert.deepEqual(f.sweeps(f.id), []);
  assert.equal(f.store.get(f.id).boot, f.A);
});

test("R9 in the pure gate: dirty revokes under both triggers; only the operator tolerates missing evidence; strict by default", () => {
  const row = {
    mode: "delegated",
    boot: "b1",
    expected: "m",
    expectedAt: "x",
    authority: "k",
    generation: 7,
  };
  const current = {
    boot: "b2",
    fenceProtocol: FENCE_PROTOCOL,
    saturated: false,
    humanAt: 0,
    status: "idle",
    pending: 0,
    lastPromptId: "m",
    lastUserAt: "x",
    archivedAt: null,
  };
  const base = { seated: true, authorityKey: "k", dispatchSupported: true };
  const clean = { state: "clean", reason: null },
    dirty = { state: "dirty", reason: "human" },
    missing = { state: "unavailable", reason: "no log" };
  assert.equal(
    reestablishable(row, current, { ...base, trigger: SWEEP, humanLog: clean }).disposition,
    REESTABLISH,
  );
  assert.equal(
    reestablishable(row, current, { ...base, trigger: OPERATOR, humanLog: clean }).disposition,
    REESTABLISH,
  );
  assert.equal(
    reestablishable(row, current, { ...base, trigger: OPERATOR, humanLog: missing }).disposition,
    REESTABLISH,
  );
  assert.equal(
    reestablishable(row, current, { ...base, trigger: SWEEP, humanLog: missing }).disposition,
    DECLINE,
  );
  assert.equal(
    reestablishable(row, current, { ...base, humanLog: missing }).disposition,
    DECLINE,
    "no trigger means the strict rule",
  );
  assert.equal(
    reestablishable(row, current, { ...base, trigger: SWEEP }).disposition,
    DECLINE,
    "no verdict is not clean",
  );
  assert.equal(
    reestablishable(row, current, { ...base, trigger: SWEEP, humanLog: dirty }).disposition,
    REVOKE,
  );
  assert.equal(
    reestablishable(row, current, { ...base, trigger: OPERATOR, humanLog: dirty }).disposition,
    REVOKE,
  );
  // Dirty outranks a prompt-identity mismatch only in wording; both revoke.
  assert.equal(
    reestablishable(
      row,
      { ...current, lastPromptId: "z" },
      { ...base, trigger: SWEEP, humanLog: missing },
    ).disposition,
    REVOKE,
  );
});

// ---------------------------------------------------------------------------------------------
// Review F1 (C2-REVIEW.md): a boot that does not run the Stage 2 guard must never be chained over.
// ATTACK-1 and ATTACK-2 are the reviewer's reproductions; each must now DECLINE, never re-seat.
// ---------------------------------------------------------------------------------------------

// Grant in A (new guard, sealed), then boot X (whatever runX makes it), then new-guard boot B; swept at B.
async function acrossBootX(t, runX) {
  const f = fixture(t),
    A = f.boot(),
    id = await f.seat();
  runBoot(f.h, { boot: A });
  const X = randomUUID();
  f.restart(X);
  await runX({ f, id, A, X });
  const B = randomUUID();
  runBoot(f.h, { boot: B });
  f.restart(B);
  f.mode("on");
  const result = (await f.sweep()).results.find((r) => r.id === id);
  return { f, id, A, X, B, result };
}
function assertDeclined({ f, id, A, result }, pattern) {
  assert.notEqual(
    result.reestablished,
    true,
    "VULNERABLE: re-seated across a boot that kept no log",
  );
  assert.match(result.error, pattern);
  assert.equal(
    f.store.get(id).mode,
    "delegated",
    "declined, not revoked: nothing is known about the skipped boot",
  );
  assert.equal(f.store.get(id).boot, A);
  assert.equal(f.sweeps(id).at(-1).outcome, "declined");
}

test("ATTACK-2: R-2 rollback then re-activation -- the REAL bbc624cf9 guard boot is caught by its receipt alone", async (t) => {
  const run = await acrossBootX(t, ({ f, id, A, X }) => {
    const x = runBoot(f.h, { boot: X, inputs: [id], guard: OLD_GUARD }); // a human interrupts the seat in X
    assert.deepEqual(x.observed, [1], "the old guard counts it");
    assert.deepEqual(armed(f.h), [A], "but leaves the Stage 2 marker in place");
    assert.equal(fs.existsSync(path.join(humanDir(f.h), X + ".log")), false, "and writes no log");
  });
  assertDeclined(run, new RegExp(`Daemon boot ${run.X} ran between boots ${run.A} and ${run.B}`));
});

test("ATTACK-2 without any human input still declines: an unlogged boot proves nothing either way", async (t) => {
  assertDeclined(
    await acrossBootX(t, ({ f, X }) => {
      runBoot(f.h, { boot: X, guard: OLD_GUARD });
    }),
    /ran between boots/,
  );
});

test("ATTACK-1 via deploy/rollback: a release switch breaks the chain, so a guardless boot after it is never chained over", async (t) => {
  // deploy-admission.mjs --apply/--rollback call exactly this while the daemon is stopped; permission-overlay.py mirrors it.
  assertDeclined(
    await acrossBootX(t, ({ f, id }) => {
      disarmHumanChain(f.h);
      f.set(id, { humanAt: 1 });
    }),
    /chain breaks/,
  );
});

test("ATTACK-1 via launchd: the launcher disarms before exec unless the release on disk is the verified Stage 2 release", async (t) => {
  assertDeclined(
    await acrossBootX(t, ({ f, id }) => {
      const py = spawnSync(
        "python3",
        [
          "-c",
          'import sys; sys.path.insert(0, sys.argv[1]); from launch import guard_human_chain; print(len(guard_human_chain({"orcaHumanLog": {"home": sys.argv[2]}}, "paseo") or []))',
          new URL("../../service-recovery", import.meta.url).pathname,
          f.h,
        ],
        { encoding: "utf8" },
      );
      assert.equal(py.status, 0, py.stderr);
      assert.equal(
        py.stdout.trim(),
        "1",
        "the test home has no Stage 2 release on disk, so the marker must go",
      );
      f.set(id, { humanAt: 1 });
    }),
    /chain breaks/,
  );
});

test("legacy patch-route witness: an unverified listener breaks the retained legacy chain", async (t) => {
  assertDeclined(
    await acrossBootX(t, async ({ f, id }) => {
      const listener = net.createServer();
      await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
      try {
        assert.equal(unverifiedListener(f.h, listener.address().port), true);
        disarmHumanChain(f.h);
      } finally {
        await new Promise((resolve) => listener.close(resolve));
      }
      f.set(id, { humanAt: 1 });
    }),
    /chain breaks/,
  );
});

test("legacy patch-route witness does not fire on a daemon that is merely down", async (t) => {
  const h = home(t);
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  assert.equal(unverifiedListener(h, port), false);
});

test("receipts: a receipt replaced by pid reuse, or an unreadable snapshot, declines", async (t) => {
  // X reuses A's pid: its receipt overwrites A's. B then sees X and not A.
  assertDeclined(
    await acrossBootX(t, ({ f, A, X }) => {
      const receipt = fs
        .readdirSync(path.join(f.h, "admission"))
        .find(
          (n) =>
            n.startsWith("loaded-") &&
            JSON.parse(fs.readFileSync(path.join(f.h, "admission", n), "utf8")).boot === A,
        );
      fs.writeFileSync(path.join(f.h, "admission", receipt), JSON.stringify({ boot: X }), {
        mode: 0o600,
      });
    }),
    /ran between boots|was gone when boot/,
  );
  // A's receipt simply gone when B starts: the receipt history is not intact, so it cannot vouch (F1b).
  assertDeclined(
    await acrossBootX(t, ({ f, A }) => {
      const receipt = fs
        .readdirSync(path.join(f.h, "admission"))
        .find(
          (n) =>
            n.startsWith("loaded-") &&
            JSON.parse(fs.readFileSync(path.join(f.h, "admission", n), "utf8")).boot === A,
        );
      fs.unlinkSync(path.join(f.h, "admission", receipt));
    }),
    /was gone when boot/,
  );
  // A receipt the guard cannot parse leaves B's snapshot null: nothing can be ruled out.
  assertDeclined(
    await acrossBootX(t, ({ f }) => {
      fs.writeFileSync(path.join(f.h, "admission", "loaded-1.json"), "not json", { mode: 0o600 });
    }),
    /receipts around boot .* could not be read/,
  );
});

// Review F1 tripwire. The disarm is what makes a boot without the Stage 2 guard visible; each site below is
// one supported way such a boot can arise, and removing any of them reopens ATTACK-1 for that path.
test("L12: legacy release switches disarm; packaged controller uses independent handshake activation", () => {
  const root = new URL("../../", import.meta.url).pathname,
    read = (f) => fs.readFileSync(path.join(root, f), "utf8");
  const deploy = read("src/control/deploy-admission.mjs");
  assert.equal(
    deploy.match(/assertStopped\(\);\n  disarmHumanChain\(home\);/g)?.length,
    2,
    "deploy-admission: --rollback and --apply, while stopped",
  );
  const overlay = read("src/control/permission-overlay.py"),
    move = overlay.slice(overlay.indexOf("    def move("));
  assert.ok(
    move.indexOf("disarm_human_chain(self.home)") > -1 &&
      move.indexOf("disarm_human_chain(self.home)") <
        move.indexOf("self.write(directory, live / relative"),
    "permission-overlay: before any module is switched",
  );
  const launch = read("service-recovery/launch.py"),
    launchMain = launch.slice(launch.indexOf("def main("));
  assert.ok(
    launchMain.indexOf("guard_human_chain(profile, args.role)") > -1 &&
      launchMain.indexOf("guard_human_chain(profile, args.role)") <
        launchMain.indexOf("os.execve("),
    "launcher: before exec",
  );
  const server = read("src/control/server.mjs");
  assert.ok(!server.includes("witnessDaemon"), "listener inspection is not packaged authority");
  assert.ok(server.includes("connectNative({ daemon, issueProvenance, getHandshakeBoot })"));
  const child = read("src/control/distribution-child.mjs");
  assert.match(child, /getHandshakeBoot:/, "the distribution must supply the independent boot");
});
