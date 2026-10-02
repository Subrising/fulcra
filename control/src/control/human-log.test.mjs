// STAGE2-DESIGN.md s2: the pinned guard's durable human-input log, and the controller's reader of it.
//
// Every boot here is the REAL guard source, relocated with bindGuardHome and imported by a child process
// (human-log.fixture.mjs), so these tests run the guard's import-time setup, its human branch and its exit
// seal exactly as the daemon would. Test names carry the mutation each one kills (STAGE2-DESIGN.md s8).
//
// requireUnpinnedAdmissionGuard is imported because these results ARE statements about the guard on disk.
import { requireUnpinnedAdmissionGuard } from "./admission-guard-precondition.mjs";
requireUnpinnedAdmissionGuard();
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { home, runBoot, humanDir, logLines, logText, armed } from "./human-log.fixture.mjs";
import { humanLogVerdict, readHumanLog, CLEAN, DIRTY, UNAVAILABLE } from "./human-log.mjs";

const S = "11111111-1111-4111-8111-000000000001",
  OTHER = "11111111-1111-4111-8111-000000000002";
const verdict = (h, currentBoot, grantBoot, grantedAt = 1, session = S) =>
  humanLogVerdict({ dir: humanDir(h), currentBoot, grantBoot, grantedAt, session });

test("guard: every human input is on disk, with its counter value, when guard() returns (S1)", async (t) => {
  // In-process, so the file can be read in the same synchronous instant guard() returns. A deferred or
  // post-return write (S1) leaves the line absent here.
  const h = home(t),
    dir = path.join(h, "admission", "inproc");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { bindGuardHome } = await import("./native-release-hooks.mjs");
  fs.writeFileSync(
    path.join(dir, "admission-guard.mjs"),
    bindGuardHome(fs.readFileSync(new URL("./admission-guard.mjs", import.meta.url), "utf8"), h),
  );
  const g = await import(new URL("file://" + path.join(dir, "admission-guard.mjs")).href);
  const file = path.join(humanDir(h), g.BOOT + ".log");
  const lines = () =>
    fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  assert.equal(lines().length, 1, "header only before any input");
  g.guard({ id: S }, "", undefined, false);
  assert.deepEqual(lines().at(-1), { a: S, n: 1 });
  assert.equal(g.observation(S).humanAt, 1); // n is the counter value the input produced
  g.guard({ id: S }, "typed text", {}, false);
  assert.deepEqual(lines().at(-1), { a: S, n: 2 });
  // A controlled prompt is not a human input and is never logged (admit() refuses it here: no journal).
  assert.throws(() =>
    g.guard({ id: S }, "x", { clientMessageId: "orca-control:" + randomUUID() }, false),
  );
  assert.equal(lines().length, 3);
  // A human input with no agent affects no session and is not logged.
  g.guard(undefined, "", undefined, false);
  assert.equal(lines().length, 3);
  assert.deepEqual(armed(h), [g.BOOT]);
});

test("guard: a boot writes a header, arms itself, disarms its predecessor and anchors its exact bytes", (t) => {
  const h = home(t);
  const a = runBoot(h, { inputs: [S, OTHER, S] });
  assert.deepEqual(a.observed, [1, 1, 2]);
  assert.deepEqual(logLines(h, a.boot), [
    {
      v: 1,
      boot: a.boot,
      pid: logLines(h, a.boot)[0].pid,
      prev: null,
      prevBytes: null,
      prevSha256: null,
      receipts: [],
    },
    { a: S, n: 1 },
    { a: OTHER, n: 1 },
    { a: S, n: 2 },
    { end: "exit", code: 0 },
  ]);
  assert.deepEqual(armed(h), [a.boot]);
  const bytes = fs.readFileSync(path.join(humanDir(h), a.boot + ".log"));
  const b = runBoot(h);
  const header = logLines(h, b.boot)[0];
  assert.equal(header.prev, a.boot);
  assert.equal(header.prevBytes, bytes.length);
  assert.equal(header.prevSha256, createHash("sha256").update(bytes).digest("hex"));
  // The receipt snapshot is taken BEFORE this boot's own receipt: it names a, not b.
  assert.deepEqual(header.receipts, [a.boot]);
  assert.deepEqual(armed(h), [b.boot]); // exactly one armed boot: the newest
  // Private: the reader requires it, and so does anyone relying on the uid boundary.
  assert.equal(fs.statSync(humanDir(h)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(humanDir(h), a.boot + ".log")).mode & 0o777, 0o600);
});

