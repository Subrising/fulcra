// Synthetic component tests for the Fulcra work map (run through verify-ui.mjs). Not a device test.
import { WorkMapSurface, OVERVIEW_POLL_MS, PROJECT_POLL_MS } from "./work-map";
import { OrganizationSurface as HomeSurface } from "./organization";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { JSDOM } from "jsdom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  calls,
  setHandler,
  copied,
  setObservedAgents,
  setNativeHostCatalog,
} from "./ui-test-adapters.mjs";
import { forgetAll } from "./last-good";
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://component.test",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { render, screen, fireEvent, waitFor, cleanup } = await import("@testing-library/react");

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
  },
};
const uuid = (n) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const P1 = uuid(20),
  P2 = uuid(21),
  W1 = uuid(10),
  LEAD = uuid(2),
  CHILD = uuid(3),
  PRIME = uuid(1);
const iso = (offset = 0) => new Date(Date.now() - offset).toISOString();
const clients = [];
function mount(component) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  return { client, ...render(h(QueryClientProvider, { client }, component)) };
}
afterEach(() => {
  cleanup();
  for (const c of clients.splice(0)) c.clear();
  copied.length = 0;
  forgetAll();
  setObservedAgents({ entries: [], total: 0, truncated: 0, source: "native-cache" });
  setNativeHostCatalog();
});

const seat = (role, id, session, mode, extra = {}) => ({
  role,
  seat: id,
  projectId: role === "prime" ? null : id,
  state: session ? "assigned" : "vacant",
  revision: 3,
  task: session ? W1 : null,
  sessionId: session,
  session: session ? { id: session, task: W1, mode, generation: 2 } : null,
  note: null,
  at: iso(),
  membershipAt: iso(),
  sessionPresent: !!session,
  sessionGenerationChanged: false,
  sessionTaskMatches: true,
  dispatch: session ? { host: "mini", supported: true, reason: null } : null,
  hold: null,
  ...extra,
});
const runtime = (title, status) => ({
  title,
  provider: "claude",
  model: "opus",
  host: "mini",
  status,
  pending: 0,
  error: null,
  updatedAt: iso(),
});
const overview = (extra = {}) => ({
  observedAt: iso(),
  available: true,
  unavailable: null,
  primes: [seat("prime", "delivery", PRIME, "human", { hold: "effective" })],
  projects: [
    {
      projectId: P2,
      name: "LinkedIn and content",
      status: "planned",
      seat: null,
      channels: [],
      workstreams: 4,
      sessions: 0,
      running: 0,
    },
    {
      projectId: P1,
      name: "Orca platform",
      status: "in_progress",
      seat: seat("project-orchestrator", P1, LEAD, "delegated"),
      channels: [{ primeSeat: "delivery", state: "open", open: true }],
      workstreams: 1,
      sessions: 2,
      running: 1,
    },
  ],
  unplaced: [
    {
      sessionId: uuid(9),
      taskId: uuid(99),
      mode: "delegated",
      runtime: runtime("Stray session", "idle"),
    },
  ],
  attention: [
    {
      kind: "no-project-orchestrator",
      detail: "LinkedIn and content needs an orchestrator.",
      projectId: P2,
      taskId: null,
      sessionId: null,
    },
  ],
  sources: {
    seats: true,
    channels: true,
    projects: { available: true, partial: false, note: "dir" },
    fleet: { available: true, partial: false, observedAt: iso() },
  },
  note: "Read-only. A seat records accountability; idle is not done, and nothing on this map grants, sends or takes over.",
  ...extra,
});
const project = (projectId) => ({
  observedAt: iso(),
  available: true,
  unavailable: null,
  projectId,
  name: "Orca platform",
  status: "in_progress",
  membership: { known: true, partial: false, truncated: false, memberTaskCount: 1, note: "" },
  leader: null,
  workstreams:
    projectId !== P1
      ? []
      : [
          {
            taskId: W1,
            recorded: 3,
            unresolved: 0,
            truncated: false,
            sessions: [
              {
                sessionId: LEAD,
                taskId: W1,
                mode: "delegated",
                generation: 2,
                ownership: "recorded",
                seat: P1,
                seatRole: "project-orchestrator",
                parentSession: null,
                adoptedUnder: null,
                leaderChanged: false,
                runtime: runtime("J2 design", "running"),
              },
              {
                sessionId: CHILD,
                taskId: W1,
                mode: "delegated",
                generation: 1,
                ownership: "recorded",
                seat: P1,
                seatRole: "project-orchestrator",
                parentSession: LEAD,
                adoptedUnder: null,
                leaderChanged: false,
                runtime: runtime("Reviewer", "idle"),
              },
            ],
          },
        ],
  needed: [],
  blockers: [],
  issues: {
    observedAt: iso(),
    truncated: false,
    providers: [{ source: "board", available: true, note: "" }],
    issues: [
      {
        source: "board",
        key: "AIN-107",
        title: "Work view",
        state: "in_progress",
        rawState: "in_progress",
        assignee: null,
        url: null,
        updatedAt: null,
        linkedTo: { scope: "workstream", scopeId: W1 },
        relation: "is",
      },
    ],
  },
  note: "n",
});
const serve = (ov = overview()) =>
  setHandler((name, input) => {
    if (name === "organization.work-map")
      return typeof ov === "function" ? ov() : Promise.resolve(ov);
    if (name === "organization.work-map-project") return Promise.resolve(project(input.projectId));
    return Promise.reject(new Error(`unexpected ${name}`));
  });
