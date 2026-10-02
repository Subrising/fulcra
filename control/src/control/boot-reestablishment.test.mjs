// Stage 1 of DESIGN.md: an operator-invoked seat re-establishment across a verified daemon restart.
//
// Every test here is written to kill a specific mutation from DESIGN.md s6. The mapping is in the test
// names (M1..M19) and in IMPLEMENTATION.md. A mutation that leaves this suite green means the test is
// missing or vacuous, so the names are part of the contract, not decoration.
//
// This suite deliberately does NOT import requireUnpinnedAdmissionGuard. That precondition exists for
// suites that exercise admit(), because a pinned working guard makes their green meaningless. Nothing
// here reaches the guard -- the native side is a fake -- so importing it would only let an unrelated
// pin abort a suite whose results do not depend on it. The consequence is stated in IMPLEMENTATION.md:
// this suite proves the CONTROLLER half of the fence, not the native half.
import fs from "node:fs";
import os from "node:os";
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
  promptIdentityUnchanged,
  sessionQuiescent,
  humanInputFence,
  observationStable,
  ensureReestablishmentJournal,
  REESTABLISH,
  REVOKE,
  DECLINE,
  OPERATOR,
} from "./boot-reestablishment.mjs";

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
const REASON = "Daemon restarted under launchd; re-pinning the verified seat";

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-boot-reestablish-")));
  const store = new ControlStore(path.join(dir, "journal.sqlite"));
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const states = new Map();
  let sends = 0,
    authority = async (id) => issue(id),
    hooks = {};
  const observe = (id) => ({
    boot: "b1",
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
      const seen = (hooks.inspects = (hooks.inspects ?? 0) + 1);
      await hooks.onInspect?.(id, seen);
      return observe(id);
    },
    send: async (id, _text, messageId) => {
      sends++;
      states.set(id, { ...states.get(id), lastPromptId: messageId });
    },
  };
  // A private, absent log directory: the operator path then runs with the evidence 'unavailable', which is
  // exactly Stage 1. The Stage 2 cases build real logs in seat-sweep.test.mjs.
  const control = new Controller({
    store,
    native,
    authority: async (id) => authority(id),
    humanLogDir: path.join(dir, "admission", "human"),
  });
  control.bindings = new Bindings(
    control,
    async () => ({
      observedAt: "2026-09-23T00:00:00.000Z",
      available: true,
      partial: false,
      projects: [{ id: P(1), name: "One", description: null, status: "in_progress" }],
      membership: [{ taskId: T(1), projectId: P(1) }],
      note: "test project source",
    }),
    path.join(dir, "grants", "role"),
  );
  const request = rpc(control, "test-operator");
  const set = (id, patch) => states.set(id, { ...states.get(id), ...patch });
  const enrol = (task) => {
    const id = randomUUID();
    store.created(id, task, path.join(dir, id));
    states.set(id, {});
    return id;
  };
  const capabilityFor = (id) =>
    JSON.parse(
      fs.readFileSync(
        control.bindings.grantRole({ sessionId: id, expectedGeneration: store.get(id).generation })
          .grantFile,
        "utf8",
      ),
    ).capability;
  // Counts from the moment the hook is installed, so setup observations (handback makes two) do not
  // shift the call the test means to interfere with.
  const hook = (fn) => {
    hooks.inspects = 0;
    hooks.onInspect = fn;
  };
  return {
    dir,
    store,
    control,
    native,
    request,
    enrol,
    set,
    observe,
    capabilityFor,
    hooks,
    hook,
    sends: () => sends,
    setAuthority: (fn) => {
      authority = fn;
    },
    reestablish: (id, reason = REASON) =>
      request({
        method: "reestablish",
        operator: "test-operator",
        input: { sessionId: id, reason },
      }),
    records: (id) =>
      store.db
        .prepare("SELECT * FROM boot_reestablishments WHERE session=? ORDER BY rowid")
        .all(id),
    transfers: (id) =>
      Number(store.db.prepare("SELECT count(*) n FROM transfers WHERE session=?").get(id).n),
  };
}

