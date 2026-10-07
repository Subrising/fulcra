// Fulcra › Today with synthetic component adapters: the front door's sections, one-tap choose from Today, what
// it says when the inbox cannot be read, and that no operator word reaches the page.
import { TodaySurface } from "./today";
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
const { render, screen, fireEvent, waitFor, cleanup, within } =
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
const P = "00000000-0000-46cd-9b65-000000002006",
  T = "00000000-0000-43b8-b458-000000002008",
  DEC = "11111111-1111-4111-8111-000000000001";
const sid = (n) => `4c111479-b424-43e5-bd1e-${String(n).padStart(12, "0")}`;
const iso = (ms) => new Date(Date.now() - ms).toISOString();
const node = (n, status, updatedAt, extra = {}) => ({
  id: sid(n),
  task: T,
  host: "local",
  agentId: sid(n),
  title: extra.title ?? `Session ${n}`,
  provider: "claude",
  model: null,
  mode: "delegated",
  status,
  pending: null,
  observedAt: null,
  updatedAt,
  error: null,
  ...extra,
});
const map = {
  observedAt: iso(0),
  available: true,
  unavailable: null,
  primes: [],
  unplaced: [],
  attention: [],
  note: "",
  sources: {
    seats: true,
    channels: true,
    projects: { available: true, partial: false, note: "" },
    fleet: { available: true, partial: false, observedAt: iso(0) },
  },
  projects: [
    {
      projectId: P,
      name: "Fulcra Command Centre",
      status: "in_progress",
      seat: {
        role: "project",
        seat: P,
        state: "assigned",
        sessionId: sid(99),
        revision: 3,
        hold: null,
      },
      channels: [],
      workstreams: 2,
      sessions: 3,
      running: 1,
    },
  ],
};
const fleet = {
  observedAt: iso(0),
  total: 3,
  partial: false,
  note: "",
  tasks: [],
  edges: [],
  nodes: [
    node(1, "running", iso(60000), {
      title: "CC R-V11B: adversarial security review of the channel",
    }),
    node(2, "idle", iso(3600000), { title: "Tracker refresh" }),
    node(3, "idle", iso(40 * 3600000), { title: "Command Centre project orchestrator" }),
  ],
};
const brief = {
  version: 1,
  observedAt: iso(0),
  partial: false,
  error: null,
  projectId: P,
  brief: null,
  authorName: null,
  stale: false,
  observed: {
    sessionsRunning: 1,
    sessionsTotal: 3,
    openDecisions: 1,
    heldMessages: 33,
    lastActivityAt: iso(0),
    observedAt: iso(0),
  },
};
const inbox = {
  version: 1,
  observedAt: iso(0),
  partial: false,
  stale: false,
  error: null,
  counts: { now: 1, today: 0, fyi: 0, decisions: 1, approvals: 0, held: 0, digests: 0, total: 1 },
  items: [
    {
      key: `decision-${DEC}`,
      source: "decision",
      ref: `decision:${DEC}`,
      title: "How should a tired orchestrator be refreshed?",
      summary: "Pick how a worn-out lead hands over.",
      projectId: P,
      urgency: "now",
      createdAt: iso(600000),
      unread: true,
    },
  ],
};
const impacts = {
  benefit: "Fresh context",
  cost: "One handover",
  time: "Minutes",
  risk: "Low",
  reversibility: "reversible",
  blastRadius: null,
};
const packet = {
  version: 1,
  id: DEC,
  revision: 1,
  kind: "decision",
  level: 1,
  projectId: P,
  taskId: null,
  askedBy: { seat: "delivery", sessionId: sid(99) },
  askedOf: "human",
  title: "How should a tired orchestrator be refreshed?",
  situation: "Long sessions get forgetful.",
  options: [
    {
      id: "a",
      title: "Hand over automatically",
      summary: "A fresh session takes over with a written handover.",
      example: "Like a shift change.",
      impacts,
      destructive: false,
    },
    {
      id: "b",
      title: "Ask me each time",
      summary: "You approve each handover.",
      example: null,
      impacts,
      destructive: false,
    },
  ],
  recommendation: {
    optionId: "a",
    why: "It keeps work moving.",
    confidence: "high",
    wouldChangeIf: "Handovers lose work.",
  },
  evidence: [],
  action: { type: "none" },
  expiresAt: null,
  state: "open",
  supersededBy: null,
  choice: null,
  delivery: null,
  createdAt: iso(600000),
  updatedAt: iso(600000),
};
const recovery = {
  status: "observed",
  observedAt: iso(0),
  recovery: {
    items: [],
    unsettled: [],
    usageLimits: {
      stops: [
        {
          sessionId: sid(3),
          line: "You've hit your weekly limit · resets 8am (Australia/Brisbane)",
          resetAt: new Date(Date.now() + 5 * 3600000).toISOString(),
          stoppedAt: iso(39 * 3600000),
          state: "notified",
        },
      ],
    },
  },
};
const reads = (over) => (name, input) =>
  over?.[name]
    ? over[name](input)
    : name === "organization.work-map"
      ? map
      : name === "organization.fleet"
        ? fleet
        : name === "organization.project-brief"
          ? brief
          : name === "organization.inbox"
            ? inbox
            : name === "organization.recovery"
              ? recovery
              : name === "organization.tracker-view"
                ? { version: 1, observedAt: iso(0), partial: false, trackers: [], items: [] }
                : name === "organization.integrations"
                  ? {
                      version: 1,
                      observedAt: iso(0),
                      partial: false,
                      hostApi: true,
                      connectors: [],
                      accounts: [],
                    }
                  : name === "organization.decision"
                    ? {
                        version: 1,
                        observedAt: iso(0),
                        partial: false,
                        stale: false,
                        error: null,
                        decision: packet,
                        answered: null,
                        evidence: [],
                      }
                    : name === "organization.decision-choose"
                      ? {
                          ok: true,
                          message: null,
                          observedAt: iso(0),
                          decision: {
                            ...packet,
                            state: "chosen",
                            revision: 2,
                            choice: {
                              optionId: input.optionId,
                              by: "human",
                              at: iso(0),
                              note: "",
                              via: input.via,
                              channelId: null,
                              deviceId: null,
                              proven: true,
                            },
                          },
                        }
                      : Promise.reject(Error(`unexpected ${name}`));