test("guard: a failed write disarms the boot and never refuses the human (S2, S3)", (t) => {
  const h = home(t);
  runBoot(h);
  // The log descriptor is closed underneath the guard before the second input: every later write fails.
  const a = runBoot(h, { inputs: [S, S, OTHER, S], breakAt: 1 });
  assert.equal(a.status, 0, "guard() must never throw on a log failure (S3)");
  assert.deepEqual(a.observed, [1, 2, 1, 3], "the in-memory fence still counts every input");
  assert.deepEqual(armed(h), [], "the failing boot disarmed itself (S2)");
  assert.deepEqual(logLines(h, a.boot).slice(1), [{ a: S, n: 1 }], "no seal after a disarm");
  // The next boot therefore has no trustworthy predecessor, and any seat depending on it declines.
  const b = runBoot(h);
  assert.equal(logLines(h, b.boot)[0].prev, null);
});

test("guard: a boot that cannot create its own log still disarms its predecessor (S4)", (t) => {
  const h = home(t);
  const a = runBoot(h, { inputs: [OTHER] });
  assert.deepEqual(armed(h), [a.boot]);
  const b = runBoot(h, { block: true, inputs: [S] }); // its O_EXCL create fails with EEXIST
  assert.equal(b.status, 0);
  assert.deepEqual(b.observed, [1], "human input still counted in memory");
  assert.deepEqual(
    armed(h),
    [],
    "the predecessor is disarmed even though this boot could not arm itself",
  );
  // b's input for S exists nowhere on disk -- so the chain must break rather than skip b.
  const c = runBoot(h);
  assert.equal(logLines(h, c.boot)[0].prev, null);
  assert.equal(verdict(h, c.boot, a.boot).state, UNAVAILABLE);
});

test("guard: the exit seal is written on a normal exit and absent after SIGKILL (S13)", (t) => {
  const h = home(t);
  const a = runBoot(h, { inputs: [S] });
  assert.deepEqual(logLines(h, a.boot).at(-1), { end: "exit", code: 0 });
  const b = runBoot(h, { inputs: [OTHER], end: "kill" });
  assert.equal(b.signal, "SIGKILL");
  assert.deepEqual(logLines(h, b.boot).at(-1), { a: OTHER, n: 1 });
});

test("guard: several armed markers are no trustworthy predecessor (S12)", (t) => {
  const h = home(t);
  runBoot(h);
  fs.writeFileSync(path.join(humanDir(h), "armed-" + randomUUID()), "", { mode: 0o600 });
  const b = runBoot(h);
  assert.equal(logLines(h, b.boot)[0].prev, null);
  assert.deepEqual(armed(h), [b.boot], "and every stray marker is disarmed");
});

// ---------------------------------------------------------------------------------------------
// The reader. No path from "could not look" to clean.
// ---------------------------------------------------------------------------------------------

test("reader: clean across one and several sealed, anchored boots; pre-grant inputs do not count", (t) => {
  const h = home(t);
  const a = runBoot(h, { inputs: [OTHER] }),
    b = runBoot(h);
  assert.deepEqual(verdict(h, b.boot, a.boot), { state: CLEAN, reason: null, path: [a.boot] });
  const c = runBoot(h, { inputs: [OTHER] }),
    d = runBoot(h);
  assert.equal(verdict(h, d.boot, a.boot).state, CLEAN);
  assert.deepEqual(verdict(h, d.boot, a.boot).path, [c.boot, b.boot, a.boot]);
  // Pre-grant input in the grant boot: the seat was granted at humanAt 1 (grantedAt 2).
  const e = runBoot(h, { inputs: [S] }),
    f = runBoot(h);
  assert.equal(verdict(h, f.boot, e.boot, 2).state, CLEAN);
});