// A seated, delegated project orchestrator holding a live role capability, as it stands the instant
// before the daemon restarts.
async function seated(t) {
  const f = fixture(t),
    id = f.enrol(T(1));
  await f.control.bindings.assign({
    role: "project-orchestrator",
    seat: P(1),
    sessionId: id,
    expectedSessionGeneration: f.store.get(id).generation,
    expectedRevision: 0,
    note: "Owns delivery of this project",
  });
  await f.control.handback(id, "Delegated before the daemon restart");
  const capability = f.capabilityFor(id);
  const restart = (boot = "b2") => f.set(id, { boot });
  return {
    ...f,
    id,
    capability,
    restart,
    selfRead: () => f.request({ method: "bindings-self", capability, input: { sessionId: id } }),
  };
}

test("the problem, then the fix: a restart kills the seat on first dispatch, re-establishment restores it (M6, M10)", async (t) => {
  const f = await seated(t);
  const before = f.store.get(f.id);
  assert.equal(before.boot, "b1");
  assert.equal(before.grantedAt, 1);
  f.restart();
  // Baseline: this is exactly the behaviour the task exists to fix, and it is NOT changed by this work.
  await assert.rejects(
    f.control.send(
      { sessionId: f.id, messageId: randomUUID(), text: "Work" },
      undefined,
      before.generation,
    ),
    /revoked/,
  );
  assert.equal(f.store.get(f.id).mode, "human");

  // Do it again on a fresh seat, re-establishing before anything touches the session.
  const g = await seated(t);
  const start = g.store.get(g.id);
  g.restart();
  const out = await g.reestablish(g.id);
  assert.equal(out.reestablished, true);
  assert.equal(out.previousBoot, "b1");
  assert.equal(out.boot, "b2");
  assert.equal(out.grantsAuthority, false);
  const after = g.store.get(g.id);
  assert.equal(after.boot, "b2");
  assert.equal(after.grantedAt, 1); // M6: observed humanAt+1, never the carried-over value
  assert.equal(after.mode, "delegated"); // no control transfer
  assert.equal(after.generation, start.generation); // M10c: generation untouched
  assert.equal(after.expected, start.expected);
  assert.equal(after.expectedAt, start.expectedAt);
  assert.equal(g.transfers(g.id), 1); // M10b: only the original handback, no new transfer
  // M10a: the role capability issued before the restart still works, with no re-grant and no reissue.
  assert.deepEqual(
    (await g.selfRead()).roles.map((r) => r.seat),
    [P(1)],
  );
  // And the seat can actually be dispatched to again, which is the point of the whole exercise.
  assert.equal(
    (
      await g.control.send(
        { sessionId: g.id, messageId: randomUUID(), text: "Carry on" },
        undefined,
        after.generation,
      )
    ).state,
    "delivered",
  );
});

test("M1: a takeover recorded before the restart still denies the seat after it", async (t) => {
  const f = await seated(t);
  f.control.takeover(f.id, "Operator took this session over before the restart");
  const taken = f.store.get(f.id);
  assert.equal(taken.mode, "human");
  f.restart();
  await assert.rejects(f.reestablish(f.id), /delegated session can be re-established|final/);
  const after = f.store.get(f.id);
  assert.equal(after.mode, "human"); // never written back to delegated
  assert.equal(after.boot, "b1"); // the fence was not re-pinned
  assert.equal(after.generation, taken.generation);
  assert.equal(f.records(f.id).at(-1).outcome, "declined");
});

test("M2: the controlDispatched exemption is NOT reused across a boot (daemon died mid-dispatch)", async (t) => {
  const f = await seated(t);
  const messageId = randomUUID();
  await f.control.send(
    { sessionId: f.id, messageId, text: "The turn that was in flight" },
    undefined,
    f.store.get(f.id).generation,
  );
  // Model the crash: the send was admitted and ran, but the post-send advance of `expected` never
  // completed, so the journal still names the previous prompt.
  f.store.db.prepare("UPDATE sessions SET expected=NULL WHERE id=?").run(f.id);
  f.set(f.id, { lastPromptId: messageId, promptClaimsControl: true });
  const row = f.store.get(f.id),
    current = f.observe(f.id);
  // Precisely the mutation: steady-state promptIdentityChanged FORGIVES this shape...
  assert.equal(f.control.promptIdentityChanged(current, row), false);
  // ...and the gate must refuse it anyway.
  assert.equal(promptIdentityUnchanged(row, current), false);
  f.restart();
  await assert.rejects(f.reestablish(f.id), /last prompt is not the one this controller recorded/);
  assert.equal(f.store.get(f.id).mode, "human");
  assert.equal(f.store.get(f.id).boot, "b1");
});

