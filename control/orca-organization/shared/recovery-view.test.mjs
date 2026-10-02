import test from "node:test";
import assert from "node:assert/strict";
import {
  validateRecovery,
  recoveryCard,
  resumePreview,
  orderItems,
  bannerSummary,
  latestRestart,
  recoverySections,
  EARLIER,
  RESTART_WINDOW_MS,
  teamItems,
  repoLine,
  CHIPS,
  when,
} from "./recovery-view.mjs";
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const item = (n, extra = {}) => ({
  interruptionId: U(100 + n),
  sessionId: U(n),
  task: U(900),
  mode: "human",
  generation: 3,
  cause: "boot",
  state: "interrupted-turn",
  turn: "interrupted",
  since: "2026-09-23T22:21:00.000Z",
  previousBoot: "b1",
  observedBoot: "b2",
  doing: {
    brief: "Implement the importer",
    messageId: U(500 + n),
    deliveryState: "delivered",
    untrusted: true,
  },
  grants: { role: false, seated: false, permission: null },
  owner: null,
  repo: { repos: [] },
  observeError: null,
  currentStatus: "idle",
  resumable: true,
  reason: null,
  disposition: "resume",
  ...extra,
});

test("validateRecovery refuses unknown states, causes and turns rather than rendering them as something else", () => {
  assert.doesNotThrow(() => validateRecovery({ items: [item(1)], unsettled: [] }));
  for (const bad of [
    { state: "completed" },
    { cause: "whatever" },
    { turn: "done" },
    { resumable: "yes" },
    { sessionId: "not-a-uuid" },
    { doing: { brief: "x".repeat(601) } },
  ])
    assert.throws(
      () => validateRecovery({ items: [item(1, bad)], unsettled: [] }),
      /Invalid recovery/,
      JSON.stringify(bad),
    );
  assert.throws(
    () => validateRecovery({ items: Array.from({ length: 65 }, (_, i) => item(i)) }),
    /Invalid recovery status/,
  );
});

test("the card says what the controller said: quoted brief, local work state, and the gate reason", () => {
  const card = recoveryCard(
    item(1, {
      repo: {
        repos: [
          {
            path: "/w/repo",
            branch: "feat/x",
            head: "0123456789ab",
            upstream: "origin/feat/x",
            ahead: 2,
            behind: 0,
            modified: 3,
            unmerged: 0,
            untracked: 1,
            clean: false,
          },
        ],
      },
    }),
    { titles: { [U(1)]: "J1 importer" } },
  );
  assert.equal(card.title, "J1 importer");
  assert.equal(card.chip, CHIPS["interrupted-turn"]);
  assert.match(card.doing.label, /quoted, never re-sent/);
  assert.equal(card.doing.text, "Implement the importer");
  assert.deepEqual(card.work, ["/w/repo: feat/x @ 0123456 · ↑2 ↓0 · 3 modified, 1 untracked"]);
  assert.match(card.workNote, /not a verification/);
  assert.equal(card.actions.resume.enabled, true);
  const refused = recoveryCard(
    item(2, {
      resumable: false,
      reason: "Human input has already reached this session since the daemon restarted",
      state: "not-resumable",
      cause: "boot-human",
    }),
  );
  assert.equal(refused.actions.resume.enabled, false);
  assert.match(refused.why, /Human input/);
  assert.match(refused.cause, /human input/);
});

test("resume is disabled on a stale observation or while another action runs, whatever the gate said", () => {
  assert.equal(recoveryCard(item(1), { fresh: false }).actions.resume.enabled, false);
  assert.match(recoveryCard(item(1), { fresh: false }).actions.resume.reason, /stale/);
  assert.equal(recoveryCard(item(1), { busy: true }).actions.resume.enabled, false);
  assert.equal(recoveryCard(item(1, { state: "needs-reconcile" })).actions.reconcile.enabled, true);
  assert.equal(recoveryCard(item(1)).actions.reconcile.enabled, false);
});

test("the preview never promises completion or a replay, and names only grants the session held", () => {
  const plain = resumePreview(item(1)).join("\n");
  assert.match(plain, /ONE controller-written message/);
  assert.match(plain, /not sent again/);
  assert.match(plain, /Resumed does not mean completed/);
  assert.doesNotMatch(plain, /routine file grant|role capability/);
  const held = resumePreview(
    item(1, {
      grants: { role: true, seated: true, permission: { rootSession: U(1), root: true } },
    }),
    "note",
  ).join("\n");
  assert.match(held, /Reissues its role capability/);
  assert.match(held, /unless the operator revoked it/);
  assert.match(held, /Your note is appended/);
  assert.match(resumePreview(item(1, { turn: "unknown" })).join("\n"), /of unknown outcome/);
});