const clients = [],
  went = [];
const go = {
  inbox: () => went.push("inbox"),
  project: (id) => went.push(`project:${id}`),
  recovery: () => went.push("recovery"),
};
function mount(compact = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  return render(
    h(
      QueryClientProvider,
      { client },
      h(TodaySurface, {
        theme,
        layout: { compact, platform: "web" },
        host: { id: `today-${clients.length}` },
        go,
      }),
    ),
  );
}
afterEach(() => {
  cleanup();
  for (const c of clients.splice(0)) c.clear();
  went.length = 0;
});

test("Today shows done, needs you (with the stuck reason), running and a generated story, in plain words", async () => {
  setHandler(reads());
  const r = mount();
  fireEvent.click(await screen.findByRole("button", { name: "All activity and history" }));
  await screen.findByText("Command Centre project lead: hit its weekly usage limit, resets 8am", {
    exact: false,
  });
  assert(screen.getByTestId("today-done"));
  assert(screen.getByTestId("today-needs"));
  assert(screen.getByTestId("today-running"));
  assert(screen.getByTestId("today-projects"));
  await screen.findByText("Tracker refresh");
  assert(
    screen.getByText("Adversarial security review of the channel"),
    "running, with the tracking code gone",
  );
  assert.equal(
    screen.getAllByText("How should a tired lead be refreshed?").length,
    1,
    "one confirmed personal obligation even when activity history is open",
  );
  assert(
    within(screen.getByTestId("today-personal-actions")).getByText(
      "How should a tired lead be refreshed?",
    ),
  );
  assert.equal(
    within(screen.getByTestId("today-needs")).queryByText("How should a tired lead be refreshed?"),
    null,
    "retained activity is not a duplicate personal inbox",
  );
  await screen.findByText(/Summarised by Fulcra from live activity/);
  assert(
    calls.every(
      (c) =>
        ![
          "organization.decision-choose",
          "organization.held-release",
          "organization.held-reply",
          "organization.held-read",
        ].includes(c.name),
    ),
    "opening Today writes nothing",
  );
  assert(
    calls.some((c) => c.name === "organization.fleet" && c.input.projectId === P),
    "per-project fleet read",
  );
  const text = r.container.textContent;
  for (const word of [
    /\bseat\b/i,
    /\bgeneration\b/i,
    /\borchestrator\b/i,
    /\bprime\b/i,
    /\bcapabilit/i,
    /\back\b/i,
  ])
    assert.doesNotMatch(text, word);
});

test("a decision is chosen from Today with one tap on the recommendation", async () => {
  setHandler(reads());
  mount(false);
  fireEvent.click(await screen.findByTestId(`today-open-human-decision-${DEC}`));
  fireEvent.click(await screen.findByTestId("decision-choose"));
  await waitFor(() =>
    assert.equal(calls.filter((c) => c.name === "organization.decision-choose").length, 1),
  );
  const sent = calls.find((c) => c.name === "organization.decision-choose").input;
  assert.equal(sent.optionId, "a");
  assert.equal(sent.id, DEC);
  assert.equal(sent.expectedRevision, 1);
  assert.equal(sent.via, "app-web");
});