test("M3/M4: both halves of prompt identity are required, and an unobserved human message denies the seat", async (t) => {
  // (a) The case the brief calls the most important: a human typed, the controller never saw it, the
  //     daemon restarted and the in-memory humanAt counter went back to zero.
  const a = await seated(t);
  a.set(a.id, { lastPromptId: "human-typed-this", lastUserAt: "2026-09-23T10:05:00.000Z" });
  a.restart();
  assert.equal(humanInputFence(a.observe(a.id)).ok, true); // the counter is useless here, as designed
  await assert.rejects(a.reestablish(a.id), /last prompt is not the one this controller recorded/);
  assert.equal(a.store.get(a.id).mode, "human");
  assert.equal(a.store.get(a.id).boot, "b1");

  // (b) M3: only lastPromptId moved.
  const b = await seated(t);
  b.set(b.id, { lastPromptId: "human-typed-this" });
  b.restart();
  await assert.rejects(b.reestablish(b.id), /last prompt is not the one this controller recorded/);
  assert.equal(b.store.get(b.id).mode, "human");

  // (c) M3/M4: only lastUserAt moved. Dropping that conjunct would let this through.
  const c = await seated(t);
  c.set(c.id, { lastUserAt: "2026-09-23T10:05:00.000Z" });
  c.restart();
  assert.equal(promptIdentityUnchanged(c.store.get(c.id), c.observe(c.id)), false);
  await assert.rejects(c.reestablish(c.id), /last prompt is not the one this controller recorded/);
  assert.equal(c.store.get(c.id).mode, "human");
});

test("M5/M19: human input after the restart, or an unaccountable guard, denies the seat", async (t) => {
  for (const [patch, pattern] of [
    [{ humanAt: 1 }, /Human input has already reached this session/],
    [{ saturated: true }, /Native input sequence fence unavailable/],
    [{ fenceProtocol: "orca-input-sequence-v0" }, /Native input sequence fence unavailable/],
  ]) {
    const f = await seated(t);
    f.set(f.id, patch);
    f.restart();
    await assert.rejects(f.reestablish(f.id), pattern, JSON.stringify(patch));
    assert.equal(f.store.get(f.id).mode, "human", JSON.stringify(patch));
    assert.equal(f.store.get(f.id).boot, "b1", JSON.stringify(patch));
  }
});

test("M6: grantedAt is re-derived, so the next human input still revokes a re-established seat", async (t) => {
  const f = fixture(t),
    id = f.enrol(T(1));
  await f.control.bindings.assign({
    role: "project-orchestrator",
    seat: P(1),
    sessionId: id,
    expectedSessionGeneration: f.store.get(id).generation,
    expectedRevision: 0,
    note: "Owns delivery of this project",
  });
  // Delegated after three human inputs in the OLD boot, so the stale grantedAt is 4.
  f.set(id, { humanAt: 3 });
  await f.control.handback(id, "Delegated after some human activity");
  assert.equal(f.store.get(id).grantedAt, 4);
  f.set(id, { boot: "b2", humanAt: 0 });
  await f.reestablish(id);
  // Carrying 4 over against a counter that restarts at 0 would silently absorb the next three inputs.
  assert.equal(f.store.get(id).grantedAt, 1);
  // One human input now, and the existing fence takes the seat over with nothing new required.
  f.set(id, { humanAt: 1 });
  await f.control.inspect(id);
  assert.equal(f.store.get(id).mode, "human");
});

test("M7/M8: a takeover racing the write wins, and a zero-row update is not a success", async (t) => {
  const f = await seated(t);
  f.restart();
  // Fire the takeover from inside the gate, after the first observation, so the conditional UPDATE is
  // the only thing standing between the race and a re-pinned fence.
  f.hook(async (id, seen) => {
    if (seen === 2) f.control.takeover(id, "Human took control during re-establishment");
  });
  await assert.rejects(f.reestablish(f.id), /control changed during re-establishment/);
  const after = f.store.get(f.id);
  assert.equal(after.mode, "human");
  assert.equal(after.boot, "b1"); // the fence was never re-pinned
  assert.equal(after.grantedAt, 1);
  assert.equal(f.records(f.id).at(-1).outcome, "revoked");
});

