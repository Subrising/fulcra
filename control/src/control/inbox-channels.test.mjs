// Fulcra J3b (CONTRACTS v1.6 §3.5, CC-PLAN §2 D4): one inbox, any channel, on a temporary journal. Every call goes
// through the real rpc(): channel calls carry only their channel capability, app calls the operator gate.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { fixture, level1, option, P, signed } from "./decisions.fixture.mjs";
import { CHANNEL_PAIR_MS, NOT_FROM_YOU, PAIR_OPEN_PURPOSE, THROTTLED } from "./inbox-channels.mjs";
import { CONFIRM_ON_DEVICE } from "./decisions.mjs";
import { closeSeatingDefaults } from "./role-defaults-fixture.mjs";
import { canonicalJson } from "../../orca-organization/shared/cc/decision-rules.mjs";
import { boundedJson } from "@getpaseo/protocol/controller-frames";
import { requireUnpinnedAdmissionGuard } from "./admission-guard-precondition.mjs";
import { inboxClient, main as inboxMain } from "./fulcra-inbox.mjs";
import { PURPOSE } from "./devices.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordBootStart, sealBoot, bootChainDir } from "./boot-chain.mjs";
requireUnpinnedAdmissionGuard();

const ALL = { projects: "all", canAnswer: true, levels: [1, 2, 3] };
const OWNER_BASE = {
  senderIsOwner: true,
  agentId: "fulcra-inbox",
  nativeChannelId: "chan-0001",
  senderId: "owner-0001",
  sessionKey: "discord:test",
};
// Each owner message is its own OpenClaw turn (v1.13 R3-3).
const turn = (extra = {}) => ({ ...OWNER_BASE, turnId: randomUUID(), ...extra });
const OWNER = turn();
async function setup(t) {
  const c = { now: Date.now() },
    f = await fixture(t, { now: () => c.now });
  const channel = (method, capability, input) => f.request({ method, capability, input });
  const open = (kind, extra = {}) =>
    f.op("cc-channel-pair-open", { kind, label: `Test ${kind}`, scope: ALL, ...extra });
  // Pair a channel of `kind`; for Discord, `proven` opens the window with a paired-device proof (owner-capable).
  const pair = async (kind, { proven = false, origin = turn() } = {}) => {
    let proof;
    if (proven) {
      f.dev ??= await f.pairFirst();
      const payload = {
        purpose: PAIR_OPEN_PURPOSE,
        kind,
        label: `Test ${kind}`,
        scope: ALL,
        messageId: randomUUID(),
        at: new Date(c.now).toISOString(),
      };
      proof = { deviceId: f.dev.id, alg: "ES256", payload, signature: signed(f.dev.key, payload) };
    }
    const w = await open(kind, proof ? { proof } : {});
    const extra =
      kind === "discord-openclaw"
        ? { origin }
        : kind === "session"
          ? { sessionId: f.project }
          : { hostId: "test-host" };
    const r = await channel("cc-channel-pair", undefined, { code: w.code, ...extra });
    return { ...r.channel, capability: r.capability, window: w };
  };
  const answer = (ch, key, optionId, extra = {}) => {
    const d = f.control.decisions.packet(key.slice(key.indexOf("-") + 1));
    return channel("cc-inbox-answer", ch.capability, {
      channelId: ch.id,
      key,
      optionId,
      note: "",
      messageId: randomUUID(),
      expectedRevision: d.revision,
      ...extra,
    });
  };
  return { f, c, channel, open, pair, answer };
}

