import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { reader } from "./control-read.mjs";
import {
  MESSAGE_SETTLED,
  REMEDIES,
  SEVERITY,
  UNSETTLED,
  inventory,
  problems,
  render,
} from "./situation.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

test("a reader refuses a method it was not given, before it opens a socket", () => {
  let connected = 0;
  const ask = reader({
    home: "/nowhere",
    reads: ["list"],
    connect: () => {
      connected++;
      throw new Error("should not reach here");
    },
  });
  // Synchronous, so it cannot be swallowed as an unhandled rejection, and pre-connection, so a write
  // method cannot reach the controller even for the length of a refused round trip.
  assert.throws(() => ask("operator-send", "secret"), /only makes read calls; operator-send/);
  assert.equal(connected, 0, "a refused method must not touch the socket");
  assert.throws(() => reader({ home: "/nowhere", reads: [] }), /must declare the reads it makes/);
});

// UNSETTLED is copied from controller.history's ordering clause. If someone adds a state there and not
// here, this report would call outstanding work settled and stay quiet about it -- so the two are pinned
// together rather than left to drift.
test("the unsettled states still match the ones controller.history treats as outstanding", () => {
  const src = fs.readFileSync(path.join(here, "controller.mjs"), "utf8");
  // Anchored to history(), not to the first `state IN` in the file: controller.mjs has since gained
  // another one (the dispatched-credential lookup), and matching that instead compared this list
  // against an unrelated clause.
  const history = src.slice(src.indexOf("  history(task) {"));
  assert.ok(history.startsWith("  history(task) {"), "controller.history was renamed or removed");
  const clause = history.match(/state IN \(([^)]+)\)/);
  assert.ok(
    clause,
    "controller.history no longer has the ordering clause this list was taken from",
  );
  const states = [...clause[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(
    [...UNSETTLED].sort(),
    states.sort(),
    "controller.history and situation.mjs disagree about what counts as outstanding",
  );
});

test("a spent allowance is reported as blocked, because nothing else will say so", () => {
  const found = problems({
    allowances: {
      allowances: [
        { role: "prime", seat: "alpha", used: 3, maxSessions: 3, remaining: 0 },
        { role: "prime", seat: "beta", used: 1, maxSessions: 3, remaining: 2 },
      ],
    },
  });
  assert.equal(found.length, 1, "a seat with remaining capacity is not a problem");
  assert.equal(found[0].severity, "BLOCKED");
  assert.equal(found[0].who, "prime/alpha");
  assert.match(found[0].detail, /0 remaining/);
});

test("a read that failed is a problem, not silence", () => {
  // The dangerous failure for a status report is answering "all clear" when it simply could not look.
  const found = problems({ channels: { __error: "timed out" } });
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, "BLOCKED");
  assert.match(found[0].detail, /could not read channels: timed out/);
  assert.match(render({ channels: { __error: "timed out" } }), /WHAT IS WRONG/);
});

test("problems come out worst first", () => {
  // Deliberately fed in the wrong order: seats are read before channels, so this produces an ATTENTION
  // before a BLOCKED. Input that already happens to be in severity order would pass without a sort.
  const contrary = problems({
    seats: { bindings: [{ role: "r", seat: "s", sessionGenerationChanged: true, sessionId: "x" }] },
    channels: {
      channels: [
        {
          channelId: "c",
          state: "expired",
          sendable: false,
          primeSeat: "p",
          projectSeat: "q",
          used: 0,
          maxMessages: 4,
          expiresAt: "then",
        },
      ],
    },
  });
  assert.deepEqual(
    contrary.map((f) => f.severity),
    ["BLOCKED", "ATTENTION"],
    "the sort must reorder, not just preserve",
  );
  const found = problems({
    sessions: [{ id: "aaaaaaaa-1111-2222-3333-444444444444", task: "t" }],
    ownership: { "aaaaaaaa-1111-2222-3333-444444444444": { ownership: "unknown" } },
    deliveries: [{ id: "d1", session: "s1", kind: "send", state: "uncertain" }],
    allowances: {
      allowances: [{ role: "prime", seat: "a", used: 1, maxSessions: 1, remaining: 0 }],
    },
  });
  assert.deepEqual(
    found.map((f) => f.severity),
    ["BLOCKED", "STUCK", "ATTENTION"],
  );
  const text = render({
    deliveries: [{ id: "d1", session: "s1", kind: "send", state: "uncertain" }],
    allowances: {
      allowances: [{ role: "prime", seat: "a", used: 1, maxSessions: 1, remaining: 0 }],
    },
  });
  assert.ok(
    text.indexOf("BLOCKED") < text.indexOf("STUCK"),
    "the report must lead with what is blocked",
  );
});

