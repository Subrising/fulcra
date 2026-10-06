// Fulcra J1 Organisation behaviour with synthetic component adapters (not a Paseo/phone UI test). The stable test
// ids (org-tree, org-project-<id>, org-remit-edit, org-story) are the ones the brief fixes.
import { SeatPanel } from "./role-seat";
import { OrganisationSurface } from "./organisation";
import { buildTree, remitLine, relativeTime } from "./organisation-model";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { JSDOM } from "jsdom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { calls, setHandler, scrollCalls } from "./ui-test-adapters.mjs";
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
const id = (n) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const TALLY = id(21),
  ORCA = id(22),
  SITE = id(23),
  LEAD = id(2),
  PRIME = id(1),
  W = id(10),
  R1 = id(31),
  R2 = id(32),
  H1 = id(41);
const iso = (ago = 0) => new Date(Date.now() - ago).toISOString();
const clients = [];
function mount(layout = { compact: false, platform: "web" }, extra = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  return render(
    h(
      QueryClientProvider,
      { client },
      h(OrganisationSurface, { theme, layout, host: { id: "mini" }, ...extra }),
    ),
  );
}
afterEach(() => {
  cleanup();
  for (const c of clients.splice(0)) c.clear();
});

const seat = (role, s, session) => ({
  role,
  seat: s,
  projectId: role === "prime" ? null : s,
  state: session ? "assigned" : "vacant",
  revision: 1,
  task: W,
  sessionId: session,
  session: null,
  note: null,
  at: iso(),
  membershipAt: null,
  sessionPresent: !!session,
  sessionGenerationChanged: false,
  sessionTaskMatches: true,
  dispatch: null,
  hold: null,
});
const map = {
  observedAt: iso(),
  available: true,
  unavailable: null,
  primes: [seat("prime", "delivery", PRIME), seat("prime", "research", null)],
  projects: [
    {
      projectId: TALLY,
      name: "Tally",
      status: "in_progress",
      seat: seat("project-orchestrator", TALLY, LEAD),
      channels: [],
      workstreams: 1,
      sessions: 3,
      running: 1,
    },
    {
      projectId: ORCA,
      name: "Orca platform",
      status: "in_progress",
      seat: null,
      channels: [],
      workstreams: 2,
      sessions: 0,
      running: 0,
    },
    {
      projectId: SITE,
      name: "Company website",
      status: "planned",
      seat: null,
      channels: [],
      workstreams: 0,
      sessions: 0,
      running: 0,
    },
  ],
  unplaced: [],
  attention: [],
  sources: {
    seats: true,
    channels: true,
    projects: { available: true, partial: false, note: "" },
    fleet: { available: true, partial: false, observedAt: iso() },
  },
  note: "Read-only.",
};
const fleet = {
  observedAt: iso(),
  total: 2,
  partial: false,
  note: "",
  nodes: [
    {
      id: LEAD,
      task: W,
      host: "mini",
      agentId: null,
      title: "Tally orchestrator",
      provider: "claude",
      model: null,
      mode: "delegated",
      status: "running",
      pending: 0,
      observedAt: null,
      updatedAt: iso(),
      error: null,
    },
    {
      id: PRIME,
      task: W,
      host: "mini",
      agentId: null,
      title: "Release lead",
      provider: "claude",
      model: null,
      mode: "human",
      status: "idle",
      pending: 0,
      observedAt: null,
      updatedAt: iso(),
      error: null,
    },
  ],
  tasks: [],
  edges: [],
};
const remit = (rid, primeSeat, scope, extra = {}) => ({
  version: 1,
  id: rid,
  revision: 1,
  primeSeat,
  scope,
  state: "active",
  since: iso(3600000),
  endedAt: null,
  note: "Delivery owns launch work this month",
  ...extra,
});
const remits = (extra = {}) => ({
  version: 1,
  observedAt: iso(),
  partial: false,
  stale: false,
  error: null,
  primes: [
    { seat: "delivery", state: "assigned", sessionId: PRIME },
    { seat: "research", state: "vacant", sessionId: null },
  ],
  remits: [
    remit(R1, "delivery", { kind: "project", projectId: TALLY }),
    remit(R2, "research", { kind: "domain", domain: "platform", label: "Platform work" }),
  ],
  domains: [{ projectId: ORCA, domain: "platform", revision: 1 }],
  projects: [
    {
      projectId: TALLY,
      name: "Tally",
      domain: null,
      domainRevision: 0,
      owner: { kind: "project", primeSeat: "delivery", remitId: R1 },
    },
    {
      projectId: ORCA,
      name: "Orca platform",
      domain: "platform",
      domainRevision: 1,
      owner: { kind: "domain", primeSeat: "research", remitId: R2 },
    },
    {
      projectId: SITE,
      name: "Company website",
      domain: null,
      domainRevision: 0,
      owner: { kind: "unassigned", primeSeat: null, remitId: null },
    },
  ],
  history: [
    {
      id: H1,
      entityId: R1,
      action: "moved",
      before: remit(
        id(30),
        "research",
        { kind: "project", projectId: TALLY },
        { state: "ended", endedAt: iso(3600000), revision: 2 },
      ),
      after: remit(R1, "delivery", { kind: "project", projectId: TALLY }),
      previousRevision: 1,
      revision: 1,
      actor: "operator",
      note: "Delivery owns launch work this month",
      at: iso(3600000),
    },
  ],
  ...extra,
});
const brief = (extra = {}) => ({
  version: 1,
  observedAt: iso(),
  partial: false,
  error: null,
  projectId: TALLY,
  authorName: "the Tally orchestrator",
  stale: false,
  observed: {
    sessionsRunning: 1,
    sessionsTotal: 3,
    openDecisions: 1,
    heldMessages: 0,
    lastActivityAt: iso(),
    observedAt: iso(),
  },
  brief: {
    version: 1,
    projectId: TALLY,
    revision: 4,
    author: { seat: TALLY, sessionId: LEAD },
    writtenAt: iso(10 * 60000),
    health: "at-risk",
    headline: "Launch may slip by a week.",
    now: "Testers found two problems with sign-up; both are being fixed.",
    next: [{ text: "Fix the two sign-up problems", by: "2026-10-01" }],
    needsYou: [{ text: "Choose whether to launch on the 1st or the 8th", decision: null }],
    risks: [
      {
        text: "Welcome emails may be slow at launch",
        severity: "high",
        mitigation: "A second email service is ready",
      },
    ],
    shipped: [{ text: "The sign-up page", ref: null }],
    evidence: [{ ref: `task:${W}`, label: "The sign-up work" }],
  },
  ...extra,
});
const ok = (extra) => ({ ok: true, message: null, observedAt: iso(), ...extra });
const serve = (over = {}) =>
  setHandler((name, input) => {
    if (over[name]) return Promise.resolve(over[name](input));
    if (name === "organization.work-map") return Promise.resolve(map);
    if (name === "organization.fleet") return Promise.resolve(fleet);
    if (name === "organization.remits") return Promise.resolve(remits());
    if (name === "organization.project-brief") return Promise.resolve(brief());
    if (name === "organization.remit-move")
      return Promise.resolve(
        ok({
          remit: remit(id(33), input.toPrimeSeat, { kind: "project", projectId: TALLY }),
          ended: remit(
            R1,
            "delivery",
            { kind: "project", projectId: TALLY },
            { state: "ended", endedAt: iso(), revision: 2 },
          ),
        }),
      );
    if (name === "organization.remit-assign")
      return Promise.resolve(ok({ remit: remit(id(34), input.primeSeat, input.scope) }));
    if (name === "organization.work-map-project") return Promise.reject(new Error("not needed"));
    return Promise.reject(new Error(`unexpected ${name}`));
  });