test("pairing: in-app code, 10 minutes, single use, bounded guessing, hashes of external ids only", async (t) => {
  const { f, c, channel, open, pair } = await setup(t);
  // Expiry.
  const late = await open("cli");
  c.now += CHANNEL_PAIR_MS + 1000;
  await assert.rejects(
    channel("cc-channel-pair", undefined, { code: late.code, hostId: "test-host" }),
    /not right, or it has expired/,
  );
  c.now += 61000; // an expired code counts as a wrong one (R3-5 throttle)
  // Single use.
  const w = await open("cli");
  const first = await channel("cc-channel-pair", undefined, { code: w.code, hostId: "test-host" });
  assert.equal(first.channel.kind, "cli");
  assert.match(first.capability, /^[A-Za-z0-9_-]{43}$/);
  await assert.rejects(
    channel("cc-channel-pair", undefined, { code: w.code, hostId: "test-host" }),
    /not right/,
  );
  c.now += 61000;
  // R3-5: wrong codes are throttled in time, and never close someone else's window.
  const g = await open("cli"),
    wrong = g.code === "000000" ? "111111" : "000000";
  await assert.rejects(
    channel("cc-channel-pair", undefined, { code: wrong, hostId: "test-host" }),
    /not right/,
  );
  await assert.rejects(
    channel("cc-channel-pair", undefined, { code: wrong, hostId: "test-host" }),
    new RegExp(THROTTLED),
    "the next try waits",
  );
  for (let i = 0; i < 6; i++) {
    c.now += 61000;
    await assert.rejects(
      channel("cc-channel-pair", undefined, { code: wrong, hostId: "test-host" }),
      /not right/,
    );
  }
  await assert.rejects(
    channel("cc-channel-pair", undefined, { code: g.code, hostId: "test-host" }),
    new RegExp(THROTTLED),
    "right after a wrong code, even the right one waits",
  );
  c.now += 61000;
  assert.equal(
    (await channel("cc-channel-pair", undefined, { code: g.code, hostId: "test-host" })).channel
      .kind,
    "cli",
    "seven wrong guesses later the owner still pairs",
  );
  // A window named by its id closes after five wrong codes for IT, and only it.
  const h = await open("cli"),
    k = await open("cli"),
    bad = h.code === "000000" ? "111111" : "000000";
  for (let i = 0; i < 5; i++) {
    c.now += 61000;
    await assert.rejects(
      channel("cc-channel-pair", undefined, {
        code: bad,
        windowId: h.windowId,
        hostId: "test-host",
      }),
      /not right/,
    );
  }
  c.now += 61000;
  await assert.rejects(
    channel("cc-channel-pair", undefined, {
      code: h.code,
      windowId: h.windowId,
      hostId: "test-host",
    }),
    /not right/,
    "that window is closed",
  );
  c.now += 61000;
  assert.equal(
    (
      await channel("cc-channel-pair", undefined, {
        code: k.code,
        windowId: k.windowId,
        hostId: "test-host",
      })
    ).channel.kind,
    "cli",
    "the other window still works",
  );
  c.now += 61000;
  // Discord: only the owner-verified origin can pair, and only hashes of its external ids are stored.
  const d = await open("discord-openclaw");
  await assert.rejects(
    channel("cc-channel-pair", undefined, { code: d.code, origin: turn({ senderIsOwner: false }) }),
    new RegExp(NOT_FROM_YOU),
  );
  c.now += 61000;
  const ch = await pair("discord-openclaw");
  const stored = f.store.db
    .prepare("SELECT binding FROM cc_channels WHERE id=?")
    .get(ch.id).binding;
  assert(!stored.includes("chan-0001") && !stored.includes("owner-0001"), "no raw external ids");
  assert.equal(
    JSON.parse(stored).ownerSenderHash,
    createHash("sha256").update("owner-0001").digest("hex"),
  );
  assert.equal(
    ch.answersCountAsOwner,
    false,
    "an operator-opened window pairs an operator-level channel",
  );
  // Pause and revoke, from the app.
  await f.op("cc-channel-pause", { id: ch.id, expectedRevision: 1 });
  await assert.rejects(channel("cc-inbox-list", ch.capability, { channelId: ch.id }), /paused/);
  await f.op("cc-channel-revoke", { id: ch.id, expectedRevision: 2 });
  await assert.rejects(
    channel("cc-inbox-list", ch.capability, { channelId: ch.id }),
    /revoked or invalid/,
  );
});

test("origin forgery is refused; only a device-opened channel with the owner-verified origin answers as the owner", async (t) => {
  const { f, pair, answer } = await setup(t);
  const owned = await pair("discord-openclaw", { proven: true });
  assert.deepEqual([owned.pairedBy, owned.answersCountAsOwner], ["human", true]);
  const key = (d) => `decision-${d.id}`;
  const ask = async (title) => (await f.ask(level1({ title }))).decision;
  for (const [label, origin] of [
    ["not the owner", turn({ senderIsOwner: false })],
    ["owner flag missing", turn({ senderIsOwner: "true" })],
    ["wrong channel", turn({ nativeChannelId: "chan-9999" })],
    ["wrong sender", turn({ senderId: "someone-else" })],
    ["wrong agent", turn({ agentId: "other-agent" })],
    ["another conversation", turn({ sessionKey: "discord:other" })],
    ["no turn", OWNER_BASE],
  ]) {
    const d = await ask(`Pick a colour for sign ${label.replace(/\W/g, "")}?`);
    await assert.rejects(answer(owned, key(d), "a", { origin }), new RegExp(NOT_FROM_YOU), label);
    assert.equal(f.control.decisions.packet(d.id).state, "open", label);
  }
  await assert.rejects(
    answer(owned, key(await ask("Open the shop on Sundays?")), "a"),
    new RegExp(NOT_FROM_YOU),
    "no origin at all",
  );
  const d = await ask("Hire a second designer?");
  const r = await answer(owned, key(d), "b", { origin: turn() });
  assert.deepEqual(
    [
      r.decision.choice.by,
      r.decision.choice.proven,
      r.decision.choice.via,
      r.decision.choice.channelId,
    ],
    ["human", true, "discord-openclaw", owned.id],
  );
  assert.match(r.text, /^You decided on Discord at \d\d:\d\d: Option B$/);
  // The same, correct origin on an operator-paired chat channel is the operator.
  const plain = await pair("discord-openclaw");
  const e = await ask("Move the launch a week?");
  assert.equal(
    (await answer(plain, key(e), "a", { origin: turn() })).decision.choice.by,
    "operator",
  );
});

