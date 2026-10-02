// Fulcra J3 Inbox RPC contracts (CONTRACTS.md §3.3–§3.4, §4.2). The server handlers are driven against the
// REAL controller on a temporary journal (src/control/decisions.fixture.mjs), so every output schema is
// checked against what the controller actually returns, not against a hand-written double. The TypeScript
// side is bundled here first (as verify-ui.mjs does), so this file runs on its own with `node --test`.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  fixture,
  level1,
  option,
  P,
  T,
  deviceKey,
  signed,
} from "../../src/control/decisions.fixture.mjs";
import { closeSeatingDefaults } from "../../src/control/role-defaults-fixture.mjs";
import { requireUnpinnedAdmissionGuard } from "../../src/control/admission-guard-precondition.mjs";
requireUnpinnedAdmissionGuard();
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  require = createRequire(import.meta.url);
const out = path.join(root, "runtime");
fs.mkdirSync(out, { recursive: true });
for (const [entry, file] of [
  ["server/inbox.ts", "inbox-server.mjs"],
  ["shared/cc/decision.ts", "cc-decision.mjs"],
  ["server/devices.ts", "devices-server.mjs"],
  ["shared/cc/devices.ts", "cc-devices.mjs"],
  ["server/channels.ts", "channels-server.mjs"],
  ["shared/cc/channels.ts", "cc-channels.mjs"],
])
  await require("esbuild").build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    outfile: path.join(out, file),
    logLevel: "silent",
  });
const { createInbox } = await import(path.join(out, "inbox-server.mjs"));
const C = await import(path.join(out, "cc-decision.mjs"));
const { createDevices } = await import(path.join(out, "devices-server.mjs"));
const D = await import(path.join(out, "cc-devices.mjs"));
const { createChannels, startPush } = await import(path.join(out, "channels-server.mjs"));
const CH = await import(path.join(out, "cc-channels.mjs"));

async function seeded(t) {
  const f = await fixture(t);
  const call = (method, input) => f.op(method, input);
  const level = (await f.ask(level1())).decision;
  closeSeatingDefaults(f.control);
  const channel = await f.op("channels-open", {
    primeSeat: "delivery",
    projectSeat: P(1),
    purpose: "Weekly delivery check-in between the board seat and this project",
    maxMessages: 6,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    expectedPrimeRevision: 1,
    expectedProjectRevision: 1,
  });
  f.control.takeover(f.prime, "The human-facing lead holds this seat");
  await f.op("seat-hold", {
    role: "prime",
    seat: "delivery",
    expectedRevision: 1,
    expectedSessionGeneration: f.store.get(f.prime).generation,
    note: "Held by the human-facing lead by design",
  });
  const heldId = randomUUID();
  await f.role("project", "channels-send", {
    channelId: channel.channelId,
    messageId: heldId,
    text: "Status: the practice copy is ready for review",
  });
  // C1: the digest slot is pinned to 00:00, which has always passed, so the result never depends on the time of day
  // (the default 08:00 slot made this fail before 08:00 local). Then wait for the real condition, not a timer:
  // both digests (All work and this project) are in the journal before anything reads the Inbox.
  f.control.decisions.digestAt = { default: "00:00" };
  const digests = () => f.store.db.prepare("SELECT count(*) n FROM cc_digests").get().n;
  while (digests() < 2) {
    const r = await f.op("decisions-digest-run", null);
    if (!r.composed.length && digests() < 2) throw Error("The digest run composed nothing");
  }
  return { f, call, level, channel, heldId };
}

test("R1: inputs are strict; no caller can name an actor, a channel of origin or a path", () => {
  const ok = {
    messageId: randomUUID(),
    id: randomUUID(),
    expectedRevision: 1,
    optionId: "a",
    note: "",
    confirmDestructive: false,
  };
  assert.equal(C.decisionChooseRpc.input.safeParse(ok).success, true);
  for (const extra of [
    { actor: "human" },
    { by: "human" },
    { via: "discord-openclaw" },
    { via: "session" },
    { channelId: randomUUID() },
    { token: "x" },
    { path: "a" },
    { url: "https://x.example" },
    { command: "rm" },
  ])
    assert.equal(
      C.decisionChooseRpc.input.safeParse({ ...ok, ...extra }).success,
      false,
      JSON.stringify(extra),
    );
  for (const via of ["app-mac", "app-ios", "app-android", "app-windows", "app-linux", "app-web"])
    assert.equal(C.decisionChooseRpc.input.safeParse({ ...ok, via }).success, true, via);
  assert.equal(
    C.decisionChooseRpc.input.safeParse({ ...ok, note: "mail me at someone@example.com" }).success,
    false,
    "notes are personal-data free",
  );
  assert.equal(C.inboxRpc.input.safeParse({ projectId: P(1) }).success, false);
  assert.equal(
    C.heldReleaseRpc.input.safeParse({
      channelId: randomUUID(),
      messageId: randomUUID(),
      expectedSeatRevision: 1,
      seat: "delivery",
    }).success,
    false,
    "the seat comes from the message, never input",
  );
});