test("M1: the tree groups projects by the owner the controller resolved; unowned projects are listed, never dropped", () => {
  const t = buildTree(map, remits(), fleet);
  assert.deepEqual(
    t.primes.map((p) => [p.seat, p.projects.map((x) => x.name), p.remitLine]),
    [
      ["delivery", ["Tally"], "Owns 1 project: Tally"],
      ["research", ["Orca platform"], "Owns Platform work · 1 project"],
    ],
  );
  assert.deepEqual(
    t.unassigned.map((x) => x.name),
    ["Company website"],
  );
  assert.deepEqual(t.primes[0].projects[0].orchestrator, {
    state: "working",
    name: "Tally orchestrator",
    sessionId: LEAD,
  });
  assert.equal(t.primes[0].holder, "Release lead");
  assert.equal(t.primes[1].filled, false);
  // An owner that is no longer a recorded prime seat falls back to "No prime yet".
  const gone = buildTree(
    map,
    remits({ primes: [{ seat: "research", state: "vacant", sessionId: null }] }),
    fleet,
  );
  assert.deepEqual(gone.unassigned.map((x) => x.name).sort(), ["Company website", "Tally"]);
  assert.equal(remitLine([], []), "Owns no projects yet");
  assert.equal(remitLine(["A", "B", "C"], ["x"]), "Owns A, B and 1 more · 1 project");
  assert.equal(relativeTime(iso(10 * 60000)), "10 min ago");
  assert.equal(relativeTime(iso(30 * 3600000)), "yesterday");
});