test("session and command-line answers are the operator: labelled so, and refused for an approval that starts work", async (t) => {
  const { f, pair, answer } = await setup(t);
  const cli = await pair("cli"),
    session = await pair("session");
  const d = (await f.ask(level1())).decision;
  const r = await answer(cli, `decision-${d.id}`, "a");
  assert.deepEqual(
    [r.decision.choice.by, r.decision.choice.proven, r.decision.choice.via],
    ["operator", false, "cli"],
  );
  assert.match(
    r.text,
    /^Answered by the operator at \d\d:\d\d, not confirmed on your device: Option A$/,
  );
  await assert.rejects(
    answer(session, `decision-${d.id}`, "a", { origin: OWNER }),
    /Only a chat channel carries an origin/,
  );
  f.control.decisions.binders.set("promotion", async () => ({ plan: 1 }));
  const digest = createHash("sha256")
    .update(canonicalJson({ plan: 1 }))
    .digest("hex");
  const approval = (
    await f.ask({
      kind: "approval",
      level: 2,
      projectId: P(1),
      taskId: null,
      askedOf: "human",
      title: "Put the new version live?",
      situation: "It passed its checks.",
      options: [option("approve"), option("reject")],
      recommendation: null,
      evidence: [],
      action: { type: "promotion", promotionId: randomUUID(), digest },
    })
  ).decision;
  await assert.rejects(
    answer(cli, `approval-${approval.id}`, "approve"),
    new RegExp(CONFIRM_ON_DEVICE),
  );
  await assert.rejects(
    answer(session, `approval-${approval.id}`, "approve"),
    new RegExp(NOT_FROM_YOU),
    "a session answer without its human-input proof",
  );
  assert.equal(f.control.decisions.packet(approval.id).state, "open");
});

test("answered everywhere: every post of an item gets exactly one update, and a late answer is told where it was answered", async (t) => {
  const { f, channel, pair, answer } = await setup(t);
  const discord = await pair("discord-openclaw"),
    cli = await pair("cli");
  const d = (await f.ask(level1())).decision,
    key = `decision-${d.id}`;
  // Both channels show it; Discord records the chat message it posted.
  await channel("cc-inbox-show", discord.capability, { channelId: discord.id, key });
  await channel("cc-inbox-posted", discord.capability, {
    channelId: discord.id,
    key,
    externalRef: "msg-0001",
  });
  await channel("cc-inbox-show", cli.capability, { channelId: cli.id, key });
  // Answered in the app.
  await f.choose(d, "b");
  const updates = (await channel("cc-inbox-updates", discord.capability, { channelId: discord.id }))
    .updates;
  assert.equal(updates.length, 1);
  assert.equal(updates[0].externalRef, "msg-0001");
  assert.match(
    updates[0].line,
    /^Answered by the operator at \d\d:\d\d, not confirmed on your device: Option B$/,
  );
  assert.equal(
    (
      await channel("cc-inbox-updated", discord.capability, {
        channelId: discord.id,
        postId: updates[0].postId,
      })
    ).applied,
    true,
  );
  assert.equal(
    (
      await channel("cc-inbox-updated", discord.capability, {
        channelId: discord.id,
        postId: updates[0].postId,
      })
    ).applied,
    false,
    "exactly once",
  );
  assert.deepEqual(
    (await channel("cc-inbox-updates", discord.capability, { channelId: discord.id })).updates,
    [],
  );
  // The terminal channel shows its update once, on its next list, and never again.
  const first = await channel("cc-inbox-list", cli.capability, { channelId: cli.id });
  assert.equal(first.updates.length, 1);
  assert.match(
    first.text,
    /^Update: Where should practice copies of the website live\?\. Answered by the operator at/,
  );
  assert.equal(
    (await channel("cc-inbox-list", cli.capability, { channelId: cli.id })).updates.length,
    0,
  );
  // A second answer, from any channel, changes nothing and says where the first came from.
  await assert.rejects(
    answer(cli, key, "a"),
    /^Error: Already answered by the operator at \d\d:\d\d, not confirmed on your device$/,
  );
  assert.equal(f.control.decisions.packet(d.id).choice.optionId, "b", "the first answer stands");
  // Withdrawal and expiry update posts the same way.
  const w = (await f.ask(level1({ title: "Open a second shop?" }))).decision;
  await channel("cc-inbox-show", discord.capability, {
    channelId: discord.id,
    key: `decision-${w.id}`,
  });
  await f.role("project", "roles-decision-withdraw", {
    decisionId: w.id,
    expectedRevision: 1,
    note: "Plans changed today",
  });
  const after = (await channel("cc-inbox-updates", discord.capability, { channelId: discord.id }))
    .updates;
  assert.deepEqual(
    after.map((u) => [u.state, u.line]),
    [["withdrawn", "Withdrawn by the project that asked."]],
  );
});