test("R2: every read and write output from the real controller satisfies its contract", async (t) => {
  const { f, call, level, channel, heldId } = await seeded(t),
    inbox = createInbox({ call });
  const list = C.inboxRpc.output.parse(await inbox.inbox());
  assert.equal(list.stale, false);
  assert.deepEqual(list.items.map((i) => i.source).sort(), [
    "decision",
    "digest",
    "digest",
    "held",
  ]);
  assert(
    list.items.some(
      (i) =>
        i.key === `decision-${level.id}` && i.urgency === "now" && i.ref === `decision:${level.id}`,
    ),
  );
  const one = C.decisionRpc.output.parse(await inbox.decision({ id: level.id }));
  assert.deepEqual(one.evidence, [
    { ref: `task:${T(1)}`, label: "The planning task", kind: "task" },
  ]);
  const stale = C.decisionChooseRpc.output.parse(
    await inbox.choose({
      messageId: randomUUID(),
      id: level.id,
      expectedRevision: 7,
      optionId: "a",
      note: "",
      confirmDestructive: false,
    }),
  );
  assert.deepEqual([stale.ok, stale.message], [false, "Changed since you looked; refresh"]);
  const chosen = C.decisionChooseRpc.output.parse(
    await inbox.choose({
      messageId: randomUUID(),
      id: level.id,
      expectedRevision: 1,
      optionId: "a",
      note: "Go ahead",
      confirmDestructive: false,
      via: "app-web",
    }),
  );
  assert.equal(chosen.ok, true);
  assert.deepEqual(
    [chosen.decision.choice.by, chosen.decision.choice.proven],
    ["operator", false],
    "v1.6: no device proof, so the operator",
  );
  assert.equal(chosen.decision.choice.via, "app-web");
  const again = await inbox.choose({
    messageId: randomUUID(),
    id: level.id,
    expectedRevision: 2,
    optionId: "b",
    note: "",
    confirmDestructive: false,
  });
  assert.equal(again.ok, false);
  assert.match(
    again.message,
    /^Already answered by the operator at \d\d:\d\d, not confirmed on your device$/,
  );
  const held = C.heldMessageRpc.output.parse(
    await inbox.held({ channelId: channel.channelId, messageId: heldId }),
  );
  assert.equal(held.message.untrustedText, "Status: the practice copy is ready for review");
  assert.equal(
    C.heldReadRpc.output.parse(
      await inbox.heldRead({ channelId: channel.channelId, messageId: heldId }),
    ).ok,
    true,
  );
  const reply = C.heldReplyRpc.output.parse(
    await inbox.heldReply({
      channelId: channel.channelId,
      inReplyTo: heldId,
      messageId: randomUUID(),
      text: "Thanks, reviewing today",
      expectedSeatRevision: held.message.pins.seatRevision,
      expectedHolderGeneration: held.message.pins.holderGeneration,
    }),
  );
  assert.deepEqual([reply.ok, reply.state], [true, "delivered"]);
  assert.equal(
    C.heldReleaseRpc.output.parse(
      await inbox.heldRelease({
        channelId: channel.channelId,
        messageId: heldId,
        expectedSeatRevision: held.message.pins.seatRevision,
      }),
    ).ok,
    true,
  );
  assert.equal(
    (
      await inbox.heldRelease({
        channelId: channel.channelId,
        messageId: heldId,
        expectedSeatRevision: held.message.pins.seatRevision,
      })
    ).message,
    "This seat is no longer held for you",
  );
  const digestItem = list.items.find(
    (i) => i.source === "digest" && i.title === "Daily digest · All work",
  );
  const digest = C.digestRpc.output.parse(
    await inbox.digest({ id: digestItem.key.slice("digest-".length) }),
  );
  assert.equal(digest.digest.noUpdate, "No project update was written today");
  assert.equal(digest.digest.held.waiting, 1);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM cc_digests").get().n, 2);
});

