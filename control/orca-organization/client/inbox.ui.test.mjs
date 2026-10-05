// Fulcra J3 Inbox behaviour with synthetic component adapters (not a Paseo/phone UI test). The stable test
// ids (inbox-list, inbox-item-<key>, decision-option-<id>, decision-choose) are the ones the brief fixes.
import { InboxSurface, viaFor, waitingTime } from "./inbox";
import { DevicesSurface } from "./devices";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { JSDOM } from "jsdom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { calls, setHandler } from "./ui-test-adapters.mjs";
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://component.test",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { render, screen, fireEvent, waitFor, cleanup, act, within } =
  await import("@testing-library/react");
const h = React.createElement;
const theme = {
  colors: {
    foreground: "#fff",
    foregroundMuted: "#ccc",
    border: "#888",
    accent: "#06f",
    accentForeground: "#fff",
    surface0: "#111",
    surface1: "#191f2a",
    surface2: "#263246",
    statusSuccess: "#0a0",
    statusWarning: "#fa0",
    statusDanger: "#f33",
  },
};
const layout = { compact: true, platform: "web" };
const DEC = "11111111-1111-4111-8111-000000000001",
  CH = "22222222-2222-4222-8222-000000000009",
  MSG = "33333333-3333-4333-8333-000000000009",
  DIG = "44444444-4444-4444-8444-000000000001";
const SESSION = "55555555-5555-4555-8555-000000000001";
const now = new Date().toISOString(),
  earlier = new Date(Date.now() - 2 * 3600000).toISOString();
const clients = [];
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  return render(h(QueryClientProvider, { client }, h(InboxSurface, { theme, layout })));
}
afterEach(() => {
  cleanup();
  for (const c of clients.splice(0)) c.clear();
});
const impacts = {
  benefit: "Safer",
  cost: "Small",
  time: "A day",
  risk: "Low",
  reversibility: "reversible",
  blastRadius: null,
};
const packet = (extra = {}) => ({
  version: 1,
  id: DEC,
  revision: 1,
  kind: "decision",
  level: 1,
  projectId: null,
  taskId: null,
  askedBy: { seat: "orca", sessionId: SESSION },
  askedOf: "human",
  title: "Where should practice copies of the website live?",
  situation: "Changes reach customers straight away today.",
  options: [
    {
      id: "a",
      title: "Keep a practice copy",
      summary: "Try every change on a copy first.",
      example: "Like a dress rehearsal before opening night.",
      impacts,
      destructive: false,
    },
    {
      id: "b",
      title: "Delete the old site",
      summary: "Start clean.",
      example: "Like clearing out the garage in one go.",
      impacts: { ...impacts, reversibility: "irreversible" },
      destructive: true,
    },
  ],
  recommendation: {
    optionId: "a",
    why: "It is the cheapest safe choice.",
    confidence: "high",
    wouldChangeIf: "Costs double.",
  },
  evidence: [{ ref: "task:66666666-6666-4666-8666-000000000001", label: "The planning task" }],
  action: { type: "none" },
  expiresAt: null,
  state: "open",
  supersededBy: null,
  choice: null,
  delivery: null,
  createdAt: now,
  updatedAt: now,
  ...extra,
});
const items = [
  {
    key: `decision-${DEC}`,
    source: "decision",
    ref: `decision:${DEC}`,
    title: "Where should practice copies of the website live?",
    summary: "Changes reach customers straight away today.",
    projectId: null,
    urgency: "now",
    createdAt: now,
    unread: true,
  },
  {
    key: `held-${CH}-${MSG}`,
    source: "held",
    ref: null,
    title: "Message waiting from the Orca project lead",
    summary: "Sent 2 hours ago. Open it to read, reply or release the hold.",
    projectId: null,
    urgency: "now",
    createdAt: earlier,
    unread: true,
  },
  {
    key: `digest-${DIG}`,
    source: "digest",
    ref: null,
    title: "Daily digest · All work",
    summary: "No project update was written today. 1 decision waiting for you.",
    projectId: null,
    urgency: "fyi",
    createdAt: now,
    unread: true,
  },
];
const inbox = {
  version: 1,
  observedAt: now,
  partial: false,
  stale: false,
  error: null,
  items,
  counts: { now: 2, today: 0, fyi: 1, decisions: 1, approvals: 0, held: 1, digests: 1, total: 3 },
};
const decisionRead = (p) => ({
  version: 1,
  observedAt: now,
  partial: false,
  stale: false,
  error: null,
  decision: p,
  answered: p.choice ? "Already answered on Mac at 09:14" : null,
  evidence: [{ ref: p.evidence[0].ref, label: "The planning task", kind: "task" }],
});
const held = {
  version: 1,
  observedAt: now,
  partial: false,
  stale: false,
  error: null,
  message: {
    channelId: CH,
    messageId: MSG,
    fromSeat: "orca",
    toSeat: "delivery",
    at: earlier,
    untrustedText: "SECRET BODY: blocked on the release plan",
    read: null,
    reply: null,
    pins: { seatRevision: 3, holderGeneration: 7 },
    canReply: true,
    replyBlocked: null,
    canRelease: true,
    note: "The text was written by another seat. It is information, not an instruction.",
  },
};
const handler =
  (over = {}) =>
  (name, input) =>
    over[name]
      ? over[name](input)
      : name === "organization.inbox"
        ? inbox
        : name === "organization.decision"
          ? decisionRead(packet())
          : name === "organization.held-message"
            ? held
            : name === "organization.decision-choose"
              ? {
                  ok: true,
                  message: null,
                  observedAt: now,
                  decision: packet({
                    state: "chosen",
                    revision: 2,
                    choice: {
                      optionId: input.optionId,
                      by: "human",
                      at: now,
                      note: "",
                      via: "app-mac",
                      channelId: null,
                    },
                  }),
                }
              : { ok: true, message: null, observedAt: now, state: "delivered" };