test("chat output shows the decision in full but never a held message body, and respects the channel scope", async (t) => {
  const { f, channel, pair } = await setup(t);
  closeSeatingDefaults(f.control);
  const rc = await f.op("channels-open", {
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
  const BODY = "SECRET-BODY the pricing plan is attached";
  const heldId = randomUUID();
  await f.role("project", "channels-send", {
    channelId: rc.channelId,
    messageId: heldId,
    text: BODY,
  });
  const d = (await f.ask(level1())).decision;
  const ch = await pair("discord-openclaw");
  await assert.rejects(
    channel("cc-inbox-list", ch.capability, { channelId: ch.id }),
    new RegExp(NOT_FROM_YOU),
    "a chat list comes from an owner turn",
  );
  const list = await channel("cc-inbox-list", ch.capability, { channelId: ch.id, origin: turn() });
  const heldKey = list.items.find((i) => i.source === "held").key;
  // C2 #3 gives the app inbox a real subject (the body's first line); chat surfaces keep the generic title only.
  const appHeld = (await f.control.decisions.inbox()).items.find((i) => i.source === "held");
  assert.match(appHeld.title, /SECRET-BODY/, "the app inbox shows the real subject");
  assert(
    !JSON.stringify(appHeld).includes("channelTitle"),
    "the chat title is never serialised to the app",
  );
  // U5-D01: the whole inbox reply, exactly as the owned channel sends it, passes the protocol's frame bound.
  const whole = await f.control.decisions.inbox();
  assert.doesNotThrow(
    () => boundedJson({ id: randomUUID(), epoch: randomUUID(), ok: true, result: whole }),
    "an inbox with a held message passes the owned-channel frame bound",
  );
  assert.equal(
    Object.getOwnPropertyNames(appHeld).includes("channelTitle"),
    false,
    "no hidden field on an inbox item",
  );
  assert.match(
    list.items.find((i) => i.source === "held").title,
    /^Message waiting from /,
    "a chat list shows the generic title",
  );
  const held = await channel("cc-inbox-show", ch.capability, { channelId: ch.id, key: heldKey });
  const decision = await channel("cc-inbox-show", ch.capability, {
    channelId: ch.id,
    key: `decision-${d.id}`,
  });
  for (const out of [list, held, decision])
    assert(!JSON.stringify(out).includes("SECRET-BODY"), "no held body in any chat output");
  assert.match(held.text, /Read it in the Fulcra app/);
  for (const part of [
    d.title,
    d.situation,
    "Recommended: Option A. It is the cheapest safe choice.",
    "1) Option A: Keep a practice copy of the site next to the real one. Like a dress rehearsal before opening night.",
  ])
    assert(decision.text.includes(part), part);
  assert(!decision.text.includes(d.id), "no ids in chat");
  // Scope: a level-1-only channel sees no level-2 decision.
  const narrow = await f.op("cc-channel-pair-open", {
    kind: "cli",
    label: "Test narrow",
    scope: { projects: "all", canAnswer: false, levels: [1] },
  });
  const n = await channel("cc-channel-pair", undefined, { code: narrow.code, hostId: "test-host" });
  const two = (await f.ask(level1({ level: 2, title: "Pick a font for the menu?" }))).decision;
  const seen = new Set(
    (await channel("cc-inbox-list", n.capability, { channelId: n.channel.id })).items.map(
      (i) => i.key,
    ),
  );
  assert(seen.has(`decision-${d.id}`) && !seen.has(`decision-${two.id}`));
  await assert.rejects(
    channel("cc-inbox-answer", n.capability, {
      channelId: n.channel.id,
      key: `decision-${d.id}`,
      optionId: "a",
      note: "",
      messageId: randomUUID(),
      expectedRevision: 1,
    }),
    /can show items but not answer/,
  );
});

test("`fulcra inbox`: pair with the app code, then list, show and answer as the operator; bound approvals stay in the app", async (t) => {
  const { f, open } = await setup(t);
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fulcra-inbox-cli-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let asked = 0;
  const cli = inboxClient({
    home,
    request: (env) => f.request(env),
    env: {},
    confirmOption: async () => {
      asked++;
      return asked > 1;
    },
  });
  const w = await open("cli");
  assert.match(await cli.pair(w.code), /Answers from here are marked as answered by the operator/);
  const grant = fs.readdirSync(path.join(home, "grants", "channel"));
  assert.equal(grant.length, 1);
  assert.equal(fs.statSync(path.join(home, "grants", "channel", grant[0])).mode & 0o777, 0o600);
  const d = (await f.ask(level1())).decision;
  assert.match(
    await cli.list(),
    /^1\. \[Now\] Where should practice copies of the website live\?$/m,
  );
  assert.match(await cli.show(1), /Recommended: Option A/);
  assert.equal(
    await cli.answer(1, "2"),
    "Not answered.",
    "an interactive terminal must retype the option number",
  );
  assert.match(
    await cli.answer(1, "2"),
    /^Answered by the operator at \d\d:\d\d, not confirmed on your device: Option B$/,
  );
  assert.deepEqual(
    [f.control.decisions.packet(d.id).choice.by, f.control.decisions.packet(d.id).choice.via],
    ["operator", "cli"],
  );
  f.control.decisions.binders.set("promotion", async () => ({ plan: 1 }));
  const digest = createHash("sha256")
    .update(canonicalJson({ plan: 1 }))
    .digest("hex");
  await f.ask({
    kind: "approval",
    level: 2,
    projectId: P(1),
    taskId: null,
    askedOf: "human",
    title: "Put the new version live?",
    situation: "It passed its checks.",
    options: [option("approve"), option("reject")],
    recommendation: null,
    evidence: [],
    action: { type: "promotion", promotionId: randomUUID(), digest },
  });
  const n = (
    await f.control.inboxChannels.listFor(
      {
        channelId: JSON.parse(
          fs.readFileSync(path.join(home, "grants", "channel", grant[0]), "utf8"),
        ).channelId,
      },
      JSON.parse(fs.readFileSync(path.join(home, "grants", "channel", grant[0]), "utf8"))
        .capability,
    )
  ).items.find((i) => i.key.startsWith("approval-")).n;
  await assert.rejects(
    cli.answer(n, "approve"),
    /confirm it on your paired device in the Fulcra app/,
  );
});

// v1.13 R3-2: a stand-in for the pinned guard's human-log and the session's timeline, driven by the test.
async function humanInputs(t, f) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fulcra-human-log-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.chmodSync(dir, 0o700);
  const orig = f.control.native.inspect,
    BOOT = (await orig(f.project)).boot,
    log = path.join(dir, `${BOOT}.log`),
    sessions = new Map();
  fs.writeFileSync(
    log,
    JSON.stringify({
      v: 1,
      boot: BOOT,
      pid: 1,
      prev: null,
      prevBytes: null,
      prevSha256: null,
      receipts: null,
    }) + "\n",
    { mode: 0o600 },
  );
  f.control.humanLogDir = dir;
  const of = (id, humanAt = 0) => {
    if (!sessions.has(id)) sessions.set(id, { humanAt, seq: 40, messages: [] });
    return sessions.get(id);
  };
  // Layered over the fixture's own observation, so the controller sees the same sessions (and takes over one a person
  // types into, as it should).
  f.control.native = {
    ...f.control.native,
    inspect: async (id) => {
      const base = await orig(id),
        st = of(id, base.humanAt);
      return { ...base, humanAt: st.humanAt, timelineCursor: { epoch: 7, seq: st.seq } };
    },
    humanMessagesSince: async (id, since) => {
      assert.equal(since.epoch, 7);
      return of(id).messages.filter((m) => m.seq > since.seq);
    },
  };
  // A person types into a session: its guard counter moves, the guard logs {a, n}, and the message lands on its timeline.
  const type = (sessionId, text, { logged = true } = {}) => {
    const st = of(sessionId);
    st.humanAt += 1;
    st.seq += 2;
    if (logged) fs.appendFileSync(log, JSON.stringify({ a: sessionId, n: st.humanAt }) + "\n");
    st.messages.push({ seq: st.seq, text });
    return { boot: BOOT, n: st.humanAt };
  };
  const state = { of };
  return { BOOT, state, type, log };
}

// W1 (V4 owned daemon): the same R3-2 proof from the daemon's own human-input counter and sealed boot chain, which V4
// has, instead of the legacy guard's log, which V4 never writes. Text on the timeline that the daemon did not count
// as human input (another agent's message, the controller's) proves nothing.
async function v4HumanInputs(t, f) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fulcra-boots-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const orig = f.control.native.inspect,
    sessions = new Map();
  let boot = (await orig(f.project)).boot;
  f.control.bootChainDir = bootChainDir(home);
  recordBootStart(home, boot, null);
  const of = (id, humanAt = 0) => {
    if (!sessions.has(id)) sessions.set(id, { humanAt, seq: 40, messages: [] });
    return sessions.get(id);
  };
  f.control.native = {
    ...f.control.native,
    inspect: async (id) => {
      const base = await orig(id),
        st = of(id, base.humanAt);
      return { ...base, boot, humanAt: st.humanAt, timelineCursor: { epoch: 7, seq: st.seq } };
    },
    humanMessagesSince: async (id, since) => {
      assert.equal(since.epoch, 7);
      return of(id).messages.filter((m) => m.seq > since.seq);
    },
  };
  // A user message lands on the timeline; only a person's moves the daemon's counter.
  const type = (id, text, { human = true } = {}) => {
    const st = of(id);
    if (human) st.humanAt += 1;
    st.seq += 2;
    st.messages.push({ seq: st.seq, text });
    return { boot, n: st.humanAt };
  };
  // A clean daemon restart: the boot is sealed with its final counters and the next boot anchors it.
  const counters = () => Object.fromEntries([...sessions].map(([id, st]) => [id, st.humanAt]));
  const next = () => {
    const b = randomUUID();
    recordBootStart(home, b, boot);
    const was = boot;
    boot = b;
    for (const st of sessions.values()) st.humanAt = 0;
    return was;
  };
  const restart = () => {
    sealBoot(home, boot, counters());
    next();
  };
  // A crash (no seal), after which someone writes a well-formed seal for the crashed boot: its successor never anchored it.
  const crashThenForgeSeal = () => {
    const c = counters(),
      was = next();
    sealBoot(home, was, c);
  };
  return { home, type, restart, crashThenForgeSeal, boot: () => boot };
}