test("reader: a post-grant input is dirty -- the boundary is n >= grantedAt (M20, S6)", (t) => {
  const h = home(t);
  const a = runBoot(h, { inputs: [S, S] }),
    b = runBoot(h);
  assert.equal(
    verdict(h, b.boot, a.boot, 2).state,
    DIRTY,
    "n === grantedAt is the first disallowed input",
  );
  assert.equal(verdict(h, b.boot, a.boot, 3).state, CLEAN);
  assert.equal(
    verdict(h, b.boot, a.boot, 1, OTHER).state,
    CLEAN,
    "another session’s input is not this seat’s",
  );
  // An interrupt is exactly this: an empty human prompt to the guard. It leaves no user_message, and here
  // it is the ONLY evidence -- which is the whole point of s7 (M20).
  const c = runBoot(h, { inputs: [S] }),
    d = runBoot(h);
  assert.match(verdict(h, d.boot, c.boot).reason, /human input reached this session/);
});

test("reader: any input in a boot after the grant boot is dirty (S8)", (t) => {
  const h = home(t);
  const a = runBoot(h),
    _b = runBoot(h, { inputs: [S] }),
    c = runBoot(h);
  assert.equal(
    verdict(h, c.boot, a.boot, 5).state,
    DIRTY,
    "n is per boot, so grantedAt does not apply after the grant boot",
  );
});

test("reader: an uncounted (saturated) input is dirty (S7)", (t) => {
  const h = home(t);
  const a = runBoot(h);
  // Saturation needs 10000 sessions in one boot; the record it produces is appended here directly, before
  // the successor anchors it, so the file is exactly what the guard would have written.
  const file = path.join(humanDir(h), a.boot + ".log"),
    text = logText(h, a.boot).split("\n").filter(Boolean);
  fs.writeFileSync(file, [text[0], JSON.stringify({ a: S, n: null }), text[1], ""].join("\n"));
  const b = runBoot(h);
  assert.equal(verdict(h, b.boot, a.boot, 50).state, DIRTY);
});

test("reader: missing, unsealed, unanchored, torn, or non-private evidence is unavailable, never clean (M21, S5, S11, S13, S21)", async (t) => {
  const h = home(t);
  // No log directory at all: the first restart after deploy.
  assert.equal(verdict(h, randomUUID(), randomUUID()).state, UNAVAILABLE);
  const a = runBoot(h),
    b = runBoot(h);
  assert.equal(verdict(h, b.boot, a.boot).state, CLEAN);
  // S5: the grant log is appended to after its successor anchored it.
  const file = path.join(humanDir(h), a.boot + ".log"),
    original = fs.readFileSync(file);
  // A structurally perfect edit -- a record inserted before the seal -- so the anchor is the only thing
  // that can notice it.
  const [header, seal] = original.toString("utf8").split("\n");
  fs.writeFileSync(file, [header, JSON.stringify({ a: OTHER, n: 1 }), seal, ""].join("\n"));
  assert.equal(readHumanLog(humanDir(h), a.boot).fault, null);
  assert.match(verdict(h, b.boot, a.boot).reason, /changed after its successor anchored it/);
  fs.writeFileSync(file, original);
  // M21: missing grant log.
  fs.renameSync(file, file + ".gone");
  assert.match(verdict(h, b.boot, a.boot).reason, /missing or unreadable/);
  fs.renameSync(file + ".gone", file);
  // S21: not private, or not a regular file.
  fs.chmodSync(file, 0o644);
  assert.match(verdict(h, b.boot, a.boot).reason, /not a private regular file/);
  fs.chmodSync(file, 0o600);
  fs.renameSync(file, file + ".real");
  fs.symlinkSync(file + ".real", file);
  assert.match(verdict(h, b.boot, a.boot).reason, /not a private regular file/);
  fs.rmSync(file);
  fs.renameSync(file + ".real", file);
  fs.chmodSync(humanDir(h), 0o755);
  assert.match(verdict(h, b.boot, a.boot).reason, /not private/);
  fs.chmodSync(humanDir(h), 0o700);
  assert.equal(verdict(h, b.boot, a.boot).state, CLEAN, "restored exactly");
  // S13: the grant boot was killed, so its tail is not proven durable.
  const c = runBoot(h, { end: "kill" }),
    d = runBoot(h);
  assert.match(verdict(h, d.boot, c.boot).reason, /no exit seal/);
  // S11: a torn final line, written before the successor anchored it.
  const e = runBoot(h),
    ef = path.join(humanDir(h), e.boot + ".log");
  fs.appendFileSync(ef, '{"a":"' + S.slice(0, 8));
  const f = runBoot(h);
  assert.match(verdict(h, f.boot, e.boot).reason, /partial line/);
  // No restart between grant and now is not evidence of anything.
  assert.equal(verdict(h, f.boot, f.boot).state, UNAVAILABLE);
  assert.equal(verdict(h, f.boot, e.boot, 0).state, UNAVAILABLE);
});