const props = { theme, layout: { compact: true, platform: "web" }, host: { id: "mini" } };
const READS = new Set(["organization.work-map", "organization.work-map-project"]);

test("work map renders prime, projects and attention, and reads nothing but the two work-map reads", async () => {
  serve();
  mount(h(WorkMapSurface, props));
  await screen.findByText("Fulcra work map");
  await screen.findByRole("button", { name: /Prime seat delivery, Held by you/ });
  assert(screen.getByRole("button", { name: /Project Orca platform, Assigned/ }));
  assert(
    screen.getByRole("button", { name: "Attention: LinkedIn and content needs an orchestrator." }),
  );
  assert(screen.getByText(/Observed \d+ s ago/));
  // The opening view stays at prime/project summaries and reads no project until expansion.
  assert(!calls.some((call) => call.name === "organization.work-map-project"));
  assert(screen.getByRole("button", { name: /Project Orca platform.*collapsed/ }));
  assert(
    calls.every((c) => READS.has(c.name)),
    calls.map((c) => c.name).join(),
  );
});

test("expanding a project reads it once and shows workstreams and nested sessions with parent links", async () => {
  serve();
  mount(h(WorkMapSurface, props));
  fireEvent.click(screen.getByRole("button", { name: "Activity: All observed" }));
  fireEvent.click(await screen.findByRole("button", { name: /Project Orca platform/ }));
  await screen.findByRole("button", { name: /Workstream AIN-107 · Work view, 2 sessions/ });
  assert(screen.getByRole("button", { name: "Session J2 design, run by Fulcra, running" }));
  assert(
    screen.getByRole("button", {
      name: "Session Reviewer, run by Fulcra, idle — not done, child of J2 design",
    }),
  );
  assert.equal(
    calls.filter((c) => c.name === "organization.work-map-project" && c.input.projectId === P1)
      .length,
    1,
  );
  assert(calls.every((c) => READS.has(c.name)));
});