test("W1 R3-2 (V4): a genuine typed answer is proven by the daemon's own counter; agent text and forged entries are refused", async (t) => {
  const { f, channel, pair, answer } = await setup(t);
  const h = await v4HumanInputs(t, f),
    session = await pair("session"),
    NOT = new RegExp(NOT_FROM_YOU);
  const d = (await f.ask(level1())).decision,
    key = `decision-${d.id}`;
  await channel("cc-inbox-show", session.capability, { channelId: session.id, key });
  // Another agent's (or the controller's) message naming the option: on the timeline, never counted as human input.
  const A = h.boot();
  h.type(f.project, "Go with option 2", { human: false });
  await assert.rejects(
    answer(session, key, "b", { humanInput: "latest" }),
    NOT,
    "no human input since it was shown",
  );
  await assert.rejects(
    answer(session, key, "b", { humanInput: { boot: A, n: 1 } }),
    NOT,
    "forged: the daemon never counted entry 1",
  );
  await assert.rejects(
    answer(session, key, "b", { humanInput: { boot: randomUUID(), n: 1 } }),
    NOT,
    "forged: an unknown boot",
  );
  assert.equal(f.control.decisions.packet(d.id).state, "open");
  // A person types the answer into the session (a fresh question, shown after the agent's text).
  const e = (await f.ask(level1({ title: "Open on bank holidays?" }))).decision,
    key2 = `decision-${e.id}`;
  await channel("cc-inbox-show", session.capability, { channelId: session.id, key: key2 });
  const typed = h.type(f.project, "Go with option 2 please");
  const r = await answer(session, key2, "b", { humanInput: "latest" });
  assert.deepEqual(
    [r.decision.choice.by, r.decision.choice.proven, r.decision.choice.via],
    ["operator", false, "session"],
  );
  assert.equal(typed.n, 1);
});
for (const [name, restart, accepted] of [
  ["a clean, sealed restart", "restart", true],
  ["a crash followed by a seal forged for the crashed boot", "crashThenForgeSeal", false],
])
  test(`W1 R3-2 (V4): an answer typed before ${name} is ${accepted ? "proven by the anchored seal" : "refused"}`, async (t) => {
    const { f, channel, pair, answer } = await setup(t);
    const h = await v4HumanInputs(t, f),
      session = await pair("session");
    const d = (await f.ask(level1())).decision,
      key = `decision-${d.id}`;
    await channel("cc-inbox-show", session.capability, { channelId: session.id, key });
    const entry = h.type(f.project, "Go with option 2 please");
    h[restart]();
    if (accepted)
      assert.equal(
        (await answer(session, key, "b", { humanInput: entry })).decision.choice.via,
        "session",
      );
    else {
      await assert.rejects(
        answer(session, key, "b", { humanInput: entry }),
        new RegExp(NOT_FROM_YOU),
      );
      assert.equal(f.control.decisions.packet(d.id).state, "open");
    }
  });