test("an unsettled delivery is stuck and a settled one is not", () => {
  const of = (state) =>
    problems({ deliveries: [{ id: "d1", session: "s1", kind: "send", state }] });
  for (const state of UNSETTLED)
    assert.equal(of(state).length, 1, `${state} should be outstanding`);
  assert.deepEqual(of("delivered"), []);
  assert.deepEqual(
    of("failed"),
    [],
    "failed is settled: it is over, and something else reports it",
  );
});

test("an unread failed message is stuck, and says it is unread", () => {
  const found = problems({
    channels: {
      messages: [
        { messageId: "m1", state: "delivered", fromSeat: "p/a", toSeat: "q/b", failure: "refused" },
      ],
    },
  });
  assert.equal(found[0].severity, "STUCK");
  assert.match(found[0].detail, /refused.*still unread/);
});

test("a quiet controller says so plainly, and still states its limits", () => {
  const text = render({ sessions: [], ownership: {} });
  assert.match(text, /NOTHING IS BLOCKED OR STUCK\./);
  assert.doesNotMatch(text, /WHAT IS WRONG/);
  for (const limit of [
    /doing anything/,
    /reports the absence, not the cause/,
    /outside the controller journal/,
    /Only the tasks it was given/,
  ])
    assert.match(text, limit);
});

test("mode and ownership are kept apart, because they are different facts", () => {
  const sessions = [
    { id: "a", task: "t", mode: "auto" },
    { id: "b", task: "t", mode: "auto" },
  ];
  const inv = inventory({
    sessions,
    ownership: {
      a: {
        ownership: "adopted",
        projectId: "p1",
        seat: "s",
        seatRole: "project-orchestrator",
        parentSession: "z",
      },
      b: { ownership: "unknown" },
    },
  });
  assert.deepEqual(
    inv.map((i) => i.owner),
    ["owner recorded", "no owner recorded"],
  );
  // A delegated session with no recorded owner is a real combination; merging the two facts would hide it.
  assert.deepEqual(
    inv.map((i) => i.mode),
    ["auto", "auto"],
  );
  const delegatedUnowned = inventory({
    sessions: [{ id: "a", task: "t", mode: "delegated" }],
    ownership: { a: { ownership: "unknown" } },
  })[0];
  assert.equal(delegatedUnowned.mode, "delegated");
  assert.equal(delegatedUnowned.owner, "no owner recorded");
  assert.equal(inv[0].seat, "project-orchestrator/s");
  assert.equal(
    inv[1].project,
    null,
    "an unowned session must not be filed under someone else’s project",
  );
});

test("neither section becomes a wall", () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, task: "t", mode: "auto" }));
  const text = render({
    sessions: many,
    ownership: Object.fromEntries(
      many.map((s) => [s.id, { ownership: "declared", projectId: "p1" }]),
    ),
    deliveries: many.map((s, i) => ({ id: `d${i}`, session: s.id, kind: "send", state: "queued" })),
  });
  // 30 copies of one finding is one finding. Before this collapsed, eight identical sentences still
  // buried the lines that mattered -- which is what the live controller actually printed.
  assert.match(
    text,
    /delivery unsettled x30/,
    "repeats of a kind collapse to one line with a count",
  );
  assert.doesNotMatch(
    text,
    /delivery unsettled x30[\s\S]*delivery unsettled/,
    "and are not then printed again",
  );
  assert.match(text, /\.\.\. and 20 more of the same/, "the ownership list is capped");
  assert.ok(
    text.split("\n").length < 60,
    `one screen is the standard; got ${text.split("\n").length} lines`,
  );
  assert.match(text, /30 session\(s\), 30 thing\(s\)/, "the totals survive the capping");
});