test("R3: a stalled controller returns the last good list marked stale, never an empty screen", async (t) => {
  const { call } = await seeded(t);
  let down = false;
  const inbox = createInbox({
    call: (m, i) =>
      down
        ? Promise.reject(Error("Control timed out; inspect delivery before retrying"))
        : call(m, i),
  });
  const good = await inbox.inbox();
  down = true;
  const later = C.inboxRpc.output.parse(await inbox.inbox());
  assert.equal(later.stale, true);
  assert.equal(later.error, "Control timed out; inspect delivery before retrying");
  assert.deepEqual(later.items, good.items);
  assert.equal(later.observedAt, good.observedAt);
  const cold = C.inboxRpc.output.parse(
    await createInbox({ call: () => Promise.reject(Error("No controller")) }).inbox(),
  );
  assert.deepEqual([cold.stale, cold.items.length, cold.error], [true, 0, "No controller"]);
});

test("U5-D01: the controller's per-section skip counts reach the app; unknown sections are dropped", async (t) => {
  const { call } = await seeded(t);
  const inbox = createInbox({
    call: async (m, i) => {
      const r = await call(m, i);
      return m === "decisions-inbox"
        ? { ...r, partial: true, unreadable: { held: 2, digests: 1, bogus: 9 } }
        : r;
    },
  });
  const got = C.inboxRpc.output.parse(await inbox.inbox());
  assert.equal(got.partial, true);
  assert.deepEqual(got.unreadable, { held: 2, digests: 1 });
  const clean = C.inboxRpc.output.parse(await createInbox({ call }).inbox());
  assert.equal(clean.unreadable, undefined);
});
test("R4: the legacy outcome adapter lists undecided records read-only, and drops decided or unauthorised ones", async (t) => {
  const { call } = await seeded(t);
  const task = (n) => `44444444-4444-4444-8444-${String(n).padStart(12, "0")}`;
  const records = {
    [task(1)]: {
      title: "Choose the release date",
      decision: null,
      publishedAt: "2026-09-20T10:00:00.000Z",
      coordination: {
        decisionNeeded: "Pick the week we release in.",
        affectedProjects: [{ projectId: P(1) }],
        dependsOn: [],
      },
    },
    [task(2)]: {
      title: "Already decided",
      decision: { alternativeId: "a" },
      coordination: { decisionNeeded: null, affectedProjects: [], dependsOn: [] },
    },
    [task(3)]: {
      title: "Not yours to see",
      decision: null,
      coordination: { decisionNeeded: "Hidden", affectedProjects: [], dependsOn: [] },
    },
  };
  const inbox = createInbox({
    call,
    outcomes: { list: () => Object.keys(records), read: (id) => ({ record: records[id] }) },
    allowed: async (id) => id !== task(3),
  });
  const legacy = C.inboxRpc.output
    .parse(await inbox.inbox())
    .items.filter((i) => i.source === "outcome");
  assert.deepEqual(legacy, [
    {
      key: `outcome-${task(1)}`,
      source: "outcome",
      ref: `outcome:${task(1)}`,
      title: "Choose the release date",
      summary: "Pick the week we release in.",
      projectId: P(1),
      urgency: "today",
      createdAt: "2026-09-20T10:00:00.000Z",
      unread: true,
    },
  ]);
});

test("L37: the legacy adapter checks authority only for undecided records, at most 12, and says partial when it stops", async (t) => {
  const { call } = await seeded(t);
  const task = (n) => `55555555-5555-4555-8555-${String(n).padStart(12, "0")}`;
  const undecided = (n) => ({
    title: `Undecided ${n}`,
    decision: null,
    publishedAt: "2026-09-20T10:00:00.000Z",
    coordination: { decisionNeeded: "Pick one.", affectedProjects: [], dependsOn: [] },
  });
  const decided = (n) => ({
    title: `Decided ${n}`,
    decision: { alternativeId: "a" },
    coordination: { decisionNeeded: null, affectedProjects: [], dependsOn: [] },
  });
  const build = (recs) => {
    let checks = 0;
    const inbox = createInbox({
      call,
      outcomes: { list: () => Object.keys(recs).sort(), read: (id) => ({ record: recs[id] }) },
      allowed: async () => {
        checks++;
        return true;
      },
    });
    return { inbox, checks: () => checks };
  };
  // 20 published records, 2 still needing a decision: 2 authority checks, not 20; nothing truncated.
  const few = Object.fromEntries(
    Array.from({ length: 20 }, (_, i) => [task(i), i < 2 ? undecided(i) : decided(i)]),
  );
  let b = build(few),
    out = C.inboxRpc.output.parse(await b.inbox.inbox());
  assert.equal(b.checks(), 2);
  assert.equal(out.items.filter((i) => i.source === "outcome").length, 2);
  assert.equal(out.partial, false);
  // 15 undecided: 12 checked and listed, the rest reported as partial rather than dropped silently.
  const many = Object.fromEntries(
    Array.from({ length: 15 }, (_, i) => [task(100 + i), undecided(i)]),
  );
  b = build(many);
  out = C.inboxRpc.output.parse(await b.inbox.inbox());
  assert.equal(b.checks(), 12);
  assert.equal(out.items.filter((i) => i.source === "outcome").length, 12);
  assert.equal(out.partial, true);
});