test("reader: dirty is never masked by a fault elsewhere in the chain (S15)", (t) => {
  const h = home(t);
  const a = runBoot(h, { inputs: [S], end: "kill" }),
    b = runBoot(h); // unsealed AND a post-grant input
  assert.equal(verdict(h, b.boot, a.boot).state, DIRTY);
});

test("reader: a chain that skips, breaks, loops or runs too long is unavailable (S10, S22)", (t) => {
  const h = home(t);
  const a = runBoot(h),
    _b = runBoot(h, { breakAt: 0, inputs: [OTHER] }),
    c = runBoot(h); // b disarmed itself
  assert.match(
    verdict(h, c.boot, a.boot).reason,
    /chain breaks/,
    "the chain cannot skip b to reach a (S10)",
  );
  // A cycle: two hand-built logs anchoring each other. The walk must terminate and refuse.
  const x = randomUUID(),
    y = randomUUID(),
    dir = humanDir(h);
  const write = (boot, prev, prevBody) => {
    const header = {
      v: 1,
      boot,
      pid: 1,
      prev,
      prevBytes: Buffer.byteLength(prevBody),
      prevSha256: createHash("sha256").update(prevBody).digest("hex"),
      receipts: [prev],
    };
    const body = JSON.stringify(header) + "\n" + JSON.stringify({ end: "exit", code: 0 }) + "\n";
    fs.writeFileSync(path.join(dir, boot + ".log"), body, { mode: 0o600 });
    return body;
  };
  write(x, y, write(y, x, ""));
  assert.match(
    verdict(h, x, randomUUID()).reason,
    /cycle/,
    "detected as a cycle, not merely stopped by the hop bound",
  );
  // More than eight hops.
  const first = runBoot(h);
  let last = first;
  for (let i = 0; i < 9; i++) last = runBoot(h);
  assert.match(verdict(h, last.boot, first.boot).reason, /exceeds 8 boots/);
});

test("reader: a line after the seal, or a header naming another boot, is a fault", (t) => {
  const h = home(t);
  const a = runBoot(h),
    file = path.join(humanDir(h), a.boot + ".log");
  fs.appendFileSync(file, JSON.stringify({ a: OTHER, n: 1 }) + "\n");
  assert.match(readHumanLog(humanDir(h), a.boot).fault, /continues after its seal|malformed/);
  const b = runBoot(h),
    bf = path.join(humanDir(h), b.boot + ".log");
  fs.writeFileSync(bf, logText(h, b.boot).replace(b.boot, randomUUID()));
  assert.match(readHumanLog(humanDir(h), b.boot).fault, /no valid header/);
});

test("reader: a same-length edit that hides a human input is caught by the digest, not the length (review F2)", (t) => {
  const h = home(t);
  const a = runBoot(h, { inputs: [S] }),
    b = runBoot(h);
  assert.equal(verdict(h, b.boot, a.boot).state, DIRTY);
  const file = path.join(humanDir(h), a.boot + ".log"),
    before = fs.readFileSync(file);
  const after = Buffer.from(before.toString("utf8").replace(`"a":"${S}"`, `"a":"${OTHER}"`));
  assert.equal(after.length, before.length, "the edit keeps the byte length");
  assert.notDeepEqual(after, before);
  fs.writeFileSync(file, after);
  assert.equal(readHumanLog(humanDir(h), a.boot).fault, null, "the edited file is well-formed");
  const v = verdict(h, b.boot, a.boot);
  assert.equal(v.state, UNAVAILABLE);
  assert.match(v.reason, /changed after its successor anchored it/);
});