test("SEVERITY is the print order and every problem uses one of its levels", () => {
  const found = problems({
    seats: {
      bindings: [
        {
          role: "r",
          seat: "s",
          dispatch: { supported: false, reason: "no channel" },
          sessionGenerationChanged: true,
        },
      ],
    },
    channels: {
      channels: [
        {
          channelId: "c",
          state: "expired",
          sendable: false,
          primeSeat: "p",
          projectSeat: "q",
          used: 0,
          maxMessages: 4,
          expiresAt: "then",
        },
      ],
    },
    requests: { requests: [{ requestId: "r1", state: "pending", seat: "s", attempts: 4 }] },
  });
  assert.ok(found.length >= 4);
  for (const f of found)
    assert.ok(SEVERITY.includes(f.severity), `${f.kind} uses an unknown severity ${f.severity}`);
});

// Found against the live journal, not in a fixture: a real message sat in state 'refused' while a version
// of this report that enumerated known-bad states said nothing. The running controller can predate this
// source, so it writes states this code has never heard of.
test("a message state this code does not recognise is surfaced, not swallowed", () => {
  const msg = (state) =>
    problems({
      channels: {
        messages: [{ messageId: "m1", state, fromSeat: "p/a", toSeat: "q/b", readAt: null }],
      },
    });
  const refused = msg("refused");
  assert.equal(refused.length, 1, "a refused message is not settled");
  assert.equal(refused[0].severity, "STUCK");
  assert.match(refused[0].detail, /refused and still unread/);
  // The point of the inversion: a state invented after this code was written still gets reported.
  const unknown = msg("a-state-added-after-this-was-written");
  assert.equal(unknown.length, 1, "an unknown state must never be treated as settled");
  assert.match(unknown[0].detail, /a-state-added-after-this-was-written/);
  assert.deepEqual(MESSAGE_SETTLED, ["delivered"]);
  assert.deepEqual(
    msg("delivered").map((p) => p.severity),
    ["ATTENTION"],
    "delivered but unread is worth knowing, not stuck",
  );
  assert.deepEqual(
    problems({
      channels: {
        messages: [
          { messageId: "m1", state: "delivered", fromSeat: "p/a", toSeat: "q/b", readAt: "now" },
        ],
      },
    }),
    [],
  );
});

// Every problem-producing branch at once, so a new one added without a remedy is caught here.
const EVERYTHING = {
  seats: {
    bindings: [
      {
        role: "r",
        seat: "s",
        dispatch: { supported: false, reason: "no session" },
        sessionGenerationChanged: true,
        sessionId: "x",
      },
    ],
  },
  allowances: {
    allowances: [
      { role: "r", seat: "s", used: 1, maxSessions: 1, remaining: 0 },
      { role: "r", seat: "t", blocked: "no allowance set", remaining: 0 },
    ],
  },
  requests: {
    requests: [
      { requestId: "q", state: "pending", seat: "s", attempts: 3 },
      { requestId: "q2", state: "failed", seat: "s", attempts: 1, failure: "boom" },
    ],
  },
  channels: {
    channels: [
      {
        channelId: "c1",
        sendable: false,
        blocked: "Channel approval has expired",
        primeSeat: "p",
        projectSeat: "q",
        used: 0,
        maxMessages: 4,
        expiresAt: "then",
      },
      {
        channelId: "c2",
        sendable: false,
        blocked:
          "The project seat changed since this channel was approved; a new operator approval is required",
        primeSeat: "p",
        projectSeat: "q",
        used: 0,
        maxMessages: 4,
        expiresAt: "then",
      },
      {
        channelId: "c3",
        sendable: false,
        blocked: "Channel message allowance reached",
        primeSeat: "p",
        projectSeat: "q",
        used: 4,
        maxMessages: 4,
        expiresAt: "then",
      },
    ],
    messages: [
      { messageId: "m1", state: "refused", fromSeat: "p", toSeat: "q" },
      { messageId: "m2", state: "queued", fromSeat: "p", toSeat: "q" },
      { messageId: "m3", state: "delivered", fromSeat: "p", toSeat: "q" },
      { messageId: "m4", state: "delivered", fromSeat: "p", toSeat: "q", failure: "nope" },
    ],
  },
  sessions: [{ id: "u", task: "t", mode: "human" }],
  ownership: { u: { ownership: "unknown" } },
  deliveries: [{ id: "d", session: "u", kind: "send", state: "uncertain" }],
};