test("leaders first, then by attention; the team action takes only resumable members", () => {
  const worker = item(1),
    leader = item(2, { grants: { seated: true }, state: "idle-at-restart" }),
    stuck = item(3, { resumable: false, state: "not-resumable" });
  assert.deepEqual(
    orderItems([stuck, worker, leader]).map((x) => x.sessionId),
    [U(2), U(1), U(3)],
  );
  assert.deepEqual(
    teamItems([worker, stuck, leader]).map((x) => x.sessionId),
    [U(2), U(1)],
  );
});

test("the banner is absent when nothing needs recovery, and counts what does", () => {
  assert.equal(bannerSummary({ items: [], unsettled: [] }), null);
  assert.equal(bannerSummary(undefined), null);
  const b = bannerSummary({
    items: [
      item(1),
      item(2, { resumable: false, state: "needs-reconcile" }),
      item(3, { resumable: false, state: "not-resumable" }),
    ],
    unsettled: [{ id: U(9), needsHuman: true }],
  });
  assert.equal(b.severity, "attention");
  assert.equal(
    b.text,
    "Host restart at 23 Sep 22:21 UTC: 3 sessions interrupted · 1 resumable · 1 need reconcile · 1 not resumable · 1 delivery needs a human decision",
  );
  assert.equal(
    bannerSummary({ items: [], unsettled: [{ id: U(9), needsHuman: false }] }),
    null,
    "a delivery still being reconciled automatically is not a banner",
  );
});

test("repo lines: unreadable, detached and clean are stated plainly", () => {
  assert.equal(repoLine({ path: "/r", error: "timeout" }), "/r: could not read (timeout)");
  assert.equal(
    repoLine({
      path: "/r",
      branch: null,
      head: null,
      upstream: null,
      ahead: null,
      behind: null,
      modified: 0,
      unmerged: 0,
      untracked: 0,
      clean: true,
    }),
    "/r: detached · no upstream · clean",
  );
});

// J8 (J7 walkthrough): items outstanding from an older restart (H2) and a newer one (H4) at once. The headline named
// the older restart above the newer cards. It must describe the latest restart and count only its sessions.
test("the banner headline describes the latest restart; older restarts and other takeovers are one trailing count", () => {
  const h2 = (n, extra) =>
    item(n, { since: "2026-09-23T23:32:16.281Z", observedBoot: "boot-h2", ...extra });
  const h4 = (n, extra) =>
    item(n, {
      since: "2026-09-24T07:16:45.922Z",
      observedBoot: "boot-h4",
      state: "idle-at-restart",
      ...extra,
    });
  const human = item(9, {
    cause: "human-input",
    since: "2026-09-23T23:42:00.890Z",
    observedBoot: "boot-h2",
    resumable: false,
    state: "not-resumable",
  });
  const b = bannerSummary({
    items: [
      h2(1, { resumable: false, state: "control-changed" }),
      h4(2),
      h4(3, { since: "2026-09-24T07:16:46.239Z", resumable: false, state: "not-resumable" }),
      human,
    ],
    unsettled: [],
  });
  assert.equal(
    b.text,
    "Host restart at 24 Sep 07:16 UTC: 2 sessions interrupted · 1 resumable · 1 not resumable · 2 more from earlier restarts or other takeovers",
  );
  assert(!b.text.includes("23 Sep"), "never the older restart");
  assert.equal(latestRestart([human]), null, "a human-input takeover is not a host restart");
  assert.equal(
    bannerSummary({ items: [human], unsettled: [] }).text,
    "Sessions taken over: 1 session interrupted · 1 not resumable",
  );
  // Arrival order must not matter: the newest restart wins even when listed first.
  assert.equal(
    bannerSummary({ items: [h4(2), h2(1)], unsettled: [] }).text.startsWith(
      "Host restart at 24 Sep 07:16 UTC: 1 session interrupted",
    ),
    true,
  );
});