test("R5 (v1.5 #7): stored packets are read back for structure only; ask-time rules stay on askPacket; a malformed item drops out alone", async (t) => {
  const { f, call, level } = await seeded(t);
  const packet = f.control.decisions.packet(level.id);
  assert.equal(C.decisionPacket.safeParse(packet).success, true);
  // A term added to the jargon list later, or any ask-time rule, must not make a stored packet unreadable.
  assert.equal(
    C.decisionPacket.safeParse({ ...packet, title: "Fix the webhook?" }).success,
    true,
    "still readable and answerable",
  );
  assert.equal(C.decisionPacket.safeParse({ ...packet, options: [option("a")] }).success, true);
  // Structure, limits and noPersonal still hold on read.
  assert.equal(
    C.decisionPacket.safeParse({ ...packet, state: "chosen" }).success,
    false,
    "chosen without a choice",
  );
  assert.equal(
    C.decisionPacket.safeParse({ ...packet, askedBy: { ...packet.askedBy, extra: 1 } }).success,
    false,
  );
  assert.equal(C.decisionPacket.safeParse({ ...packet, title: "x".repeat(121) }).success, false);
  assert.equal(
    C.decisionPacket.safeParse({ ...packet, situation: "Logs are in ~/app" }).success,
    false,
  );
  // The ask contract still runs #1, #2 and #9.
  const {
    version,
    id,
    revision,
    askedBy,
    state,
    supersededBy,
    choice,
    delivery,
    createdAt,
    updatedAt,
    ...asked
  } = packet;
  assert.equal(C.askPacket.safeParse(asked).success, true);
  assert.equal(C.askPacket.safeParse({ ...asked, title: "Fix the webhook?" }).success, false);
  const inbox = createInbox({
    call: async (m, i) => {
      const r = await call(m, i);
      if (m === "decisions-inbox") r.items.push({ key: "BAD KEY", source: "decision" });
      return r;
    },
  });
  const list = C.inboxRpc.output.parse(await inbox.inbox());
  assert.equal(list.partial, true);
  assert(!list.items.some((i) => i.key === "BAD KEY"));
});

test("R-J3-6: a choice the controller recorded is ok even if the packet cannot be parsed for display", async (t) => {
  const { call, level } = await seeded(t);
  const inbox = createInbox({
    call: async (m, i) => {
      const r = await call(m, i);
      return m === "decisions-choose" ? { ...r, decision: { ...r.decision, unexpected: true } } : r;
    },
  });
  const r = C.decisionChooseRpc.output.parse(
    await inbox.choose({
      messageId: randomUUID(),
      id: level.id,
      expectedRevision: 1,
      optionId: "a",
      note: "Go with the low-risk-first option",
      confirmDestructive: false,
    }),
  );
  assert.deepEqual([r.ok, r.message, r.decision], [true, null, null]);
});

test("R-J3-11: held-reply text is personal-data free, and ordinary words pass", () => {
  const reply = {
    channelId: randomUUID(),
    inReplyTo: randomUUID(),
    messageId: randomUUID(),
    expectedSeatRevision: 1,
    expectedHolderGeneration: 1,
  };
  assert.equal(
    C.heldReplyRpc.input.safeParse({ ...reply, text: "Go with the low-risk-first plan" }).success,
    true,
  );
  for (const text of [
    "Details are in ~/notes",
    "Write to someone@example.com",
    "Use sk-abcdEFGH12345678",
  ])
    assert.equal(C.heldReplyRpc.input.safeParse({ ...reply, text }).success, false, text);
});