test("R3-2: a session cannot answer its own question; only a message typed into it after the question was shown counts", async (t) => {
  const { f, channel, pair, answer } = await setup(t);
  const h = await humanInputs(t, f),
    session = await pair("session"); // the project session pairs with itself
  const d = (await f.ask(level1())).decision,
    key = `decision-${d.id}`;
  // Not shown yet: nothing to be newer than.
  await assert.rejects(
    answer(session, key, "b", { humanInput: "latest" }),
    new RegExp(NOT_FROM_YOU),
  );
  await channel("cc-inbox-show", session.capability, { channelId: session.id, key });
  // The session answers its own packet: no proof, the latest (older) input, an invented entry, a text that isn't human.
  await assert.rejects(answer(session, key, "b"), new RegExp(NOT_FROM_YOU), "no human input named");
  await assert.rejects(
    answer(session, key, "b", { humanInput: "latest" }),
    new RegExp(NOT_FROM_YOU),
    "no input since it was shown",
  );
  await assert.rejects(
    answer(session, key, "b", { humanInput: { boot: h.BOOT, n: 9 } }),
    new RegExp(NOT_FROM_YOU),
    "an entry the human-log does not have",
  );
  h.type(f.project, "2", { logged: false });
  await assert.rejects(
    answer(session, key, "b", { humanInput: "latest" }),
    new RegExp(NOT_FROM_YOU),
    "counted but never logged by the guard",
  );
  const other = h.type(f.other, "2");
  await assert.rejects(
    answer(session, key, "b", { humanInput: other }),
    new RegExp(NOT_FROM_YOU),
    "another session's input",
  );
  h.type(f.project, "what does option two cost?");
  await assert.rejects(
    answer(session, key, "b", { humanInput: "latest" }),
    new RegExp(NOT_FROM_YOU),
    "the message must name the option",
  );
  await assert.rejects(
    answer(session, key, "b", { humanInput: { boot: randomUUID(), n: 99 } }),
    new RegExp(NOT_FROM_YOU),
    "another boot",
  );
  assert.equal(f.control.decisions.packet(d.id).state, "open");
  // A person types "go with option 2" into the session: now the answer is accepted, still as the operator.
  h.type(f.project, "Go with option 2 please");
  const r = await answer(session, key, "b", { humanInput: "latest" });
  assert.deepEqual(
    [r.decision.choice.by, r.decision.choice.proven, r.decision.choice.via],
    ["operator", false, "session"],
  );
  // Only session channels name a human input.
  const cli = await pair("cli"),
    e = (await f.ask(level1({ title: "Open on bank holidays?" }), {}, "prime")).decision;
  await assert.rejects(
    answer(cli, `decision-${e.id}`, "a", { humanInput: "latest" }),
    /Only a session channel names a human input/,
  );
  // The command line refuses an answer that isn't typed at an interactive terminal.
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fulcra-inbox-tty-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const g = path.join(home, "grants", "channel");
  fs.mkdirSync(g, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(g, `${cli.id}.json`),
    JSON.stringify({ version: 1, channelId: cli.id, capability: cli.capability }),
    { mode: 0o600 },
  );
  const n = (await channel("cc-inbox-list", cli.capability, { channelId: cli.id })).items.find(
    (i) => i.key === `decision-${e.id}`,
  ).n;
  await assert.rejects(
    inboxMain(["answer", String(n), "1"], {
      home,
      request: (env) => f.request(env),
      out: () => {},
      stdin: { isTTY: false },
    }),
    /interactive terminal/,
  );
  assert.equal(f.control.decisions.packet(e.id).state, "open");
});