test("M9: a revoke-class refusal takes the seat over; a decline-class refusal changes nothing", async (t) => {
  const revoked = await seated(t);
  revoked.set(revoked.id, { lastPromptId: "human-typed-this" });
  revoked.restart();
  await assert.rejects(revoked.reestablish(revoked.id));
  assert.equal(revoked.store.get(revoked.id).mode, "human");
  assert.equal(revoked.records(revoked.id).at(-1).outcome, "revoked");

  const declined = await seated(t);
  const before = declined.store.get(declined.id);
  declined.set(declined.id, { status: "busy" });
  declined.restart();
  await assert.rejects(declined.reestablish(declined.id), /busy/);
  const after = declined.store.get(declined.id);
  // Declining costs nothing: the row is still boot-stale, so it is still unusable and the first
  // dispatch against it still takes it over.
  assert.equal(after.mode, "delegated");
  assert.equal(after.boot, "b1");
  assert.equal(after.generation, before.generation);
  assert.equal(declined.records(declined.id).at(-1).outcome, "declined");
  await assert.rejects(
    declined.control.send(
      { sessionId: declined.id, messageId: randomUUID(), text: "Work" },
      undefined,
      before.generation,
    ),
    /revoked/,
  );
  assert.equal(declined.store.get(declined.id).mode, "human");
});

test("M11: no boot value is accepted from a caller, and an unverifiable daemon re-establishes nothing", async (t) => {
  const f = await seated(t);
  f.restart();
  await assert.rejects(
    f.request({
      method: "reestablish",
      operator: "test-operator",
      input: { sessionId: f.id, reason: REASON, boot: "b2" },
    }),
    /Invalid seat re-establishment/,
  );
  await assert.rejects(
    f.request({ method: "reestablish", operator: "test-operator", input: { sessionId: f.id } }),
    /Invalid seat re-establishment/,
  );
  await assert.rejects(f.reestablish(f.id, "short"), /Invalid seat re-establishment/);
  // A seat cannot repair its own fence: the operator credential is required.
  await assert.rejects(
    f.request({
      method: "reestablish",
      capability: f.capability,
      input: { sessionId: f.id, reason: REASON },
    }),
    /Operator authorization required/,
  );
  assert.equal(f.store.get(f.id).boot, "b1");
  assert.equal(f.records(f.id).length, 0);
  // verifyActivation lives inside native.inspect; when it refuses, nothing is observed and nothing moves.
  f.native.inspect = async () => {
    throw new Error("Running Paseo has not loaded the reviewed admission guard");
  };
  await assert.rejects(f.reestablish(f.id), /reviewed admission guard/);
  assert.equal(f.store.get(f.id).boot, "b1");
  assert.equal(f.store.get(f.id).mode, "delegated");
  assert.equal(f.records(f.id).length, 0);
});

test("M12: an archived session is revoked and a busy one is declined, never re-established", async (t) => {
  const archived = await seated(t);
  archived.set(archived.id, { archivedAt: "2026-09-23T09:00:00.000Z" });
  archived.restart();
  await assert.rejects(archived.reestablish(archived.id), /archived/);
  assert.equal(archived.store.get(archived.id).mode, "human");
  assert.equal(archived.store.get(archived.id).boot, "b1");

  const pending = await seated(t);
  pending.set(pending.id, { pending: 1 });
  pending.restart();
  await assert.rejects(pending.reestablish(pending.id), /permission decision/);
  assert.equal(pending.store.get(pending.id).boot, "b1");
});

test("M13: one attempt per daemon boot, so the gate cannot be ground against the race", async (t) => {
  const f = await seated(t);
  f.set(f.id, { status: "busy" });
  f.restart();
  await assert.rejects(f.reestablish(f.id), /busy/);
  // The obstacle clears, but this boot's single attempt is already spent.
  f.set(f.id, { status: "idle" });
  await assert.rejects(f.reestablish(f.id), /already been attempted for this daemon boot/);
  assert.equal(f.store.get(f.id).boot, "b1");
  assert.equal(f.records(f.id).length, 1);
  // A genuinely new boot is a new attempt.
  f.set(f.id, { boot: "b3" });
  await f.reestablish(f.id);
  assert.equal(f.store.get(f.id).boot, "b3");
  assert.equal(f.records(f.id).length, 2);
});