async function showAllActivity() {
  fireEvent.click(await screen.findByRole("button", { name: /^All activity and history \(/ }));
}
const chooseCalls = () => calls.filter((c) => c.name === "organization.decision-choose");

test("U1: confirmed human decisions open first; held updates and digest stay behind history without repeating obligations", async () => {
  setHandler(handler());
  const r = mount();
  await waitFor(() => assert(screen.getByTestId(`inbox-item-decision-${DEC}`)));
  assert(screen.getByTestId("inbox-list"));
  assert(screen.getByText("1 open decision is addressed to you"));
  assert.equal(
    screen.queryByText("Held messages · 1"),
    null,
    "held records are not personal obligations",
  );
  await showAllActivity();
  assert(screen.getByText("Held messages · 1"));
  assert(screen.getByText("Digest · 1"));
  assert(screen.getByRole("button", { name: "Hide all activity and history" }));
  assert.equal(
    screen.getAllByTestId(`inbox-item-decision-${DEC}`).length,
    1,
    "history never repeats the same confirmed obligation",
  );
  assert.equal(screen.getAllByText("Now").length, 1);
  assert.equal(screen.getAllByText("FYI").length, 1);
  assert(!r.container.textContent.includes("SECRET BODY"), "the list never carries a held body");
});

test("U-L37 / U5-D01: a partial inbox says part of it could not be read, counts are lower bounds, retry offered; a complete one does not", async () => {
  setHandler(handler({ "organization.inbox": () => ({ ...inbox, partial: true }) }));
  mount();
  await waitFor(() => assert(screen.getByTestId(`inbox-item-decision-${DEC}`)));
  assert.match(
    screen.getByTestId("inbox-headline").textContent,
    /^At least \d+ in all.*Part of the inbox could not be read\./,
  );
  assert(screen.getByTestId("inbox-retry"));
  cleanup();
  setHandler(handler());
  mount();
  await waitFor(() => assert(screen.getByTestId(`inbox-item-decision-${DEC}`)));
  assert.doesNotMatch(
    screen.getByTestId("inbox-headline").textContent,
    /At least|could not be read/,
  );
  assert.equal(screen.queryByTestId("inbox-retry"), null);
});

test("U5-D01: the live failure shape (stale, nothing read) never shows the all-clear; it names the problem and offers a retry", async () => {
  setHandler(
    handler({
      "organization.inbox": () => ({
        ...inbox,
        stale: true,
        partial: true,
        error: "Management unavailable",
        items: [],
        counts: Object.fromEntries(Object.keys(inbox.counts).map((k) => [k, 0])),
      }),
    }),
  );
  mount();
  await waitFor(() =>
    assert.match(screen.getByTestId("inbox-headline").textContent, /could not be read/),
  );
  assert.equal(screen.queryByText("Nothing is waiting for you."), null);
  assert(screen.getByText(/could not reach the service that keeps the inbox/));
  assert(screen.getByTestId("inbox-retry"));
});

test("U2: the card puts the recommendation on top, shows each example, and one tap chooses it", async () => {
  setHandler(handler());
  mount();
  fireEvent.click(await screen.findByTestId(`inbox-item-decision-${DEC}`));
  await waitFor(() => assert(screen.getByTestId("decision-option-a")));
  assert(screen.getByText("RECOMMENDED · high confidence"));
  assert(screen.getByText("Like a dress rehearsal before opening night."));
  assert(screen.getByText("Like clearing out the garage in one go."));
  assert.equal(screen.getByTestId("decision-option-a").getAttribute("aria-checked"), "true");
  fireEvent.click(screen.getByTestId("decision-choose"));
  await waitFor(() => assert.equal(chooseCalls().length, 1));
  const { messageId, ...sent } = chooseCalls()[0].input;
  assert.match(messageId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(sent, {
    id: DEC,
    expectedRevision: 1,
    optionId: "a",
    note: "",
    confirmDestructive: false,
    via: "app-web",
  });
});

test("U3: a destructive option takes a second tap, and only the second sends", async () => {
  setHandler(handler());
  mount();
  fireEvent.click(await screen.findByTestId(`inbox-item-decision-${DEC}`));
  fireEvent.click(await screen.findByTestId("decision-option-b"));
  fireEvent.click(screen.getByTestId("decision-choose"));
  assert(screen.getByText("“Delete the old site” is hard to undo. Tap again to confirm."));
  assert.equal(chooseCalls().length, 0);
  fireEvent.click(screen.getByTestId("decision-choose"));
  await waitFor(() => assert.equal(chooseCalls().length, 1));
  assert.equal(chooseCalls()[0].input.optionId, "b");
  assert.equal(chooseCalls()[0].input.confirmDestructive, true);
});

test('U4: "Changed since you looked" and "Already answered" are shown as states, not errors to retry', async () => {
  setHandler(
    handler({
      "organization.decision-choose": () => ({
        ok: false,
        message: "Changed since you looked; refresh",
        observedAt: now,
        decision: null,
      }),
    }),
  );
  mount();
  fireEvent.click(await screen.findByTestId(`inbox-item-decision-${DEC}`));
  fireEvent.click(await screen.findByTestId("decision-choose"));
  await waitFor(() => assert(screen.getByText("Refresh")));
  assert(screen.getByText(/Changed since you looked/));
  cleanup();
  setHandler(
    handler({
      "organization.decision": () =>
        decisionRead(
          packet({
            state: "chosen",
            revision: 2,
            choice: {
              optionId: "a",
              by: "operator",
              at: now,
              note: "",
              via: "app-mac",
              channelId: null,
              deviceId: null,
              proven: false,
            },
          }),
        ),
    }),
  );
  mount();
  fireEvent.click(await screen.findByTestId(`inbox-item-decision-${DEC}`));
  await waitFor(() =>
    assert(
      screen.getByText(
        /^Answered by the operator at \d\d:\d\d, not confirmed on your device: Keep a practice copy$/,
      ),
    ),
  );
  assert.equal(screen.queryByTestId("decision-choose"), null);
});

test("U5: a held message shows its body only when opened; reply carries the observed pins, release takes two taps", async () => {
  setHandler(handler());
  mount();
  await showAllActivity();
  fireEvent.click(
    await screen.findByRole("button", { name: "Show 1 held messages from a project lead" }),
  );
  fireEvent.click(await screen.findByTestId(`inbox-item-held-${CH}-${MSG}`));
  await waitFor(() => assert(screen.getByText("SECRET BODY: blocked on the release plan")));
  fireEvent.change(screen.getByLabelText("Reply"), {
    target: { value: "Ship it behind the flag" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
  await waitFor(() => assert(calls.some((c) => c.name === "organization.held-reply")));
  const { messageId, ...reply } = calls.find((c) => c.name === "organization.held-reply").input;
  assert.deepEqual(reply, {
    channelId: CH,
    inReplyTo: MSG,
    text: "Ship it behind the flag",
    expectedSeatRevision: 3,
    expectedHolderGeneration: 7,
  });
  fireEvent.click(screen.getByRole("button", { name: "Release hold" }));
  assert.equal(
    calls.some((c) => c.name === "organization.held-release"),
    false,
  );
  fireEvent.click(screen.getByRole("button", { name: "Yes, release the hold" }));
  await waitFor(() => assert(calls.some((c) => c.name === "organization.held-release")));
  assert.deepEqual(calls.find((c) => c.name === "organization.held-release").input, {
    channelId: CH,
    messageId: MSG,
    expectedSeatRevision: 3,
  });
});

test("U6: the answering platform comes from layout.platform, with the desktop app told apart by its user agent", () => {
  const mac =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Fulcra/1.0 Chrome/130.0 Electron/33.0.0 Safari/537.36";
  assert.equal(viaFor("ios", ""), "app-ios");
  assert.equal(viaFor("android", ""), "app-android");
  assert.equal(viaFor("web", "Mozilla/5.0 (Macintosh) Chrome/130.0 Safari/537.36"), "app-web");
  assert.equal(viaFor("web", mac), "app-mac");
  assert.equal(
    viaFor("web", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Electron/33.0.0"),
    "app-windows",
  );
  assert.equal(viaFor("web", "Mozilla/5.0 (X11; Linux x86_64) Electron/33.0.0"), "app-linux");
  assert.equal(viaFor(undefined, ""), "app-mac");
});

test("U7 (v1.6): the owner's proven answer reads as theirs, a bound approval waits for a paired device, and Devices says how each key is protected", async () => {
  const proven = {
    optionId: "a",
    by: "human",
    at: now,
    note: "",
    via: "app-ios",
    channelId: null,
    deviceId: SESSION,
    proven: true,
  };
  setHandler(
    handler({
      "organization.decision": () =>
        decisionRead(packet({ state: "chosen", revision: 2, choice: proven })),
    }),
  );
  mount();
  fireEvent.click(await screen.findByTestId(`inbox-item-decision-${DEC}`));
  await waitFor(() =>
    assert(screen.getByText(/^You decided on iPhone at \d\d:\d\d: Keep a practice copy$/)),
  );
  cleanup();
  const bound = packet({
    kind: "approval",
    level: 2,
    recommendation: null,
    options: [
      { ...packet().options[0], id: "approve", title: "Approve" },
      { ...packet().options[0], id: "reject", title: "Reject" },
    ],
    action: {
      type: "promotion",
      promotionId: "77777777-7777-4777-8777-000000000001",
      digest: "a".repeat(64),
    },
  });
  setHandler(handler({ "organization.decision": () => decisionRead(bound) }));
  mount();
  fireEvent.click(await screen.findByTestId(`inbox-item-decision-${DEC}`));
  await waitFor(() => assert(screen.getByText(/^Confirm this on your paired device\./)));
  assert.equal(
    screen.queryByTestId("decision-choose"),
    null,
    "no operator answer is offered for an approval that starts work",
  );
  cleanup();
  const dev = (id, extra) => ({
    version: 1,
    id,
    label: "Test Mac",
    platform: "macos",
    publicKey: "AAAA",
    alg: "ES256",
    keyStorage: "os-protected",
    userPresence: true,
    pairedAt: now,
    pairedVia: { kind: "first-device", windowId: DIG },
    state: "active",
    revokedAt: null,
    lastUsedAt: null,
    revision: 1,
    ...extra,
  });
  setHandler((name) =>
    name === "organization.devices"
      ? {
          version: 1,
          observedAt: now,
          stale: false,
          error: null,
          pairingWindow: null,
          devices: [
            dev(DEC),
            dev(DIG, {
              label: "Test Laptop",
              platform: "linux",
              keyStorage: "software",
              userPresence: false,
              state: "revoked",
              revokedAt: now,
            }),
          ],
        }
      : null,
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  render(h(QueryClientProvider, { client }, h(DevicesSurface, { theme, layout })));
  await waitFor(() => assert(screen.getByText("1 device paired")));
  assert(screen.getByText("Protected by Touch ID"));
  assert(screen.getByText("Not protected by hardware"));
  assert(screen.getByTestId(`device-revoke-${DEC}`));
  assert.equal(
    screen.queryByTestId(`device-revoke-${DIG}`),
    null,
    "a revoked device offers no Revoke",
  );
  cleanup();
  setHandler((name) =>
    name === "organization.devices"
      ? { version: 1, observedAt: now, stale: false, error: null, pairingWindow: null, devices: [] }
      : null,
  );
  render(h(QueryClientProvider, { client }, h(DevicesSurface, { theme, layout })));
  await waitFor(() => assert(screen.getByText("Pair a device after the next Fulcra update")));
});

test("held messages start collapsed and group the same sender across channels", async () => {
  const heldItem = items.find((i) => i.source === "held");
  const grouped = [
    {
      ...heldItem,
      ref: "seat:fixture-lead",
      summary: "From the Fixture project lead. Sent recently.",
      title: "First subject",
    },
    {
      ...heldItem,
      key: `held-${MSG}-${CH}`,
      ref: "seat:fixture-lead",
      summary: "From the Fixture project lead. Sent recently.",
      title: "Second subject",
    },
  ];
  setHandler(handler({ "organization.inbox": () => ({ ...inbox, items: grouped }) }));
  mount();
  await showAllActivity();
  const button = await screen.findByRole("button", {
    name: "Show 2 held messages from the Fixture project lead",
  });
  assert.equal(button.getAttribute("aria-expanded"), "false");
  assert.equal(screen.queryByText("First subject"), null);
  fireEvent.click(button);
  assert(screen.getByText("First subject"));
  assert(screen.getByText("Second subject"));
  assert.equal(
    calls.some((c) => c.name === "organization.held-message"),
    false,
  );
});

test("held badges show waiting time oldest first without changing the received items", async () => {
  const at = Date.now();
  const rows = [5 * 60000, 2 * 86400000, 3 * 3600000].map((age, index) => ({
    ...items[1],
    key: `held-${CH}-${index}`,
    title: `Waiting fixture ${index}`,
    createdAt: new Date(at - age).toISOString(),
  }));
  const original = JSON.stringify(rows);
  setHandler(handler({ "organization.inbox": () => ({ ...inbox, items: rows }) }));
  mount();
  await showAllActivity();
  fireEvent.click(
    await screen.findByRole("button", { name: "Show 3 held messages from a project lead" }),
  );
  const badges = screen.getAllByText(/^Waiting (?:2 days|3 h|5 min)$/);
  assert.deepEqual(
    badges.map((b) => b.textContent),
    ["Waiting 2 days", "Waiting 3 h", "Waiting 5 min"],
  );
  assert.equal(screen.queryByText("Now"), null);
  assert.equal(screen.queryByText("Today"), null);
  assert.equal(JSON.stringify(rows), original);
});
test("read-only held cards never invite a reply", async () => {
  setHandler(
    handler({
      "organization.held-message": () => ({
        ...held,
        message: {
          ...held.message,
          canReply: false,
          pins: null,
          canRelease: false,
          replyBlocked: "This is read-only; reply in the app.",
        },
      }),
    }),
  );
  mount();
  await showAllActivity();
  fireEvent.click(
    await screen.findByRole("button", { name: "Show 1 held messages from a project lead" }),
  );
  assert.equal(screen.queryByText(/read, reply or release/), null);
  fireEvent.click(await screen.findByTestId(`inbox-item-held-${CH}-${MSG}`));
  await screen.findByText("Open in Fulcra");
  assert.equal(screen.queryByRole("textbox", { name: "Reply" }), null);
  assert.equal(screen.queryByRole("button", { name: "Send reply" }), null);
  assert.equal(screen.queryByText(/Reply unavailable|reply in the app/), null);
  assert.equal(calls.filter((c) => c.name === "organization.held-reply").length, 0);
});

test("waiting time boundaries are plain elapsed time, including malformed and future dates", () => {
  const now = Date.parse("2026-09-27T00:00:00Z");
  for (const [minutes, label] of [
    [0, "less than 1 min"],
    [5, "5 min"],
    [180, "3 h"],
    [1440, "1 day"],
    [2880, "2 days"],
    [-5, "less than 1 min"],
  ])
    assert.equal(
      waitingTime(new Date(now - minutes * 60000).toISOString(), now),
      `Waiting ${label}`,
    );
  assert.equal(waitingTime("invalid", now), "Waiting time unavailable");
});

test("history expansion exposes additional confirmed decisions once while held records stay separate", async () => {
  const questions = Array.from({ length: 4 }, (_, index) => ({
    ...items[0],
    key: `decision-${index}`,
    ref: `decision:11111111-1111-4111-8111-${String(index + 1).padStart(12, "0")}`,
    title: `Confirmed question ${index + 1}`,
  }));
  setHandler(
    handler({
      "organization.inbox": () => ({
        ...inbox,
        observedAt: new Date().toISOString(),
        items: [...questions, items[1]],
        counts: { ...inbox.counts, decisions: 4, held: 1, digests: 0, total: 5 },
      }),
    }),
  );
  mount();
  await screen.findByText("Confirmed question 1");
  assert.equal(screen.queryByText("Confirmed question 4"), null);
  await showAllActivity();
  await screen.findByText("Confirmed question 4");
  for (const question of questions) assert.equal(screen.getAllByText(question.title).length, 1);
  assert(screen.getByRole("button", { name: "Show 1 held messages from a project lead" }));
  assert.equal(
    calls.some((call) => call.name === "organization.held-message"),
    false,
    "history disclosure does not read/release retained bodies",
  );
});

for (const decisionCount of [0, 1]) {
  test(`a thrown refetch keeps the cached ${decisionCount}-decision observation visibly last-known and recovers through Retry`, async () => {
    const listed = decisionCount ? items : [];
    const cached = {
      ...inbox,
      observedAt: new Date().toISOString(),
      items: listed,
      counts: {
        ...inbox.counts,
        now: decisionCount ? 2 : 0,
        decisions: decisionCount,
        held: decisionCount,
        digests: decisionCount,
        fyi: decisionCount,
        total: listed.length,
      },
    };
    let failed = false;
    setHandler(
      handler({
        "organization.inbox": () => {
          if (failed) throw new Error("Current inbox read refused");
          return { ...cached, observedAt: new Date().toISOString() };
        },
      }),
    );
    mount();
    const currentHeadline = decisionCount
      ? "1 open decision is addressed to you"
      : "No confirmed unresolved decision is addressed to you in this observation.";
    await screen.findByText(currentHeadline);
    const client = clients.at(-1);
    const cachedRecords = client.getQueryData(["orca-organization", "inbox"]).items;
    failed = true;
    await act(async () => {
      await client.refetchQueries({ queryKey: ["orca-organization", "inbox"], exact: true });
    });
    await screen.findByText(/The latest inbox read failed/);
    assert.match(screen.getByTestId("inbox-headline").textContent, /coverage is unknown/);
    assert.equal(
      screen.queryByText(currentHeadline),
      null,
      "the current failure replaces the confirmed-only headline",
    );
    assert(screen.getByText(/Current inbox read refused/));
    assert(screen.getByText(/other personal actions cannot be ruled out/));
    assert(screen.getByTestId("inbox-retry"));
    const personal = within(screen.getByTestId("inbox-personal-decisions"));
    assert.equal(personal.queryAllByTestId(`inbox-item-decision-${DEC}`).length, decisionCount);
    if (decisionCount)
      assert(personal.getByText("Last-known open decisions; current status could not be checked."));
    assert.equal(
      personal.queryByText(items[1].title),
      null,
      "held updates do not become obligations after a read failure",
    );
    assert.equal(
      client.getQueryData(["orca-organization", "inbox"]).items,
      cachedRecords,
      "the failed query retains the exact cached records",
    );
    await showAllActivity();
    if (decisionCount) {
      assert(screen.getByText("Held messages · 1"));
      assert(screen.getByText("Digest · 1"));
    } else {
      assert.equal(screen.queryByText("Held messages · 1"), null);
      assert.equal(screen.queryByText("Digest · 1"), null);
    }
    assert.equal(
      screen.queryAllByTestId(`inbox-item-decision-${DEC}`).length,
      decisionCount,
      "last-known decisions have one home",
    );
    assert(
      calls.every((call) => call.name === "organization.inbox"),
      "read failure/disclosure never writes or reads held bodies",
    );
    failed = false;
    fireEvent.click(screen.getByTestId("inbox-retry"));
    await screen.findByText(currentHeadline);
    assert.equal(screen.queryByTestId("inbox-retry"), null);
    assert.equal(screen.queryByText(/other personal actions cannot be ruled out/), null);
    assert.equal(
      screen.queryByText("Last-known open decisions; current status could not be checked."),
      null,
    );
    assert.equal(screen.queryAllByTestId(`inbox-item-decision-${DEC}`).length, decisionCount);
    assert(calls.every((call) => call.name === "organization.inbox"));
  });
}