test("R-D1 (v1.6 §3.6): device RPCs against the real controller: pair, list, prove an answer, surface a refused proof, revoke", async (t) => {
  const { f, call } = await seeded(t);
  assert.equal(
    (await createDevices({ call }).open({})).message,
    "Pairing arrives with the next Fulcra update",
    "no host device API, no window",
  );
  const devices = createDevices({ call, hostDevice: true }),
    inbox = createInbox({ call });
  assert.deepEqual(D.devicesRpc.output.parse(await devices.list()).devices, []);
  const w = D.devicePairOpenRpc.output.parse(await devices.open({}));
  assert.equal(w.ok, true);
  assert.match(w.code, /^\d{6}$/);
  const key = deviceKey(),
    device = {
      label: "Test Mac",
      platform: "macos",
      publicKey: key.publicKey,
      keyStorage: "os-protected",
      userPresence: true,
    };
  const payload = {
    purpose: "fulcra.device.pair",
    windowId: w.windowId,
    code: w.code,
    device,
    messageId: randomUUID(),
    at: new Date().toISOString(),
  };
  const input = D.devicePairCompleteRpc.input.parse({ payload, signature: signed(key, payload) });
  const paired = D.devicePairCompleteRpc.output.parse(await devices.complete(input));
  assert.equal(paired.ok, true);
  assert.equal(D.protectionText(paired.device), "Protected by Touch ID");
  assert.equal(
    D.devicePairOpenRpc.output.parse(await devices.open({})).ok,
    false,
    "no second first-device window",
  );
  // A proven answer through organization.decision-choose.
  const d = (await f.ask(level1({ title: "Open the shop on Sundays?" }))).decision;
  const messageId = randomUUID(),
    proofPayload = {
      decisionId: d.id,
      revision: d.revision,
      optionId: "a",
      digest: null,
      messageId,
      note: "",
      confirmDestructive: false,
      at: new Date().toISOString(),
    };
  const choose = C.decisionChooseRpc.input.parse({
    messageId,
    id: d.id,
    expectedRevision: d.revision,
    optionId: "a",
    note: "",
    confirmDestructive: false,
    via: "app-mac",
    proof: {
      deviceId: paired.device.id,
      alg: "ES256",
      payload: proofPayload,
      signature: signed(key, proofPayload),
    },
  });
  const proven = C.decisionChooseRpc.output.parse(await inbox.choose(choose));
  assert.deepEqual(
    [proven.ok, proven.message, proven.decision.choice.by, proven.decision.choice.deviceId],
    [true, null, "human", paired.device.id],
  );
  // v1.8 R2-5: a proof that does not hold refuses the answer with the reason, and nothing is recorded.
  const e = (await f.ask(level1({ title: "Hire a second designer?" }))).decision;
  const bad = { ...proofPayload, decisionId: e.id, messageId: randomUUID() };
  const refused = C.decisionChooseRpc.output.parse(
    await inbox.choose({
      messageId: randomUUID(),
      id: e.id,
      expectedRevision: 1,
      optionId: "a",
      note: "",
      confirmDestructive: false,
      proof: {
        deviceId: paired.device.id,
        alg: "ES256",
        payload: bad,
        signature: signed(key, bad),
      },
    }),
  );
  assert.equal(refused.ok, false);
  assert.match(refused.message, /did not check out: The proof does not match this answer/);
  assert.equal(f.control.decisions.packet(e.id).state, "open", "nothing recorded");
  // Unknown fields are refused, and a revocation is a signed act.
  assert.equal(D.deviceRevokeRpc.input.safeParse({ deviceId: paired.device.id }).success, false);
  const rev = {
    purpose: "fulcra.device.revoke",
    deviceId: paired.device.id,
    messageId: randomUUID(),
    at: new Date().toISOString(),
  };
  const revoked = D.deviceRevokeRpc.output.parse(
    await devices.revoke({
      proof: {
        deviceId: paired.device.id,
        alg: "ES256",
        payload: rev,
        signature: signed(key, rev),
      },
    }),
  );
  assert.equal(revoked.device.state, "revoked");
  const list = C.inboxRpc.output.parse(await inbox.inbox());
  assert.equal(
    list.items.filter((i) => i.key.startsWith("attention-device-") && i.urgency === "now").length,
    2,
    "the pairing and the revocation are announced",
  );
});

