// W1 row 9 (H7b part ii) on the owned daemon: the Stage 2 seat sweep's human-input evidence is the daemon's sealed boot
// chain (boot-chain.mjs), written exactly as the controller distribution writes it (recordBootStart at distribution
// start with the daemon's own previous boot; sealBoot at the end of the orderly shutdown with the host's final
// human-input counters). The sweep, Controller, Bindings and store are real; native reports a quiescent session.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { FENCE_PROTOCOL } from "./native-fence.mjs";
import { ControlStore } from "./store.mjs";
import { Controller } from "./controller.mjs";
import { Bindings } from "./bindings.mjs";
import { RoleSessions } from "./role-sessions.mjs";
import { sweepSeats, MODE_FILE } from "./seat-sweep.mjs";
import {
  recordBootStart,
  sealBoot,
  bootChainDir,
  bootChainVerdict,
  sealedHumanAt,
  voidBootSeals,
} from "./boot-chain.mjs";
import { privateDenyRules } from "./trusted-contribution.mjs";
import { createDistribution } from "./distribution-host.mjs";

const P = "22222222-2222-4222-8222-000000000001",
  T = "33333333-3333-4333-8333-000000000001",
  COMPANY = "11111111-1111-4111-8111-000000000001",
  PROGRAMME = "44444444-4444-4444-8444-000000000001";
const home = (t) => {
  const h = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-boot-chain-")));
  t.after(() => fs.rmSync(h, { recursive: true, force: true }));
  return h;
};

// A seat and its team (seat-sweep.test.mjs / shutdown-closure.test.mjs shape), delegated in boot A, which is recorded.
async function seatAndTeam(t, { humanAtAtGrant = 0 } = {}) {
  const h = home(t),
    store = new ControlStore(path.join(h, "journal.sqlite"));
  t.after(() => store.close());
  let boot = randomUUID(),
    humanAt = humanAtAtGrant;
  const native = {
    route: () => undefined,
    inspect: async () => ({
      boot,
      fenceProtocol: FENCE_PROTOCOL,
      saturated: false,
      humanAt,
      status: "idle",
      pending: 0,
      lastPromptId: null,
      lastUserAt: null,
      archivedAt: null,
    }),
  };
  const control = new Controller({
    store,
    native,
    bootChainDir: bootChainDir(h),
    humanLogDir: path.join(h, "no-legacy-log"),
    authority: async (id) => ({
      id,
      companyId: COMPANY,
      parentId: id === PROGRAMME ? null : PROGRAMME,
      assigneeUserId: "local-board",
      assigneeAgentId: null,
      status: "in_progress",
    }),
  });
  control.bindings = new Bindings(
    control,
    async () => ({
      observedAt: "2026-09-28T00:00:00.000Z",
      available: true,
      partial: false,
      projects: [{ id: P, name: "P", description: null, status: "in_progress" }],
      membership: [{ taskId: T, projectId: P }],
      note: "test project source",
    }),
    path.join(h, "grants", "role"),
  );
  control.roleSessions = new RoleSessions(control);
  const holder = randomUUID(),
    worker = randomUUID();
  store.created(holder, T, path.join(h, holder));
  store.created(worker, T, path.join(h, worker));
  recordBootStart(h, boot, null);
  await control.bindings.assign({
    role: "project-orchestrator",
    seat: P,
    sessionId: holder,
    expectedSessionGeneration: store.get(holder).generation,
    expectedRevision: 0,
    note: "Owns delivery of this project",
  });
  await control.handback(holder, "Delegated before the host restart");
  await control.handback(worker, "The seat’s worker, delegated before the host restart");
  const request = randomUUID();
  store.db
    .prepare(
      "INSERT INTO session_ownership VALUES (?,?,?,'project-orchestrator','project-orchestrator',?,1,?,?)",
    )
    .run(request, P, T, P, holder, new Date().toISOString());
  store.db
    .prepare("INSERT INTO deliveries VALUES (?,NULL,'create','{}','delivered',?)")
    .run(request, JSON.stringify({ id: worker }));
  fs.writeFileSync(path.join(h, MODE_FILE), "on", { mode: 0o600 });
  const A = boot;
  // The daemon restarts into boot `next`, which the daemon says replaced `previous` (A unless stated).
  const restart = (next = randomUUID(), previous = A) => {
    boot = next;
    humanAt = 0;
    recordBootStart(h, next, previous);
    return next;
  };
  const sweep = async () => {
    const out = await sweepSeats(control, { home: h, currentBoot: () => boot });
    const row = (id) => out.results.find((r) => r.id === id) ?? null;
    return {
      out,
      holder: row(holder),
      worker: row(worker),
      modes: [store.get(holder).mode, store.get(worker).mode],
    };
  };
  return {
    h,
    store,
    control,
    holder,
    worker,
    A,
    restart,
    sweep,
    grantedAt: store.get(holder).grantedAt,
  };
}