test("when the inbox cannot be read, Today says so and still counts held messages from the projects", async () => {
  setHandler(
    reads({
      "organization.inbox": () => ({
        ...inbox,
        stale: true,
        error: "Management unavailable",
        items: [],
      }),
    }),
  );
  mount();
  await screen.findByText(/Decisions and held messages could not be read just now/);
  fireEvent.click(screen.getByRole("button", { name: "All activity and history" }));
  await screen.findByText("33 messages waiting for you to read or pass on");
  fireEvent.click(screen.getAllByRole("button", { name: "Open in the Inbox" })[0]);
  assert.deepEqual(went, ["inbox"]);
  fireEvent.click(screen.getByRole("button", { name: "Open Fulcra Command Centre" }));
  assert.deepEqual(went, ["inbox", `project:${P}`]);
});

test("nothing readable still gives a page that says so, not a blank", async () => {
  setHandler(() => Promise.reject(Error("Management unavailable")));
  mount();
  await screen.findByText(/Your projects could not be read just now/);
  assert(screen.getByText("Home"));
});

for (const observation of ["missing", "stale"]) {
  test(`zero confirmed actions still shows unknown coverage with a ${observation} permission observation`, async () => {
    setHandler(
      reads({
        "organization.inbox": () => ({
          ...inbox,
          observedAt: iso(0),
          items: [],
          counts: { ...inbox.counts, now: 0, decisions: 0, total: 0 },
        }),
        "organization.fleet": () => ({
          ...fleet,
          observedAt: iso(0),
          total: 1,
          nodes: [
            node(8, "running", iso(0), {
              pending: 1,
              serverId: "Book",
              observedAt: observation === "missing" ? null : iso(60000),
            }),
          ],
        }),
      }),
    );
    mount();
    await screen.findByText("Fulcra Command Centre · Has a project lead");
    await waitFor(() =>
      assert.equal(
        clients.at(-1).getQueryState(["orca-fleet", `today-${clients.length}`, "project", P])
          .status,
        "success",
      ),
    );
    const personal = within(screen.getByTestId("today-personal-actions"));
    await waitFor(() =>
      assert(
        personal.getByText(
          "Some observations are unavailable or incomplete. Additional actions may be unknown.",
        ),
      ),
    );
    assert(
      personal.getByText("No confirmed unresolved human action in the available observations."),
    );
    assert(screen.getByText("0 confirmed actions"));
    assert.equal(
      personal.queryByRole("button"),
      null,
      "unknown permission records are not human action buttons",
    );
    assert(
      calls.every((call) => !call.name.includes("choose") && !call.name.includes("release")),
      "coverage rendering does not write",
    );
  });
}

test("Home exposes Inbox directly without discarding retained activity", async () => {
  setHandler(reads());
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Open Inbox" }));
  assert.deepEqual(went, ["inbox"]);
  assert(screen.getByRole("button", { name: "All activity and history" }));
});

test("a session with a question shows it on Home as an answerable card, with the conversation one tap away", async () => {
  setHandler(
    reads({
      "organization.fleet": () => ({
        ...fleet,
        observedAt: iso(0),
        total: 2,
        nodes: [
          node(8, "running", iso(0), { pending: 1, serverId: "Book", title: "Docs lead" }),
          node(9, "running", iso(0), { pending: 0, serverId: "Book", title: "Quiet worker" }),
        ],
      }),
    }),
  );
  mount();
  const section = within(await screen.findByTestId("today-questions"));
  assert(section.getByText("Docs lead is waiting for you"));
  const card = section.getByTestId(`agent-questions-${sid(8)}`);
  assert.equal(card.getAttribute("data-server"), "Book");
  assert.equal(section.queryByText(/Quiet worker/), null);
});

test("a question from a session on an unbound This Mac still shows, asked on the connected host", async () => {
  // Installs leave the organisation's "This Mac" without a serverId, so the fleet sends none.
  setHandler(
    reads({
      "organization.fleet": () => ({
        ...fleet,
        observedAt: iso(0),
        total: 1,
        nodes: [
          node(8, "running", iso(0), { pending: 1, serverId: null, title: "Main assistant" }),
        ],
      }),
    }),
  );
  mount();
  const section = within(await screen.findByTestId("today-questions"));
  const card = section.getByTestId(`agent-questions-${sid(8)}`);
  assert.match(card.getAttribute("data-server"), /^today-\d+$/);
});