test("U1: primes with a one-line remit, their projects, each orchestrator and live session count", async () => {
  serve();
  mount();
  await waitFor(() => assert(screen.getByTestId(`org-project-${TALLY}`)));
  const tree = screen.getByTestId("org-tree");
  assert(within(tree).getByText("▾ Delivery prime"));
  assert(within(tree).getByText("Owns 1 project: Tally"));
  assert(within(tree).getByText("Led by Release lead"));
  assert(within(tree).getByText("Owns Platform work · 1 project"));
  assert(within(tree).getByText("No one is in this seat"));
  const row = screen.getByTestId(`org-project-${TALLY}`);
  assert(within(row).getByText("Tally orchestrator · working now"));
  assert(within(row).getByText("● 1 of 3 sessions working"));
  assert(within(screen.getByTestId(`org-project-${ORCA}`)).getByText("No orchestrator yet"));
  assert(screen.getByText("No prime yet · 1"));
  assert(screen.getByTestId(`org-project-${SITE}`));
  assert(!tree.textContent.includes(TALLY), "ids stay out of the tree");
});

test("U2: a prime collapses and expands its projects", async () => {
  serve();
  mount({ compact: true, platform: "ios" });
  const header = await screen.findByRole("button", {
    name: /^Delivery prime\. Owns 1 project: Tally\. Hide its projects\./,
  });
  assert.equal(header.getAttribute("aria-expanded"), "true");
  fireEvent.click(header);
  await waitFor(() => assert.equal(screen.queryByTestId(`org-project-${TALLY}`), null));
  assert.equal(
    screen.getByRole("button", { name: /^Delivery prime\./ }).getAttribute("aria-expanded"),
    "false",
  );
  fireEvent.click(screen.getByRole("button", { name: /^Delivery prime\./ }));
  await waitFor(() => assert(screen.getByTestId(`org-project-${TALLY}`)));
});

test('U3: tapping a project shows Now / Next / Needs you / Risks, "Written by", and ids only behind Details', async () => {
  serve();
  mount();
  fireEvent.click(await screen.findByTestId(`org-project-${TALLY}`));
  const story = await screen.findByTestId("org-story");
  await waitFor(() => assert(within(story).getByText("Launch may slip by a week.")));
  assert(within(story).getByText("Written by the Tally orchestrator, 10 min ago"));
  for (const s of ["Now", "Next", "Needs you", "Risks", "Finished since last time"])
    assert(within(story).getByText(s));
  assert(within(story).getByText("• Fix the two sign-up problems — by 1 Oct"));
  assert(within(story).getByText("Choose whether to launch on the 1st or the 8th"));
  assert(within(story).getByText("What is being done: A second email service is ready"));
  assert(within(story).getByText("At risk"));
  assert.equal(within(story).queryByText("May be out of date"), null);
  assert(
    within(story).getByText(
      "Right now: 1 of 3 sessions working · 1 decision waiting for you · 0 messages held",
    ),
  );
  assert(
    !story.textContent.includes(TALLY) && !story.textContent.includes(W),
    "no ids before Details",
  );
  fireEvent.click(within(story).getByTestId("org-story-details"));
  await waitFor(() => assert(story.textContent.includes(`Project: ${TALLY}`)));
  assert(story.textContent.includes(`The sign-up work: task:${W}`));
  assert(calls.some((c) => c.name === "organization.project-brief" && c.input.projectId === TALLY));
});