test("M14: native state that moves between the two observations denies the seat", async (t) => {
  const f = await seated(t);
  f.restart();
  f.hook(async (id, seen) => {
    if (seen === 2) f.set(id, { lastPromptId: "human-typed-this" });
  });
  await assert.rejects(f.reestablish(f.id), /changed during re-establishment/);
  assert.equal(f.store.get(f.id).mode, "human");
  assert.equal(f.store.get(f.id).boot, "b1");
});

test("M15: a dispatch arriving during re-establishment is refused, not admitted", async (t) => {
  const f = await seated(t);
  f.restart();
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  f.hook(async (_id, seen) => {
    if (seen === 1) await held;
  });
  const running = f.reestablish(f.id);
  await assert.rejects(
    f.control.send(
      { sessionId: f.id, messageId: randomUUID(), text: "Work" },
      undefined,
      f.store.get(f.id).generation,
    ),
    /Session operation already in flight/,
  );
  assert.equal(f.sends(), 0);
  release();
  await running;
  assert.equal(f.store.get(f.id).boot, "b2");
});

test("M16/M17/M18: lapsed authority, an unchanged boot and an unseated session are all declined", async (t) => {
  const lapsed = await seated(t);
  lapsed.restart();
  lapsed.setAuthority(async (id) => ({
    ...issue(id),
    assigneeUserId: "local-board",
    status: "in_progress",
    companyId: COMPANY,
    parentId: T(9),
  }));
  await assert.rejects(lapsed.reestablish(lapsed.id), /authority/);
  assert.equal(lapsed.store.get(lapsed.id).mode, "delegated");
  assert.equal(lapsed.store.get(lapsed.id).boot, "b1");

  // M17: without a boot change there is nothing to re-establish, and the attempt is not even recorded,
  // so an operator typo cannot spend the seat's one attempt.
  const same = await seated(t);
  await assert.rejects(same.reestablish(same.id), /has not restarted/);
  assert.equal(same.records(same.id).length, 0);
  assert.equal(same.store.get(same.id).mode, "delegated");

  // M18: a delegated session holding no seat keeps today's behaviour untouched.
  const unseated = fixture(t),
    id = unseated.enrol(T(1));
  await unseated.control.handback(id, "Delegated without any seat");
  unseated.set(id, { boot: "b2" });
  await assert.rejects(unseated.reestablish(id), /holds no role binding/);
  assert.equal(unseated.store.get(id).boot, "b1");
});

// ---------------------------------------------------------------------------------------------
// Conditions C1-C4 from the independent security review (C-REVIEW.md), pinned as tests.
// ---------------------------------------------------------------------------------------------