test("R-C1 (§3.5): channel RPCs against the real controller: pair, list, pause, revoke; the label rules are plain words", async (t) => {
  const { f, call } = await seeded(t);
  const channels = createChannels({ call });
  const scope = { projects: "all", canAnswer: true, levels: [1, 2, 3] };
  assert.equal(
    CH.channelPairOpenRpc.input.safeParse({ kind: "cli", label: "Terminal", scope, token: "x" })
      .success,
    false,
  );
  const w = CH.channelPairOpenRpc.output.parse(
    await channels.open({ kind: "cli", label: "Terminal", scope }),
  );
  assert.deepEqual([w.ok, w.pairedBy], [true, "operator"]);
  assert.match(w.code, /^\d{6}$/);
  await f.request({ method: "cc-channel-pair", input: { code: w.code, hostId: "test-host" } });
  let list = CH.channelsRpc.output.parse(await channels.list());
  assert.equal(list.channels.length, 1);
  const ch = list.channels[0];
  assert.equal(CH.channelAnswerText(ch), "Answers here are marked as answered by the operator");
  const paused = CH.channelPauseRpc.output.parse(
    await channels.pause({ id: ch.id, expectedRevision: ch.revision, paused: true }),
  );
  assert.equal(paused.channel.state, "paused");
  assert.equal(
    (await channels.pause({ id: ch.id, expectedRevision: ch.revision, paused: false })).message,
    "Changed since you looked; refresh",
  );
  const revoked = CH.channelRevokeRpc.output.parse(
    await channels.revoke({ id: ch.id, expectedRevision: paused.channel.revision }),
  );
  assert.equal(revoked.channel.state, "revoked");
});

test("R-C2 (§3.4 push): title only, once per new urgent item, never on the first look; with no host notify nothing runs", async () => {
  let reads = 0;
  const stop = startPush({
    notify: undefined,
    read: async () => {
      reads++;
      return { items: [], stale: false };
    },
  });
  stop();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(reads, 0, "degrades silently: no polling at all without notify");
  const sent = [],
    inbox = { items: [{ key: "held-x", urgency: "now", title: "Old urgent item" }], stale: false };
  const stop2 = startPush({
    notify: (n) => {
      sent.push(n);
    },
    read: async () => inbox,
    everyMs: 10,
  });
  await new Promise((r) => setTimeout(r, 30));
  inbox.items = [
    ...inbox.items,
    { key: "decision-y", urgency: "now", title: "Where should practice copies live?" },
    { key: "digest-z", urgency: "fyi", title: "Daily digest" },
  ];
  await new Promise((r) => setTimeout(r, 60));
  stop2();
  assert.deepEqual(sent, [{ title: "Where should practice copies live?", key: "decision-y" }]);
});

test("G4: the review record reaches the real controller once, is strict, and a refusal is an answer", async (t) => {
  const f = await fixture(t),
    call = (method, input) => f.op(method, input),
    inbox = createInbox({ call });
  const input = {
    workspace: "/work/checkout-app",
    repo: "acme/checkout",
    number: 42,
    headSha: "a".repeat(40),
    choice: "request_changes",
    note: "Add a test for the retry.",
    via: "app-web",
  };
  assert.equal(C.reviewRecordRpc.input.safeParse(input).success, true);
  for (const bad of [
    { choice: "merge" },
    { note: "x".repeat(501) },
    { note: "mail me at someone@example.com" },
    { headSha: "abc" },
    { repo: "a b" },
    { postToGithub: true },
    { via: "session" },
  ])
    assert.equal(
      C.reviewRecordRpc.input.safeParse({ ...input, ...bad }).success,
      false,
      JSON.stringify(bad),
    );
  const first = C.reviewRecordRpc.output.parse(await inbox.recordReview(input));
  assert.equal(first.ok, true);
  assert.equal(first.already, false);
  assert.match(first.decisionId, /^[0-9a-f-]{36}$/);
  const again = C.reviewRecordRpc.output.parse(await inbox.recordReview(input));
  assert.deepEqual([again.ok, again.already, again.decisionId], [true, true, first.decisionId]);
  const list = C.inboxRpc.output.parse(await inbox.inbox());
  assert.equal(
    list.items.find((i) => i.ref === `decision:${first.decisionId}`)?.title,
    "You reviewed PR #42: Request changes — Add a test for the retry.",
  );
  const refused = C.reviewRecordRpc.output.parse(
    await inbox.recordReview({ ...input, repo: "../etc" }),
  );
  assert.deepEqual([refused.ok, refused.decisionId], [false, null]);
  assert.match(refused.message, /Invalid review repository/);
});