test("R3-3 and R3-4: each owner turn answers once; a chat update is settled only when a later turn lists again", async (t) => {
  const { f, channel, pair, answer } = await setup(t);
  const ch = await pair("discord-openclaw");
  const d1 = (await f.ask(level1({ title: "Paint the office blue?" }))).decision,
    d2 = (await f.ask(level1({ title: "Paint the office green?" }))).decision;
  const t1 = turn();
  await answer(ch, `decision-${d1.id}`, "a", { origin: t1 });
  await assert.rejects(
    answer(ch, `decision-${d2.id}`, "a", { origin: t1 }),
    new RegExp(NOT_FROM_YOU),
    "a replayed turn",
  );
  assert.equal(f.control.decisions.packet(d2.id).state, "open");
  // A turn that paired can't answer either.
  const pairTurn = turn(),
    w = await f.op("cc-channel-pair-open", {
      kind: "discord-openclaw",
      label: "Second chat",
      scope: ALL,
    });
  const second = await channel("cc-channel-pair", undefined, { code: w.code, origin: pairTurn });
  await assert.rejects(
    answer({ id: second.channel.id, capability: second.capability }, `decision-${d2.id}`, "a", {
      origin: pairTurn,
    }),
    new RegExp(NOT_FROM_YOU),
  );
  // R3-4: d2 answered in the app; the chat's list shows the update in this turn (again, if asked again in it) ...
  await channel("cc-inbox-show", ch.capability, { channelId: ch.id, key: `decision-${d2.id}` });
  await f.choose(d2, "b");
  const t2 = turn();
  const shown = (await channel("cc-inbox-list", ch.capability, { channelId: ch.id, origin: t2 }))
    .updates;
  assert.equal(shown.length, 1);
  assert.equal(
    (await channel("cc-inbox-list", ch.capability, { channelId: ch.id, origin: t2 })).updates
      .length,
    1,
    "same turn: still owed",
  );
  assert.equal(
    f.store.db.prepare("SELECT updatedAt FROM cc_channel_posts WHERE id=?").get(shown[0].postId)
      .updatedAt,
    null,
    "not settled before the reply was seen",
  );
  // ... and the owner's next message settles it.
  assert.equal(
    (await channel("cc-inbox-list", ch.capability, { channelId: ch.id, origin: turn() })).updates
      .length,
    0,
  );
  assert.notEqual(
    f.store.db.prepare("SELECT updatedAt FROM cc_channel_posts WHERE id=?").get(shown[0].postId)
      .updatedAt,
    null,
  );
});