test("every problem says what to do about it", () => {
  const found = problems(EVERYTHING);
  assert.ok(found.length >= 12, `only ${found.length} branches exercised`);
  const silent = found.filter((f) => !f.remedy?.trim()).map((f) => f.kind);
  assert.deepEqual(silent, [], "a problem nobody can act on is a problem half reported");
  // One line each. The report's value is that it fits on a screen; a manual defeats it.
  for (const f of found) {
    assert.doesNotMatch(f.remedy, /\n/, `${f.kind} remedy is more than one line`);
    assert.ok(f.remedy.length < 140, `${f.kind} remedy is ${f.remedy.length} chars`);
  }
  assert.match(render(EVERYTHING), /^ {6}-> /m, "the remedy is printed, not just carried");
});

// A wrong RPC name is worse than no remedy: it sends someone down a path that does not work, and they
// trust it because it was printed. So every name printed is checked against the server's own case list.
const rpcCases = () =>
  new Set(
    [...fs.readFileSync(path.join(here, "rpc.mjs"), "utf8").matchAll(/case '([a-z-]+)':/g)].map(
      (m) => m[1],
    ),
  );
// A candidate is a hyphenated token whose first segment is a namespace rpc.mjs actually uses, so ordinary
// hyphenated English ("re-bind", "back-filled") is not mistaken for an RPC name while "roles-allowance-st"
// still is. Derived from the server rather than listed here, so a new namespace is covered automatically.
const rpcsNamedIn = (text, known) => {
  const namespaces = new Set([...known].map((c) => c.split("-")[0]));
  return [...text.matchAll(/\b([a-z]+-[a-z-]+[a-z])\b/g)]
    .map((m) => m[1])
    .filter((t) => namespaces.has(t.split("-")[0]));
};

test("every RPC a remedy names actually exists in rpc.mjs", () => {
  const known = rpcCases();
  assert.ok(
    known.size > 20,
    `only ${known.size} RPC cases found -- the parse is wrong, not the remedies`,
  );
  const named = [...new Set(Object.values(REMEDIES).flatMap((r) => rpcsNamedIn(r, known)))];
  assert.ok(named.length >= 3, `no RPC names found in the remedies at all: ${named}`);
  assert.deepEqual(
    named.filter((n) => !known.has(n)),
    [],
    "a remedy names an RPC the server does not serve",
  );
  // Proof the check can fail: an invented name in the same namespace is caught.
  assert.deepEqual(
    rpcsNamedIn("use the roles-allowance-reset RPC", known).filter((n) => !known.has(n)),
    ["roles-allowance-reset"],
  );
});

test("an expired channel is never told to re-approve, because it cannot be", () => {
  const of = (blocked) =>
    problems({
      channels: {
        channels: [
          {
            channelId: "c",
            sendable: false,
            blocked,
            primeSeat: "p",
            projectSeat: "q",
            used: 0,
            maxMessages: 4,
            expiresAt: "t",
          },
        ],
      },
    })[0].remedy;
  assert.match(of("Channel approval has expired"), /fresh channel with channels-open/);
  assert.match(
    of(
      "The prime seat changed since this channel was approved; a new operator approval is required",
    ),
    /no longer current.*channels-open/,
  );
  assert.match(of("Channel message allowance reached"), /fixed when the channel is approved/);
  // Re-approving is the obvious wrong move, so every channel remedy must send the reader to a fresh one.
  for (const reason of [
    "Channel approval has expired",
    "Channel is closed",
    "Channel message allowance reached",
  ])
    assert.match(of(reason), /fresh/, `${reason} must direct to a fresh channel`);
});

test("a problem with no honest remedy says so instead of inventing one", () => {
  assert.match(REMEDIES.unowned, /^No fix:/);
  assert.match(REMEDIES.unowned, /cannot be back-filled/);
  // The test that matters: it must not name an operator call, because none of them does this.
  assert.deepEqual(
    rpcsNamedIn(REMEDIES.unowned, rpcCases()),
    [],
    "the unowned remedy must not name an RPC",
  );
});

test("the spent allowance names the RPC that raises it", () => {
  assert.match(REMEDIES.allowance, /roles-allowance-set/);
  assert.match(REMEDIES.allowance, /cannot start new work/);
});