test("W1 H7b 3 (V4): after a clean owned restart the seat and its team are re-established automatically", async (t) => {
  const f = await seatAndTeam(t);
  sealBoot(f.h, f.A, { [randomUUID()]: 4 }); // other agents' human input does not matter
  const B = f.restart();
  const r = await f.sweep();
  assert.equal(r.out.mode, "on");
  assert.equal(r.holder?.reestablished, true, JSON.stringify(r.out.results));
  assert.equal(r.worker?.reestablished, true, JSON.stringify(r.out.results));
  assert.deepEqual(r.modes, ["delegated", "delegated"]);
  assert.equal(f.store.get(f.holder).boot, B);
});

test("W1 H7b (V4) negative: a genuine human input to the seat after the grant revokes it (takeover) and its team is not re-established", async (t) => {
  const f = await seatAndTeam(t);
  sealBoot(f.h, f.A, { [f.holder]: f.grantedAt }); // the counter moved past the grant: a human spoke to the seat
  f.restart();
  const r = await f.sweep();
  assert.match(
    r.holder?.error ?? "",
    /A human input reached this session during boot .* after the seat was granted/,
    JSON.stringify(r.out.results),
  );
  assert.equal(r.modes[0], "human");
  assert.notEqual(r.worker?.reestablished, true, JSON.stringify(r.out.results));
});

test("W1 H7b (V4): human input before the grant does not count", async (t) => {
  const f = await seatAndTeam(t, { humanAtAtGrant: 2 });
  assert.equal(f.grantedAt, 3);
  sealBoot(f.h, f.A, { [f.holder]: 2 });
  f.restart();
  const r = await f.sweep();
  assert.equal(r.holder?.reestablished, true, JSON.stringify(r.out.results));
});

const declined = (r, pattern) => {
  assert.equal(r.holder?.reestablished, undefined, JSON.stringify(r.out.results));
  assert.match(JSON.stringify(r.holder), pattern);
  assert.equal(r.modes[0], "delegated", "a decline is not a takeover");
};

test("W1 H7b (V4): a crash (the grant boot never sealed) declines", async (t) => {
  const f = await seatAndTeam(t);
  f.restart();
  declined(await f.sweep(), /has no exit seal; it did not end cleanly/);
});

test("W1 H7b (V4): a broken chain declines -- predecessor unknown, an unrecorded boot in between, a seal forged after the fact", async (t) => {
  const unknown = await seatAndTeam(t);
  sealBoot(unknown.h, unknown.A, {});
  unknown.restart(randomUUID(), null);
  declined(await unknown.sweep(), /The boot chain breaks before boot/);

  // Boot X ran between A and B without the distribution (no records): the daemon names X as B's predecessor.
  const gap = await seatAndTeam(t);
  sealBoot(gap.h, gap.A, {});
  gap.restart(randomUUID(), randomUUID());
  declined(await gap.sweep(), /has no exit seal|left no boot record/);

  // A crashed; a seal for A written after B started does not match what B anchored.
  const forged = await seatAndTeam(t);
  forged.restart();
  sealBoot(forged.h, forged.A, {});
  declined(await forged.sweep(), /is not the one boot .* anchored when it started/);
});

test("W1 H7b (V4): the chain is walked across several clean boots, and human input in any later boot is dirty", async (t) => {
  const clean = await seatAndTeam(t);
  sealBoot(clean.h, clean.A, {});
  const C = clean.restart();
  sealBoot(clean.h, C, { [randomUUID()]: 1 });
  clean.restart(randomUUID(), C);
  assert.equal((await clean.sweep()).holder?.reestablished, true);

  const f = await seatAndTeam(t);
  sealBoot(f.h, f.A, {});
  const D = f.restart(); // the sweep does not run in D
  sealBoot(f.h, D, { [f.holder]: 1 });
  f.restart(randomUUID(), D); // a human spoke to the seat during D
  const r = await f.sweep();
  assert.match(
    r.holder?.error ?? "",
    /A human input reached this session during boot .* after the seat was granted/,
    JSON.stringify(r.out.results),
  );
  assert.equal(r.modes[0], "human");
});

test("W1 H7b (V4): boot records are private and denied to agents; the distribution seals through its daemon contract", (t) => {
  const h = home(t),
    boot = randomUUID();
  recordBootStart(h, boot, null);
  assert.equal(fs.statSync(bootChainDir(h)).mode & 0o077, 0);
  assert.equal(fs.statSync(path.join(bootChainDir(h), `${boot}.start`)).mode & 0o077, 0);
  const rules = privateDenyRules(h);
  for (const tool of ["Read", "Edit", "Write"])
    assert.ok(rules.includes(`${tool}(/${h}/boots/**)`), tool);
  assert.ok(rules.includes(`Bash(*${h}/boots*)`));
  const d = createDistribution({ home: h, bundleDirectory: h });
  assert.equal(typeof d.sealBoot, "function");
  d.sealBoot({ boot, humanAt: { a: 1 } });
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(bootChainDir(h), `${boot}.exit`), "utf8")),
    { v: 1, boot, end: "exit", humanAt: { a: 1 } },
  );
});