test("R3-6 and R3-7: revoking a device pauses the chat channels it authorised; channel pairings are announced in Security and the digest", async (t) => {
  const { f, c, channel: _channel, pair, answer } = await setup(t);
  const owned = await pair("discord-openclaw", { proven: true }),
    plain = await pair("cli");
  assert.equal(owned.answersCountAsOwner, true);
  const inbox = await f.control.decisions.inbox();
  const titles = inbox.items
    .filter((i) => i.key.startsWith("attention-channel-"))
    .map((i) => [i.title.replace(/\d\d:\d\d/, "HH:MM"), i.urgency]);
  assert.deepEqual(titles.sort(), [
    ["A chat channel that answers as you was paired at HH:MM: Test discord-openclaw", "now"],
    ["A command-line channel was paired at HH:MM: Test cli", "now"],
  ]);
  // Revoke the device that opened the owner-capable channel.
  const payload = {
    purpose: PURPOSE.revoke,
    deviceId: f.dev.id,
    messageId: randomUUID(),
    at: new Date(c.now).toISOString(),
  };
  const r = await f.op("devices-revoke", {
    proof: { deviceId: f.dev.id, alg: "ES256", payload, signature: signed(f.dev.key, payload) },
  });
  assert.deepEqual(
    r.channelsPaused.map((x) => x.id),
    [owned.id],
  );
  const after = (await f.op("cc-channels-list", null)).channels.find((x) => x.id === owned.id);
  assert.deepEqual(
    [after.state, after.pairedBy, after.answersCountAsOwner],
    ["paused", "operator", false],
  );
  assert.equal(
    (await f.op("cc-channels-list", null)).channels.find((x) => x.id === plain.id).state,
    "active",
    "other channels untouched",
  );
  const notice = (await f.control.decisions.inbox()).items.find((i) =>
    i.title.includes("was paused"),
  );
  assert.match(
    notice.title,
    /^The chat channel Test discord-openclaw was paused at \d\d:\d\d: the device that authorised it was revoked$/,
  );
  // Resumed, it answers only as the operator.
  await f.op("cc-channel-resume", { id: owned.id, expectedRevision: after.revision });
  const d = (await f.ask(level1())).decision;
  assert.equal(
    (await answer({ ...owned }, `decision-${d.id}`, "a", { origin: turn() })).decision.choice.by,
    "operator",
  );
  // The digest lists them too.
  const digest = f.control.decisions.composeDigest({
    projectId: null,
    projectName: "All work",
    periodStart: new Date(c.now - 86400000).toISOString(),
    periodEnd: new Date(c.now + 60000).toISOString(),
    composedAt: new Date(c.now).toISOString(),
    directoryAvailable: true,
  });
  assert.deepEqual(digest.channels.map((x) => [x.kind, x.action, x.ownerCapable]).sort(), [
    ["cli", "paired", false],
    ["discord-openclaw", "device-revoked", false],
    ["discord-openclaw", "paired", true],
  ]);
  assert.match(
    digest.summary,
    /a chat channel that answers as you was paired: Test discord-openclaw/,
  );
  assert(digest.summary.length <= 400);
});
