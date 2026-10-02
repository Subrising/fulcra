// H6 item 6: Claude usage-limit auto-resume (usage-limits.mjs).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { FENCE_PROTOCOL } from "./native-fence.mjs";
import { ControlStore } from "./store.mjs";
import { Controller } from "./controller.mjs";
import { Recovery } from "./recovery.mjs";
import { rpc } from "./rpc.mjs";
import { COMPANY, PROGRAMME } from "./authority.mjs";
import { AUTOMATION_LIMIT } from "./journal-capacity.mjs";
import { HostNative } from "./host-native.mjs";
import { limitNoticeText } from "./held-notifier.mjs";
import {
  parseLimitLine,
  detectStop,
  UsageLimits,
  MAX_ATTEMPTS,
  MAX_RESUMES_PER_DAY,
} from "./usage-limits.mjs";

const T = (n) => `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;
const issue = (id) => ({
  id,
  companyId: COMPANY,
  parentId: id === PROGRAMME ? null : PROGRAMME,
  assigneeUserId: "local-board",
  assigneeAgentId: null,
  status: "in_progress",
});
const at = (s) => Date.parse(s);

// ---------------------------------------------------------------- the line, from the real 24->25 Sep journal
test("the real incident lines resolve to the right reset instants, from the message’s own time", () => {
  // 21:47 Brisbane on the 24th -> 00:50 Brisbane on the 25th (UTC+10, no DST).
  assert.deepEqual(
    parseLimitLine(
      "You've hit your session limit · resets 12:50am (Australia/Brisbane)",
      at("2026-09-24T11:47:40.818Z"),
    ),
    {
      kind: "session",
      reset: "12:50am",
      zone: "Australia/Brisbane",
      resetAt: "2026-09-24T14:50:00.000Z",
    },
  );
  assert.equal(
    parseLimitLine(
      "You've hit your session limit · resets 3pm (Australia/Brisbane)",
      at("2026-09-19T04:19:07.521Z"),
    ).resetAt,
    "2026-09-19T05:00:00.000Z",
  );
  assert.equal(
    parseLimitLine(
      "You've hit your session limit · resets 5am (Australia/Brisbane)",
      at("2026-09-18T17:27:31.006Z"),
    ).resetAt,
    "2026-09-18T19:00:00.000Z",
  );
  // Observed 3 h late (a controller restarted during the wait): still the same reset, because the reference is the message time.
  assert.equal(
    parseLimitLine(
      "You've hit your session limit · resets 12:50am (Australia/Brisbane)",
      at("2026-09-24T11:47:40.818Z"),
    ).resetAt,
    parseLimitLine(
      "You've hit your session limit · resets 12:50am (Australia/Brisbane)",
      at("2026-09-24T11:47:40.818Z"),
    ).resetAt,
  );
});
test("other forms: a DST zone, the weekly date form, the typographic apostrophe, the legacy epoch form", () => {
  // New York, the night DST ends (1 Nov 2026 02:00 EDT -> 01:00 EST): 3am local is 08:00Z.
  assert.equal(
    parseLimitLine(
      "You've hit your session limit · resets 3am (America/New_York)",
      at("2026-11-01T04:00:00Z"),
    ).resetAt,
    "2026-11-01T08:00:00.000Z",
  );
  assert.equal(
    parseLimitLine(
      "You’ve hit your weekly limit · resets Oct 3, 5pm (Europe/London)",
      at("2026-09-29T10:00:00Z"),
    ).resetAt,
    "2026-10-03T16:00:00.000Z",
  );
  assert.equal(
    parseLimitLine(
      "You've hit your weekly limit · resets Oct 3, 5pm (Europe/London)",
      at("2026-09-29T10:00:00Z"),
    ).kind,
    "weekly",
  );
  assert.equal(
    parseLimitLine("Claude AI usage limit reached|1790300000", at("2026-09-25T00:00:00Z")).resetAt,
    new Date(1790300000 * 1000).toISOString(),
  );
  // A named reset the controller cannot place is recorded but resolves to nothing (no automatic resume).
  assert.equal(
    parseLimitLine(
      "You've hit your session limit · resets 3pm (Mars/Olympus)",
      at("2026-09-25T00:00:00Z"),
    ).resetAt,
    null,
  );
  assert.equal(
    parseLimitLine("Claude AI usage limit reached|1990300000", at("2026-09-25T00:00:00Z")).resetAt,
    null,
    "more than 8 days ahead is not believed",
  );
});
test("only the WHOLE line parses -- the same words inside other text never do", () => {
  const t = at("2026-09-24T11:47:40Z");
  for (const text of [
    "Note: You've hit your session limit · resets 3pm (Australia/Brisbane)",
    "You've hit your session limit · resets 3pm (Australia/Brisbane)\nContinue?",
    "You've hit your session limit · resets 3pm (Australia/Brisbane) and more",
    "you've hit your session limit · resets 3pm",
    "You've hit your session limit - resets 3pm",
    "You've hit your session limit · resets 13pm",
    "You've hit your session limit · resets 3:75pm",
    "",
    null,
    "x".repeat(300),
  ])
    assert.equal(parseLimitLine(text, t)?.resetAt ?? null, null, JSON.stringify(text));
  assert.equal(
    parseLimitLine("Note: You've hit your session limit · resets 3pm (Australia/Brisbane)", t),
    null,
  );
});
const LINE = "You've hit your session limit · resets 12:50am (Australia/Brisbane)";
const entry = (seq, item, extra = {}) => ({
  seqStart: seq,
  seqEnd: seq,
  turnId: "foreground-turn-18",
  timestamp: "2026-09-24T11:47:40.818Z",
  item,
  ...extra,
});
const limitTail = (over = {}) => ({
  provider: "claude",
  status: "idle",
  updatedAt: "2026-09-24T11:47:41.000Z",
  lastUserMessageAt: "2026-09-24T11:30:00.000Z",
  maxSeq: 5697,
  entries: [
    entry(5695, { type: "tool_call", name: "Bash" }),
    entry(5697, {
      type: "assistant_message",
      text: LINE,
      messageId: "00000000-0000-4f94-9fb4-000000002022",
    }),
  ],
  ...over,
});
// H7 item 3: the REAL weekly line (26 Sep, the prime 4c111479 at 01:46:18Z and the Command Centre 2d82a4a4 at 01:43:58Z).
// The CLI writes the date form with " at ", which the H6 grammar did not accept, so neither stop was ever recorded.
test('H7: the real weekly line of 26 Sep resolves (date form with "at"), and its near variants', () => {
  const real = "You've hit your weekly limit · resets Sep 29 at 8am (Australia/Brisbane)";
  assert.deepEqual(parseLimitLine(real, at("2026-09-26T01:46:18.953Z")), {
    kind: "weekly",
    reset: "Sep 29 at 8am",
    zone: "Australia/Brisbane",
    resetAt: "2026-09-28T22:00:00.000Z",
  });
  assert.equal(
    parseLimitLine(real, at("2026-09-26T01:43:58.887Z")).resetAt,
    "2026-09-28T22:00:00.000Z",
  );
  assert.equal(
    parseLimitLine(
      "You've hit your weekly limit · resets Sep 29 at 8:30pm (Australia/Brisbane)",
      at("2026-09-26T01:46:18Z"),
    ).resetAt,
    "2026-09-29T10:30:00.000Z",
  );
  // Across a year end, the date form still means the NEXT such date.
  assert.equal(
    parseLimitLine(
      "You've hit your weekly limit · resets Jan 2 at 9am (Australia/Brisbane)",
      at("2026-12-30T00:00:00Z"),
    ).resetAt,
    "2027-01-01T23:00:00.000Z",
  );
  for (const bad of [
    "You've hit your weekly limit · resets Sep 29 at  8am (Australia/Brisbane)",
    "You've hit your weekly limit · resets Sep 29 at8am",
    "You've hit your weekly limit · resets Sep 29 on 8am",
    "You've hit your weekly limit · resets Sep 29 at 8am (Australia/Brisbane) today",
  ])
    assert.equal(parseLimitLine(bad, at("2026-09-26T01:46:18Z")), null, bad);
  // The real stop is a stop: newest entry, an assistant message, on an idle Claude session.
  const s = detectStop(
    limitTail({
      entries: [
        entry(
          70020,
          { type: "assistant_message", text: real, messageId: "weekly-1" },
          { timestamp: "2026-09-26T01:46:18.953Z" },
        ),
      ],
      maxSeq: 70020,
    }),
  );
  assert.deepEqual([s.kind, s.resetAt, s.seq], ["weekly", "2026-09-28T22:00:00.000Z", 70020]);
});
test("a stop is the newest entry, an assistant message, on an idle Claude session -- nothing else", () => {
  const s = detectStop(limitTail());
  assert.deepEqual(
    [s.seq, s.turnId, s.resetAt, s.stoppedAt],
    [5697, "foreground-turn-18", "2026-09-24T14:50:00.000Z", "2026-09-24T11:47:40.818Z"],
  );
  assert.equal(detectStop(limitTail({ provider: "codex" })), null);
  assert.equal(detectStop(limitTail({ status: "running" })), null);
  assert.equal(detectStop(limitTail({ maxSeq: 5698 })), null, "something newer exists");
  assert.equal(
    detectStop(limitTail({ entries: [entry(5697, { type: "user_message", text: LINE })] })),
    null,
    "user text is never read as a limit",
  );
  assert.equal(
    detectStop(
      limitTail({
        entries: [
          entry(5697, { type: "assistant_message", text: LINE }),
          entry(5698, { type: "assistant_message", text: "Done." }),
        ],
        maxSeq: 5698,
      }),
    ),
    null,
  );
  assert.equal(detectStop(null), null);
  // Without an entry timestamp the session's updatedAt is the reference, never the time of observation.
  assert.equal(
    detectStop(
      limitTail({
        entries: [
          entry(
            5697,
            { type: "assistant_message", text: LINE, messageId: "m" },
            { timestamp: undefined },
          ),
        ],
      }),
    ).stoppedAt,
    "2026-09-24T11:47:41.000Z",
  );
});

// ---------------------------------------------------------------- the controller
function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-usage-limits-")));
  const store = new ControlStore(path.join(dir, "journal.sqlite"));
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const sent = [],
    states = new Map(),
    tails = new Map(),
    notices = [];
  const native = {
    route: () => undefined,
    inspect: async (id) => ({
      boot: "fixture",
      fenceProtocol: FENCE_PROTOCOL,
      saturated: false,
      humanAt: 0,
      status: "idle",
      pending: 0,
      lastPromptId: null,
      ...states.get(id),
    }),
    send: async (id, text, messageId) => {
      sent.push({ id, text, messageId });
      states.set(id, { ...states.get(id), lastPromptId: messageId });
    },
    limitTail: async (id) => tails.get(id) ?? null,
  };
  const control = new Controller({ store, native, authority: async (id) => issue(id) });
  const clock = { now: at("2026-09-24T11:48:00Z") };
  control.recovery = new Recovery(control, { now: () => clock.now });
  control.usageLimits = new UsageLimits(control, { now: () => clock.now, random: () => 0 });
  control.limitNotifier = async (n) => {
    notices.push(n);
  };
  const enrol = () => {
    const id = randomUUID();
    store.created(id, T(1), path.join(dir, id));
    tails.set(id, limitTail());
    return id;
  };
  return {
    dir,
    store,
    control,
    sent,
    states,
    tails,
    notices,
    clock,
    enrol,
    request: rpc(control, "test-operator"),
    delegate: (id) => control.handback(id, "Delegated for the usage-limit verification"),
    limits: control.usageLimits,
  };
}
const row = (f, id) =>
  f.store.db.prepare("SELECT * FROM usage_limit_stops WHERE session=? ORDER BY rowid DESC").get(id);
test("a delegated session that stopped at the limit is resumed once, after the reset, through the ordinary send path", async (t) => {
  const f = fixture(t),
    id = f.enrol();
  await f.delegate(id);
  await f.limits.onAgent({ id, provider: "claude", status: "idle", updatedAt: "u1" });
  let r = row(f, id);
  assert.deepEqual(
    [r.state, r.resetAt, r.nextAt, r.turnId, r.seq, r.mode],
    [
      "waiting",
      "2026-09-24T14:50:00.000Z",
      "2026-09-24T14:50:30.000Z",
      "foreground-turn-18",
      5697,
      "delegated",
    ],
  );
  await f.limits.tick();
  assert.equal(f.sent.length, 0, "nothing before the reset");
  f.clock.now = at("2026-09-24T14:50:31Z");
  await f.limits.tick();
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].text, /Continue exactly where you stopped/);
  assert.match(f.sent[0].text, /do NOT repeat an external action/);
  r = row(f, id);
  assert.equal(r.state, "resumed");
  assert.equal(f.sent[0].messageId, r.continuation);
  assert.equal(
    f.store.delivery(r.continuation).state,
    "delivered",
    "journaled like every controller send",
  );
  await f.limits.tick();
  await f.limits.onAgent({ id, provider: "claude", status: "idle", updatedAt: "u1" });
  await f.limits.observe(id);
  assert.equal(f.sent.length, 1, "never twice");
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM usage_limit_stops").get().n, 1);
  // A crash after the send but before the record: the stop is still 'waiting', and the retry reuses the derived id,
  // so the journal returns the delivered send and nothing is dispatched again.
  f.store.db
    .prepare("UPDATE usage_limit_stops SET state='waiting',nextAt=? WHERE id=?")
    .run("2026-09-24T14:50:30.000Z", r.id);
  await f.limits.tick();
  assert.equal(f.sent.length, 1, "a retry after a crash does not send again");
  assert.equal(row(f, id).state, "resumed");
  const status = await f.request({ method: "recovery-status", operator: "test-operator" });
  assert.equal(status.usageLimits.stops[0].state, "resumed");
  assert.equal(status.usageLimits.stops[0].interruptedTurn.turnId, "foreground-turn-18");
});
test("a human-held session is never sent anything: its human is notified once", async (t) => {
  const f = fixture(t),
    id = f.enrol();
  await f.limits.observe(id);
  f.clock.now = at("2026-09-24T15:00:00Z");
  await f.limits.tick();
  await f.limits.tick();
  assert.equal(f.sent.length, 0);
  assert.equal(row(f, id).state, "notified");
  assert.match(row(f, id).outcome, /Under human control; nothing was sent; human notified/);
  assert.deepEqual(f.notices, [
    {
      session: id,
      resetAt: "2026-09-24T14:50:00.000Z",
      reset: "12:50am (Australia/Brisbane)",
      heldBack: false,
    },
  ]);
});
test("a session that moved on, or whose control changed, is not resumed", async (t) => {
  const f = fixture(t),
    moved = f.enrol(),
    changed = f.enrol();
  await f.delegate(moved);
  await f.delegate(changed);
  await f.limits.observe(moved);
  await f.limits.observe(changed);
  f.tails.set(moved, limitTail({ lastUserMessageAt: "2026-09-24T12:00:00.000Z" })); // someone spoke to it
  f.control.takeover(changed, "A human took it");
  await f.delegate(changed); // new generation
  f.clock.now = at("2026-09-24T15:00:00Z");
  await f.limits.tick();
  assert.equal(f.sent.length, 0);
  assert.equal(row(f, moved).state, "superseded");
  assert.equal(row(f, changed).state, "superseded");
});
test("a busy session is retried with backoff, and gives up after the bounded attempts", async (t) => {
  const f = fixture(t),
    id = f.enrol();
  await f.delegate(id);
  await f.limits.observe(id);
  f.states.set(id, { status: "running" });
  for (let n = 0; n < MAX_ATTEMPTS + 2; n++) {
    f.clock.now = at("2026-09-25T00:00:00Z") + n * 3600000;
    await f.limits.tick();
  }
  const r = row(f, id);
  assert.equal(f.sent.length, 0);
  assert.equal(r.state, "failed");
  assert.match(r.outcome, new RegExp(`Still busy after ${MAX_ATTEMPTS} attempts`));
});
test("resumes are capped per session per day; the rest is left for a human", async (t) => {
  const f = fixture(t),
    id = f.enrol();
  await f.delegate(id);
  for (let n = 0; n < MAX_RESUMES_PER_DAY; n++)
    f.store.db
      .prepare(
        "INSERT INTO usage_limit_stops VALUES (?,?,1,'delegated','claude',NULL,?,'m','x','t',NULL,NULL,NULL,'resumed',0,NULL,NULL,NULL,?)",
      )
      .run(randomUUID(), id, n, "2026-09-24T12:00:00.000Z");
  await f.limits.observe(id);
  f.clock.now = at("2026-09-24T15:00:00Z");
  await f.limits.tick();
  assert.equal(f.sent.length, 0);
  assert.equal(row(f, id).state, "held-back");
  assert.equal(f.notices.at(-1).heldBack, true);
});
test("the continuation is automated traffic: refused at the journal’s automation limit", async (t) => {
  const f = fixture(t),
    id = f.enrol();
  await f.delegate(id);
  await f.limits.observe(id);
  f.store.db.exec("BEGIN");
  while (f.store.db.prepare("SELECT count(*) n FROM deliveries").get().n < AUTOMATION_LIMIT)
    f.store.db
      .prepare("INSERT INTO deliveries VALUES (?,NULL,'fixture','{}','delivered',NULL)")
      .run(randomUUID());
  f.store.db.exec("COMMIT");
  f.clock.now = at("2026-09-24T15:00:00Z");
  await f.limits.tick();
  assert.equal(f.sent.length, 0);
  assert.equal(row(f, id).state, "failed");
  assert.match(row(f, id).outcome, /Journal automation budget reached/);
});
test("an unresolvable reset is recorded and never resumed; updates that are not a Claude idle of ours are ignored", async (t) => {
  const f = fixture(t),
    id = f.enrol();
  await f.delegate(id);
  f.tails.set(
    id,
    limitTail({
      entries: [
        entry(5697, {
          type: "assistant_message",
          text: "You've hit your session limit · resets 3pm (Mars/Olympus)",
          messageId: "m",
        }),
      ],
    }),
  );
  await f.limits.observe(id);
  assert.equal(row(f, id).state, "unresolved");
  f.clock.now = at("2026-09-30T00:00:00Z");
  await f.limits.tick();
  assert.equal(f.sent.length, 0);
  let reads = 0;
  f.control.native.limitTail = async () => {
    reads++;
    return null;
  };
  for (const a of [
    { id, provider: "codex", status: "idle", updatedAt: "x" },
    { id, provider: "claude", status: "running", updatedAt: "x" },
    { id: randomUUID(), provider: "claude", status: "idle", updatedAt: "x" },
  ])
    await f.limits.onAgent(a);
  assert.equal(reads, 0);
  await f.limits.onAgent({ id, provider: "claude", status: "idle", updatedAt: "v2" });
  await f.limits.onAgent({ id, provider: "claude", status: "idle", updatedAt: "v2" });
  assert.equal(reads, 1, "one read per daemon update");
});
test("a Book (remote) session is not read here; the notice carries metadata only", async (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-usage-limits-host-"))),
    store = new ControlStore(path.join(dir, "journal.sqlite"));
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const native = new HostNative({
      store,
      book: async () => assert.fail("nothing reaches the Book host"),
      local: { limitTail: async () => "local" },
    }),
    remote = randomUUID();
  native.db
    .prepare(
      "INSERT INTO host_routes(id,request,host,creation,agent,cwd,phase,generation,binding) VALUES (?,?,'macbook','{}',?,'/book/owned','active',1,NULL)",
    )
    .run(remote, randomUUID(), randomUUID());
  assert.equal(await native.limitTail(remote), null);
  assert.equal(await native.limitTail(randomUUID()), "local");
  const t1 = limitNoticeText({
    session: "00000000-0000-4bbb-8ccc-000000002013",
    reset: "12:50am (Australia/Brisbane)",
    heldBack: false,
  });
  assert.match(
    t1.body,
    /Session 4c111479 stopped at its usage limit; resets 12:50am \(Australia\/Brisbane\)\. It is under your control, so nothing was sent/,
  );
  assert.throws(() => limitNoticeText({ session: "not-a-session", reset: "3pm" }));
  assert.throws(() =>
    limitNoticeText({
      session: "00000000-0000-4bbb-8ccc-000000002013",
      reset: 'x"; do shell script "y',
    }),
  );
});
test("server.mjs is wired: agent updates, a startup pass, the watchdog tick, recovery-status (static)", () => {
  const src = fs.readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
  assert.match(src, /control\.usageLimits = new UsageLimits\(control\)/);
  assert.match(src, /native\.subscribe\(a => \{ void control\.usageLimits\.onAgent\(a\);/);
  assert.match(src, /await control\.usageLimits\.observe\(id\)/);
  assert.match(src, /void control\.usageLimits\.tick\(\);/);
  assert.match(src, /control\.limitNotifier = macLimitNotifier\(\)/);
});