// J0 (J7 walkthrough #3): the headline's restart is the restart of the cards directly under it. Older-restart and
// human-input cards are listed after, under their own label, never mixed in beneath the headline.
test("the cards under the headline are exactly the headline restart; everything else follows under its own label", () => {
  const h2 = item(1, {
    since: "2026-09-23T23:32:16.281Z",
    observedBoot: "boot-h2",
    grants: { role: true, seated: true, permission: null },
  });
  const h4a = item(2, {
    since: "2026-09-24T07:16:45.922Z",
    observedBoot: "boot-h4",
    state: "idle-at-restart",
  });
  const h4b = item(3, {
    since: "2026-09-24T07:16:46.239Z",
    observedBoot: "boot-h4",
    grants: { role: true, seated: true, permission: null },
  });
  const human = item(4, {
    cause: "human-input",
    since: "2026-09-24T08:00:00.000Z",
    observedBoot: "boot-h4",
    resumable: false,
    state: "not-resumable",
  });
  const status = { items: [h2, h4a, human, h4b], unsettled: [] },
    sections = recoverySections(status.items);
  assert.deepEqual(
    sections.map((s) => [s.key, s.title, s.items.map((x) => x.sessionId)]),
    [
      ["latest", null, [U(3), U(2)]],
      ["earlier", EARLIER, [U(1), U(4)]],
    ],
  );
  const headline = bannerSummary(status).text,
    restartAt = headline.match(/^Host restart at (.+?): /)[1];
  assert.equal(
    restartAt,
    when(sections[0].items.map((x) => x.since).sort()[0]),
    "the headline names the first takeover of the cards under it",
  );
  assert(
    sections[0].items.every((x) => x.observedBoot === "boot-h4") && !headline.includes("23 Sep"),
  );
  assert.deepEqual(
    recoverySections([human]).map((s) => [s.key, s.items.length]),
    [["all", 1]],
    "no restart: one untitled list",
  );
  assert.deepEqual(recoverySections([]), []);
});
test("items with no recorded boot are never pooled into one restart spanning several", () => {
  // No boot recorded at all (J0-7: grouped by a two-minute window), and hours apart: two restarts.
  const old = item(1, {
      since: "2026-09-23T23:32:16.281Z",
      observedBoot: null,
      previousBoot: null,
    }),
    recent = item(2, { since: "2026-09-24T07:16:45.922Z", observedBoot: null, previousBoot: null });
  const b = bannerSummary({ items: [old, recent], unsettled: [] });
  assert.equal(
    b.text,
    "Host restart at 24 Sep 07:16 UTC: 1 session interrupted · 1 resumable · 1 more from earlier restarts or other takeovers",
  );
  assert.deepEqual(
    recoverySections([old, recent]).map((s) => s.items.map((x) => x.sessionId)),
    [[U(2)], [U(1)]],
  );
  // Different previous boots are different restarts too.
  assert.deepEqual(
    recoverySections([
      { ...old, previousBoot: "boot-h1" },
      { ...recent, previousBoot: "boot-h2" },
    ]).map((s) => s.items.map((x) => x.sessionId)),
    [[U(2)], [U(1)]],
  );
});

// J0-7 (R-A): one restart whose items recorded no boot is still one restart; restarts minutes apart stay apart.
test("boot-less items from one restart group together; by previous boot, or within a two-minute window", () => {
  const at = (ms) => new Date(Date.parse("2026-09-24T07:16:45.000Z") + ms).toISOString();
  const loose = [0, 300, 600].map((ms, i) =>
    item(10 + i, { since: at(ms), observedBoot: null, previousBoot: null }),
  );
  assert.equal(
    bannerSummary({ items: loose, unsettled: [] }).text,
    "Host restart at 24 Sep 07:16 UTC: 3 sessions interrupted · 3 resumable",
  );
  assert.deepEqual(
    recoverySections(loose).map((s) => s.items.length),
    [3],
    "no card of this restart is filed as earlier",
  );
  const older = item(20, { since: at(-3 * 60 * 1000), observedBoot: null, previousBoot: null });
  assert.deepEqual(
    recoverySections([older, ...loose]).map((s) => [s.key, s.items.length]),
    [
      ["latest", 3],
      ["earlier", 1],
    ],
    "three minutes earlier is another restart",
  );
  const sameBoot = [
    item(30, { since: at(0), observedBoot: null, previousBoot: "boot-h2" }),
    item(31, { since: at(10 * 60 * 1000), observedBoot: null, previousBoot: "boot-h2" }),
  ];
  assert.equal(
    latestRestart(sameBoot).items.length,
    2,
    "the same previous boot is the same restart, however far apart",
  );
  assert.equal(RESTART_WINDOW_MS, 120000);
});

test("U5-D05: a card leads with the cause in plain words, how long ago, and the safe next step; ids and history are details", () => {
  const now = Date.parse("2026-09-24T01:21:00.000Z");
  const card = recoveryCard(item(1), { now });
  assert.equal(card.headline, "Stopped when the computer or Fulcra restarted 3 hours ago.");
  assert.match(card.nextStep, /^Resume it\. Fulcra will ask it to check its work/);
  assert.doesNotMatch(
    card.headline + card.nextStep,
    /[a-f0-9]{8}-[a-f0-9]{4}/,
    "no UUID in what is read first",
  );
  assert.ok(
    card.details.some((d) => d.includes(U(1))),
    "the session id is kept under details",
  );
  const untitled = recoveryCard(item(7), { now, titles: {} });
  assert.equal(
    untitled.title,
    `Session ${U(7).slice(0, 8)}`,
    "an unnamed session is a short label, not a full UUID",
  );
  const refused = recoveryCard(
    item(2, {
      resumable: false,
      reason: "Human input has already reached this session since the daemon restarted.",
      state: "not-resumable",
      cause: "boot-human",
    }),
    { now },
  );
  assert.match(
    refused.nextStep,
    /^Open the conversation and decide what to do: it cannot be resumed automatically \(Human input has already reached/,
  );
  assert.match(
    recoveryCard(item(3, { state: "busy-stale" }), { now }).nextStep,
    /Wait a minute and refresh/,
  );
  assert.match(
    recoveryCard(item(4, { state: "needs-reconcile" }), { now }).nextStep,
    /Reconcile its unfinished delivery first/,
  );
});