// Review W1-1: the chain must not skip a boot through a wrong or stale predecessor.
const verdictOf = (h, currentBoot, grantBoot, session) =>
  bootChainVerdict({ dir: bootChainDir(h), currentBoot, grantBoot, grantedAt: 1, session });
function grantThenHuman(t) {
  // grant in B0 (sealed, counter 0); a human types to the seat in B1 (sealed, 1)
  const h = home(t),
    S = randomUUID(),
    B0 = randomUUID(),
    B1 = randomUUID();
  recordBootStart(h, B0, null);
  sealBoot(h, B0, { [S]: 0 });
  recordBootStart(h, B1, B0);
  sealBoot(h, B1, { [S]: 1 });
  return { h, S, B0, B1 };
}
test("W1-1 acceptance: B0 sealed; B1 human, sealed; B2 names B0 -> unavailable, never clean", (t) => {
  const { h, S, B0, B1 } = grantThenHuman(t),
    B2 = randomUUID();
  recordBootStart(h, B2, B0); // rewritten or stale daemon-boot.json
  const start = JSON.parse(fs.readFileSync(path.join(bootChainDir(h), `${B2}.start`), "utf8"));
  assert.equal(start.prevSeal, null, "B0 already has a successor (B1): B2 anchors nothing");
  const v = verdictOf(h, B2, B0, S);
  assert.equal(v.state, "unavailable", JSON.stringify(v));
  // The honest chain stays dirty.
  const B3 = randomUUID();
  recordBootStart(h, B3, B1);
  assert.equal(verdictOf(h, B3, B0, S).state, "dirty");
});
test("W1-1(a): a start forged afterwards with the right digest is still refused (one successor per seal)", (t) => {
  const { h, S, B0 } = grantThenHuman(t),
    B2 = randomUUID();
  const digest = createHash("sha256")
    .update(fs.readFileSync(path.join(bootChainDir(h), `${B0}.exit`)))
    .digest("hex");
  fs.writeFileSync(
    path.join(bootChainDir(h), `${B2}.start`),
    JSON.stringify({ v: 1, boot: B2, prev: B0, prevSeal: digest }) + "\n",
    { mode: 0o600 },
  );
  const v = verdictOf(h, B2, B0, S);
  assert.equal(v.state, "unavailable");
  assert.match(v.reason, /More than one boot names boot/);
  assert.equal(
    sealedHumanAt(bootChainDir(h), B0, S),
    null,
    "two anchoring starts: the seal proves nothing",
  );
});
test("W1-1(b) acceptance: a pre-W1 host (previousBoot undefined) leaves no usable earlier seal", (t) => {
  const h = home(t),
    S = randomUUID(),
    B0 = randomUUID(),
    B1 = randomUUID(),
    B2 = randomUUID();
  recordBootStart(h, B0, null);
  sealBoot(h, B0, { [S]: 0 });
  recordBootStart(h, B1, undefined); // new control under an old daemon; B1 never seals
  const names = fs.readdirSync(bootChainDir(h));
  assert.ok(!names.includes(`${B0}.exit`));
  assert.ok(
    names.some((n) => n.startsWith(`${B0}.exit.void-`)),
    "renamed, not deleted",
  );
  assert.equal(sealedHumanAt(bootChainDir(h), B0, S), null);
  recordBootStart(h, B2, B0); // the re-upgraded daemon still names B0
  assert.equal(verdictOf(h, B2, B0, S).state, "unavailable");
});
test("W1-1(c): voidBootSeals breaks the chain for every later boot and is idempotent", (t) => {
  const h = home(t),
    S = randomUUID(),
    B0 = randomUUID(),
    B1 = randomUUID();
  recordBootStart(h, B0, null);
  sealBoot(h, B0, {});
  assert.deepEqual(voidBootSeals(h), [`${B0}.exit`]);
  assert.deepEqual(voidBootSeals(h), []);
  recordBootStart(h, B1, B0);
  assert.equal(verdictOf(h, B1, B0, S).state, "unavailable");
  assert.deepEqual(voidBootSeals(path.join(h, "no-such-home")), []);
});
test("W1-1 (review delta): voidBootSeals refuses a symlinked boots directory and renames nothing through it", (t) => {
  const h = home(t),
    elsewhere = home(t);
  fs.writeFileSync(path.join(elsewhere, "x.exit"), "{}", { mode: 0o600 });
  fs.symlinkSync(elsewhere, bootChainDir(h));
  assert.throws(() => voidBootSeals(h), /symlink/);
  assert.deepEqual(fs.readdirSync(elsewhere), ["x.exit"]);
  // At distribution start under a pre-W1 host the refusal leaves no start record: the sweep declines.
  assert.throws(() => recordBootStart(h, randomUUID(), undefined), /symlink/);
});