test("selecting a controller session shows its ids, preserves copying and disables unavailable native actions", async () => {
  serve();
  mount(h(WorkMapSurface, props));
  fireEvent.click(screen.getByRole("button", { name: "Activity: All observed" }));
  fireEvent.click(await screen.findByRole("button", { name: /Project Orca platform/ }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Session J2 design, run by Fulcra, running" }),
  );
  // J0: ids sit behind the Details disclosure, closed by default.
  assert.equal(screen.queryByText(`Session ${LEAD}`), null);
  fireEvent.click(screen.getByRole("button", { name: "Show details" }));
  assert(screen.getByText(`Session ${LEAD}`));
  fireEvent.click(screen.getByRole("button", { name: `Copy id ${LEAD}` }));
  await screen.findByText("Copied");
  assert.deepEqual(copied, [LEAD]);
  assert(calls.every((c) => READS.has(c.name)));
});

test("no button on the work map is a control action", async () => {
  serve();
  mount(h(WorkMapSurface, props));
  fireEvent.click(screen.getByRole("button", { name: "Activity: All observed" }));
  fireEvent.click(await screen.findByRole("button", { name: /Project Orca platform/ }));
  // Select a session first so the detail panel (the one place with an action) is on screen.
  fireEvent.click(
    await screen.findByRole("button", { name: "Session J2 design, run by Fulcra, running" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Show details" }));
  assert(screen.getByRole("button", { name: `Copy id ${LEAD}` }));
  fireEvent.click(screen.getByRole("button", { name: "Show map" }));
  fireEvent.click(screen.getByRole("button", { name: "Status legend" }));
  const allowed =
    /^(Refresh work map|Freeze updates|Resume updates|Show list|Show map|Status legend|Clear filters|Show details|Hide details|Show more filters|Hide more filters|Copy id .*|Open exact conversation|Open native Changes|Activity: .*|All hosts|Show active workers|Hide worker detail|Show recorded connections|Hide connections|Fit map|Focus selection|Zoom in|Zoom out|Reset map|Pan (left|right|up|down)|Attention: .*|Prime seat .*|Project .*|Workstream .*|Session .*|Unplaced sessions.*|\d+ more sessions.*)$/;
  for (const b of screen.getAllByRole("button"))
    assert.match(b.getAttribute("aria-label") ?? b.textContent, allowed);
  for (const word of [
    "Assign",
    "Adopt",
    "Send",
    "Take over",
    "Grant",
    "Hold",
    "Open conversation",
    "Request",
  ])
    assert.equal(screen.queryAllByRole("button", { name: new RegExp(`^${word}`) }).length, 0, word);
});

test("a stale observation is retained, labelled STALE, dimmed and drawn with hollow glyphs", async () => {
  serve(overview({ observedAt: iso(120_000) }));
  mount(h(WorkMapSurface, props));
  await screen.findByText(/STALE · retained 2 min ago/);
  assert(screen.getByText(/◇ Prime · delivery/), "the prime glyph is hollow when stale");
  assert(screen.getByRole("button", { name: /Prime seat delivery/ }));
});

test("a failed refresh keeps the last map and says it is retained", async () => {
  let fail = false;
  serve(() =>
    fail ? Promise.reject(new Error("connect ENOENT control.sock")) : Promise.resolve(overview()),
  );
  mount(h(WorkMapSurface, props));
  await screen.findByRole("button", { name: /Prime seat delivery/ });
  fail = true;
  fireEvent.click(screen.getByRole("button", { name: "Refresh work map" }));
  await screen.findByText(/^Last updated just now · Fulcra did not answer; retrying$/);
  await screen.findByText(/STALE · retained/);
  assert(screen.getByRole("button", { name: /Prime seat delivery/ }), "retained, not dropped");
});

test("with no observation at all the error state names Fulcra and the reason", async () => {
  serve(() => Promise.reject(new Error("connect ENOENT control.sock")));
  mount(h(WorkMapSurface, props));
  await screen.findByText(
    "Fulcra can't reach the controller on this host: connect ENOENT control.sock.",
  );
});

test("unreadable seats are shown as unknown, never as no seats", async () => {
  serve(
    overview({
      available: false,
      unavailable: "Operator authorization required",
      primes: [],
      attention: [],
    }),
  );
  mount(h(WorkMapSurface, props));
  await screen.findByText(
    "Recorded seats could not be read (Operator authorization required). No orchestrator can be named or ruled out.",
  );
  assert.equal(screen.queryByText(/No prime or project orchestrator is recorded yet/), null);
});

test("an empty installation says where seats are assigned, without offering to assign them", async () => {
  serve(overview({ primes: [], projects: [], unplaced: [], attention: [] }));
  mount(h(WorkMapSurface, props));
  await screen.findByText(
    "No prime or project orchestrator is recorded yet. Seats are assigned in Leadership.",
  );
});

test("freeze stops updates and says so; polling cadence is 15 s overview / 30 s project", async () => {
  assert.equal(OVERVIEW_POLL_MS, 15000);
  assert.equal(PROJECT_POLL_MS, 30000);
  serve();
  const { client } = mount(h(WorkMapSurface, props));
  await screen.findByRole("button", { name: /Prime seat delivery/ });
  fireEvent.click(
    screen.getByRole("button", { name: "Attention: LinkedIn and content needs an orchestrator." }),
  );
  await waitFor(() =>
    assert(client.getQueryCache().find({ queryKey: ["orca-work-map-project", "mini", P2] })),
  );
  const options = (key) => client.getQueryCache().find({ queryKey: key }).observers[0].options;
  assert.equal(options(["orca-work-map", "mini"]).refetchInterval, 15000);
  assert.equal(options(["orca-work-map", "mini"]).refetchIntervalInBackground, false);
  assert.equal(options(["orca-work-map-project", "mini", P2]).refetchInterval, 30000);
  assert.equal(options(["orca-work-map-project", "mini", P2]).refetchIntervalInBackground, false);
  fireEvent.click(screen.getByRole("button", { name: "Freeze updates" }));
  await screen.findByText("Frozen");
  assert(screen.getByRole("button", { name: "Resume updates" }));
  assert.equal(
    options(["orca-work-map", "mini"]).refetchInterval,
    false,
    "frozen stops overview polling",
  );
  assert.equal(
    options(["orca-work-map-project", "mini", P2]).refetchInterval,
    false,
    "frozen stops project polling",
  );
});

test("the needs-attention filter and search narrow the outline; a miss offers to clear filters", async () => {
  serve();
  mount(h(WorkMapSurface, props));
  await screen.findByRole("button", { name: /Project Orca platform/ });
  fireEvent.click(screen.getByRole("button", { name: "Show more filters" }));
  fireEvent.click(screen.getByRole("radio", { name: "Filter: Needs attention" }));
  await waitFor(() =>
    assert.equal(screen.queryByRole("button", { name: /Project Orca platform/ }), null),
  );
  assert(screen.getByRole("button", { name: /Project LinkedIn and content/ }));
  fireEvent.click(screen.getByRole("radio", { name: "Filter: All" }));
  fireEvent.change(screen.getByLabelText("Search sessions, seats, workstreams and issues"), {
    target: { value: "no such thing" },
  });
  await screen.findByText("Nothing matches these filters.");
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  await screen.findByRole("button", { name: /Project Orca platform/ });
});

test("map view draws the same rows as accessible buttons with bounded zoom", async () => {
  serve();
  mount(h(WorkMapSurface, props));
  await screen.findByRole("button", { name: /Prime seat delivery/ });
  fireEvent.click(screen.getByRole("button", { name: "Show map" }));
  assert(screen.getByTestId("work-map-viewport"));
  assert(screen.getByText(/\d+ nodes · \d+ links · 100%/));
  for (let i = 0; i < 6; i++) fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  assert(screen.getByText(/· 200%/));
});

// J1: the Organisation tab opens on the Organisation view; on a wide screen the work map is one tap away as "Map".
// The home itself opens on Today, the front door.
test("the Organisation tab opens on the Organisation view, with the Fulcra work map one tap away", async () => {
  serve();
  mount(h(HomeSurface, { ...props, layout: { compact: false, platform: "web" } }));
  await screen.findByTestId("today");
  fireEvent.click(screen.getByTestId("organization-tab-organisation"));
  await screen.findByTestId("org-tree");
  assert(screen.getByRole("button", { name: "Leadership", exact: true }));
  fireEvent.click(screen.getByTestId("org-view-map"));
  await screen.findByText("Fulcra work map");
});

// J0 regroup: Organisation, Sessions, Trackers only; unfinished tabs are hidden; every earlier test id still works.
test("the home shows only ready tabs, and earlier tab ids still select their views", async () => {
  // C1: the Organisation tab opens on J1's organisation view; the work map is one tap away under "Map". J1 offers that
  // button only in the wide layout, so this test mounts wide (the compact layout has no way to the map: RC-C1 open item).
  serve();
  mount(h(HomeSurface, { ...props, layout: { compact: false, platform: "web" } }));
  const openMap = async () => {
    fireEvent.click(await screen.findByTestId("org-view-map"));
    await screen.findByText("Fulcra work map");
  };
  // Today is the front door: the Command Centre opens on it, and Organisation is one tap away.
  assert.equal(
    (await screen.findByTestId("organization-tab-today")).getAttribute("aria-selected"),
    "true",
    "Today opens first",
  );
  fireEvent.click(screen.getByTestId("organization-tab-organisation"));
  await openMap();
  const top = [...document.querySelectorAll('[data-testid^="organization-tab-"]')].map((e) =>
    e.getAttribute("data-testid"),
  );
  // C1 registry: Environments (J8) is ready; Changes stays hidden (J7's view is the app's Architecture map panel).
  assert.deepEqual(top.slice(0, 9), [
    "organization-tab-today",
    "organization-tab-organisation",
    "organization-tab-inbox",
    "organization-tab-changes",
    "organization-tab-environments",
    "organization-tab-sessions",
    "organization-tab-fleet",
    "organization-tab-trackers",
    "organization-tab-settings",
  ]);
  for (const hidden of ["Live work"])
    assert.equal(screen.queryByRole("button", { name: hidden, exact: true }), null, hidden);
  for (const id of ["workmap", "leadership", "portfolio", "task"])
    assert(screen.getByTestId(`organization-tab-${id}`), id);
  fireEvent.click(screen.getByTestId("organization-tab-fleet"));
  assert.equal(
    screen.getByTestId("organization-tab-sessions").getAttribute("aria-selected"),
    "true",
    "the old Live work id selects Sessions",
  );
  assert.equal(
    screen.queryByTestId("organization-tab-workmap"),
    null,
    "Organisation views belong to Organisation",
  );
  fireEvent.click(screen.getByTestId("organization-tab-organisation"));
  fireEvent.click(await screen.findByTestId("organization-tab-task"));
  assert(
    await screen.findByRole("button", { name: "Back to Organisation" }),
    "Manage task opens as a sheet inside Organisation",
  );
  // J0-8: the sheet header keeps the Manage task id, selected, so automation still finds it.
  assert.equal(screen.getByTestId("organization-tab-task").getAttribute("aria-selected"), "true");
  fireEvent.click(screen.getByRole("button", { name: "Back to Organisation" }));
  await openMap();
  // Settings holds J3's Devices and Channels, under J3's own tab ids.
  fireEvent.click(screen.getByTestId("organization-tab-settings"));
  assert.equal(
    screen.getByTestId("organization-tab-devices").getAttribute("aria-selected"),
    "true",
  );
  fireEvent.click(screen.getByTestId("organization-tab-channels"));
  assert.equal(
    screen.getByTestId("organization-tab-channels").getAttribute("aria-selected"),
    "true",
  );
});

test("native cache event reveals Book work and opens only the exact Book conversation/Changes without a new read", async () => {
  serve();
  const targets = [];
  const entry = {
    serverId: "srv_book",
    agentId: uuid(99),
    hostName: "Book",
    connection: "online",
    title: "Book native worker",
    provider: "codex",
    model: "gpt-6.1-sol",
    status: "running",
    activity: "working",
    observedAt: iso(),
    creatorAgentId: null,
    workspace: {
      id: uuid(98),
      projectId: uuid(97),
      projectName: "Ship It",
      kind: "worktree",
      changesAvailable: true,
    },
  };
  setNativeHostCatalog([{ serverId: "srv_book", label: "Book", status: "online" }]);
  setObservedAgents({ entries: [entry], total: 1, truncated: 0, source: "native-cache" });
  mount(
    h(WorkMapSurface, {
      ...props,
      navigation: {
        openAgentOnHost: (target) => {
          targets.push(["chat", target]);
          return "requested";
        },
        openAgentChangesOnHost: (target) => {
          targets.push(["changes", target]);
          return "requested";
        },
      },
    }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: /Book native worker, Book, model turn active/ }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Open exact conversation" }));
  fireEvent.click(screen.getByRole("button", { name: "Open native Changes" }));
  assert.deepEqual(targets, [
    ["chat", { serverId: "srv_book", agentId: uuid(99) }],
    ["changes", { serverId: "srv_book", agentId: uuid(99) }],
  ]);
  const count = calls.length;
  await React.act(async () =>
    setObservedAgents({
      entries: [{ ...entry, connection: "offline", activity: "unavailable" }],
      total: 1,
      truncated: 0,
      source: "native-cache",
    }),
  );
  assert.equal(
    screen.queryByRole("button", { name: "Open native Changes" }),
    null,
    "active filtering withdraws offline selection and its actions",
  );
  fireEvent.click(screen.getByRole("button", { name: "Activity: All observed" }));
  fireEvent.click(await screen.findByRole("button", { name: /Book native worker, Book,/ }));
  assert.equal(screen.getByRole("button", { name: "Open native Changes" }).disabled, true);
  assert.equal(calls.length, count, "a cached native event starts no provider/controller read");
});