test('U4: a stale story says "May be out of date"; a project with no story says so plainly', async () => {
  serve({
    "organization.project-brief": (input) =>
      input.projectId === TALLY
        ? brief({ stale: true })
        : brief({ projectId: input.projectId, brief: null, authorName: null }),
  });
  mount();
  fireEvent.click(await screen.findByTestId(`org-project-${TALLY}`));
  await waitFor(() =>
    assert(within(screen.getByTestId("org-story")).getByText("May be out of date")),
  );
  fireEvent.click(screen.getByTestId(`org-project-${SITE}`));
  await waitFor(() =>
    assert(within(screen.getByTestId("org-story")).getByText("No update has been written yet.")),
  );
  assert(within(screen.getByTestId("org-story")).getByText("No prime yet"));
});

test("U5: Edit remit moves a project with a reason, as one move with the revision it showed", async () => {
  serve();
  mount();
  fireEvent.click(await screen.findByTestId(`org-project-${TALLY}`));
  fireEvent.click(await screen.findByTestId("org-remit-edit-open"));
  const sheet = await screen.findByTestId("org-remit-edit");
  assert(within(sheet).getByText("Who owns Tally?"));
  const save = within(sheet).getByTestId("org-remit-save");
  assert.equal(save.disabled, true, "nothing chosen yet");
  assert.equal(
    within(sheet).getByTestId("org-remit-prime-delivery").disabled,
    true,
    "the current owner is not a choice",
  );
  fireEvent.click(within(sheet).getByTestId("org-remit-prime-research"));
  fireEvent.change(within(sheet).getByTestId("org-remit-reason"), { target: { value: "short" } });
  assert.equal(
    within(sheet).getByTestId("org-remit-save").disabled,
    true,
    "a reason of at least 12 characters",
  );
  assert(within(sheet).getByText("Write at least 12 characters so the history makes sense later."));
  fireEvent.change(within(sheet).getByTestId("org-remit-reason"), {
    target: { value: "  Research is taking over all platform work  " },
  });
  fireEvent.click(within(sheet).getByTestId("org-remit-save"));
  await waitFor(() => assert(within(sheet).getByTestId("org-remit-result")));
  assert(within(sheet).getByText("Tally now belongs to the Research prime."));
  const move = calls.filter((c) => c.name === "organization.remit-move");
  assert.equal(move.length, 1);
  assert.deepEqual(
    { ...move[0].input, messageId: undefined },
    {
      messageId: undefined,
      expectedRevision: 1,
      remitId: R1,
      toPrimeSeat: "research",
      note: "Research is taking over all platform work",
    },
  );
  assert.match(move[0].input.messageId, /^[0-9a-f-]{36}$/);
  assert(!calls.some((c) => c.name === "organization.remit-assign"));
});

test("U6: a project with no prime gets its own remit; a refusal is shown as it is; history reads as words", async () => {
  serve({
    "organization.remit-assign": () => ({
      ok: false,
      message: "Changed since you looked; refresh: it already has a prime, so move it instead",
      observedAt: iso(),
      remit: null,
    }),
  });
  mount();
  fireEvent.click(await screen.findByTestId(`org-project-${SITE}`));
  fireEvent.click(await screen.findByTestId("org-remit-edit-open"));
  const sheet = await screen.findByTestId("org-remit-edit");
  fireEvent.click(within(sheet).getByTestId("org-remit-prime-delivery"));
  fireEvent.change(within(sheet).getByTestId("org-remit-reason"), {
    target: { value: "The website launch is delivery work" },
  });
  fireEvent.click(within(sheet).getByTestId("org-remit-save"));
  await waitFor(() =>
    assert(
      within(sheet).getByText(
        "Changed since you looked; refresh: it already has a prime, so move it instead",
      ),
    ),
  );
  const assign = calls.find((c) => c.name === "organization.remit-assign");
  assert.deepEqual(assign.input.scope, { kind: "project", projectId: SITE });
  assert.equal(assign.input.expectedRevision, 0);
  assert.equal(assign.input.primeSeat, "delivery");
  // History for Tally, from its own sheet.
  fireEvent.click(screen.getByTestId(`org-project-${TALLY}`));
  fireEvent.click(await screen.findByTestId("org-remit-edit-open"));
  const history = await screen.findByTestId("org-remit-history");
  assert(within(history).getByText("Moved from the Research prime to the Delivery prime"));
  assert(
    within(history).getByText(
      "“Delivery owns launch work this month” · 1 h ago, by the Fulcra app",
    ),
  );
});