// C1 was "nothing calls reestablish automatically": right while the interrupt gap was open. Stage 2 closes
// that gap with the durable human-input log, so C1' pins the NEW shape instead of forbidding it (mutations
// N3 and S18): the operator RPC is still the only caller of the operator trigger; the machine trigger has
// exactly one caller (seat-sweep.mjs), which has exactly one caller (server.mjs), which calls it exactly
// twice -- once before the socket listens and once on the watchdog tick -- and nothing else schedules it.
test("C1': the operator RPC is the only operator trigger, and the sweep has exactly its two approved call sites", () => {
  const root = new URL("../", import.meta.url).pathname;
  const walk = (dir) =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .flatMap((e) =>
        e.isDirectory()
          ? e.name === "node_modules"
            ? []
            : walk(path.join(dir, e.name))
          : [path.join(dir, e.name)],
      );
  const sources = walk(root).filter(
    (f) => /\.(mjs|js)$/.test(f) && !/\.test\.mjs$|\.fixture\.mjs$|\.integration\.mjs$/.test(f),
  );
  assert.ok(sources.length > 40, "the scan must actually be reading the tree");
  const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
  // Only these three may mention re-establishment at all: the gate module, the method's definition, the RPC case.
  // H7: plus the H7 mutation harness, which NAMES the gate's file to edit its source text for a mutation run (H7s2)
  // and restores it; it never imports or calls the gate, and the sweepSeat(/sweepSeats( rules below still apply to it.
  const allowed = new Set([
    "control/boot-reestablishment.mjs",
    "control/controller.mjs",
    "control/rpc.mjs",
    "control/h7.mutations.mjs",
  ]);
  // DESIGN-R: session recovery reuses the PURE gate helpers ("reusable by a sibling route", below). It may
  // carry exactly this one import line and nothing else that mentions re-establishment: stripping the line
  // must leave no mention, so a call to reestablish(), or an import of the gate itself, still trips here.
  const helperImport =
    "import { humanInputFence, sessionQuiescent, promptIdentityUnchanged, observationStable } from './boot-reestablishment.mjs';";
  const parserSchema = "methods('takeover reestablish', object({ sessionId: uuid, reason }));";
  for (const file of sources) {
    const relative = file.slice(root.length);
    let text = fs.readFileSync(file, "utf8");
    // R's allowance, kept exactly: recovery.mjs may carry the one pure-helper import line and nothing else.
    if (relative === "control/recovery.mjs") {
      assert.equal(
        text.split(helperImport).length,
        2,
        "recovery.mjs imports the pure helpers exactly once, by that exact line",
      );
      text = text.replace(helperImport, "");
    }
    // V3b's host management validator (command-parser.mjs) grants no authority; it may name the operator method in at
    // most its one schema line (V4 #33 dropped that line) and nothing else.
    if (relative === "control/command-parser.mjs") {
      assert.ok(
        text.split(parserSchema).length <= 2,
        "command-parser.mjs names the reestablish method at most once, by that exact schema line",
      );
      text = text.replace(parserSchema, "");
    }
    if (!allowed.has(relative))
      assert.equal(
        /reestablish/i.test(text),
        false,
        `${relative} must not reference reestablishment`,
      );
    if (!["control/controller.mjs", "control/seat-sweep.mjs"].includes(relative))
      assert.equal(/sweepSeat\(/.test(text), false, `${relative} must not call the sweep trigger`);
    if (!["control/seat-sweep.mjs", "control/server.mjs"].includes(relative))
      assert.equal(/sweepSeats\(/.test(text), false, `${relative} must not run the sweep`);
  }
  // Exactly one operator invocation, after the operator credential check. bindings-restore stays removed.
  const rpcSource = read("control/rpc.mjs");
  assert.equal(rpcSource.match(/control\.reestablish\(/g).length, 1);
  assert.ok(
    rpcSource.indexOf("Operator authorization required") <
      rpcSource.indexOf("control.reestablish("),
    "the only caller must sit after the operator credential check",
  );
  assert.equal(
    /sweepSeat|bindings-restore/.test(rpcSource),
    false,
    "no RPC may reach the machine trigger or a second restart route",
  );
  // The controller never calls either trigger on its own behalf, and schedules nothing.
  const controllerSource = read("control/controller.mjs");
  assert.equal(
    /this\.(reestablish|sweepSeat)\(/.test(controllerSource),
    false,
    "the controller must never call a trigger on its own behalf",
  );
  for (const timer of ["setInterval", "setTimeout", "cron", "schedule"])
    assert.equal(
      controllerSource.includes(timer),
      false,
      `controller.mjs must not ${timer} anything`,
    );
  // Each trigger literal is bound exactly once, in its own method.
  assert.equal(
    controllerSource.match(/repinSeat\(id, reason\.trim\(\), OPERATOR, false\)/g)?.length,
    1,
  );
  assert.equal(controllerSource.match(/, SWEEP, report\)/g)?.length, 1);
  assert.equal(controllerSource.match(/this\.repinSeat\(/g).length, 2);
  // seat-sweep.mjs: one call of the trigger, no timers of its own.
  const sweepSource = read("control/seat-sweep.mjs");
  assert.equal(sweepSource.match(/control\.sweepSeat\(/g).length, 1);
  for (const timer of ["setInterval", "setTimeout"])
    assert.equal(sweepSource.includes(timer), false);
  // server.mjs: exactly one sweepSeats call wrapped as sweep(), called exactly twice: before listen, and in the watchdog.
  const server = read("control/server.mjs");
  assert.equal(server.match(/sweepSeats\(/g).length, 1);
  assert.equal(server.match(/\bsweep\(\)/g).length, 2);
  // The first pass starts before the socket listens; review F3's deadline only bounds how long listen waits for it.
  const first = server.indexOf(
    "await Promise.race([sweep(), new Promise(resolve => setTimeout(resolve, 60000).unref())]);",
  );
  assert.ok(
    first > -1 && first < server.indexOf("server.listen("),
    "the first pass must run before the socket listens",
  );
  const watchdog = server
    .split("\n")
    .find((line) => line.startsWith("eventWatchdog = setInterval("));
  assert.ok(watchdog?.includes("sweep()"), "the second call site is the watchdog tick");
  // WL's opt-in finished-job clean-up is the one other timer; it runs only that clean-up, never a sweep or a
  // re-establishment.
  const lifecycleTimer =
    "const lifecycleTimer = setInterval(cleanFinishedJobs, 3600000); lifecycleTimer.unref();";
  assert.equal(
    server.split("\n").filter((line) => line === lifecycleTimer).length,
    1,
    "the worktree clean-up timer, exactly",
  );
  assert.equal(/sweep|reestablish/i.test(lifecycleTimer), false);
  const timers = server
    .split("\n")
    .filter((line) => line !== lifecycleTimer && /(?<![.\w])(setInterval|setTimeout)\(/.test(line));
  assert.equal(timers.length, 2, "no other timer in server.mjs");
  assert.ok(
    timers.every(
      (line) =>
        line.startsWith("eventWatchdog = setInterval(") ||
        line.includes("setTimeout(resolve, 60000)"),
    ),
    "only the watchdog and the startup deadline",
  );
});

// C2 / review F2 + A4c. Before this, status and pending were judged only on the first observation, so
// a session that picked up a turn between the two reads was still re-established -- the one place this
// path checked an older observation than handback does.
test("C2: a session that becomes busy or pending between the two observations is refused", async (t) => {
  for (const [patch, pattern, mode] of [
    [{ status: "running", pending: 1 }, /busy/, "delegated"],
    [{ pending: 1 }, /permission decision/, "delegated"],
    // archivedAt is already one of observationStable's fields, so it is caught one step earlier and
    // revokes for that reason. Asserted here so the ordering is pinned rather than assumed.
    [{ archivedAt: "2026-09-23T09:00:00.000Z" }, /changed during re-establishment/, "human"],
  ]) {
    const f = await seated(t);
    f.restart();
    f.hook(async (id, seen) => {
      if (seen === 2) f.set(id, patch);
    });
    await assert.rejects(f.reestablish(f.id), pattern, JSON.stringify(patch));
    assert.equal(f.store.get(f.id).boot, "b1", JSON.stringify(patch)); // never re-pinned
    assert.equal(f.store.get(f.id).grantedAt, 1, JSON.stringify(patch));
    // Busy is routine, so it declines; archived is a human act, so it revokes.
    assert.equal(f.store.get(f.id).mode, mode, JSON.stringify(patch));
  }
});

// C3 / review F3 + A9b. reestablish never bumps the generation, so it never passes through
// reissueRole -- which refuses a session whose routing cannot carry a role capability. Without R8 a
// seat whose route went Book-shaped across the boot would KEEP a credential the manual path destroys.
test("C3: a seat whose routing cannot carry a role capability is refused, not re-established", async (t) => {
  const f = await seated(t);
  f.restart();
  // A Book-shaped route: bindings.dispatch reports capability.supported false for any non-local route.
  f.native.route = () => ({
    host: "macbook",
    phase: "active",
    generation: f.store.get(f.id).generation,
    creation: "{}",
  });
  assert.equal(f.control.bindings.dispatch(f.id).capability.supported, false);
  await assert.rejects(f.reestablish(f.id), /must be repaired by takeover and handback/);
  assert.equal(f.store.get(f.id).boot, "b1");
  assert.equal(f.store.get(f.id).mode, "delegated"); // declined: unroutable is not human input
  // Absent routing is unknown routing, and refuses for the same reason.
  const g = await seated(t);
  g.restart();
  delete g.native.route;
  await assert.rejects(g.reestablish(g.id), /must be repaired by takeover and handback/);
  assert.equal(g.store.get(g.id).boot, "b1");
});

// C4 / review F4 (mutation K7 survived the original suite). The re-pin and its audit row must commit
// together, or a crash between them leaves a re-established seat whose journal still reads 'attempted'.
test("C4: the two-column write and the attempt-journal finish are one transaction", async (t) => {
  const f = await seated(t);
  f.restart();
  f.control.finishReestablishment = () => {
    throw new Error("journal write failed");
  };
  await assert.rejects(f.reestablish(f.id), /journal write failed/);
  // Rolled back together: without store.atomic the UPDATE would have landed and boot would read b2.
  assert.equal(f.store.get(f.id).boot, "b1");
  assert.equal(f.store.get(f.id).grantedAt, 1);
  assert.equal(f.records(f.id).at(-1).outcome, "attempted");
});

test("the gate is pure and its helpers are reusable by a sibling route", () => {
  const row = {
    mode: "delegated",
    boot: "b1",
    expected: "m-42",
    expectedAt: "2026-09-23T10:00:00.000Z",
    authority: "key",
    generation: 7,
  };
  const good = {
    boot: "b2",
    fenceProtocol: FENCE_PROTOCOL,
    saturated: false,
    humanAt: 0,
    status: "idle",
    pending: 0,
    lastPromptId: "m-42",
    lastUserAt: "2026-09-23T10:00:00.000Z",
    archivedAt: null,
  };
  // trigger OPERATOR with no humanLog verdict is exactly Stage 1; R9 is exercised in seat-sweep.test.mjs.
  const facts = { seated: true, authorityKey: "key", dispatchSupported: true, trigger: OPERATOR };
  assert.deepEqual(reestablishable(row, good, facts), {
    allow: true,
    disposition: REESTABLISH,
    reason: null,
    grantedAt: 1,
  });
  assert.equal(reestablishable({ ...row, mode: "human" }, good, facts).disposition, DECLINE);
  assert.equal(reestablishable({ ...row, boot: null }, good, facts).disposition, DECLINE);
  assert.equal(reestablishable(row, { ...good, boot: "b1" }, facts).disposition, DECLINE);
  assert.equal(reestablishable(row, good, { ...facts, seated: false }).disposition, DECLINE);
  assert.equal(
    reestablishable(row, good, { ...facts, dispatchSupported: false }).disposition,
    DECLINE,
  );
  assert.equal(
    reestablishable(row, good, { ...facts, authorityKey: "other" }).disposition,
    DECLINE,
  );
  assert.equal(reestablishable(row, { ...good, status: "busy" }, facts).disposition, DECLINE);
  assert.equal(reestablishable(row, { ...good, pending: 2 }, facts).disposition, DECLINE);
  assert.equal(reestablishable(row, { ...good, archivedAt: "x" }, facts).disposition, REVOKE);
  assert.equal(reestablishable(row, { ...good, humanAt: 1 }, facts).disposition, REVOKE);
  assert.equal(reestablishable(row, { ...good, saturated: true }, facts).disposition, REVOKE);
  assert.equal(reestablishable(row, { ...good, lastPromptId: "other" }, facts).disposition, REVOKE);
  assert.equal(reestablishable(row, { ...good, lastUserAt: null }, facts).disposition, REVOKE);
  // The seam worker B's bindings-restore calls instead of re-implementing these checks.
  assert.equal(promptIdentityUnchanged(row, good), true);
  assert.equal(promptIdentityUnchanged(row, { ...good, lastPromptId: "other" }), false);
  assert.equal(sessionQuiescent(good), null);
  assert.equal(sessionQuiescent({ ...good, archivedAt: "x" }).disposition, REVOKE);
  assert.deepEqual(humanInputFence(good), { ok: true, grantedAt: 1, reason: null });
  assert.equal(humanInputFence({ ...good, humanAt: 2 }).ok, false);
  assert.equal(observationStable(good, good), true);
  assert.equal(observationStable(good, { ...good, humanAt: 1 }), false);
  assert.equal(observationStable(good, { ...good, boot: "b3" }), false);
});

test("the re-establishment journal asserts its own shape before the controller starts", async (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-boot-schema-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new ControlStore(path.join(dir, "journal.sqlite"));
  t.after(() => store.close());
  ensureReestablishmentJournal(store.db);
  ensureReestablishmentJournal(store.db); // idempotent
  const older = new ControlStore(path.join(dir, "older.sqlite"));
  t.after(() => older.close());
  older.db.exec("CREATE TABLE boot_reestablishments(id TEXT PRIMARY KEY, session TEXT)");
  assert.throws(
    () => ensureReestablishmentJournal(older.db),
    /Unsupported boot_reestablishments schema/,
  );
});