test('U7: the work map stays one tap away as "Map" on wide and compact screens; the phone retains its project story', async () => {
  serve();
  const wide = mount();
  fireEvent.click(await screen.findByTestId("org-view-map"));
  await screen.findByText("Fulcra work map");
  fireEvent.click(screen.getByTestId("org-view-tree"));
  await screen.findByTestId("org-tree");
  wide.unmount();
  serve();
  mount({ compact: true, platform: "ios" });
  await screen.findByTestId(`org-project-${TALLY}`);
  fireEvent.click(screen.getByTestId("org-view-map"));
  await screen.findByText("Fulcra work map");
  fireEvent.click(screen.getByTestId("org-view-tree"));
  await screen.findByTestId(`org-project-${TALLY}`);
  fireEvent.click(screen.getByTestId(`org-project-${TALLY}`));
  await screen.findByTestId("org-story");
  assert.equal(screen.queryByTestId("org-tree"), null);
  fireEvent.click(screen.getByTestId("org-back"));
  await screen.findByTestId("org-tree");
});

test("U8: when the reads fail, the view says so instead of showing an empty organisation", async () => {
  setHandler(() => Promise.reject(new Error("Controller did not answer")));
  mount();
  await screen.findByText("Your organisation could not be read. Try again in a moment.");
});

test("selecting either project resets the story scroll to the top", async () => {
  serve();
  mount();
  await screen.findByTestId(`org-project-${TALLY}`);
  scrollCalls.length = 0;
  fireEvent.click(screen.getByTestId(`org-project-${TALLY}`));
  await waitFor(() => assert.deepEqual(scrollCalls.at(-1), { y: 0, animated: false }));
  scrollCalls.length = 0;
  fireEvent.click(screen.getByTestId(`org-project-${ORCA}`));
  await waitFor(() => assert.deepEqual(scrollCalls.at(-1), { y: 0, animated: false }));
});

test("a project session opens step-through directly", async () => {
  serve({
    "organization.session-turns": () => ({ status: "unsupported", note: "Fixture older host" }),
  });
  mount();
  fireEvent.click(await screen.findByTestId(`org-project-${TALLY}`));
  fireEvent.click(screen.getByRole("button", { name: /Show saved conversations/ }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Read activity history: Tally orchestrator" }),
  );
  await waitFor(() =>
    assert(
      calls.some((c) => c.name === "organization.session-turns" && c.input.sessionId === LEAD),
    ),
  );
  assert.deepEqual(
    calls.filter((c) => c.name === "organization.session-turns").map((c) => c.input.sessionId),
    [LEAD],
    "only the exact selected orchestrator history is read",
  );
  assert(calls.some((c) => c.name === "organization.fleet" && c.input.projectId === TALLY));
});

test("a management session-read refusal stays visible and does not become an empty membership or role write", async () => {
  setHandler((name) =>
    name === "organization.task-manage"
      ? Promise.resolve({
          status: "error",
          message: "management_unavailable: saved session list refused",
          observedAt: iso(),
        })
      : Promise.reject(new Error(`Unexpected ${name}`)),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  render(
    h(
      QueryClientProvider,
      { client },
      h(SeatPanel, {
        target: {
          seat: map.primes[0],
          label: "company intake",
          candidateTaskIds: [W],
          scope: "Existing programme membership only",
        },
        props: {
          theme,
          layout: { compact: false, platform: "web" },
          host: { id: "mini", label: "Mini" },
        },
        onDone() {},
        onChanged() {},
      }),
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: /Workstream:/ }));
  await screen.findByText(/Read refusal: management_unavailable/);
  assert.equal(screen.queryByText("This workstream has no saved sessions."), null);
  assert(screen.getByRole("button", { name: "Retry workstream session read" }));
  assert.equal(
    screen.getByRole("button", { name: /^Record this session as accountable/ }).disabled,
    true,
  );
  assert(
    !calls.some((call) => call.name.includes("assign")),
    "failed metadata does not produce a role assignment",
  );
});

test("the direct Team workflow entry uses the existing map without changing project membership", async () => {
  serve();
  mount({ compact: false, platform: "web" }, { initialMode: "map" });
  await screen.findByText("Fulcra work map");
  assert(screen.getByText(/Team workflow shows project leadership/));
  assert(screen.getByTestId("org-view-tree"));
  assert(calls.every((call) => !call.name.includes("assign") && !call.name.includes("send")));
});
