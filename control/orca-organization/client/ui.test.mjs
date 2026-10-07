import { IntakeSurface } from "./organization/intake";
import { OrganizationStore } from "../server/organization/store.mjs";
import { projectReferenceKey } from "../shared/workspace-organization.mjs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { ManagementPanel } from "./management";
import { WorkBrief } from "./work-brief";
import { ConversationUpdates } from "./conversation-updates";
import { readableUpdate } from "./readable-update";
import { QuotaWaitCard, quotaIsStale } from "./quota-wait";
import { OriginalConversation } from "./original-conversation";
import { FleetSurface } from "./fleet";
import { ProjectBriefing } from "./briefing";
import { PortfolioSurface } from "./portfolio";
import { PrimeSurface } from "./prime";
import { WorkGraph } from "./work-graph";
import { RecoveryBanner } from "./recovery";
import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import React from "react";
import { JSDOM } from "jsdom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  TaskSurface as OrganizationSurface,
  OrganizationSurface as HomeSurface,
} from "./organization";
import contribute from "../index.client";
import { OutcomePanel } from "./outcomes";
import { TaskControls, UsagePanel } from "./tasks";
import {
  calls,
  setHandler,
  setNativeHostCatalog,
  panResponders,
  layoutHandlers,
  nativePans,
  setHostPanAvailable,
} from "./ui-test-adapters.mjs";
import { forgetAll } from "./last-good";
import { fleetHostsRpc } from "../shared/fleet";
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://component.test",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { render, screen, fireEvent, waitFor, cleanup, act } = await import("@testing-library/react");
const h = React.createElement,
  A = "a0a0a0a0-a0a0-4a0a-8a0a-a0a0a0a0a0a0",
  B = "11111111-1111-4111-8111-111111111111",
  S = "22222222-2222-4222-8222-222222222222";
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
const time = () => new Date().toISOString(),
  observed = (extra) => ({
    status: "observed",
    message: "Observed fixture",
    observedAt: time(),
    ...extra,
  });
const entry = (id, identifier) => ({
  id,
  identifier,
  title: `Task ${identifier}`,
  status: "in_progress",
  eligibleHint: true,
  retained: true,
});
const clients = [];
function mount(component) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  clients.push(client);
  return { client, ...render(h(QueryClientProvider, { client }, component)) };
}
// Portable configuration (1bea30f2) has no built-in default task: Manage task starts empty until one is chosen.
const chooseTask = async (identifier = "AIN-73") =>
  fireEvent.click(
    await screen.findByRole("radio", { name: `Select ${identifier}: Task ${identifier}` }),
  );
async function disposeFixture() {
  setHostPanAvailable(true);
  setNativeHostCatalog();
  cleanup();
  const owned = clients.splice(0);
  const retainedObservers = owned.flatMap((client) =>
    client
      .getQueryCache()
      .getAll()
      .filter((query) => query.getObserversCount() > 0)
      .map((query) => query.queryKey),
  );
  // Pending fake RPCs need cancellation as well as cache removal. Settle each client's
  // cancellation callbacks before another test installs its handler or fake clock.
  await Promise.all(owned.map((client) => client.cancelQueries()));
  for (const client of owned) client.clear();
  forgetAll();
  assert.deepEqual(retainedObservers, [], "Fixture query observers survived unmount");
}
afterEach(disposeFixture);
after(async () => {
  await disposeFixture();
  // Close only this suite's window, including any timers created through its DOM APIs.
  dom.window.close();
});
test("project briefing shows incoming reasons, named dependencies and original native task actions without hashes", async () => {
  const opened = [],
    hash = "a".repeat(64),
    row = {
      taskId: A,
      title: "Choose memory format",
      projectId: B,
      projectName: "Shared memory",
      outcome: "Keep decisions useful across projects",
      currentState: "Comparison ready",
      nextStep: "Read the options",
      question: "Which trade-off best fits the product?",
      decision: null,
      publishedAt: null,
      recordSha256: hash,
      affects: [{ projectId: S, name: "Orca", reason: "Every leader uses the same decisions" }],
      dependencies: [
        {
          taskId: B,
          title: "Verify retrieval",
          reportedStatus: "done",
          reason: "Need real cross-host evidence",
        },
      ],
    };
  const data = {
    observedAt: time(),
    partial: true,
    scanned: 64,
    total: 130,
    missing: 62,
    unavailable: 1,
    nextCursor: B,
    entries: [row],
  };
  setHandler((name, input) => {
    assert.equal(name, "organization.project-briefing");
    return Promise.resolve(input.after ? { ...data, entries: [], nextCursor: null } : data);
  });
  const view = mount(
    h(ProjectBriefing, {
      theme,
      host: { id: "mini" },
      layout: { compact: true, platform: "ios" },
      project: S,
      now: Date.now(),
      onTask: (id) => opened.push(id),
    }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Review decisions and dependencies" }));
  await screen.findByText(row.question);
  assert(screen.getByText("Shared memory · affects this project"));
  assert(screen.getByText(row.affects[0].reason));
  assert(screen.getByText(/Incomplete coverage/));
  assert(!view.container.textContent.includes(hash));
  assert(!view.container.textContent.includes(A));
  fireEvent.click(screen.getByRole("button", { name: "Open dependency: Verify retrieval" }));
  fireEvent.click(screen.getByRole("button", { name: "Open decision work: Choose memory format" }));
  assert.deepEqual(opened, [B, A]);
  fireEvent.click(screen.getByRole("button", { name: "Decision context: Choose memory format" }));
  assert(screen.getByText(row.currentState));
  assert(screen.getByText(/No choice is recorded/));
  fireEvent.click(screen.getByRole("button", { name: "Check next page of decision records" }));
  await screen.findByText(/No matching decision records on this page/);
  assert.equal(screen.queryByText(row.question), null);
  assert(screen.getByText(/Only this page is shown/));
  fireEvent.click(screen.getByRole("button", { name: "Return to first decision page" }));
  await screen.findByText(row.question);
});
test("briefing isolates hosts and projects, exposes outdated observations and withholds unresolved task navigation", async () => {
  const row = {
    taskId: A,
    title: "Recorded work",
    projectId: B,
    projectName: "Source",
    outcome: "Outcome",
    currentState: "State",
    nextStep: null,
    question: null,
    decision: "Keep the simpler approach",
    publishedAt: time(),
    recordSha256: "b".repeat(64),
    affects: [{ projectId: S, name: null, reason: "Unavailable project" }],
    dependencies: [
      { taskId: null, title: null, reportedStatus: null, reason: "Unknown dependency" },
    ],
  };
  let fail = false;
  setHandler(() =>
    fail
      ? Promise.reject(Error("Offline"))
      : Promise.resolve({
          observedAt: "2000-01-01T00:00:00.000Z",
          partial: true,
          scanned: 1,
          total: 1,
          missing: 0,
          unavailable: 0,
          nextCursor: null,
          entries: [row],
        }),
  );
  const props = {
      theme,
      host: { id: "mini" },
      layout: { compact: true },
      project: B,
      now: Date.now(),
      onTask: () => assert.fail("No unresolved action"),
    },
    view = mount(h(ProjectBriefing, props));
  fireEvent.click(await screen.findByRole("button", { name: "Review decisions and dependencies" }));
  await screen.findByText("Recorded work");
  assert(screen.getByText(/Saved observation is outdated/));
  assert(screen.getByText(/work that cannot be verified/));
  assert.equal(screen.queryByText("Inspect dependency"), null);
  fireEvent.click(screen.getByRole("button", { name: "Decision context: Recorded work" }));
  assert(screen.getByText(/Recorded rationale: Keep the simpler approach/));
  view.rerender(
    h(
      QueryClientProvider,
      { client: view.client },
      h(ProjectBriefing, { ...props, project: "ungrouped" }),
    ),
  );
  await screen.findByText(/No matching decision records/);
  fail = true;
  view.rerender(
    h(
      QueryClientProvider,
      { client: view.client },
      h(ProjectBriefing, { ...props, host: { id: "book" } }),
    ),
  );
  await screen.findByText(/Decision records unavailable/);
  assert.equal(screen.queryByText("Recorded work"), null);
  assert.equal(view.client.getQueryData(["orca-project-briefing", "book", null]), undefined);
});
function reveal(name) {
  const toggle = screen.queryByRole("button", { name });
  if (toggle && toggle.getAttribute("aria-expanded") !== "true") fireEvent.click(toggle);
}
function mapControls() {
  reveal("Map controls");
}
function evidence() {
  reveal("Session evidence");
}
test("conversation updates show actual words, preserve plain text and expand without claiming acceptance", async () => {
  const messages = [
    { id: "1", role: "instruction", text: "Review checkout retries.", truncated: false },
    {
      id: "2",
      role: "agent",
      text:
        "<script>not code</script> Receipts are delayed. " +
        "Investigating the retry path. ".repeat(30),
      truncated: true,
    },
  ];
  const view = mount(h(ConversationUpdates, { theme, messages, historical: false, stale: false }));
  assert(screen.getByText("Latest conversation updates"));
  assert(screen.getByText(/Agent reports still need review/));
  assert.equal(view.container.querySelector("script"), null);
  fireEvent.click(screen.getByRole("button", { name: "Read more of this update" }));
  assert(
    screen.getByText(
      (_text, node) => node?.tagName === "SPAN" && node.textContent === messages[1].text.trim(),
    ),
  );
  assert(screen.getByText(/Excerpt ends here/));
  view.rerender(
    h(
      QueryClientProvider,
      { client: view.client },
      h(ConversationUpdates, { theme, messages, historical: false, stale: true }),
    ),
  );
  assert(
    screen.getByText(
      (_text, node) => node?.tagName === "SPAN" && node.textContent === messages[1].text.trim(),
    ),
  );
  assert(screen.getByText(/Connection lost/));
  assert.equal(screen.queryByText("Review checkout retries."), null);
  fireEvent.click(screen.getByRole("button", { name: "Show instructions" }));
  assert(
    view.container.textContent.indexOf("Agent update") <
      view.container.textContent.indexOf("Instruction"),
  );
});
test("machine acceptance markers and identifiers never substitute for the readable report", () => {
  const source =
    "\n---\nTEAM_DURABLE_ACCEPTED " + A + "\n\nThe guide is practical and phone-friendly.";
  assert.equal(readableUpdate(source), "The guide is practical and phone-friendly.");
  mount(
    h(ConversationUpdates, {
      theme,
      messages: [{ id: "1", role: "agent", text: source, truncated: false }],
      historical: false,
      stale: false,
    }),
  );
  assert(screen.getByText("The guide is practical and phone-friendly."));
  assert(!document.body.textContent.includes(A));
  fireEvent.click(screen.getByRole("button", { name: "Show original text" }));
  assert(document.body.textContent.includes("TEAM_DURABLE_ACCEPTED " + A));
  assert.equal(
    readableUpdate("Failed for " + A + " with " + "f".repeat(64)),
    "Failed for [reference] with [fingerprint]",
  );
});

test("client entry registers its actual surface and return commands and cleans up all contributions", () => {
  const registrations = [],
    removed = [],
    commands = [];
  const cleanup = contribute({
    addSurface: (id, component) => {
      registrations.push([id, component]);
      return () => removed.push(id);
    },
    addSidebarItem: (item) => {
      registrations.push(item);
      return () => removed.push(`sidebar:${item.id}`);
    },
    addCommandCenterItem: (command) => {
      commands.push(command);
      return () => removed.push(command.id);
    },
    openSurface() {},
  });
  assert.equal(registrations[0][1], HomeSurface);
  assert.deepEqual(
    registrations.filter(Array.isArray).map(([id]) => id),
    ["organization", "workspaces", "intake", "leadership", "team"],
  );
  assert.deepEqual(
    registrations
      .filter((entry) => !Array.isArray(entry))
      .map((entry) => [entry.id, entry.surface]),
    [
      ["workspaces", "workspaces"],
      ["organization", "organization"],
    ],
  );
  assert.equal(commands.length, 2);
  cleanup();
  assert.deepEqual(
    removed.sort(),
    [
      "organization",
      "workspaces",
      "intake",
      "leadership",
      "team",
      "sidebar:workspaces",
      "sidebar:organization",
      ...commands.map((command) => command.id),
    ].sort(),
  );
});
function base(name, input, { inactive = false, sessions = [] } = {}) {
  if (name === "organization.fleet-hosts")
    return Promise.resolve(
      fleetHostsRpc.output.parse({
        local: "mini",
        hosts: [
          { name: "mini", serverId: null },
          { name: "macbook", serverId: null },
        ],
      }),
    );
  if (name === "organization.project-briefing")
    return Promise.resolve({
      observedAt: time(),
      partial: false,
      scanned: 0,
      total: 0,
      missing: 0,
      unavailable: 0,
      nextCursor: null,
      entries: [],
    });
  if (name === "organization.projects")
    return Promise.resolve({
      observedAt: time(),
      available: true,
      partial: false,
      projects: [],
      membership: [],
      note: "Synthetic project source",
    });
  if (name === "organization.fleet")
    return Promise.resolve({
      observedAt: time(),
      nodes: [],
      tasks: [],
      edges: [],
      total: 0,
      partial: false,
      note: "No identity fixture",
    });
  if (name === "organization.outcome")
    return Promise.resolve({
      observedAt: time(),
      status: "missing",
      message: "No published decision",
      recordSha256: null,
      record: null,
      artifacts: [],
      reviews: [],
    });
  if (name === "organization.tasks")
    return Promise.resolve({
      tasks: [entry(A, "AIN-73"), entry(B, "AIN-74")],
      available: true,
      partial: false,
      nextCursor: null,
      total: 2,
      note: "Synthetic tasks",
      observedAt: time(),
    });
  if (name === "organization.usage")
    return Promise.resolve({
      available: false,
      providers: [],
      truncated: false,
      observedAt: time(),
    });
  if (name === "organization.snapshot")
    return Promise.resolve({
      observedAt: time(),
      board: {
        identifier: input.taskId === A ? "AIN-73" : "AIN-74",
        title: "Selected task",
        status: inactive ? "blocked" : "in_progress",
        owner: "local-board",
      },
      sessionsAvailable: true,
      sessions: [],
      coverage: "Synthetic source",
      remote: "No live runtime used",
    });
  if (name === "organization.task-manage") {
    if (input.command.action === "list")
      return Promise.resolve(
        observed({
          sessions,
          deliveries: [],
          supervisors: [],
          handoffs: [],
          permissions: [],
          taskAuthority: { allowed: !inactive, error: inactive ? "Task held" : null },
        }),
      );
    return Promise.resolve(observed());
  }
  throw Error(`Unexpected RPC ${name}`);
}
test("DESIGN-NEXT-BUILD A3: the create form sends no role by default, and the chosen role when one is picked", async () => {
  setHandler((name, input) =>
    name === "organization.task-manage" && input.command.action === "create"
      ? Promise.resolve(
          observed({ status: "delivered", message: "Created", messageId: input.command.messageId }),
        )
      : base(name, input),
  );
  mount(h(OrganizationSurface, { theme, layout: { compact: true } }));
  await chooseTask();
  await screen.findByRole("button", { name: "Sessions and instructions" });
  reveal("Sessions and instructions");
  await screen.findByLabelText("New session title");
  fireEvent.change(screen.getByLabelText("New session title"), {
    target: { value: "Default role session" },
  });
  await waitFor(() =>
    assert.equal(screen.getByRole("button", { name: "Create session" }).disabled, false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Create session" }));
  await waitFor(() =>
    assert.equal(calls.filter((c) => c.input.command?.action === "create").length, 1),
  );
  assert.equal(
    Object.hasOwn(calls.find((c) => c.input.command?.action === "create").input.command, "role"),
    false,
  );
  fireEvent.click(screen.getByRole("radio", { name: /Implementation/ }));
  fireEvent.change(screen.getByLabelText("New session title"), {
    target: { value: "Worker session" },
  });
  await waitFor(() =>
    assert.equal(screen.getByRole("button", { name: "Create session" }).disabled, false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Create session" }));
  await waitFor(() =>
    assert.equal(calls.filter((c) => c.input.command?.action === "create").length, 2),
  );
  const second = calls.filter((c) => c.input.command?.action === "create")[1].input.command;
  assert.equal(second.role, "implementation");
});
test("switching A to B during create keeps both request identities and late acknowledgement scoped to A", async () => {
  let resolveA;
  const pendingA = new Promise((resolve) => {
    resolveA = resolve;
  });
  setHandler((name, input) => {
    if (name === "organization.task-manage" && input.command.action === "create")
      return input.taskId === A
        ? pendingA
        : Promise.resolve(
            observed({
              status: "delivered",
              message: "B completed",
              messageId: input.command.messageId,
            }),
          );
    return base(name, input);
  });
  const { client } = mount(h(OrganizationSurface, { theme, layout: { compact: true } }));
  await chooseTask();
  await screen.findByRole("button", { name: "Sessions and instructions" });
  reveal("Sessions and instructions");
  await screen.findByLabelText("New session title");
  fireEvent.change(screen.getByLabelText("New session title"), {
    target: { value: "Identical title" },
  });
  await waitFor(() =>
    assert.equal(screen.getByRole("button", { name: "Create session" }).disabled, false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Create session" }));
  await waitFor(() =>
    assert.equal(calls.filter((c) => c.input.command?.action === "create").length, 1),
  );
  const requestA = calls.find((c) => c.input.command?.action === "create").input;
  fireEvent.click(screen.getByRole("radio", { name: "Select AIN-74: Task AIN-74" }));
  await waitFor(() => assert.equal(screen.getByLabelText("New session title").value, ""));
  reveal("Sessions and instructions");
  fireEvent.change(screen.getByLabelText("New session title"), {
    target: { value: "Identical title" },
  });
  await waitFor(() =>
    assert.equal(screen.getByRole("button", { name: "Create session" }).disabled, false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Create session" }));
  await screen.findByText(/B completed/);
  const requestB = calls.filter((c) => c.input.command?.action === "create")[1].input;
  assert.equal(requestA.taskId, A);
  assert.equal(requestB.taskId, B);
  assert.notEqual(requestA.command.messageId, requestB.command.messageId);
  fireEvent.change(screen.getByLabelText("New session title"), {
    target: { value: "Keep B draft" },
  });
  await act(async () =>
    resolveA(
      observed({
        status: "delivered",
        message: "A late result",
        messageId: requestA.command.messageId,
      }),
    ),
  );
  await waitFor(() =>
    assert(
      calls.some(
        (c) =>
          c.input.taskId === A &&
          c.input.command?.action === "acknowledge" &&
          c.input.command.messageId === requestA.command.messageId,
      ),
    ),
  );
  assert.equal(screen.getByLabelText("New session title").value, "Keep B draft");
  assert.equal(screen.queryByText(/A late result/), null);
  assert(screen.getByText(/B completed/));
  assert.equal(client.getQueryData(["orca-management", B]).taskAuthority.allowed, true);
  const acknowledgements = calls
    .filter((c) => c.input.command?.action === "acknowledge")
    .map((c) => [c.input.taskId, c.input.command.messageId]);
  assert.deepEqual(
    acknowledgements.sort(),
    [
      [A, requestA.command.messageId],
      [B, requestB.command.messageId],
    ].sort(),
  );
});
test("inactive selected task disables new authority while takeover, revoke and prepared history remain usable", async () => {
  setHandler((name, input) => {
    if (name === "organization.task-manage" && input.command.action === "list")
      return Promise.resolve(
        observed({
          sessions: [{ id: S, task: A, mode: "delegated", generation: 3 }],
          supervisors: [],
          deliveries: [{ id: B, session: null, kind: "create", state: "prepared" }],
          taskAuthority: { allowed: false, error: "Task held" },
        }),
      );
    return base(name, input, { inactive: true });
  });
  mount(h(OrganizationSurface, { theme, layout: { compact: false } }));
  await chooseTask();
  await screen.findByRole("button", { name: "Sessions and instructions" });
  reveal("Sessions and instructions");
  await screen.findByText(/New work is disabled/);
  fireEvent.change(screen.getByLabelText("New session title"), {
    target: { value: "Disallowed creation" },
  });
  assert.equal(screen.getByRole("button", { name: "Create session" }).disabled, true);
  fireEvent.click(screen.getByRole("button", { name: `Manage ${S}` }));
  fireEvent.change(screen.getByLabelText("Control transfer context"), {
    target: { value: "Human explicitly revokes authority" },
  });
  fireEvent.change(screen.getByLabelText("Task instruction"), {
    target: { value: "No instruction may be sent" },
  });
  assert.equal(screen.getByRole("button", { name: "Send instruction" }).disabled, true);
  assert.equal(screen.getByRole("button", { name: "Allow routine file approvals" }).disabled, true);
  assert.equal(screen.queryByRole("button", { name: `Reconcile ${B}` }), null);
  assert.equal(screen.queryByRole("button", { name: `Abandon ${B}` }), null);
  assert(screen.getByText(/Creation was prepared, but no admitted delivery/));
  fireEvent.click(screen.getByRole("button", { name: "Take control" }));
  await waitFor(() =>
    assert(calls.some((c) => c.input.command?.action === "takeover" && c.input.taskId === A)),
  );
  fireEvent.click(screen.getByRole("button", { name: "Revoke routine file approvals" }));
  await waitFor(() =>
    assert(calls.some((c) => c.input.command?.action === "revoke-routine" && c.input.taskId === A)),
  );
  assert(
    !calls.some((c) => ["create", "assign", "allow-routine"].includes(c.input.command?.action)),
  );
});
test("inactive human-owned sessions cannot be delegated even with a complete reason", async () => {
  setHandler((name, input) =>
    base(name, input, {
      inactive: true,
      sessions: [{ id: S, task: A, mode: "human", generation: 3 }],
    }),
  );
  mount(h(OrganizationSurface, { theme, layout: { compact: true } }));
  await chooseTask();
  await screen.findByRole("button", { name: "Sessions and instructions" });
  reveal("Sessions and instructions");
  fireEvent.click(await screen.findByRole("button", { name: `Manage ${S}` }));
  fireEvent.change(screen.getByLabelText("Control transfer context"), {
    target: { value: "Complete but unauthorized delegation reason" },
  });
  assert.equal(screen.getByRole("button", { name: "Delegate session" }).disabled, true);
  assert.equal(screen.getByRole("button", { name: "Delegate as supervisor" }).disabled, true);
  assert.equal(screen.getByRole("button", { name: "Take control" }).disabled, false);
});
test("failed management and usage reads become visible and do not retry automatically", async () => {
  setHandler((name, input) =>
    name === "organization.usage" ||
    (name === "organization.task-manage" && input.command.action === "list")
      ? Promise.reject(Error("Offline"))
      : base(name, input),
  );
  mount(h(OrganizationSurface, { theme, layout: { compact: true } }));
  await chooseTask();
  await screen.findByRole("button", { name: "Sessions and instructions" });
  reveal("Sessions and instructions");
  await screen.findByText("Usage unavailable. Missing figures do not mean zero usage.");
  await screen.findByText(/Management unavailable or stale/);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 1200)));
  assert.equal(calls.filter((c) => c.name === "organization.usage").length, 1);
  assert.equal(calls.filter((c) => c.input.command?.action === "list").length, 1);
  assert.equal(screen.getByRole("button", { name: "Create session" }).disabled, true);
});
test("freshness and connection failures disable new work even when retained rows remain available", async (t) => {
  const clock = Date.now();
  t.mock.method(Date, "now", () => clock);
  let failList = false;
  setHandler((name, input) =>
    failList && name === "organization.task-manage" && input.command.action === "list"
      ? Promise.reject(Error("List refresh failed"))
      : base(name, input),
  );
  const { client } = mount(h(OrganizationSurface, { theme, layout: { compact: true } }));
  await chooseTask();
  await screen.findByRole("button", { name: "Sessions and instructions" });
  reveal("Sessions and instructions");
  fireEvent.change(await screen.findByLabelText("New session title"), {
    target: { value: "Needs fresh authority" },
  });
  const create = () => screen.getByRole("button", { name: "Create session" });
  await waitFor(() => assert.equal(create().disabled, false));
  const key = ["orca-management", A],
    freshList = client.getQueryData(key),
    health = client.getQueryData(["orca-management-health"]);
  await act(async () =>
    client.setQueryData(key, { ...freshList, observedAt: new Date(clock - 60000).toISOString() }),
  );
  await waitFor(() => assert.equal(create().disabled, true));
  await act(async () => {
    client.setQueryData(key, freshList);
    client.setQueryData(["orca-management-health"], health, { updatedAt: clock - 8000 });
  });
  await waitFor(() => assert.equal(create().disabled, true));
  await act(async () =>
    client.setQueryData(["orca-management-health"], { ...health, status: "error" }),
  );
  await waitFor(() => assert.equal(create().disabled, true));
  await act(async () =>
    client.setQueryData(["orca-management-health"], health, { updatedAt: clock }),
  );
  await waitFor(() => assert.equal(create().disabled, false));
  failList = true;
  await act(async () => client.refetchQueries({ queryKey: key, exact: true }));
  await waitFor(() => assert.equal(create().disabled, true));
  assert.deepEqual(client.getQueryData(key), freshList);
});
test("loading, unavailable and empty-session messages follow observed state without false green or false empty claims", async () => {
  let resolveTasks, resolveUsage;
  setHandler((name, input) =>
    name === "organization.tasks"
      ? new Promise((resolve) => {
          resolveTasks = resolve;
        })
      : name === "organization.usage"
        ? new Promise((resolve) => {
            resolveUsage = resolve;
          })
        : base(name, input),
  );
  const { client } = mount(h(OrganizationSurface, { theme, layout: { compact: true } }));
  assert(screen.getByText("Reading current and retained tasks…"));
  assert(screen.getByText("Reading provider reports…"));
  assert.equal(screen.queryByText(/Task list unavailable/), null);
  await act(async () => {
    resolveTasks(await base("organization.tasks", {}));
    resolveUsage({ available: true, providers: [], truncated: false, observedAt: time() });
  });
  assert(screen.getByText("Choose a task below to see its sessions."));
  await chooseTask();
  await screen.findByText(/No saved sessions are enrolled/);
  assert.equal(screen.queryByText("Reading current and retained tasks…"), null);
  assert.equal(screen.queryByText(/Usage unavailable/), null);
  const key = ["orca-organization", "", A],
    original = client.getQueryData(key);
  await act(async () => client.setQueryData(key, { ...original, sessionsAvailable: false }));
  await waitFor(() => assert.equal(screen.queryByText(/No saved sessions are enrolled/), null));
  setHandler((name, input) =>
    name === "organization.tasks" ? Promise.reject(Error("Board unavailable")) : base(name, input),
  );
  await act(async () => client.refetchQueries({ queryKey: ["orca-tasks"], exact: false }));
  await screen.findByText("Task list unavailable. Retained choices below may be stale.");
});
test("task paging and manual retained-task selection do not create or delegate sessions", async () => {
  const selected = [];
  let resolveCheck;
  setHandler((name, input) => {
    if (name === "organization.tasks")
      return Promise.resolve({
        tasks: [entry(input.cursor ? B : A, input.cursor ? "AIN-74" : "AIN-73")],
        available: false,
        partial: true,
        nextCursor: input.cursor ? null : 32,
        total: 33,
        note: "Board unavailable; retained tasks",
        observedAt: time(),
      });
    if (name === "organization.task-manage")
      return new Promise((resolve) => {
        resolveCheck = resolve;
      });
    throw Error("Unexpected call");
  });
  mount(h(TaskControls, { theme, selected: A, onSelect: (id) => selected.push(id) }));
  fireEvent.click(await screen.findByRole("button", { name: "More tasks" }));
  await screen.findByRole("radio", { name: "Select AIN-74: Task AIN-74" });
  fireEvent.click(screen.getByRole("button", { name: "Previous tasks" }));
  await screen.findByRole("radio", { name: "Select AIN-73: Task AIN-73" });
  fireEvent.change(screen.getByLabelText("Task UUID"), { target: { value: "bad id" } });
  assert.equal(screen.getByRole("button", { name: "Open task by ID" }).disabled, true);
  fireEvent.change(screen.getByLabelText("Task UUID"), { target: { value: B.toUpperCase() } });
  fireEvent.click(screen.getByRole("button", { name: "Open task by ID" }));
  assert.equal(screen.getByRole("radio", { name: "Select AIN-73: Task AIN-73" }).disabled, true);
  await act(async () =>
    resolveCheck(
      observed({ taskAuthority: { allowed: false, error: "Held" }, sessions: [{ id: S }] }),
    ),
  );
  assert.deepEqual(selected, [B]);
  assert.deepEqual(
    calls.filter((c) => c.name === "organization.task-manage").map((c) => c.input),
    [{ taskId: B, command: { action: "list" } }],
  );
});
test("manual lookup failures remain visible and provider missing figures are never rendered as zero", async () => {
  let lookup = 0;
  setHandler((name, input) => {
    if (name === "organization.task-manage") {
      if (lookup++) return Promise.reject(Error("Disconnected"));
      return Promise.resolve(observed({ taskAuthority: { allowed: false, error: "Held" } }));
    }
    if (name === "organization.usage")
      return Promise.resolve({
        available: true,
        observedAt: time(),
        truncated: true,
        providers: [
          {
            id: "claude",
            name: "Claude",
            status: "available",
            source: null,
            fetchedAt: null,
            windows: [{ label: "Unknown window", remaining: null, used: null, resetsAt: null }],
            balances: [{ label: "Credits", remaining: null, unit: "USD" }],
            error: null,
          },
          {
            id: "codex",
            name: "Codex",
            status: "available",
            source: "Native report",
            fetchedAt: "2026-09-13T00:00:00Z",
            windows: [
              { label: "Session", remaining: 90, used: 10, resetsAt: "2026-09-19T00:00:00Z" },
            ],
            balances: [{ label: "Credits", remaining: 0, unit: "USD" }],
            error: null,
          },
          {
            id: "other",
            name: "Other",
            status: "error",
            source: null,
            fetchedAt: null,
            windows: [],
            balances: [],
            error: "Provider unavailable",
          },
        ],
      });
    return base(name, input);
  });
  mount(
    h(
      React.Fragment,
      null,
      h(TaskControls, { theme, selected: A, onSelect: () => assert.fail("Invalid task selected") }),
      h(UsagePanel, { theme }),
    ),
  );
  fireEvent.change(screen.getByLabelText("Task UUID"), { target: { value: B } });
  fireEvent.click(screen.getByRole("button", { name: "Open task by ID" }));
  await screen.findByText(/not currently authorized/);
  assert(screen.getByText(/Synthetic tasks.*Observed/));
  fireEvent.click(screen.getByRole("button", { name: "Open task by ID" }));
  await screen.findByText(/Task could not be checked/);
  assert(screen.getByText("Unknown window: Remaining usage unavailable"));
  assert(screen.getByText("Credits: Unavailable"));
  mapControls();
  assert(screen.getByText(/90% remaining · 10% used/));
  assert(screen.getByText("Credits: 0 USD remaining"));
  assert(screen.getByText("No usage window or balance reported."));
  assert(screen.getByText(/Report shortened/));
});
process.on("exit", () => {
  if (process.env.ORCA_UI_COVERAGE && globalThis.__coverage__)
    fs.writeFileSync(process.env.ORCA_UI_COVERAGE, JSON.stringify(globalThis.__coverage__));
});
function outcomeFixture() {
  return {
    observedAt: time(),
    status: "available",
    message: "Published decision",
    recordSha256: "a".repeat(64),
    record: {
      title: "Fictional decision",
      outcome: "Usable output",
      currentState: "Conditional recommendation",
      alternatives: [
        {
          id: "a",
          title: "Local pilot",
          change: "Route locally",
          benefits: "Six hours saved",
          risks: "Baseline uncertainty",
          dependencies: ["Verified baseline"],
          example: "One request routes to a person",
        },
      ],
      decision: {
        alternativeId: "a",
        by: "Recorded author",
        at: time(),
        rationale: "Conditional pilot only",
        authority: "No actual rollout authorized",
      },
      artifacts: [
        {
          id: "brief",
          title: "Decision brief",
          kind: "output",
          file: "brief.md",
          sha256: "b".repeat(64),
          producerSessionId: S,
        },
      ],
      reviews: [{ by: "Reviewer", verdict: "accepted", scope: "Fictional calculation" }],
    },
    artifacts: [{ id: "brief", state: "matches" }],
    reviews: [{ current: true, reason: "Declared review, not an ADW approval" }],
  };
}
test("decision view exposes alternatives, scoped authority and exact saved output with producer navigation", async () => {
  const d = outcomeFixture(),
    opened = [];
  setHandler((name, input) =>
    name === "organization.outcome"
      ? Promise.resolve(d)
      : name === "organization.outcome-artifact"
        ? Promise.resolve({
            observedAt: time(),
            status: "available",
            message: "Exact published text",
            text: "Exact fictional brief bytes",
            sha256: "b".repeat(64),
          })
        : base(name, input),
  );
  mount(
    h(OutcomePanel, { taskId: A, theme, navigation: { openAgent: (value) => opened.push(value) } }),
  );
  await screen.findByText("Fictional decision");
  fireEvent.click(screen.getByRole("radio", { name: "Product perspective" }));
  assert.equal(
    screen.getByRole("radio", { name: "Product perspective" }).getAttribute("aria-checked"),
    "true",
  );
  fireEvent.click(screen.getByRole("button", { name: "Inspect alternative Local pilot" }));
  assert(screen.getByText("Risks and uncertainty: Baseline uncertainty"));
  assert(screen.getByText("Authority: No actual rollout authorized"));
  fireEvent.click(screen.getByRole("button", { name: "Read Decision brief" }));
  await screen.findByText("Exact fictional brief bytes");
  const request = calls.find((c) => c.name === "organization.outcome-artifact");
  assert.deepEqual(request.input, { taskId: A, artifactId: "brief", recordSha256: d.recordSha256 });
  fireEvent.click(screen.getByRole("button", { name: "Open producer of Decision brief" }));
  assert.deepEqual(opened, [{ agentId: S }]);
  fireEvent.click(screen.getByRole("button", { name: "Close saved file" }));
  assert.equal(screen.queryByText("Exact fictional brief bytes"), null);
});
test("changed evidence hides an already opened artifact and disables new reads", async () => {
  const d = outcomeFixture();
  setHandler((name) =>
    Promise.resolve(
      name === "organization.outcome"
        ? d
        : {
            observedAt: time(),
            status: "available",
            message: "Exact bytes",
            text: "Content that was current",
            sha256: "b".repeat(64),
          },
    ),
  );
  const { client } = mount(h(OutcomePanel, { taskId: A, theme }));
  fireEvent.click(await screen.findByRole("button", { name: "Read Decision brief" }));
  await screen.findByText("Content that was current");
  await act(async () =>
    client.setQueryData(["orca-outcome", A], {
      ...d,
      artifacts: [{ id: "brief", state: "changed" }],
    }),
  );
  await waitFor(() => assert.equal(screen.queryByText("Content that was current") === null, true));
  assert.equal(screen.getByRole("button", { name: "Read Decision brief" }).disabled, true);
  assert(screen.getByText("Saved content unavailable or stale. Refresh evidence."));
});
test("stale observations cannot expose artifact content or claim evidence is current", async () => {
  const d = outcomeFixture();
  d.observedAt = "2000-01-01T00:00:00Z";
  setHandler(() => Promise.resolve(d));
  mount(h(OutcomePanel, { taskId: A, theme }));
  await screen.findByText("Fictional decision");
  assert.equal(screen.getByRole("button", { name: "Read Decision brief" }).disabled, true);
  assert(screen.getByText(/STALE/));
  assert.equal(calls.filter((c) => c.name === "organization.outcome-artifact").length, 0);
});
test("failed decision refresh marks retained evidence stale and hides saved text", async () => {
  const d = outcomeFixture();
  let offline = false;
  setHandler((name) =>
    offline
      ? Promise.reject(Error("Disconnected"))
      : Promise.resolve(
          name === "organization.outcome"
            ? d
            : {
                observedAt: time(),
                status: "available",
                message: "Exact bytes",
                text: "Previously observed file",
              },
        ),
  );
  mount(h(OutcomePanel, { taskId: A, theme }));
  fireEvent.click(await screen.findByRole("button", { name: "Read Decision brief" }));
  await screen.findByText("Previously observed file");
  offline = true;
  fireEvent.click(screen.getByRole("button", { name: "Refresh decision evidence" }));
  await screen.findByText("Decision evidence unavailable. Retained information is stale.");
  assert.equal(screen.queryByText("Previously observed file") === null, true);
  assert.equal(screen.queryByText("Referenced evidence matches") === null, true);
  assert.equal(screen.getByRole("button", { name: "Read Decision brief" }).disabled, true);
});

function setFleetHandler(fn) {
  setHandler(async (name, input) => {
    // The configured host directory is a separate RPC, not an activity-history reply.
    const result = await (["organization.outcome", "organization.fleet-hosts"].includes(name)
      ? base(name, input)
      : fn(name, input));
    if (name !== "organization.fleet") return result;
    return {
      ...result,
      nodes: result.nodes.filter(
        (n) => !input.host || input.host === "all" || n.host === input.host,
      ),
    };
  });
}

test("fleet defaults to both hosts, filters Book and opens receipt evidence without a control mutation", async () => {
  const nodes = [
    {
      id: S,
      task: A,
      host: "mini",
      agentId: S,
      title: "Mini author",
      provider: "codex",
      mode: "human",
      status: "idle",
      pending: 0,
      observedAt: time(),
      updatedAt: time(),
    },
    {
      id: B,
      task: A,
      host: "macbook",
      agentId: B,
      title: "Book author",
      provider: "codex",
      mode: "human",
      status: "unavailable",
      pending: null,
      error: "Book offline",
    },
  ];
  setFleetHandler((name, input) => {
    if (name === "organization.fleet")
      return Promise.resolve({
        observedAt: time(),
        total: 2,
        partial: true,
        note: "Partial observation",
        nodes,
        tasks: [{ id: A, title: "Real task", identifier: "AIN-103" }],
        edges: [],
      });
    if (name === "organization.activity-history")
      return Promise.resolve({
        observedAt: time(),
        cursor: null,
        note: "Book tool timeline not transported",
        receipts: [{ id: S, kind: "send", state: "delivered", notification: "consumed" }],
        activity: [],
      });
    return base(name, input);
  });
  mount(h(HomeSurface, { theme, layout: { compact: true, platform: "web" } }));
  fireEvent.click(await screen.findByTestId("organization-tab-organisation"));
  fireEvent.click(await screen.findByRole("button", { name: "Workstreams", exact: true }));
  await screen.findByText("Your orchestrators");
  fireEvent.click(await screen.findByRole("button", { name: "More views" }));
  fireEvent.click(await screen.findByTestId("organization-tab-sessions"));
  await screen.findByText(/Your work, at a glance/);
  await screen.findByRole("button", { name: "Inspect Mini author" });
  fireEvent.click(screen.getByRole("button", { name: "Macbook", exact: true }));
  assert.equal(screen.queryByRole("button", { name: "Inspect Mini author" }), null);
  fireEvent.click(await screen.findByRole("button", { name: "Inspect Book author" }));
  evidence();
  await screen.findByText(/send → delivered → consumed/);
  assert.equal(screen.queryByRole("button", { name: "Open original conversation" }), null);
  fireEvent.click(screen.getByRole("button", { name: "Freeze view" }));
  assert(screen.getByRole("button", { name: "Resume updates" }));
  assert(
    calls.every((c) =>
      [
        "organization.recovery",
        // Home counts deploy plans a session prepared under Needs you.
        "organization.deploy-overview",
        "organization.inbox",
        "organization.integrations",
        "organization.fleet",
        "organization.fleet-hosts",
        "organization.activity-history",
        "organization.outcome",
        "organization.projects",
        "organization.project-briefing",
        "organization.role-directory",
        "organization.work-map",
        "organization.work-map-project",
        "organization.remits",
      ].includes(c.name),
    ),
  );
});

test("history controls retain failed pages visibly stale, restore latest and reset on session change", async () => {
  const nodes = [
      {
        id: S,
        task: A,
        host: "mini",
        agentId: S,
        title: "First session",
        provider: "codex",
        mode: "human",
        status: "idle",
        pending: 0,
      },
      {
        id: B,
        task: A,
        host: "macbook",
        agentId: B,
        title: "Second session",
        provider: "codex",
        mode: "human",
        status: "idle",
        pending: 0,
      },
    ],
    cursor = { scope: "a".repeat(64), epoch: "epoch", seq: 51 };
  let fail = true,
    olderRequests = 0;
  setFleetHandler((name, input) => {
    if (name === "organization.fleet")
      return Promise.resolve({
        observedAt: time(),
        total: 2,
        partial: false,
        note: "Synthetic fleet",
        nodes,
        tasks: [{ id: A, title: "Task", identifier: "AIN103" }],
        edges: [],
      });
    assert.equal(name, "organization.activity-history");
    if (input.cursor) {
      olderRequests++;
      if (fail) return Promise.reject(Error("Cursor gap"));
    }
    return Promise.resolve({
      observedAt: time(),
      sessionId: input.sessionId,
      taskId: A,
      note: input.cursor ? "Earlier page" : "Latest page",
      receipts: [],
      cursor: input.cursor ? null : cursor,
      activity: [
        {
          id: "1",
          kind: "tool_call",
          label: input.cursor
            ? "Older tool"
            : input.sessionId === S
              ? "Newest tool"
              : "Second tool",
          state: "completed",
          files: [],
        },
      ],
    });
  });
  mount(h(FleetSurface, { theme, layout: { compact: true }, onTask: () => {} }));
  fireEvent.click(await screen.findByRole("button", { name: "Inspect First session" }));
  evidence();
  await screen.findByText("Newest tool · completed");
  fireEvent.click(screen.getByRole("button", { name: "Load older activity" }));
  await screen.findByText("Activity unavailable. Retained details below are stale.");
  assert(screen.getByText("Newest tool · completed"));
  assert.equal(screen.getByRole("button", { name: "Load older activity" }).disabled, true);
  assert.equal(olderRequests, 1);
  assert.equal(screen.queryByText(/Historical page/), null);
  assert(screen.getByText("Return to latest to restart activity history."));
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Return to latest activity" }));
  await waitFor(() =>
    assert.equal(
      screen.queryByText("Activity unavailable. Retained details below are stale."),
      null,
    ),
  );
  await waitFor(() =>
    assert.equal(screen.getByRole("button", { name: "Load older activity" }).disabled, false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Load older activity" }));
  await screen.findByText("Older tool · completed");
  assert(screen.getByText(/Historical page/));
  assert.equal(screen.getByRole("button", { name: "Load older activity" }).disabled, true);
  fireEvent.click(screen.getByRole("button", { name: "Return to latest activity" }));
  await screen.findByText("Newest tool · completed");
  await waitFor(() =>
    assert.equal(screen.getByRole("button", { name: "Load older activity" }).disabled, false),
  );
  fail = true;
  fireEvent.click(screen.getByRole("button", { name: "Load older activity" }));
  await screen.findByText("Activity unavailable. Retained details below are stale.");
  assert(screen.getByText("Newest tool · completed"));
  assert.equal(screen.queryByText("Older tool · completed"), null);
  fireEvent.click(screen.getByRole("button", { name: "Inspect Second session" }));
  evidence();
  await screen.findByText("Second tool · completed");
  assert.equal(screen.queryByText("Older tool · completed"), null);
  assert.equal(
    calls
      .filter((c) => c.name === "organization.activity-history" && c.input.sessionId === B)
      .at(-1).input.cursor,
    null,
  );
});

test("opening an offline Book history retains delivered receipts without claiming complete coverage", async () => {
  setFleetHandler((name) =>
    name === "organization.fleet"
      ? Promise.resolve({
          observedAt: time(),
          total: 1,
          partial: false,
          note: "Fixture",
          nodes: [
            {
              id: S,
              task: A,
              host: "macbook",
              agentId: S,
              title: "Offline Book",
              provider: "codex",
              mode: "human",
              status: "unknown",
              pending: null,
            },
          ],
          tasks: [{ id: A, title: "Task" }],
          edges: [],
        })
      : Promise.resolve({
          observedAt: time(),
          sessionId: S,
          taskId: A,
          cursor: null,
          activity: [],
          receipts: [
            {
              id: B,
              kind: "send",
              state: "delivered",
              notification: "consumed",
              evidenceHash: null,
            },
          ],
          note: "Native tool activity unavailable, stale or unsupported; receipts retained. No current activity is inferred. No summarizable activity in this window; coverage unverified.",
        }),
  );
  mount(h(FleetSurface, { theme, layout: { compact: true }, onTask: () => {} }));
  fireEvent.click(await screen.findByRole("button", { name: "Inspect Offline Book" }));
  evidence();
  await screen.findByText("send → delivered → consumed");
  assert(screen.getByText(/No current activity is inferred/));
  assert.equal(screen.getByRole("button", { name: "Load older activity" }).disabled, true);
});

test("scrollable graph reuses history reset, keeps evidence reachable and supports bounded pan/zoom without control RPCs", async () => {
  const nodes = [
      {
        id: S,
        task: A,
        host: "mini",
        agentId: S,
        title: "Graph first",
        provider: "codex",
        mode: "human",
        status: "idle",
        pending: 0,
      },
      {
        id: B,
        task: A,
        host: "macbook",
        agentId: B,
        title: "Graph second",
        provider: "codex",
        mode: "human",
        status: "idle",
        pending: 0,
      },
    ],
    cursor = { scope: "a".repeat(64), epoch: "epoch", seq: 51 };
  let fail = false;
  setFleetHandler((name, input) => {
    if (name === "organization.fleet")
      return Promise.resolve({
        observedAt: time(),
        total: 2,
        partial: false,
        note: "Fixture",
        nodes,
        tasks: [{ id: A, title: "Graph task", identifier: "AIN114" }],
        edges: [],
      });
    assert.equal(name, "organization.activity-history");
    if (fail && input.cursor) return Promise.reject(Error("Offline"));
    return Promise.resolve({
      sessionId: input.sessionId,
      taskId: A,
      observedAt: time(),
      cursor: input.cursor ? null : cursor,
      note: "Coverage unverified",
      receipts: [],
      activity: [
        {
          id: input.cursor ? "older" : "latest",
          kind: "tool_call",
          label: input.cursor
            ? "Earlier graph tool"
            : input.sessionId === S
              ? "Latest first tool"
              : "Latest second tool",
          state: "completed",
          files: ["src/report.ts"],
        },
      ],
    });
  });
  mount(h(FleetSurface, { theme, layout: { compact: true }, onTask: () => {} }));
  fireEvent.click(await screen.findByRole("button", { name: "Inspect Graph first" }));
  evidence();
  await screen.findByText("Latest first tool · completed");
  fireEvent.click(screen.getByRole("button", { name: "Open work graph" }));
  evidence();
  await screen.findByText("Latest first tool · completed");
  const viewport = screen.getByTestId("work-graph-viewport");
  assert(viewport.closest('[data-native-kind="ScrollView"]'));
  mapControls();
  fireEvent.click(screen.getByRole("button", { name: "Reset graph" }));
  assert(
    screen.getByText("Latest first tool · completed").closest('[data-native-kind="ScrollView"]'),
  );
  const responder = panResponders.at(-1);
  assert.equal(responder.onMoveShouldSetPanResponder(null, { dx: 1, dy: 1 }), false);
  assert.equal(responder.onMoveShouldSetPanResponder(null, { dx: -100, dy: 0 }), true);
  await act(async () => {
    responder.onPanResponderGrant();
    responder.onPanResponderMove(null, { dx: -100, dy: 0 });
  });
  assert(screen.getByText(/100, 0$/));
  (mapControls(), fireEvent.click(screen.getByRole("button", { name: "Zoom in" })));
  mapControls();
  assert(screen.getByText(/125%/));
  (mapControls(), fireEvent.click(screen.getByRole("button", { name: "Reset graph" })));
  mapControls();
  assert(screen.getByText(/100%.*0, 0$/));
  await waitFor(() =>
    assert(!screen.getByRole("button", { name: "Load older activity" }).disabled),
  );
  fireEvent.click(screen.getByRole("button", { name: "Load older activity" }));
  evidence();
  await screen.findByText("Earlier graph tool · completed");
  assert(screen.getAllByText(/Historical page/).length > 0);
  (mapControls(), fireEvent.click(screen.getByRole("button", { name: "Pan right" })));
  fireEvent.click(screen.getByRole("button", { name: "Inspect Graph second" }));
  evidence();
  await screen.findByText("Latest second tool · completed");
  assert.equal(screen.queryByText("Earlier graph tool · completed"), null);
  (mapControls(), fireEvent.click(screen.getByRole("button", { name: "Pan right" })));
  fireEvent.click(screen.getByRole("button", { name: "Inspect Graph first" }));
  evidence();
  await screen.findByText("Latest first tool · completed");
  assert.equal(screen.queryByText("Earlier graph tool · completed"), null);
  assert.equal(
    calls
      .filter((c) => c.name === "organization.activity-history" && c.input.sessionId === S)
      .at(-1).input.cursor,
    null,
  );
  fail = true;
  await waitFor(() =>
    assert(!screen.getByRole("button", { name: "Load older activity" }).disabled),
  );
  fireEvent.click(screen.getByRole("button", { name: "Load older activity" }));
  evidence();
  await screen.findByText("Activity unavailable. Retained details below are stale.");
  assert(screen.getByText(/STALE · retained observations/));
  assert(screen.getByText("Latest first tool · completed"));
  fireEvent.click(screen.getByRole("button", { name: "Back to work list" }));
  evidence();
  await screen.findByText("Your work, at a glance");
  assert.equal(screen.queryByTestId("work-graph-viewport"), null);
  assert(
    calls.every((c) =>
      [
        "organization.fleet",
        "organization.fleet-hosts",
        "organization.activity-history",
        "organization.outcome",
        "organization.projects",
        "organization.project-briefing",
        "organization.role-directory",
        "organization.work-map",
        "organization.work-map-project",
      ].includes(c.name),
    ),
  );
});

test("graph display preserves visible topology, typed styles, inspection-only file actions and zoom limits", async () => {
  const nodes = [
      {
        id: S,
        task: A,
        title: "First worker",
        host: "mini",
        provider: "codex",
        mode: "human",
        status: "idle",
      },
      {
        id: B,
        task: A,
        title: "Second worker",
        host: "macbook",
        provider: "claude",
        mode: "human",
        status: "idle",
      },
      {
        id: A,
        task: A,
        title: "Third worker",
        host: "mini",
        provider: "codex",
        mode: "human",
        status: "idle",
      },
    ],
    fleet = {
      nodes,
      tasks: [{ id: A, title: "<img src=x onerror=alert(1)>", identifier: "TASK" }],
      edges: [
        { from: S, to: B, active: true },
        { from: S, to: A, active: false },
      ],
    },
    page = {
      historical: false,
      stale: false,
      loading: false,
      data: {
        sessionId: S,
        taskId: A,
        activity: [
          { id: "1", label: "Read API", kind: "tool_call", state: "completed", files: ["api.ts"] },
          {
            id: "2",
            label: "Read Docs",
            kind: "tool_call",
            state: "completed",
            files: ["docs.md"],
          },
        ],
      },
    };
  const selected = [],
    tasks = [],
    props = {
      fleet,
      shown: nodes,
      selected: S,
      page,
      stale: false,
      frozen: false,
      theme,
      onSelect: (id) => selected.push(id),
      onTask: (id) => tasks.push(id),
    };
  const mounted = mount(h(WorkGraph, props)),
    vp = () => screen.getByTestId("work-graph-viewport"),
    measure = async (width, height) =>
      act(async () =>
        layoutHandlers.get("work-graph-viewport")({ nativeEvent: { layout: { width, height } } }),
      ),
    styles = () =>
      [...vp().querySelectorAll("[data-native-style]")].map((e) =>
        JSON.parse(e.dataset.nativeStyle),
      );
  assert.equal(vp().querySelectorAll('[role="button"]').length, 1);
  assert.equal(vp().querySelectorAll('[data-native-accessible="false"]').length, 3);
  assert.equal(screen.queryByText("No enrolled sessions match these filters."), null);
  await measure(1400, 1000);
  assert.equal(vp().querySelectorAll('[role="button"]').length, 8);
  assert.equal(vp().querySelectorAll("img").length, 0);
  assert.equal(vp().querySelectorAll('[data-native-accessible="false"]').length, 13);
  assert.equal([...vp().querySelectorAll("span")].filter((e) => e.textContent === "›").length, 9);
  assert(styles().some((s) => s.borderTopWidth === 3 && s.borderColor === theme.colors.foreground));
  assert(styles().some((s) => s.borderStyle === "dashed" && s.borderTopWidth === 1));
  fireEvent.click(screen.getByRole("button", { name: "file api.ts" }));
  assert.equal(tasks.length + selected.length, 0);
  assert.equal(
    screen.getByRole("button", { name: "file api.ts" }).getAttribute("aria-selected"),
    "true",
  );
  assert.equal(
    screen.getByRole("button", { name: "Inspect First worker" }).getAttribute("aria-selected"),
    "true",
  );
  assert.equal(
    JSON.parse(screen.getByRole("button", { name: "Inspect First worker" }).dataset.nativeStyle)
      .borderWidth,
    2,
  );
  assert.equal(
    JSON.parse(screen.getByRole("button", { name: "Inspect Second worker" }).dataset.nativeStyle)
      .borderWidth,
    1,
  );
  fireEvent.click(screen.getByRole("button", { name: "event Read API" }));
  assert.equal(tasks.length + selected.length, 0);
  fireEvent.click(screen.getByRole("button", { name: "Inspect Second worker" }));
  evidence();
  assert.deepEqual(selected, [B]);
  fireEvent.click(screen.getByRole("button", { name: /^task TASK/ }));
  assert.deepEqual(tasks, [A]);
  for (let i = 0; i < 10; i++)
    (mapControls(), fireEvent.click(screen.getByRole("button", { name: "Zoom out" })));
  mapControls();
  assert(screen.getByText(/ · 50% ·/));
  for (let i = 0; i < 10; i++)
    (mapControls(), fireEvent.click(screen.getByRole("button", { name: "Zoom in" })));
  mapControls();
  assert(screen.getByText(/200%/));
  (mapControls(), fireEvent.click(screen.getByRole("button", { name: "Reset graph" })));
  await measure(320, 100);
  assert.equal(vp().querySelectorAll('[role="button"]').length, 1);
  assert.equal(vp().querySelectorAll('[data-native-accessible="false"]').length, 3);
  for (let i = 0; i < 5; i++)
    (mapControls(), fireEvent.click(screen.getByRole("button", { name: "Pan right" })));
  assert(!screen.queryByRole("button", { name: /^task TASK/ }));
  assert(!screen.queryByRole("button", { name: "Inspect First worker" }));
  (mapControls(), fireEvent.click(screen.getByRole("button", { name: "Pan down" })));
  assert(!screen.queryByRole("button", { name: "event Read API" }));
  assert(panResponders.at(-1).onPanResponderTerminationRequest());
  await measure(0, 0);
  assert.equal(vp().querySelectorAll('[role="button"]').length, 0);
  fireEvent.click(screen.getByRole("button", { name: "Focus session" }));
  assert(screen.getByText(/316, 128$/));
  mounted.rerender(
    h(
      QueryClientProvider,
      { client: mounted.client },
      h(WorkGraph, { ...props, shown: [], page: undefined, frozen: true }),
    ),
  );
  assert(screen.getByText("No enrolled sessions match these filters."));
  assert(screen.getByText(/Frozen observations/));
});

test("graph selection preserves requested navigation through delayed history and resized temporary bounds", async () => {
  const nodes = [
    {
      id: S,
      task: A,
      host: "mini",
      agentId: S,
      title: "Intent Alpha",
      provider: "codex",
      mode: "human",
      status: "idle",
      pending: 0,
    },
    {
      id: B,
      task: A,
      host: "macbook",
      agentId: B,
      title: "Intent Beta",
      provider: "codex",
      mode: "human",
      status: "idle",
      pending: 0,
    },
  ];
  let resolveBeta,
    hold = true,
    small = false;
  const page = (id) => ({
    sessionId: id,
    taskId: A,
    observedAt: time(),
    cursor: null,
    note: "Scoped fixture",
    receipts: [],
    activity:
      small && id === B
        ? []
        : Array.from({ length: 20 }, (_, i) => ({
            id: String(i),
            kind: "tool_call",
            label: (id === S ? "Alpha " : "Beta ") + i,
            state: "completed",
            files: ["src/" + i + ".ts"],
          })),
  });
  setFleetHandler((name, input) => {
    if (name === "organization.fleet")
      return Promise.resolve({
        observedAt: time(),
        total: 2,
        partial: false,
        note: "Fixture",
        nodes,
        tasks: [{ id: A, title: "Intent task" }],
        edges: [],
      });
    assert.equal(name, "organization.activity-history");
    return input.sessionId === B && hold
      ? new Promise((r) => {
          resolveBeta = r;
        })
      : Promise.resolve(page(input.sessionId));
  });
  const props = { theme, layout: { compact: true }, onTask: () => {} },
    mounted = mount(h(FleetSurface, props)),
    measure = (width, height) =>
      act(async () =>
        layoutHandlers.get("work-graph-viewport")({ nativeEvent: { layout: { width, height } } }),
      );
  fireEvent.click(await screen.findByRole("button", { name: "Inspect Intent Alpha" }));
  evidence();
  await screen.findByText("Alpha 0 · completed");
  fireEvent.click(screen.getByRole("button", { name: "Open work graph" }));
  evidence();
  await screen.findByText("Alpha 0 · completed");
  mapControls();
  fireEvent.click(screen.getByRole("button", { name: "Reset graph" }));
  await measure(1000, 400);
  (mapControls(), fireEvent.click(screen.getByRole("button", { name: "Zoom in" })));
  (mapControls(), fireEvent.click(screen.getByRole("button", { name: "Zoom in" })));
  (mapControls(), fireEvent.click(screen.getByRole("button", { name: "Pan right" })));
  (mapControls(), fireEvent.click(screen.getByRole("button", { name: "Pan right" })));
  (mapControls(), fireEvent.click(screen.getByRole("button", { name: "Pan down" })));
  mapControls();
  assert(screen.getByText(/150%.*440, 160$/));
  fireEvent.click(screen.getByRole("button", { name: "Freeze view" }));
  assert(screen.getByText(/Frozen observations/));
  fireEvent.click(screen.getByRole("button", { name: "Resume updates" }));
  assert(screen.getByText(/Observed work/));
  fireEvent.click(screen.getByRole("button", { name: "Inspect Intent Beta" }));
  evidence();
  await screen.findByText("Reading confirmed activity…");
  assert(screen.queryByText("Alpha 0 · completed") === null);
  await measure(1000, 400);
  mapControls();
  assert(screen.getByText(/150%.*0, 80$/));
  await measure(800, 400);
  mapControls();
  assert(screen.getByText(/150%.*160, 80$/));
  hold = false;
  await act(async () => resolveBeta(page(B)));
  evidence();
  await screen.findByText("Beta 0 · completed");
  mapControls();
  assert(screen.getByText(/150%.*440, 160$/));
  await measure(2000, 400);
  mapControls();
  assert(screen.getByText(/150%.*0, 160$/));
  await measure(1000, 400);
  mapControls();
  assert(screen.getByText(/150%.*440, 160$/));
  small = true;
  fireEvent.click(screen.getByRole("button", { name: "Return to latest activity" }));
  await waitFor(() => assert(screen.queryByText("Beta 0 · completed") === null));
  mapControls();
  assert(screen.getByText(/150%.*0, 80$/));
  fireEvent.click(screen.getByRole("button", { name: "Inspect Intent Alpha" }));
  evidence();
  await screen.findByText("Alpha 0 · completed");
  await measure(1000, 400);
  mapControls();
  assert(screen.getByText(/150%.*440, 160$/));
  assert.equal(
    calls
      .filter((c) => c.name === "organization.activity-history" && c.input.sessionId === S)
      .at(-1).input.cursor,
    null,
  );
  fireEvent.click(screen.getByRole("button", { name: "Back to work list" }));
  fireEvent.click(screen.getByRole("button", { name: "Macbook" }));
  await waitFor(() =>
    assert.equal(screen.getByRole("button", { name: "Open work graph" }).disabled, false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Open work graph" }));
  await measure(1000, 400);
  mapControls();
  assert(screen.getByText(/100%.*0, 0$/));
  (mapControls(), fireEvent.click(screen.getByRole("button", { name: "Zoom in" })));
  mounted.rerender(
    h(
      QueryClientProvider,
      { client: mounted.client },
      h(FleetSurface, { ...props, host: { id: "another-paseo-host" } }),
    ),
  );
  assert.equal(screen.queryByTestId("work-graph-viewport"), null);
  await waitFor(() =>
    assert.equal(screen.getByRole("button", { name: "Open work graph" }).disabled, false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Open work graph" }));
  await screen.findByTestId("work-graph-viewport");
  mapControls();
  await measure(1000, 400);
  mapControls();
  assert(screen.getByText(/100%.*0, 0$/));
  assert(
    calls.every((c) =>
      [
        "organization.fleet",
        "organization.fleet-hosts",
        "organization.activity-history",
        "organization.outcome",
        "organization.projects",
        "organization.project-briefing",
        "organization.role-directory",
        "organization.work-map",
        "organization.work-map-project",
      ].includes(c.name),
    ),
  );
});

test("explicit navigation replaces clamped intent, reset survives remount, and invalid saved numbers are sanitized", async () => {
  const nodes = [
      {
        id: S,
        task: A,
        host: "mini",
        agentId: S,
        title: "Intent worker",
        provider: "codex",
        mode: "human",
        status: "idle",
        pending: 0,
      },
    ],
    fleet = {
      observedAt: time(),
      total: 1,
      partial: false,
      note: "Fixture",
      nodes,
      tasks: [{ id: A, title: "Intent task" }],
      edges: [],
    },
    intent = { current: { zoom: 1.5, x: 440, y: 160 } },
    page = {
      data: {
        taskId: A,
        sessionId: S,
        activity: Array.from({ length: 20 }, (_, i) => ({
          id: String(i),
          kind: "tool_call",
          label: "Item " + i,
          state: "completed",
          files: ["src/" + i + ".ts"],
        })),
      },
      historical: false,
      loading: false,
      stale: false,
    },
    props = {
      fleet,
      shown: nodes,
      selected: S,
      stale: false,
      frozen: false,
      theme,
      onSelect: () => {},
      onTask: () => {},
      intent,
    };
  const mounted = mount(h(WorkGraph, props));
  mapControls();
  const show = (extra = {}, key = "same") =>
      mounted.rerender(
        h(
          QueryClientProvider,
          { client: mounted.client },
          h(WorkGraph, { ...props, ...extra, key }),
        ),
      ),
    measure = (width, height) =>
      act(async () =>
        layoutHandlers.get("work-graph-viewport")({ nativeEvent: { layout: { width, height } } }),
      );
  await measure(1000, 400);
  mapControls();
  assert(screen.getByText(/150%.*0, 80$/));
  assert.deepEqual(intent.current, { zoom: 1.5, x: 440, y: 160 });
  const drag = panResponders.at(-1);
  await act(async () => {
    drag.onPanResponderGrant();
    drag.onPanResponderMove(null, { dx: 10, dy: 20 });
  });
  assert.deepEqual(intent.current, { zoom: 1.5, x: 0, y: 60 });
  show({ page });
  await measure(1000, 400);
  mapControls();
  assert(screen.getByText(/150%.*0, 60$/));
  (mapControls(), fireEvent.click(screen.getByRole("button", { name: "Pan right" })));
  assert.deepEqual(intent.current, { zoom: 1.5, x: 220, y: 60 });
  show();
  await measure(1000, 400);
  (mapControls(), fireEvent.click(screen.getByRole("button", { name: "Pan down" })));
  assert.deepEqual(intent.current, { zoom: 1.5, x: 0, y: 80 });
  show({ page });
  mapControls();
  assert(screen.getByText(/150%.*0, 80$/));
  fireEvent.click(screen.getByRole("button", { name: "Focus session" }));
  assert.deepEqual(intent.current, { zoom: 1.5, x: 486, y: 36 });
  (mapControls(), fireEvent.click(screen.getByRole("button", { name: "Reset graph" })));
  assert.deepEqual(intent.current, { zoom: 1, x: 0, y: 0 });
  show({ page }, "reset-remount");
  mapControls();
  assert(screen.getByText(/100%.*0, 0$/));
  for (const [saved, expected] of [
    [
      { zoom: NaN, x: Infinity, y: -5 },
      { zoom: 1, x: 0, y: 0 },
    ],
    [
      { zoom: Infinity, x: NaN, y: -Infinity },
      { zoom: 1, x: 0, y: 0 },
    ],
    [
      { zoom: -1, x: 0, y: 0 },
      { zoom: 0.5, x: 0, y: 0 },
    ],
    [
      { zoom: 99, x: 0, y: 0 },
      { zoom: 2, x: 0, y: 0 },
    ],
  ]) {
    intent.current = saved;
    show({ page }, "invalid-" + String(saved.zoom));
    assert.deepEqual(intent.current, expected);
    assert(!screen.queryByText(/NaN|Infinity/));
  }
});

test("original conversation action uses exact Book target in list and graph with explicit retry", async () => {
  // Portable hosts (1bea30f2): each node carries its configured server ID and the host name is its label.
  const mini = "srv_example_mini",
    book = "srv_example_book",
    requests = [];
  let reply = "host-unavailable";
  const nodes = [
    {
      id: S,
      task: A,
      host: "mini",
      serverId: mini,
      agentId: S,
      title: "Link Mini",
      provider: "codex",
      mode: "human",
      status: "idle",
      pending: 0,
    },
    {
      id: B,
      task: A,
      host: "macbook",
      serverId: book,
      agentId: B,
      title: "Link Book",
      provider: "codex",
      mode: "human",
      status: "unavailable",
      pending: null,
    },
  ];
  setFleetHandler((name) => {
    if (name === "organization.fleet")
      return Promise.resolve({
        observedAt: time(),
        total: 2,
        partial: true,
        note: "Link fixture",
        nodes,
        tasks: [{ id: A, title: "Link task", identifier: "AIN119" }],
        edges: [],
      });
    assert.equal(name, "organization.activity-history");
    return Promise.resolve({
      observedAt: time(),
      cursor: null,
      note: "Retained activity",
      receipts: [],
      activity: [],
    });
  });
  const navigation = {
    openAgent: () => assert.fail("No legacy fallback"),
    openWorkspace: () => assert.fail("No direct workspace action"),
    openAgentOnHost: (input) => {
      requests.push(input);
      return reply;
    },
  };
  mount(
    h(FleetSurface, {
      theme,
      layout: { compact: true },
      host: { id: mini, label: "Mini" },
      navigation,
      onTask: () => {},
    }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Inspect Link Book" }));
  evidence();
  fireEvent.click(await screen.findByRole("button", { name: "Open original conversation" }));
  assert.deepEqual(requests, [{ serverId: book, agentId: B }]);
  assert(screen.getByText(/wait for your hosts to finish loading, then try again/));
  reply = "requested";
  assert.equal(requests.length, 1);
  fireEvent.click(screen.getByRole("button", { name: "Open original conversation" }));
  assert(screen.getByText("Opening macbook conversation…"));
  fireEvent.click(screen.getByRole("button", { name: "Open work graph" }));
  await screen.findByTestId("work-graph-viewport");
  mapControls();
  fireEvent.click(await screen.findByRole("button", { name: "Open original conversation" }));
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.at(-1), { serverId: book, agentId: B });
  fireEvent.click(screen.getByRole("button", { name: "Back to work list" }));
  fireEvent.click(await screen.findByRole("button", { name: "Inspect Link Mini" }));
  evidence();
  await waitFor(() => assert.equal(screen.queryByText("Opening macbook conversation…"), null));
  fireEvent.click(screen.getByRole("button", { name: "Open original conversation" }));
  assert.deepEqual(requests.at(-1), { serverId: mini, agentId: S });
  assert(
    calls.every((c) =>
      [
        "organization.fleet",
        "organization.fleet-hosts",
        "organization.activity-history",
        "organization.outcome",
        "organization.projects",
        "organization.project-briefing",
        "organization.role-directory",
        "organization.work-map",
        "organization.work-map-project",
      ].includes(c.name),
    ),
  );
});

test("original conversation legacy action requires the exact current server ID", () => {
  const requests = [],
    navigation = {
      openAgent: (input) => requests.push(input),
      openWorkspace: () => assert.fail("No workspace action"),
    };
  const view = mount(
    h(OriginalConversation, {
      theme,
      targetHost: "macbook",
      targetServerId: "srv_example_book",
      agentId: B,
      host: { id: "srv_example_mini", label: "Mini" },
      navigation,
    }),
  );
  assert.equal(screen.queryByRole("button", { name: "Open original conversation" }), null);
  assert(screen.getByText(/latest Fulcra client/));
  view.rerender(
    h(OriginalConversation, {
      theme,
      targetHost: "macbook",
      targetServerId: "srv_example_book",
      agentId: B,
      host: { id: "srv_example_book", label: "Book" },
      navigation,
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Open original conversation" }));
  assert.deepEqual(requests, [{ agentId: B }]);
  assert(screen.getByText("Opening macbook conversation…"));
});

test("original conversation errors expose no private exception text", () => {
  const navigation = {
    openAgent: () => {},
    openWorkspace: () => {},
    openAgentOnHost: () => {
      throw Error("PRIVATE transport details");
    },
  };
  mount(
    h(OriginalConversation, {
      theme,
      targetHost: "macbook",
      targetServerId: "srv_example_book",
      agentId: B,
      host: { id: "srv_example_mini", label: "Mini" },
      navigation,
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Open original conversation" }));
  assert(screen.getByText(/Could not request navigation/));
  assert.equal(screen.queryByText(/PRIVATE/), null);
  assert.equal(screen.queryByText(/Opening macbook/), null);
});

test("original conversation label is readable on light and dark activity cards", () => {
  const luminance = (hex) => {
    const full = hex.length === 4 ? "#" + [...hex.slice(1)].map((c) => c + c).join("") : hex;
    const linear = [1, 3, 5]
      .map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  };
  for (const colors of [theme.colors, { ...theme.colors, foreground: "#111", surface0: "#fff" }]) {
    const view = mount(
      h(OriginalConversation, {
        theme: { colors },
        targetHost: "macbook",
        targetServerId: "srv_example_book",
        agentId: B,
        host: { id: "srv_example_book", label: "Book" },
        navigation: { openAgent: () => {} },
      }),
    );
    const label = screen.getByText("Open original conversation ↗");
    const style = JSON.parse(label.getAttribute("data-native-style"));
    const a = luminance(style.color),
      b = luminance(
        JSON.parse(
          screen
            .getByRole("button", { name: "Open original conversation" })
            .getAttribute("data-native-style"),
        ).backgroundColor,
      ),
      ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    assert(
      ratio >= 4.5,
      `Action label contrast ${ratio.toFixed(2)} is below 4.5:1 on the actual action background`,
    );
    view.unmount();
  }
});

test("compact work design keeps one primary action and historical recovery outside disclosures", async () => {
  const cursor = { scope: "a".repeat(64), epoch: "design", seq: 51 },
    requests = [];
  setFleetHandler((name, input) =>
    Promise.resolve(
      name === "organization.fleet"
        ? {
            observedAt: time(),
            total: 1,
            partial: true,
            note: "Partial observation; no complete coverage inferred.",
            nodes: [
              {
                id: S,
                task: A,
                host: "macbook",
                serverId: "srv_example_book",
                agentId: S,
                title: "Design session",
                provider: "claude",
                mode: "human",
                status: "unknown",
                pending: null,
              },
            ],
            tasks: [{ id: A, title: "Design task" }],
            edges: [],
          }
        : {
            observedAt: time(),
            sessionId: S,
            taskId: A,
            cursor: input.cursor ? null : cursor,
            note: "Native activity unavailable; receipts retained.",
            receipts: [{ id: B, kind: "send", state: "delivered" }],
            activity: [],
          },
    ),
  );
  mount(
    h(FleetSurface, {
      theme,
      host: { id: "srv_example_mini" },
      layout: { compact: true },
      navigation: {
        openAgentOnHost: (input) => {
          requests.push(input);
          return "host-unavailable";
        },
      },
      onTask: () => {},
    }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Inspect Design session" }));
  const graphAction = screen.getByRole("button", { name: "Open work graph" });
  assert(
    graphAction
      .getAttribute("aria-label")
      .toLowerCase()
      .includes(graphAction.textContent.toLowerCase()),
  );
  fireEvent.click(graphAction);
  await screen.findByTestId("work-graph-viewport");
  const action = screen.getByRole("button", { name: "Open original conversation" }),
    toggle = screen.getByRole("button", { name: "Session evidence" });
  assert(
    action.compareDocumentPosition(screen.getByTestId("work-graph-viewport")) &
      window.Node.DOCUMENT_POSITION_FOLLOWING,
  );
  assert(
    action
      .getAttribute("aria-label")
      .toLowerCase()
      .includes(action.textContent.replace(/↗/g, "").trim().toLowerCase()),
  );
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(screen.queryByText("send → delivered"), null);
  assert(screen.getByText("Status unavailable · You have control"));
  assert.equal(screen.queryByText("Native activity unavailable; receipts retained."), null);
  assert.equal(screen.queryByRole("button", { name: "Zoom in" }), null);
  mapControls();
  assert.equal(
    screen.getByRole("button", { name: "Map controls" }).getAttribute("aria-expanded"),
    "true",
  );
  assert(screen.getByRole("button", { name: "Zoom in" }));
  evidence();
  for (const name of [
    "Back to work list",
    "Focus session",
    "Map controls",
    "Load older activity",
    "Return to latest activity",
    "Session evidence",
    "Open original conversation",
  ])
    assert(
      JSON.parse(screen.getByRole("button", { name }).getAttribute("data-native-style"))
        .minHeight >= 48,
      name,
    );
  evidence();
  assert(screen.getByText("send → delivered"));
  assert.equal(screen.getAllByRole("button", { name: "Open original conversation" }).length, 1);
  fireEvent.click(action);
  assert.deepEqual(requests, [{ serverId: "srv_example_book", agentId: S }]);
  fireEvent.click(screen.getByRole("button", { name: "Load older activity" }));
  await screen.findByText("Historical page · automatic updates paused");
  fireEvent.click(toggle);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert(screen.getByText("Historical page · automatic updates paused"));
  assert(screen.getByRole("button", { name: "Return to latest activity" }));
  assert.equal(screen.getAllByRole("button", { name: "Open original conversation" }).length, 1);
  assert(
    calls.every((c) =>
      [
        "organization.fleet",
        "organization.fleet-hosts",
        "organization.activity-history",
        "organization.outcome",
        "organization.projects",
        "organization.project-briefing",
        "organization.role-directory",
        "organization.work-map",
        "organization.work-map-project",
      ].includes(c.name),
    ),
  );
});

for (const platform of ["web"])
  test(`graph touch ownership restores page scroll on ${platform}`, async () => {
    const nodes = [
      {
        id: S,
        task: A,
        host: "macbook",
        agentId: S,
        title: "Touch session",
        provider: "codex",
        mode: "human",
        status: "idle",
        pending: 0,
      },
    ];
    setFleetHandler((name, input) =>
      Promise.resolve(
        name === "organization.fleet"
          ? {
              observedAt: time(),
              total: 1,
              partial: false,
              note: "Fixture",
              nodes,
              tasks: [{ id: A, title: "Touch task" }],
              edges: [],
            }
          : {
              observedAt: time(),
              sessionId: input.sessionId,
              taskId: A,
              cursor: null,
              note: "Scoped history",
              receipts: [],
              activity: Array.from({ length: 8 }, (_, i) => ({
                id: String(i),
                label: "Read " + i,
                kind: "tool_call",
                state: "completed",
                files: [],
              })),
            },
      ),
    );
    mount(
      h(FleetSurface, {
        theme,
        host: { id: "touch-" + platform },
        layout: { compact: true, platform },
        onTask: () => {},
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Inspect Touch session" }));
    evidence();
    await screen.findByText("Scoped history");
    fireEvent.click(screen.getByRole("button", { name: "Open work graph" }));
    const vp = () => screen.getByTestId("work-graph-viewport"),
      enabled = () =>
        screen.getByTestId("work-graph-page").getAttribute("data-native-scroll-enabled") ?? "true";
    const start = () => fireEvent.touchStart(vp(), { touches: [{ identifier: 1 }] }),
      end = (touches) => fireEvent.touchEnd(vp(), { touches });
    assert.equal(enabled(), "true");
    start();
    assert.equal(enabled(), platform === "web" ? "true" : "false");
    end([{ identifier: 2 }]);
    assert.equal(enabled(), platform === "web" ? "true" : "false");
    end([]);
    assert.equal(enabled(), "true");
    start();
    fireEvent.touchCancel(vp());
    assert.equal(enabled(), "true");
    const pan = panResponders.at(-1);
    assert.equal(pan.onStartShouldSetPanResponder(), platform !== "web");
    assert.equal(
      pan.onStartShouldSetPanResponderCapture({ nativeEvent: { touches: [{}] } }),
      false,
    );
    assert(pan.onPanResponderTerminationRequest());
    assert.equal(pan.onMoveShouldSetPanResponderCapture({}, { dx: 3, dy: 3 }), false);
    assert.equal(pan.onMoveShouldSetPanResponderCapture({}, { dx: 0, dy: 7 }), true);
    for (const terminal of ["onPanResponderRelease", "onPanResponderTerminate"]) {
      start();
      await act(async () => pan.onPanResponderGrant());
      assert.equal(pan.onPanResponderTerminationRequest(), false);
      await act(async () => pan.onPanResponderMove({}, { dx: -100, dy: -100 }));
      await act(async () => pan[terminal]());
      assert.equal(enabled(), "true");
      assert(pan.onPanResponderTerminationRequest());
    }
    // A touch without drag leaves the existing node action available; no control RPC is introduced.
    start();
    end([]);
    fireEvent.click(screen.getByRole("button", { name: "Focus session" }));
    fireEvent.click(screen.getByRole("button", { name: "Inspect Touch session" }));
    evidence();
    assert.equal(enabled(), "true");
    assert(
      calls.every((c) =>
        [
          "organization.fleet",
          "organization.fleet-hosts",
          "organization.activity-history",
          "organization.outcome",
          "organization.projects",
          "organization.project-briefing",
          "organization.role-directory",
          "organization.work-map",
          "organization.work-map-project",
        ].includes(c.name),
      ),
    );
  });
test("graph unmount releases its transient touch owner", () => {
  const active = [],
    nodes = [
      {
        id: S,
        task: A,
        host: "mini",
        title: "Touch owner",
        provider: "codex",
        mode: "human",
        status: "idle",
      },
    ];
  const r = mount(
    h(WorkGraph, {
      fleet: { nodes, tasks: [{ id: A, title: "Task" }], edges: [] },
      shown: nodes,
      selected: S,
      stale: false,
      frozen: false,
      theme,
      onSelect: () => {},
      onTask: () => {},
      onTouchActive: (value) => active.push(value),
    }),
  );
  fireEvent.touchStart(screen.getByTestId("work-graph-viewport"), { touches: [{ identifier: 1 }] });
  assert.equal(active.at(-1), true);
  r.unmount();
  assert.equal(active.at(-1), false);
});

test("card drag retains movement that caused responder takeover", async () => {
  const nodes = [
    {
      id: S,
      task: A,
      host: "mini",
      title: "Drag session",
      provider: "codex",
      mode: "human",
      status: "idle",
    },
  ];
  const page = {
    data: {
      sessionId: S,
      taskId: A,
      activity: Array.from({ length: 8 }, (_, i) => ({
        id: String(i),
        label: "Read " + i,
        kind: "tool_call",
        state: "completed",
        files: [],
      })),
    },
  };
  mount(
    h(WorkGraph, {
      fleet: { nodes, tasks: [{ id: A, title: "Drag task" }], edges: [] },
      shown: nodes,
      selected: S,
      page,
      stale: false,
      frozen: true,
      theme,
      onSelect: () => {},
      onTask: () => {},
      onTouchActive: () => {},
    }),
  );
  const pan = panResponders.at(-1);
  assert.equal(pan.onMoveShouldSetPanResponderCapture({}, { dx: -72, dy: -96 }), true);
  // RN resets dx/dy to zero when granting a move-triggered responder.
  await act(async () => pan.onPanResponderGrant({}, { dx: 0, dy: 0 }));
  mapControls();
  assert(screen.getByText(/nodes.*72, 96$/));
  await act(async () => pan.onPanResponderMove({}, { dx: -10, dy: -14 }));
  mapControls();
  assert(screen.getByText(/nodes.*82, 110$/));
  await act(async () => pan.onPanResponderRelease());
  // The next background touch must not replay the preceding takeover movement.
  assert.equal(pan.onStartShouldSetPanResponderCapture({ nativeEvent: { touches: [{}] } }), false);
  await act(async () => pan.onPanResponderGrant({}, { dx: 0, dy: 0 }));
  mapControls();
  assert(screen.getByText(/nodes.*82, 110$/));
  await act(async () => pan.onPanResponderRelease());
});

for (const available of [true, false])
  test(`native graph uses host pan capability: ${available}`, async () => {
    setHostPanAvailable(available);
    const nodes = [
      {
        id: S,
        task: A,
        host: "macbook",
        agentId: S,
        title: "Native pan session",
        provider: "codex",
        mode: "human",
        status: "idle",
        pending: 0,
      },
    ];
    setFleetHandler((name, input) =>
      Promise.resolve(
        name === "organization.fleet"
          ? {
              observedAt: time(),
              total: 1,
              partial: false,
              note: "Fixture",
              nodes,
              tasks: [{ id: A, title: "Native task" }],
              edges: [],
            }
          : {
              observedAt: time(),
              sessionId: input.sessionId,
              taskId: A,
              cursor: null,
              note: "Native scoped history",
              receipts: [],
              activity: Array.from({ length: 8 }, (_, i) => ({
                id: String(i),
                label: "Read " + i,
                kind: "tool_call",
                state: "completed",
                files: [],
              })),
            },
      ),
    );
    mount(
      h(FleetSurface, {
        theme,
        host: { id: "native-pan-" + available },
        layout: { compact: true, platform: "android" },
        onTask: () => {},
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Inspect Native pan session" }));
    evidence();
    await screen.findByText("Native scoped history");
    fireEvent.click(screen.getByRole("button", { name: "Open work graph" }));
    evidence();
    await screen.findByText("Read 0 · completed");
    assert.equal(
      screen.getByTestId("work-graph-page").getAttribute("data-native-scroll-enabled"),
      null,
    );
    if (available) {
      assert.equal(screen.queryByText(/Update the Fulcra app/), null);
      const pan = nativePans.at(-1);
      await act(async () => {
        pan.onPanStart();
        pan.onPanUpdate({ x: -72, y: -96 });
      });
      mapControls();
      assert(screen.getByText(/nodes.*388, 112$/));
      await act(async () => {
        nativePans.at(-1).onPanUpdate({ x: -100, y: -120 });
        nativePans.at(-1).onPanEnd(false);
      });
      mapControls();
      assert(screen.getByText(/nodes.*416, 136$/));
    } else {
      assert(screen.getByText(/Update the Fulcra app to drag this map/));
      mapControls();
      fireEvent.click(screen.getByRole("button", { name: "Pan down" }));
      mapControls();
      assert(screen.getByText(/nodes.*316, 176$/));
    }
    fireEvent.click(screen.getByRole("button", { name: "Focus session" }));
    fireEvent.click(screen.getByRole("button", { name: "Inspect Native pan session" }));
    evidence();
    assert(
      calls.every((c) =>
        [
          "organization.fleet",
          "organization.fleet-hosts",
          "organization.activity-history",
          "organization.outcome",
          "organization.projects",
          "organization.project-briefing",
          "organization.role-directory",
          "organization.work-map",
          "organization.work-map-project",
        ].includes(c.name),
      ),
    );
  });

for (const light of [false, true])
  test(`quota wait uses host theme and distinguishes saved wait from stale/control review: ${light ? "light" : "dark"}`, () => {
    const palette = light
      ? {
          colors: {
            ...theme.colors,
            foreground: "#111",
            foregroundMuted: "#555",
            surface0: "#fff",
            surface2: "#eee",
          },
        }
      : theme;
    const wait = {
      messageId: B,
      sessionId: S,
      taskId: A,
      state: "waiting",
      reason: "provider-limit",
      since: time(),
      checkedAt: null,
      nextCheckAt: time(),
    };
    const view = mount(h(QuotaWaitCard, { wait, theme: palette, stale: false }));
    assert(screen.getByText("Waiting for provider capacity"));
    assert(screen.getByText(/do not need to send it again/));
    assert(screen.getByText(/not a promised restart time/));
    assert.equal(
      JSON.parse(screen.getByLabelText("Saved instruction wait").getAttribute("data-native-style"))
        .backgroundColor,
      light ? "#eee" : "#263246",
    );
    view.rerender(h(QuotaWaitCard, { wait, theme: palette, stale: true }));
    assert(screen.getByText("Last recorded: Waiting for provider capacity"));
    assert.equal(screen.queryByText(/Scheduled check:/), null);
    view.rerender(
      h(QuotaWaitCard, {
        wait: { ...wait, state: "attention", nextCheckAt: null },
        theme: palette,
        stale: false,
      }),
    );
    assert(screen.getByText("Waiting for control review"));
    assert(screen.getByText(/Open task controls/));
    assert.equal(screen.queryByRole("button"), null);
  });
test("work list and selected session show queued work separately from native idle, without sending work", async () => {
  const wait = {
    messageId: B,
    sessionId: S,
    taskId: A,
    state: "checking",
    reason: "verification",
    since: time(),
    checkedAt: null,
    nextCheckAt: null,
  };
  const data = {
    observedAt: time(),
    total: 1,
    partial: false,
    note: "Read-only observation",
    quotaNote: "Saved quota waits",
    nodes: [
      {
        id: S,
        task: A,
        host: "mini",
        agentId: S,
        title: "Queued author",
        provider: "codex",
        mode: "delegated",
        status: "idle",
        pending: 0,
        quotaObservedAt: time(),
        quotaWait: wait,
      },
    ],
    tasks: [{ id: A, title: "Owned task", identifier: "AIN-73" }],
    edges: [],
  };
  setFleetHandler((name, input) =>
    name === "organization.fleet"
      ? Promise.resolve(data)
      : name === "organization.activity-history"
        ? Promise.resolve({
            observedAt: time(),
            note: "No native turn started",
            receipts: [],
            activity: [],
            cursor: null,
          })
        : base(name, input),
  );
  mount(h(FleetSurface, { theme, layout: { compact: true, platform: "ios" }, onTask() {} }));
  await screen.findByText("Waiting for verification");
  assert(screen.getByText(/codex · Idle/));
  fireEvent.click(screen.getByRole("button", { name: "Inspect Queued author" }));
  await screen.findByLabelText("Saved instruction wait");
  assert(screen.getByText(/do not need to send it again/));
  assert(
    calls.every((c) =>
      [
        "organization.fleet",
        "organization.fleet-hosts",
        "organization.activity-history",
        "organization.outcome",
        "organization.projects",
      ].includes(c.name),
    ),
  );
});

test("quota freshness is independent from the new fleet observation timestamp", () => {
  assert.equal(quotaIsStale(time()), false);
  for (const at of [
    undefined,
    null,
    "invalid",
    new Date(Date.now() - 60000).toISOString(),
    new Date(Date.now() + 10000).toISOString(),
  ])
    assert.equal(quotaIsStale(at), true);
});

test("pending fleet request cannot keep expired observations fresh without a response", async (t) => {
  let clock = Date.now();
  t.mock.method(Date, "now", () => clock);
  t.mock.timers.enable({ apis: ["setInterval"] });
  const at = new Date(clock).toISOString(),
    wait = {
      messageId: B,
      sessionId: S,
      taskId: A,
      state: "waiting",
      reason: "provider-limit",
      since: at,
      checkedAt: null,
      nextCheckAt: null,
    };
  const data = {
    observedAt: at,
    total: 1,
    partial: false,
    note: "Owned observation",
    nodes: [
      {
        id: S,
        task: A,
        host: "mini",
        agentId: S,
        title: "Stalled author",
        provider: "codex",
        mode: "delegated",
        status: "idle",
        pending: 0,
        quotaObservedAt: at,
        quotaWait: wait,
      },
    ],
    tasks: [{ id: A, title: "Owned task", identifier: "AIN-73" }],
    edges: [],
  };
  let reads = 0;
  setFleetHandler((name) =>
    name === "organization.fleet"
      ? ++reads === 1
        ? Promise.resolve(data)
        : new Promise(() => {})
      : Promise.resolve({
          observedAt: at,
          note: "No activity",
          receipts: [],
          activity: [],
          cursor: null,
        }),
  );
  const view = mount(
    h(FleetSurface, { theme, layout: { compact: true, platform: "ios" }, onTask() {} }),
  );
  await screen.findByRole("button", { name: "Inspect Stalled author" });
  fireEvent.click(screen.getByRole("button", { name: "Inspect Stalled author" }));
  fireEvent.click(screen.getByRole("button", { name: "Refresh work" }));
  await act(async () => {});
  const pendingReads = reads;
  clock += 51000;
  await act(async () => {
    t.mock.timers.tick(5000);
  });
  assert(screen.getByText(/^May be out of date/));
  assert(screen.getAllByText("Last recorded: Waiting for provider capacity").length > 0);
  assert.equal(reads, pendingReads);
  assert(screen.getByText(/This observation is stale/));
  view.unmount();
});

test("work brief leads with outcome and next step, reads the bound output and never displays raw hashes", async () => {
  const hash = "a".repeat(64),
    callsRead = [],
    record = {
      title: "Release work",
      outcome: "Let people resume their team from an iPhone",
      currentState: "Guide finished; app release still in progress.",
      nextStep: "Verify the native app on iPhone.",
      decision: {
        alternativeId: "fork",
        rationale: "Own the app and retain the upstream foundation.",
      },
      alternatives: [
        {
          id: "fork",
          benefits: "One place to understand the team.",
          example: "Read the finished guide from your phone.",
        },
      ],
      artifacts: [{ id: "guide", kind: "output", title: "Recovery guide", sha256: hash }],
    };
  let changed = false;
  setHandler((name, input) => {
    if (name === "organization.outcome")
      return Promise.resolve({
        observedAt: time(),
        recordSha256: hash,
        record,
        artifacts: [{ id: "guide", state: changed ? "changed" : "matches" }],
      });
    assert.equal(name, "organization.outcome-artifact");
    callsRead.push(input);
    return Promise.resolve({ text: "Three recovery steps for your saved team." });
  });
  const view = mount(
    h(WorkBrief, { taskId: A, theme, host: { id: "host-a" }, frozen: false, onTask: () => {} }),
  );
  await screen.findByText(record.outcome);
  assert(screen.getByText(record.nextStep));
  assert.equal(screen.queryByText(hash), null);
  fireEvent.click(screen.getByRole("button", { name: "Read output Recovery guide" }));
  await screen.findByText("Three recovery steps for your saved team.");
  assert.deepEqual(callsRead, [{ taskId: A, artifactId: "guide", recordSha256: hash }]);
  changed = true;
  await act(async () => view.client.refetchQueries({ queryKey: ["orca-work-brief", "host-a", A] }));
  await waitFor(() =>
    assert.equal(screen.getByRole("button", { name: "Read output Recovery guide" }).disabled, true),
  );
  assert.equal(screen.queryByText("Three recovery steps for your saved team."), null);
  assert(screen.getByText(/unavailable or changed/));
});

test("portfolio distinguishes provider, saved leader and live activity and opens the actual cross-host conversation", async () => {
  const native = "33333333-3333-4333-8333-333333333333",
    opened = [],
    managed = [];
  const fleet = {
    observedAt: time(),
    total: 1,
    partial: false,
    note: "Observed",
    supervisionAvailable: true,
    supervisors: [{ id: S, task: A, active: false, maxWorkers: 2, reserved: 0, workers: [] }],
    nodes: [
      {
        id: S,
        task: A,
        host: "macbook",
        serverId: "srv_book_portfolio",
        agentId: native,
        title: "Product lead",
        provider: "claude",
        model: "Chosen model",
        mode: "human",
        status: "idle",
        pending: 0,
      },
    ],
    tasks: [
      { id: A, title: "Launch the product", identifier: "AIN-73" },
      { id: B, title: "Customer research", identifier: "AIN-74" },
    ],
    edges: [],
  };
  setFleetHandler((name, input) =>
    name === "organization.fleet" ? Promise.resolve(fleet) : base(name, input),
  );
  mount(
    h(PortfolioSurface, {
      theme,
      layout: { compact: true, platform: "ios" },
      host: { id: "srv_mini_portfolio" },
      navigation: {
        openAgentOnHost: (target) => {
          opened.push(target);
          return "requested";
        },
      },
      onTask: (id) => managed.push(id),
    }),
  );
  await screen.findByText("Product lead");
  assert(screen.getByText("Claude · Chosen model · macbook"));
  assert(screen.getByText("Idle"));
  assert(screen.getByText(/You have control. This saved leader/));
  assert(screen.getByText("No workers recorded yet. This orchestrator can still lead the work."));
  assert.equal(screen.queryByText("Customer research"), null);
  fireEvent.click(screen.getByRole("button", { name: "Tasks without a recorded leader" }));
  assert(screen.getByRole("button", { name: "Set up leadership: Customer research" }));
  fireEvent.click(screen.getByRole("button", { name: "Talk to Product lead" }));
  assert.deepEqual(opened, [{ serverId: "srv_book_portfolio", agentId: native }]);
  fireEvent.click(screen.getByRole("button", { name: "Manage leaders: Launch the product" }));
  assert.deepEqual(managed, [A]);
  assert(
    calls.every((c) =>
      [
        "organization.fleet",
        "organization.outcome",
        "organization.projects",
        "organization.project-briefing",
      ].includes(c.name),
    ),
  );
  assert(!document.body.textContent.includes(S));
});
test("projects filter native leaders by exact membership, retain ungrouped work and never issue control calls", async () => {
  const projectId = "33333333-3333-4333-8333-333333333333",
    emptyId = "44444444-4444-4444-8444-444444444444",
    managed = [];
  const directory = {
    observedAt: time(),
    available: true,
    partial: false,
    projects: [
      {
        id: projectId,
        name: "Product strategy",
        description: "Understand customer choices",
        status: "in_progress",
      },
      { id: emptyId, name: "New direction", description: null, status: "backlog" },
    ],
    membership: [
      { taskId: A, projectId },
      { taskId: B, projectId: null },
    ],
    note: "Exact source",
  };
  const fleet = {
    observedAt: time(),
    total: 1,
    partial: false,
    supervisionAvailable: true,
    supervisors: [{ id: S, task: A, active: false, workers: [] }],
    nodes: [
      {
        id: S,
        task: A,
        host: "mini",
        agentId: S,
        title: "Strategy leader",
        provider: "codex",
        mode: "human",
        status: "idle",
        pending: 0,
      },
    ],
    tasks: [
      { id: A, title: "Compare options", identifier: "AIN-73" },
      { id: B, title: "Ungrouped AIN-730 work", identifier: "AIN-730" },
    ],
    edges: [],
  };
  setHandler((name, input) =>
    name === "organization.projects"
      ? Promise.resolve(directory)
      : name === "organization.fleet"
        ? Promise.resolve(fleet)
        : base(name, input),
  );
  mount(
    h(PortfolioSurface, { theme, layout: { compact: true }, onTask: (id) => managed.push(id) }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Project: Product strategy" }));
  await screen.findByText("Strategy leader");
  assert(screen.getByText("Understand customer choices"));
  assert.equal(screen.queryByText("Ungrouped AIN-730 work"), null);
  assert(screen.getByText("1 recorded leader"));
  fireEvent.click(screen.getByRole("button", { name: "Work without a verified project" }));
  assert.equal(screen.queryByText("Strategy leader"), null);
  assert(screen.getByRole("button", { name: "Set up leadership: Ungrouped AIN-730 work" }));
  assert(screen.getByText("0 recorded leaders"));
  fireEvent.click(screen.getByRole("button", { name: "Project: New direction" }));
  assert(screen.getByText(/No recorded work is linked to this project/));
  fireEvent.click(screen.getByRole("button", { name: "All recorded work" }));
  assert(screen.getByText("Strategy leader"));
  assert.deepEqual(managed, []);
  assert(
    calls.every((c) =>
      [
        "organization.projects",
        "organization.fleet",
        "organization.outcome",
        "organization.project-briefing",
      ].includes(c.name),
    ),
  );
});
test("project source failure retains all work and a removed selection stays explicit until reset", async () => {
  const projectId = "33333333-3333-4333-8333-333333333333";
  let unavailable = false;
  const directory = {
    observedAt: "2000-01-01T00:00:00.000Z",
    available: true,
    partial: true,
    projects: [{ id: projectId, name: "Old grouping", description: null, status: "paused" }],
    membership: [{ taskId: A, projectId }],
    note: "Some membership unknown",
  };
  const fleet = {
    observedAt: time(),
    total: 0,
    partial: false,
    supervisionAvailable: false,
    tasks: [{ id: A, title: "Retained work", identifier: "AIN-73" }],
    nodes: [],
    supervisors: [],
    edges: [],
  };
  setHandler((name, input) =>
    name === "organization.projects"
      ? unavailable
        ? Promise.reject(Error("Offline"))
        : Promise.resolve(directory)
      : name === "organization.fleet"
        ? Promise.resolve(fleet)
        : base(name, input),
  );
  const view = mount(
    h(PortfolioSurface, {
      theme,
      layout: { compact: true },
      onTask: () => assert.fail("No control"),
    }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Project: Old grouping" }));
  assert(screen.getByText(/Project membership is unavailable or outdated/));
  assert(screen.getByText("Retained work"));
  unavailable = true;
  fireEvent.click(screen.getByRole("button", { name: "Refresh orchestrators" }));
  await waitFor(() =>
    assert(view.client.getQueryState(["orca-projects", undefined]).status === "error"),
  );
  assert(screen.getByText("Retained work"));
  await act(async () =>
    view.client.setQueryData(["orca-projects", undefined], {
      ...directory,
      observedAt: time(),
      projects: [],
      membership: [],
    }),
  );
  await screen.findByText(/selected project is no longer available/);
  fireEvent.click(screen.getByRole("button", { name: "All recorded work" }));
  assert(screen.getByText("Retained work"));
});
test("portfolio treats missing leadership and stale runtime as unknown, not inferred ownership", async () => {
  const fleet = {
    observedAt: "2000-01-01T00:00:00.000Z",
    total: 1,
    partial: true,
    note: "Partial",
    nodes: [
      {
        id: S,
        task: A,
        host: "mini",
        agentId: S,
        title: "CTO sounds like a leader",
        provider: "codex",
        mode: "delegated",
        status: "running",
        pending: 0,
      },
    ],
    tasks: [{ id: A, title: "One workstream", identifier: null }],
    edges: [],
  };
  setFleetHandler((name, input) =>
    name === "organization.fleet" ? Promise.resolve(fleet) : base(name, input),
  );
  mount(
    h(PortfolioSurface, {
      theme,
      layout: { compact: true },
      onTask: () => assert.fail("Inspection must not mutate control"),
    }),
  );
  await screen.findByText(/Leadership records are unavailable/);
  assert(screen.getByText(/This view may be out of date/));
  assert.equal(screen.queryByText("LEAD ORCHESTRATOR"), null);
  assert.equal(screen.queryByText("Working now"), null);
  assert.equal(screen.queryByText("No orchestrator is recorded for this workstream."), null);
});
test("portfolio keeps suspended team relationships visible and opens their readable updates", async () => {
  const fleet = {
    observedAt: time(),
    total: 2,
    partial: false,
    note: "Observed",
    supervisionAvailable: true,
    supervisors: [
      {
        id: S,
        task: A,
        active: false,
        maxWorkers: 1,
        reserved: 1,
        workers: [
          {
            requestId: B,
            workerId: B,
            phase: "attached",
            ownership: "orphaned",
            fault: null,
            lastEvent: { kind: "turn-ended", state: "delivered", consumed: false, at: time() },
          },
        ],
      },
    ],
    nodes: [
      {
        id: S,
        task: A,
        host: "mini",
        agentId: S,
        title: "Engineering lead",
        provider: "codex",
        mode: "human",
        status: "idle",
        pending: 0,
      },
      {
        id: B,
        task: A,
        host: "macbook",
        agentId: B,
        title: "Research worker",
        provider: "codex",
        mode: "human",
        status: "idle",
        pending: 0,
      },
    ],
    tasks: [{ id: A, title: "Deliver the release", identifier: "AIN-73" }],
    edges: [],
  };
  setFleetHandler((name, input) =>
    name === "organization.fleet"
      ? Promise.resolve(fleet)
      : name === "organization.activity-history"
        ? Promise.resolve({
            observedAt: time(),
            cursor: null,
            note: "Observed",
            receipts: [],
            activity: [],
            messages: [
              {
                id: "1",
                role: "agent",
                text: "The release notes are ready for review.",
                truncated: false,
              },
            ],
          })
        : base(name, input),
  );
  mount(h(PortfolioSurface, { theme, layout: { compact: true }, onTask: () => {} }));
  await screen.findByText(/Automation suspended; reassociation needed/);
  assert(screen.getByText(/An update is waiting/));
  fireEvent.click(screen.getByRole("button", { name: "Inspect team member Research worker" }));
  await screen.findByText("The release notes are ready for review.");
  assert(
    calls.some(
      (c) =>
        c.name === "organization.activity-history" &&
        c.input.sessionId === B &&
        c.input.taskId === A,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Back to orchestrators" }));
  assert(screen.getByText("Your orchestrators"));
});

function managedNavigationFixture(nodes) {
  setHandler((name, input) => {
    if (name === "organization.fleet")
      return Promise.resolve({
        observedAt: time(),
        nodes,
        tasks: [{ id: A, title: "Release" }],
        edges: [],
        partial: false,
        total: nodes.length,
        note: "Identity fixture",
      });
    if (name === "organization.task-manage" && input.command.action === "list")
      return Promise.resolve(
        observed({
          sessions: [
            { id: S, task: A, mode: "human", generation: 7 },
            { id: B, task: A, mode: "human", generation: 4 },
          ],
          deliveries: [],
          permissions: [],
          supervisors: [
            {
              id: S,
              task: A,
              active: false,
              maxWorkers: 1,
              reserved: 1,
              workers: [
                {
                  requestId: A,
                  workerId: B,
                  phase: "attached",
                  ownership: "orphaned",
                  fault: null,
                  lastEvent: null,
                },
              ],
            },
          ],
          taskAuthority: { allowed: true },
        }),
      );
    return base(name, input);
  });
}
test("management opens leader and worker using task-bound host/native IDs without changing control", async () => {
  const native = "33333333-3333-4333-8333-333333333333",
    mini = "44444444-4444-4444-8444-444444444444",
    opened = [];
  managedNavigationFixture([
    {
      id: S,
      task: A,
      host: "mini",
      serverId: "srv_manage_mini",
      agentId: mini,
      title: "Release leader",
    },
    {
      id: B,
      task: A,
      host: "macbook",
      serverId: "srv_manage_book",
      agentId: native,
      title: "Book reviewer",
    },
  ]);
  mount(
    h(ManagementPanel, {
      theme,
      host: { id: "srv_manage_mini" },
      taskId: A,
      titles: {},
      navigation: {
        openAgent: () => assert.fail("Never route controller IDs locally"),
        openAgentOnHost: (value) => {
          opened.push(value);
          return "requested";
        },
      },
    }),
  );
  reveal("Restore a saved team");
  reveal("Sessions and instructions");
  fireEvent.click(
    await screen.findByRole("button", { name: "Open supervisor conversation: Release leader" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Open worker conversation: Book reviewer" }));
  fireEvent.click(screen.getByRole("button", { name: "Manage Book reviewer" }));
  fireEvent.click(await screen.findByRole("button", { name: "Open managed conversation" }));
  assert.deepEqual(opened, [
    { serverId: "srv_manage_mini", agentId: mini },
    { serverId: "srv_manage_book", agentId: native },
    { serverId: "srv_manage_book", agentId: native },
  ]);
  assert(
    calls.every(
      (c) =>
        c.name === "organization.fleet" ||
        (c.name === "organization.task-manage" &&
          ["list", "health"].includes(c.input.command.action)),
    ),
  );
});
test("management refuses foreign-task or missing native mapping instead of guessing controller identity", async () => {
  managedNavigationFixture([
    {
      id: B,
      task: S,
      host: "macbook",
      serverId: "srv_manage_book",
      agentId: B,
      title: "Foreign worker",
    },
    { id: S, task: A, host: "mini", serverId: null, agentId: null, title: "Unresolved leader" },
  ]);
  mount(
    h(ManagementPanel, {
      theme,
      host: { id: "srv_manage_mini" },
      taskId: A,
      titles: { [B]: "Saved worker" },
      navigation: {
        openAgent: () => assert.fail("No guessed identity"),
        openAgentOnHost: () => assert.fail("No guessed identity"),
      },
    }),
  );
  reveal("Restore a saved team");
  reveal("Sessions and instructions");
  await screen.findByRole("button", { name: "Manage Unresolved leader" });
  fireEvent.click(await screen.findByRole("button", { name: "Manage Saved worker" }));
  assert.equal(screen.queryByRole("button", { name: /Open worker conversation/ }), null);
  assert.equal(screen.queryByRole("button", { name: /Open supervisor conversation/ }), null);
  assert.equal(screen.queryByRole("button", { name: "Open managed conversation" }), null);
  assert.equal(screen.queryByText("Foreign worker"), null);
  assert(screen.getAllByText(/Conversation identity unavailable/).length > 0);
});
test("older clients keep Book management links unavailable and allow verified same-host native links", async () => {
  const mini = "44444444-4444-4444-8444-444444444444",
    opened = [];
  managedNavigationFixture([
    {
      id: S,
      task: A,
      host: "mini",
      serverId: "srv_manage_mini",
      agentId: mini,
      title: "Mini leader",
    },
    {
      id: B,
      task: A,
      host: "macbook",
      serverId: "srv_manage_book",
      agentId: B,
      title: "Book worker",
    },
  ]);
  mount(
    h(ManagementPanel, {
      theme,
      host: { id: "srv_manage_mini" },
      taskId: A,
      titles: {},
      navigation: { openAgent: (value) => opened.push(value) },
    }),
  );
  reveal("Restore a saved team");
  reveal("Sessions and instructions");
  fireEvent.click(
    await screen.findByRole("button", { name: "Open supervisor conversation: Mini leader" }),
  );
  assert.deepEqual(opened, [{ agentId: mini }]);
  assert.equal(
    screen.queryByRole("button", { name: "Open worker conversation: Book worker" }),
    null,
  );
  await screen.findByText(/Open macbook in Fulcra Hosts/);
});

// Disclosures change presentation, never authority or request identity.
test("management starts focused and keeps unresolved work visible outside optional history", async () => {
  const closed = "33333333-3333-4333-8333-333333333333";
  setHandler((name, input) =>
    name === "organization.task-manage" && input.command.action === "list"
      ? Promise.resolve(
          observed({
            sessions: [],
            taskAuthority: { allowed: true },
            supervisors: [
              {
                id: S,
                workers: [
                  { requestId: A, workerId: B, fault: "Wake needs review", lastEvent: null },
                ],
              },
            ],
            handoffs: [
              {
                id: A,
                state: "pending",
                source: S,
                destination: B,
                deliveryState: "intent",
                context: "Inspect actual outputs",
              },
              {
                id: S,
                state: "superseded-by-takeover",
                source: S,
                destination: B,
                deliveryState: "refused",
                context: "Old closed handoff",
              },
            ],
            deliveries: [
              { id: B, kind: "send", state: "uncertain" },
              { id: closed, kind: "send", state: "delivered" },
            ],
          }),
        )
      : base(name, input),
  );
  mount(h(ManagementPanel, { theme, taskId: A, titles: { [B]: "Design reviewer" } }));
  for (const name of ["Restore a saved team", "Change team leader", "Sessions and instructions"])
    assert.equal(screen.getByRole("button", { name }).getAttribute("aria-expanded"), "false");
  await screen.findByRole("button", { name: `Reconcile ${B}` });
  assert.equal(screen.queryByRole("button", { name: "Create session" }) === null, true);
  assert.equal(screen.queryByText(new RegExp(closed)) === null, true);
  assert(screen.getByText(/Worker updates to inspect.*Design reviewer/));
  assert(screen.getByText(/1 handoff records need inspection/));
  fireEvent.click(screen.getByRole("button", { name: "Show resolved delivery history" }));
  assert(screen.getByText(new RegExp(closed)));
  fireEvent.click(screen.getByRole("button", { name: "Show resolved delivery history" }));
  assert.equal(screen.queryByText(new RegExp(closed)) === null, true);
  assert(screen.getByRole("button", { name: `Reconcile ${B}` }));
  assert(
    calls.every(
      (c) =>
        c.name === "organization.fleet" || ["health", "list"].includes(c.input.command?.action),
    ),
  );
});
test("closing a focused section dismisses focus but keeps its exact handoff draft mounted", async () => {
  setHandler((name, input) => base(name, input));
  mount(h(ManagementPanel, { theme, taskId: A, titles: {} }));
  reveal("Change team leader");
  const field = screen.getByRole("textbox", { name: "Leadership handoff context" });
  fireEvent.change(field, {
    target: { value: "Keep this scoped context and all existing workers." },
  });
  field.focus();
  assert.equal(document.activeElement, field);
  fireEvent.click(screen.getByRole("button", { name: "Change team leader" }));
  assert.equal(document.activeElement === field, false);
  assert.equal(
    screen.queryByRole("textbox", { name: "Leadership handoff context" }) === null,
    true,
  );
  assert(field.isConnected);
  assert.equal(
    field
      .closest("[data-native-accessibility-hidden]")
      .getAttribute("data-native-accessibility-hidden"),
    "true",
  );
  assert.equal(
    field
      .closest("[data-native-important-accessibility]")
      .getAttribute("data-native-important-accessibility"),
    "no-hide-descendants",
  );
  reveal("Sessions and instructions");
  fireEvent.change(screen.getByRole("textbox", { name: "New session title" }), {
    target: { value: "Retained draft title" },
  });
  reveal("Change team leader");
  assert.equal(screen.getByRole("textbox", { name: "Leadership handoff context" }), field);
  assert.equal(field.value, "Keep this scoped context and all existing workers.");
  assert.equal(
    screen.getByRole("textbox", { name: "New session title" }).value,
    "Retained draft title",
  );
  assert(
    calls.every(
      (c) =>
        c.name === "organization.fleet" || ["health", "list"].includes(c.input.command?.action),
    ),
  );
});
test("urgent takeover remains visible during an unresolved request when its form is collapsed", async () => {
  let finish;
  setHandler((name, input) =>
    name === "organization.task-manage" && input.command.action === "create"
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : base(name, input, { sessions: [{ id: S, task: A, mode: "delegated", generation: 3 }] }),
  );
  mount(h(ManagementPanel, { theme, taskId: A, titles: { [S]: "Working leader" } }));
  reveal("Sessions and instructions");
  fireEvent.click(await screen.findByRole("button", { name: "Manage Working leader" }));
  fireEvent.change(screen.getByRole("textbox", { name: "New session title" }), {
    target: { value: "Pending creation" },
  });
  await waitFor(() =>
    assert.equal(screen.getByRole("button", { name: "Create session" }).disabled, false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Create session" }));
  await waitFor(() => assert(finish));
  fireEvent.click(screen.getByRole("button", { name: "Sessions and instructions" }));
  assert.equal(screen.queryByRole("button", { name: "Create session" }) === null, true);
  assert.equal(screen.getByRole("button", { name: "Take control" }).disabled, false);
  fireEvent.click(screen.getByRole("button", { name: "Take control" }));
  await waitFor(() =>
    assert(
      calls.some((c) => c.input.command?.action === "takeover" && c.input.command.sessionId === S),
    ),
  );
  await act(async () => finish(observed({ status: "delivered", message: "Late creation result" })));
  assert.equal(screen.queryByText(/Late creation result/), null);
  assert.equal(calls.filter((c) => c.input.command?.action === "create").length, 1);
});

test("queued and unknown delivery states cannot be hidden or displaced by fifty resolved receipts", async () => {
  const states = ["intent", "uncertain", "prepared", "reserved", "queued", "future-unknown"];
  const deliveries = [
    ...Array.from({ length: 53 }, (_, i) => ({
      id: `closed-${i}`,
      kind: "send",
      state: "delivered",
    })),
    ...states.map((state) => ({ id: `pending-${state}`, kind: "send", state })),
  ];
  setHandler((name, input) =>
    name === "organization.task-manage" && input.command.action === "list"
      ? Promise.resolve(observed({ sessions: [], deliveries, taskAuthority: { allowed: true } }))
      : base(name, input),
  );
  mount(h(ManagementPanel, { theme, taskId: A, titles: {} }));
  await screen.findByText(/pending-future-unknown/);
  for (const state of states) assert(screen.getByText(new RegExp(`^send.*pending-${state}$`)));
  assert.equal(screen.queryByText(/closed-0$/) === null, true);
  fireEvent.click(screen.getByRole("button", { name: "Show resolved delivery history" }));
  assert(screen.getByText(/closed-49$/));
  assert.equal(screen.queryByText(/closed-50$/), null);
  for (const state of states) assert(screen.getByText(new RegExp(`^send.*pending-${state}$`)));
});

for (const platform of ["ios", "web"])
  test(`home-to-task selection survives tabs and stays host scoped with no usable browser storage on ${platform}`, async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw Error("Storage unavailable");
      },
    });
    try {
      setHandler((name, input) =>
        name === "organization.fleet"
          ? Promise.resolve({
              observedAt: time(),
              nodes: [],
              tasks: [entry(B, "AIN-74")],
              edges: [],
              supervisors: [],
              supervisionAvailable: true,
              total: 0,
              partial: false,
              note: "Explicit enrolled task",
            })
          : base(name, input),
      );
      const props = {
        theme,
        layout: { compact: true, platform },
        host: { id: `navigation-${platform}-one` },
      };
      const mounted = mount(h(HomeSurface, props));
      // Today opens first; Leadership is the Organisation entry point, so the workstream list is one tab across.
      fireEvent.click(await screen.findByTestId("organization-tab-organisation"));
      fireEvent.click(await screen.findByRole("button", { name: "Workstreams" }));
      fireEvent.click(
        await screen.findByRole("button", { name: "Tasks without a recorded leader" }),
      );
      fireEvent.click(
        await screen.findByRole("button", { name: "Set up leadership: Task AIN-74" }),
      );
      await screen.findByText("AIN-74 · Selected task");
      assert(
        calls.filter((c) => c.name === "organization.snapshot").every((c) => c.input.taskId === B),
      );
      fireEvent.click(screen.getByRole("button", { name: "Workstreams" }));
      fireEvent.click(screen.getByRole("button", { name: "Manage task" }));
      await screen.findByText("AIN-74 · Selected task");
      mounted.rerender(
        h(
          QueryClientProvider,
          { client: mounted.client },
          h(HomeSurface, { ...props, host: { id: `navigation-${platform}-two` } }),
        ),
      );
      // Another host has no selection of its own and no built-in default task (1bea30f2).
      await screen.findByText("Choose a task below to see its sessions.");
      assert.equal(screen.queryByText("AIN-74 · Selected task"), null);
      mounted.rerender(h(QueryClientProvider, { client: mounted.client }, h(HomeSurface, props)));
      await screen.findByText("AIN-74 · Selected task");
      assert(
        calls.every((c) => !c.input.command || ["list", "health"].includes(c.input.command.action)),
        "Selecting and opening tasks never delegates or mutates",
      );
    } finally {
      if (previous) Object.defineProperty(globalThis, "localStorage", previous);
      else delete globalThis.localStorage;
    }
  });

test("work labels resolve conversation references and keep original text selectable", () => {
  const messages = [
    {
      id: "1",
      role: "agent",
      text: `Pairing guide is ready for ${B}. Awaiting review from ${S}.`,
      truncated: false,
    },
  ];
  mount(
    h(ConversationUpdates, {
      theme,
      messages,
      historical: false,
      stale: false,
      references: new Map([
        [B, "Phone onboarding"],
        [S, "Release reviewer"],
      ]),
    }),
  );
  assert(
    screen.getByText(
      "Pairing guide is ready for Phone onboarding. Awaiting review from Release reviewer.",
    ),
  );
  assert(!document.body.textContent.includes(B));
  fireEvent.click(screen.getByRole("button", { name: "Show original text" }));
  assert(screen.getByText(messages[0].text));
});

test("unnamed sessions stay selectable by original identity and expose IDs only in evidence", async () => {
  const nodes = [B, S].map((id) => ({
    id,
    task: A,
    host: "mini",
    agentId: id,
    title: "Saved conversation",
    provider: "codex",
    model: null,
    mode: "human",
    status: "idle",
    pending: 0,
    observedAt: time(),
    updatedAt: time(),
    error: null,
  }));
  setFleetHandler((name, input) =>
    Promise.resolve(
      name === "organization.fleet"
        ? {
            observedAt: time(),
            total: 2,
            partial: false,
            note: "Fixture",
            nodes,
            tasks: [{ id: A, title: "Retained task · a0a0a0a0", identifier: null }],
            edges: [],
            supervisionAvailable: true,
            supervisors: [],
          }
        : name === "organization.projects"
          ? {
              observedAt: time(),
              available: true,
              partial: false,
              projects: [],
              membership: [],
              note: "Fixture",
            }
          : name === "organization.outcome"
            ? { observedAt: time(), record: null, artifacts: [] }
            : name === "organization.activity-history"
              ? {
                  observedAt: time(),
                  sessionId: input.sessionId,
                  taskId: input.taskId,
                  messages: [],
                  activity: [],
                  receipts: [],
                  cursor: null,
                  note: "Fixture",
                }
              : {},
    ),
  );
  const view = mount(
    h(FleetSurface, { theme, layout: { compact: true, platform: "web" }, onTask: () => {} }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Inspect Untitled mini conversation 2" }),
  );
  await waitFor(() =>
    assert(
      calls.some(
        (c) =>
          c.name === "organization.activity-history" &&
          c.input.sessionId === S &&
          c.input.taskId === A,
      ),
    ),
  );
  assert(!view.container.textContent.includes(S));
  assert(!view.container.textContent.includes("a0a0a0a0"));
  assert(screen.getAllByText(/Idle/).length > 0);
  fireEvent.click(screen.getByRole("button", { name: "Session evidence" }));
  assert(view.container.textContent.includes(S));
});

test("published decision questions remain visible in progress and detailed briefs", async () => {
  const record = {
    publishedAt: "2026-09-18T10:00:00.000Z",
    currentState: "Two approaches reviewed",
    outcome: "Simplify pairing",
    nextStep: "Choose an approach",
    coordination: { decisionNeeded: "Use a QR code or a typed address?" },
    alternatives: [],
    artifacts: [],
    decision: null,
  };
  setHandler(() =>
    Promise.resolve({ observedAt: time(), record, artifacts: [], recordSha256: "a".repeat(64) }),
  );
  const view = mount(
    h(WorkBrief, { theme, taskId: A, frozen: true, onTask: () => {}, compact: true }),
  );
  await screen.findByText("Needs your decision: Use a QR code or a typed address?");
  assert(screen.getByText("Reported progress"));
  assert(screen.getByText(/^Brief written /));
  assert.equal(screen.queryByText(/not live activity or release approval/), null);
  view.rerender(
    h(
      QueryClientProvider,
      { client: view.client },
      h(WorkBrief, { theme, taskId: A, frozen: true, onTask: () => {} }),
    ),
  );
  await screen.findByText("Use a QR code or a typed address?");
  assert.equal(screen.queryByText(/No decision has been recorded/), null);
});

test("work overview bounds brief reads and reveals additional retained tasks on demand", async () => {
  const ids = Array.from(
    { length: 9 },
    (_, i) => `77777777-7777-4777-8777-${String(i).padStart(12, "0")}`,
  );
  const nodes = ids.map((id, i) => ({
    id,
    task: id,
    host: "mini",
    agentId: id,
    title: `Author ${i + 1}`,
    provider: "codex",
    model: null,
    mode: "human",
    status: "idle",
    pending: 0,
    observedAt: time(),
    updatedAt: time(),
    error: null,
  }));
  setFleetHandler((name) =>
    Promise.resolve(
      name === "organization.fleet"
        ? {
            observedAt: time(),
            total: 9,
            partial: false,
            note: "Fixture",
            nodes,
            tasks: ids.map((id, i) => ({ id, title: `Deliverable ${i + 1}`, identifier: null })),
            edges: [],
          }
        : name === "organization.outcome"
          ? { observedAt: time(), record: null, artifacts: [] }
          : {
              observedAt: time(),
              available: true,
              partial: false,
              projects: [],
              membership: [],
              note: "Fixture",
            },
    ),
  );
  mount(h(FleetSurface, { theme, layout: { compact: true, platform: "web" }, onTask: () => {} }));
  await screen.findByRole("button", { name: "Show more work" });
  await waitFor(() =>
    assert.equal(calls.filter((c) => c.name === "organization.outcome").length, 8),
  );
  assert.equal(screen.queryByRole("button", { name: "Inspect Author 9" }), null);
  fireEvent.click(screen.getByRole("button", { name: "Show more work" }));
  await screen.findByRole("button", { name: "Inspect Author 9" });
  await waitFor(() =>
    assert.equal(calls.filter((c) => c.name === "organization.outcome").length, 9),
  );
});

test("prime leadership names the actual seated orchestrator and opens its real conversation", async () => {
  const PRIME = "33333333-3333-4333-8333-333333333333",
    LEAD = "44444444-4444-4444-8444-444444444444",
    TASK2 = "55555555-5555-4555-8555-555555555555",
    opened = [];
  const node = (id, task, title, extra = {}) => ({
    id,
    task,
    host: "mini",
    serverId: "srv_example_mini",
    agentId: id,
    title,
    provider: "claude",
    model: "opus-5",
    mode: "delegated",
    status: "running",
    pending: 0,
    observedAt: time(),
    updatedAt: time(),
    error: null,
    ...extra,
  });
  const sup = (id, task, workers) => ({
    id,
    task,
    active: true,
    maxWorkers: 4,
    reserved: 0,
    workers,
  });
  const link = (workerId) => ({
    requestId: S,
    workerId,
    phase: "running",
    ownership: "linked",
    fault: null,
    lastEvent: null,
  });
  const fleet = {
    observedAt: time(),
    total: 2,
    partial: false,
    note: "Fixture",
    supervisionAvailable: true,
    supervisors: [sup(PRIME, A, [link(LEAD)]), sup(LEAD, TASK2, [])],
    nodes: [node(PRIME, A, "Chief of staff"), node(LEAD, TASK2, "Memory lead")],
    tasks: [
      { id: A, title: "Run the portfolio", identifier: "P-1" },
      { id: TASK2, title: "Shared memory format", identifier: "P-2" },
    ],
    edges: [],
  };
  const projects = {
    observedAt: time(),
    available: true,
    partial: false,
    projects: [
      {
        id: B,
        name: "Shared memory",
        description: "Decisions that outlive a session",
        status: "in_progress",
      },
    ],
    membership: [
      { taskId: A, projectId: B },
      { taskId: TASK2, projectId: B },
    ],
    note: "Fixture",
  };
  // An explicit controller role binding, not a supervision shape.
  const seat = {
    role: "project-orchestrator",
    seat: B,
    projectId: B,
    state: "assigned",
    revision: 3,
    task: TASK2,
    sessionId: LEAD,
    session: { id: LEAD, task: TASK2, mode: "delegated", generation: 4 },
    note: "Accountable for the retained format",
    at: time(),
    membershipAt: time(),
    sessionPresent: true,
    sessionGenerationChanged: false,
    sessionTaskMatches: true,
    dispatch: { host: "mini", supported: true, reason: null },
  };
  const primeSeat = {
    ...seat,
    role: "prime",
    seat: "orca",
    projectId: null,
    task: A,
    sessionId: PRIME,
    session: { id: PRIME, task: A, mode: "delegated", generation: 2 },
  };
  const brief = {
    taskId: TASK2,
    title: "Shared memory format",
    projectId: B,
    projectName: "Shared memory",
    outcome: "One retained format",
    currentState: "Comparison ready",
    nextStep: "Publish the comparison",
    question: "Which retention window?",
    decision: null,
    publishedAt: null,
    recordSha256: "c".repeat(64),
    affects: [],
    dependencies: [],
  };
  setHandler((name) =>
    Promise.resolve(
      name === "organization.fleet"
        ? fleet
        : name === "organization.projects"
          ? projects
          : name === "organization.role-directory"
            ? {
                observedAt: time(),
                available: true,
                unavailable: null,
                primes: [primeSeat],
                projectSeats: [seat],
                programme: null,
                note: "A role binding records accountability only.",
              }
            : name === "organization.project-briefing"
              ? {
                  observedAt: time(),
                  partial: false,
                  scanned: 2,
                  total: 2,
                  missing: 1,
                  unavailable: 0,
                  nextCursor: null,
                  entries: [brief],
                }
              : name === "organization.history"
                ? {
                    observedAt: time(),
                    sessionId: LEAD,
                    taskId: TASK2,
                    note: "Coverage unverified",
                    receipts: [],
                    activity: [],
                    messages: [],
                    cursor: null,
                    hasOlder: false,
                  }
                : {
                    observedAt: time(),
                    record: null,
                    artifacts: [],
                    reviews: [],
                    status: "missing",
                    message: "No brief",
                    recordSha256: null,
                  },
    ),
  );
  mount(
    h(PrimeSurface, {
      theme,
      host: { id: "srv_example_mini" },
      layout: { compact: false, platform: "web" },
      navigation: { openAgent: () => {} },
      onTask: (id) => opened.push(id),
    }),
  );

  // The prime comes from its explicit seat, not from the nested supervisor relationship.
  await screen.findByText("MAIN ASSISTANT · orca");
  assert(
    screen.getByRole("button", {
      name: "Read retained updates from Chief of staff, main assistant orca",
    }),
  );
  // The supervision relationship is still shown, but never as the role itself.
  assert(screen.getByText("LEADS OTHER LEADERS"));

  // Clicking the project names the actual accountable session instead of a placeholder.
  fireEvent.click(screen.getByRole("button", { name: "Project overview: Shared memory" }));
  await screen.findByText("PROJECT ORCHESTRATOR");
  assert.equal(screen.queryByText("Unassigned"), null);
  assert.equal(screen.queryByText("Unknown"), null);
  assert(
    screen.getByText(
      /A recorded controller role binding names this session as the project orchestrator/,
    ),
  );
  assert(
    screen.getByText(
      /records who is accountable for the project\. It does not start, stop or message any session/,
    ),
  );
  // The real conversation of the assigned leader is reachable from the project.
  assert(
    screen.getByRole("button", {
      name: "Read retained updates from Memory lead, project orchestrator",
    }),
  );
  assert(screen.getByRole("button", { name: "Talk to Memory lead, project orchestrator" }));
  assert(screen.getByRole("button", { name: "Change who is accountable for Shared memory" }));
  assert(screen.getByText(/1 of 2 workstreams have a published brief/));
  fireEvent.click(screen.getByRole("button", { name: "Open decision work: Shared memory format" }));
  assert.deepEqual(opened, [TASK2]);

  // Sessions remain a drill-down and return without losing the project.
  fireEvent.click(
    screen.getByRole("button", {
      name: "Read retained updates from Memory lead, project orchestrator",
    }),
  );
  await screen.findByText("SELECTED SESSION");
  fireEvent.click(screen.getByRole("button", { name: "Back to leadership" }));
  await screen.findByText("PROJECT ORCHESTRATOR");
});

test("prime leadership keeps an unreadable binding table distinct from an empty seat", async () => {
  const node = {
    id: A,
    task: B,
    host: "mini",
    serverId: "srv_example_mini",
    agentId: A,
    title: "Saved conversation one",
    provider: "codex",
    model: null,
    mode: "human",
    status: "idle",
    pending: 0,
    observedAt: time(),
    updatedAt: time(),
    error: null,
  };
  const fleet = {
    observedAt: time(),
    total: 1,
    partial: false,
    note: "Fixture",
    supervisionAvailable: true,
    supervisors: [{ id: A, task: B, active: true, maxWorkers: 4, reserved: 0, workers: [] }],
    nodes: [node],
    tasks: [{ id: B, title: "Unled work", identifier: null }],
    edges: [],
  };
  setHandler((name) =>
    Promise.resolve(
      name === "organization.fleet"
        ? fleet
        : name === "organization.projects"
          ? {
              observedAt: time(),
              available: true,
              partial: false,
              projects: [{ id: S, name: "Orca", description: null, status: "in_progress" }],
              membership: [{ taskId: B, projectId: S }],
              note: "Fixture",
            }
          : name === "organization.role-directory"
            ? {
                observedAt: time(),
                available: false,
                unavailable: "Unknown method bindings-status",
                primes: [],
                projectSeats: [],
                programme: null,
                note: "Recorded leadership roles could not be read, so no orchestrator can be named or ruled out here.",
              }
            : {
                observedAt: time(),
                partial: false,
                scanned: 0,
                total: 0,
                missing: 0,
                unavailable: 0,
                nextCursor: null,
                entries: [],
              },
    ),
  );
  mount(
    h(PrimeSurface, {
      theme,
      host: { id: "srv_example_mini" },
      layout: { compact: true, platform: "ios" },
      navigation: { openAgent: () => {} },
      onTask: () => assert.fail("No navigation expected"),
    }),
  );
  // Await the loaded refusal, not the identical pending sentence.
  await screen.findByText(/Controller reported: Unknown method bindings-status/);
  assert(
    screen.getByText(
      /Fulcra could not read who leads what, so it cannot say whether a main assistant is set/,
    ),
  );
  assert.equal(screen.queryByText(/MAIN ASSISTANT ·/), null);
  fireEvent.click(await screen.findByRole("button", { name: "Project overview: Orca" }));
  await screen.findByText("Unknown");
  // The crucial distinction: unreadable is not empty, and no seat action is offered.
  assert.equal(screen.queryByText("Unassigned"), null);
  assert(screen.getByText(/not the same as the seat being empty/));
  assert.equal(screen.queryByRole("button", { name: "Record who is accountable for Orca" }), null);
  assert(
    screen.getByText(
      /Recording an orchestrator is unavailable while leadership role records cannot be read/,
    ),
  );
});

test("prime leadership reports paged brief coverage and published status instead of claiming none", async () => {
  const PRIME = "33333333-3333-4333-8333-333333333333",
    TASK2 = "55555555-5555-4555-8555-555555555555",
    CURSOR = "66666666-6666-4666-8666-666666666666";
  const node = (id, task, title) => ({
    id,
    task,
    host: "mini",
    serverId: "srv_example_mini",
    agentId: id,
    title,
    provider: "claude",
    model: "opus-5",
    mode: "delegated",
    status: "running",
    pending: 0,
    observedAt: time(),
    updatedAt: time(),
    error: null,
  });
  const fleet = {
    observedAt: time(),
    total: 1,
    partial: false,
    note: "Fixture",
    supervisionAvailable: true,
    supervisors: [{ id: PRIME, task: A, active: true, maxWorkers: 4, reserved: 0, workers: [] }],
    nodes: [node(PRIME, A, "Chief of staff")],
    tasks: [
      { id: A, title: "Run the portfolio", identifier: "P-1" },
      { id: TASK2, title: "Shared memory format", identifier: "P-2" },
    ],
    edges: [],
  };
  const projects = {
    observedAt: time(),
    available: true,
    partial: false,
    projects: [{ id: B, name: "Shared memory", description: null, status: "in_progress" }],
    membership: [
      { taskId: A, projectId: B },
      { taskId: TASK2, projectId: B },
    ],
    note: "Fixture",
  };
  const brief = {
    taskId: TASK2,
    title: "Shared memory format",
    projectId: B,
    projectName: "Shared memory",
    outcome: "One retained format for decisions",
    currentState: "Comparison of three formats is ready",
    nextStep: null,
    question: null,
    decision: null,
    publishedAt: null,
    recordSha256: "c".repeat(64),
    affects: [],
    dependencies: [],
  };
  setHandler((name) =>
    Promise.resolve(
      name === "organization.fleet"
        ? fleet
        : name === "organization.projects"
          ? projects
          : name === "organization.project-briefing"
            ? {
                observedAt: time(),
                partial: true,
                scanned: 2,
                total: 11,
                missing: 3,
                unavailable: 1,
                nextCursor: CURSOR,
                entries: [brief],
              }
            : base(name, {}),
    ),
  );
  mount(
    h(PrimeSurface, {
      theme,
      host: { id: "srv_example_mini" },
      layout: { compact: false, platform: "web" },
      navigation: { openAgent: () => {} },
      onTask: () => {},
    }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Project overview: Shared memory" }));
  await screen.findByText("PROJECT ORCHESTRATOR");
  // A page is not the deployment: the unbriefed workstream is unknown here, never asserted absent.
  assert.equal(screen.queryByText(/1 have none, so their progress is unknown here/), null);
  assert.equal(screen.queryByText(/has none, so their progress is unknown here/), null);
  assert(
    screen.getByText(
      /2 of 11 recorded tasks were checked on this page; 3 have no published brief and 1 could not be read/,
    ),
  );
  assert(screen.getByText(/Progress for the rest is unknown, not absent/));
  assert(screen.getByText(/Only the first page of published briefs was read here/));
  // What is happening now states what is actually happening, not only a count.
  assert(screen.getByText("One retained format for decisions"));
  assert(screen.getByText("Comparison of three formats is ready"));
});

test("prime leadership leaves project reach and membership unknown when the directory cannot be read", async () => {
  const PRIME = "33333333-3333-4333-8333-333333333333",
    LEAD = "44444444-4444-4444-8444-444444444444",
    TASK2 = "55555555-5555-4555-8555-555555555555";
  const node = (id, task, title) => ({
    id,
    task,
    host: "mini",
    serverId: "srv_example_mini",
    agentId: id,
    title,
    provider: "claude",
    model: "opus-5",
    mode: "delegated",
    status: "running",
    pending: 0,
    observedAt: time(),
    updatedAt: time(),
    error: null,
  });
  const fleet = {
    observedAt: time(),
    total: 2,
    partial: false,
    note: "Fixture",
    supervisionAvailable: true,
    supervisors: [
      {
        id: PRIME,
        task: A,
        active: true,
        maxWorkers: 4,
        reserved: 0,
        workers: [
          {
            requestId: S,
            workerId: LEAD,
            phase: "running",
            ownership: "linked",
            fault: null,
            lastEvent: null,
          },
        ],
      },
      { id: LEAD, task: TASK2, active: true, maxWorkers: 4, reserved: 0, workers: [] },
    ],
    nodes: [node(PRIME, A, "Chief of staff"), node(LEAD, TASK2, "Memory lead")],
    tasks: [
      { id: A, title: "Run the portfolio", identifier: "P-1" },
      { id: TASK2, title: "Shared memory format", identifier: "P-2" },
    ],
    edges: [],
  };
  setHandler((name) =>
    Promise.resolve(
      name === "organization.fleet"
        ? fleet
        : name === "organization.projects"
          ? {
              observedAt: time(),
              available: false,
              partial: false,
              projects: [],
              membership: [],
              note: "Directory unreadable",
            }
          : base(name, {}),
    ),
  );
  mount(
    h(PrimeSurface, {
      theme,
      host: { id: "srv_example_mini" },
      layout: { compact: false, platform: "web" },
      navigation: { openAgent: () => {} },
      onTask: () => {},
    }),
  );
  await screen.findByText("Chief of staff");
  // A failed directory read cannot establish that this leader reaches no project.
  assert.equal(screen.queryByText(/none of them linked to a recorded project/), null);
  assert(
    screen.getByText(/project grouping is unavailable, so this leader's project reach is unknown/),
  );
  assert(screen.getByText(/no leader's project reach can be established from this read/));
});

test("prime leadership separates a hierarchy deeper than the traversal limit from a leadership loop", async () => {
  const id = (n) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
  const supervisors = Array.from({ length: 70 }, (_, i) => ({
    id: id(100 + i),
    task: id(200 + i),
    active: true,
    maxWorkers: 4,
    reserved: 0,
    workers: [
      {
        requestId: S,
        workerId: id(101 + i),
        phase: "running",
        ownership: "linked",
        fault: null,
        lastEvent: null,
      },
    ],
  }));
  const nodes = [
    {
      id: id(100),
      task: id(200),
      host: "mini",
      serverId: "srv_example_mini",
      agentId: id(100),
      title: "Chief of staff",
      provider: "claude",
      model: "opus-5",
      mode: "delegated",
      status: "running",
      pending: 0,
      observedAt: time(),
      updatedAt: time(),
      error: null,
    },
  ];
  const fleet = {
    observedAt: time(),
    total: 1,
    partial: false,
    note: "Fixture",
    supervisionAvailable: true,
    supervisors,
    nodes,
    tasks: [{ id: id(200), title: "Run the portfolio", identifier: "P-1" }],
    edges: [],
  };
  setHandler((name) => Promise.resolve(name === "organization.fleet" ? fleet : base(name, {})));
  mount(
    h(PrimeSurface, {
      theme,
      host: { id: "srv_example_mini" },
      layout: { compact: false, platform: "web" },
      navigation: { openAgent: () => {} },
      onTask: () => {},
    }),
  );
  await screen.findByText("Chief of staff");
  assert(screen.getByText(/across at least 64 workstreams/));
  assert(
    screen.getByText(
      /Leadership beyond 64 recorded sessions was not followed; the counts above are a lower bound/,
    ),
  );
  // Truncation is not a loop, and must not send the user to management to find one.
  assert.equal(screen.queryByText(/Some leadership links loop back/), null);
});

test("a selected project that leaves the observation is stated, not silently dropped", async () => {
  const projectId = "33333333-3333-4333-8333-333333333333";
  const directory = {
    observedAt: time(),
    available: true,
    partial: false,
    projects: [{ id: projectId, name: "Shared memory", description: null, status: "in_progress" }],
    membership: [{ taskId: A, projectId }],
    note: "Fixture",
  };
  const fleet = {
    observedAt: time(),
    total: 0,
    partial: false,
    note: "Fixture",
    supervisionAvailable: true,
    supervisors: [],
    nodes: [],
    tasks: [{ id: A, title: "Retained work", identifier: "AIN-73" }],
    edges: [],
  };
  setHandler((name) =>
    Promise.resolve(
      name === "organization.fleet"
        ? fleet
        : name === "organization.projects"
          ? directory
          : base(name, {}),
    ),
  );
  const view = mount(
    h(PrimeSurface, {
      theme,
      layout: { compact: true },
      navigation: { openAgent: () => {} },
      onTask: () => assert.fail("No control"),
    }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Project overview: Shared memory" }));
  await screen.findByText("PROJECT ORCHESTRATOR");
  await act(async () =>
    view.client.setQueryData(["orca-projects", undefined], {
      ...directory,
      observedAt: time(),
      projects: [],
      membership: [],
    }),
  );
  await screen.findByText(/The project you opened is no longer in the current observation/);
  assert.equal(screen.queryByText("PROJECT ORCHESTRATOR"), null);
});

test("leadership and workstreams read one shared observation rather than a private copy each", async () => {
  const fleet = {
    observedAt: time(),
    total: 0,
    partial: false,
    note: "Fixture",
    supervisionAvailable: true,
    supervisors: [],
    nodes: [],
    tasks: [{ id: A, title: "Retained work", identifier: "AIN-73" }],
    edges: [],
  };
  setHandler((name, input) =>
    name === "organization.fleet" ? Promise.resolve(fleet) : base(name, input),
  );
  const props = {
    theme,
    layout: { compact: true },
    navigation: { openAgent: () => {}, openAgentOnHost: () => "requested" },
    onTask: () => {},
  };
  mount(h(React.Fragment, null, h(PrimeSurface, props), h(PortfolioSurface, props)));
  await screen.findByText("Who leads your work");
  await waitFor(() => assert(calls.some((c) => c.name === "organization.projects")));
  // One cache entry per read, so a refresh on either tab cannot leave the other stale.
  assert.equal(calls.filter((c) => c.name === "organization.fleet").length, 1);
  assert.equal(calls.filter((c) => c.name === "organization.projects").length, 1);
});

test("clicking a project shows its goal, progress and needs, and asks the orchestrator for a session", async () => {
  const LEAD = "44444444-4444-4444-8444-444444444444",
    TASK2 = "55555555-5555-4555-8555-555555555555",
    OWNED = "77777777-7777-4777-8777-777777777777",
    sent = [];
  const node = (id, task, title, agentId) => ({
    id,
    task,
    host: "mini",
    serverId: "srv_example_mini",
    agentId: agentId ?? id,
    title,
    provider: "claude",
    model: "opus-5",
    mode: "delegated",
    status: "running",
    pending: 0,
    observedAt: time(),
    updatedAt: time(),
    error: null,
  });
  const fleet = {
    observedAt: time(),
    total: 2,
    partial: false,
    note: "Fixture",
    supervisionAvailable: true,
    supervisors: [],
    nodes: [
      node(LEAD, TASK2, "Memory lead"),
      node(OWNED, TASK2, "Retention comparison", "agent-owned"),
    ],
    tasks: [{ id: TASK2, title: "Shared memory format", identifier: "P-2" }],
    edges: [],
  };
  const projects = {
    observedAt: time(),
    available: true,
    partial: false,
    projects: [{ id: B, name: "Shared memory", description: null, status: "in_progress" }],
    membership: [{ taskId: TASK2, projectId: B }],
    note: "Fixture",
  };
  const seat = {
    role: "project-orchestrator",
    seat: B,
    projectId: B,
    state: "assigned",
    revision: 3,
    task: TASK2,
    sessionId: LEAD,
    session: { id: LEAD, task: TASK2, mode: "delegated", generation: 4 },
    note: "Accountable for the retained format",
    at: time(),
    membershipAt: time(),
    sessionPresent: true,
    sessionGenerationChanged: false,
    sessionTaskMatches: true,
    dispatch: { host: "mini", supported: true, reason: null },
  };
  const projection = {
    observedAt: time(),
    available: true,
    unavailable: null,
    projectId: B,
    summary: {
      id: B,
      name: "Shared memory",
      description: "One retained format for decisions that outlive a session",
      status: "in_progress",
    },
    membership: {
      known: true,
      available: true,
      partial: false,
      observedAt: time(),
      memberTaskCount: 1,
      truncated: false,
      note: "Fixture",
    },
    leader: seat,
    primes: [],
    progress: {
      memberTasks: 1,
      recorded: 4,
      unresolved: 1,
      sessions: 2,
      truncated: false,
      basis: "Journal activity, not work completed or accepted.",
    },
    needed: [
      {
        kind: "no-prime",
        detail: "No prime seat is filled, so this project has no recorded escalation address",
        taskId: null,
        sessionId: null,
        at: null,
      },
    ],
    blockers: [
      {
        kind: "unresolved-delivery",
        detail: "Recorded work has no confirmed outcome",
        taskId: TASK2,
        sessionId: OWNED,
        at: null,
      },
    ],
    sessions: [
      { sessionId: OWNED, taskId: TASK2, mode: "delegated", generation: 2 },
      { sessionId: LEAD, taskId: TASK2, mode: "delegated", generation: 4 },
    ],
    note: "A role binding records accountability only.",
  };
  setHandler((name, input) => {
    if (name === "organization.project-request-session") {
      sent.push(input);
      return Promise.resolve({
        status: "unavailable",
        message:
          "This controller does not expose seat session requests yet, so work cannot be routed through a project orchestrator here. Nothing was requested.",
        observedAt: time(),
        requestId: null,
        state: null,
        grantsAuthority: false,
      });
    }
    if (name === "organization.project-session-requests")
      return Promise.resolve({
        observedAt: time(),
        available: true,
        unavailable: null,
        requests: [
          {
            requestId: S,
            seat: B,
            seatRole: "project-orchestrator",
            taskId: TASK2,
            provider: "claude",
            title: "Earlier ask",
            state: "pending",
            sessionId: null,
            at: time(),
            detail: "The seat has been woken",
          },
        ],
      });
    if (name === "organization.role-allowances")
      return Promise.resolve({
        observedAt: time(),
        available: true,
        unavailable: null,
        allowances: [
          {
            seat: B,
            role: "project-orchestrator",
            revision: 3,
            limit: 4,
            used: 1,
            remaining: 3,
            current: true,
            detail: null,
          },
        ],
      });
    if (name === "organization.session-ownership")
      return Promise.resolve({
        ownership: {
          "agent-owned": {
            projectId: B,
            projectName: "Shared memory",
            taskId: TASK2,
            taskTitle: "Shared memory format",
            leaderAgentId: null,
            leaderTitle: null,
            state: "declared",
            detail:
              "An operator declared the project at creation, so it is owned by the project but led by no recorded leader.",
          },
        },
      });
    if (name === "organization.role-adopt") {
      sent.push(["adopt", input]);
      return Promise.resolve({
        status: "unavailable",
        message:
          "This controller does not expose adoption yet, so a declared session cannot be placed under a seat here. Nothing was changed.",
        observedAt: time(),
        sessionId: null,
        seat: null,
        remaining: null,
        grantsAuthority: false,
      });
    }
    return Promise.resolve(
      name === "organization.fleet"
        ? fleet
        : name === "organization.projects"
          ? projects
          : name === "organization.role-directory"
            ? {
                observedAt: time(),
                available: true,
                unavailable: null,
                primes: [],
                projectSeats: [seat],
                programme: null,
                note: "n",
              }
            : name === "organization.role-project"
              ? projection
              : {
                  observedAt: time(),
                  partial: false,
                  scanned: 1,
                  total: 1,
                  missing: 0,
                  unavailable: 0,
                  nextCursor: null,
                  entries: [],
                },
    );
  });
  mount(
    h(PrimeSurface, {
      theme,
      host: { id: "srv_example_mini" },
      layout: { compact: false, platform: "web" },
      navigation: { openAgent: () => {} },
      onTask: () => {},
    }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Project overview: Shared memory" }));

  // The goal and progress are the controller's own, with the basis of the count attached.
  await screen.findByText("One retained format for decisions that outlive a session");
  assert(
    screen.getByText(
      /4 recorded deliveries across 1 confirmed workstream, 2 sessions, 1 unresolved/,
    ),
  );
  assert(screen.getByText(/Journal activity, not work completed or accepted/));
  assert(screen.getByText(/Recorded work has no confirmed outcome/));

  // Membership is stated as membership; ownership is a separate read and is not claimed here.
  assert(screen.getByText(/Being on a member workstream is membership, not ownership/));
  // An outstanding request is visible, and is not presented as a session.
  assert(screen.getByText("Earlier ask"));
  assert(screen.getByText(/A request is not a session/));

  // The seat's allowance is stated before the operator is asked to write a reason.
  assert(await screen.findByText(/Session allowance: 3 remaining of 4 at seat revision 3/));

  // A declared session is offered for adoption, and adoption is named as spending allowance.
  assert(await screen.findByText(/Owned by this project, led by nobody/));
  assert(screen.getByText(/led by no recorded leader/));
  assert(screen.getByText(/adopting spends the seat's session allowance/));

  // Starting work routes through the seat and reports an unavailable controller honestly.
  fireEvent.click(
    screen.getByRole("button", { name: "Workstream for new work: Shared memory format" }),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "New work title" }), {
    target: { value: "Compare retention windows" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "Why this work belongs to this project" }), {
    target: { value: "Owned by the shared memory project" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Ask this project's orchestrator for a session" }),
  );
  await screen.findByText(/does not expose seat session requests yet/);
  assert.equal(sent.length, 1);
  // The app names the seat and workstream only; it mints no identity and claims no ownership.
  assert.equal(sent[0].seat, B);
  assert.equal(sent[0].expectedRevision, 3);
  assert.equal(sent[0].taskId, TASK2);
  assert.equal("sessionId" in sent[0], false);
  assert.equal("ownership" in sent[0], false);
  assert.equal("projectId" in sent[0], false);
});

test("an unassigned project offers assigning an orchestrator instead of a permanent placeholder", async () => {
  const TASK2 = "55555555-5555-4555-8555-555555555555";
  const fleet = {
    observedAt: time(),
    total: 0,
    partial: false,
    note: "Fixture",
    supervisionAvailable: true,
    supervisors: [],
    nodes: [],
    tasks: [{ id: TASK2, title: "Shared memory format", identifier: "P-2" }],
    edges: [],
  };
  const projects = {
    observedAt: time(),
    available: true,
    partial: false,
    projects: [{ id: B, name: "Shared memory", description: null, status: "in_progress" }],
    membership: [{ taskId: TASK2, projectId: B }],
    note: "Fixture",
  };
  const vacant = {
    role: "project-orchestrator",
    seat: B,
    projectId: B,
    state: "vacant",
    revision: 2,
    task: null,
    sessionId: null,
    session: null,
    note: null,
    at: null,
    membershipAt: null,
    sessionPresent: false,
    sessionGenerationChanged: false,
    sessionTaskMatches: false,
    dispatch: null,
  };
  setHandler((name) =>
    Promise.resolve(
      name === "organization.fleet"
        ? fleet
        : name === "organization.projects"
          ? projects
          : name === "organization.role-directory"
            ? {
                observedAt: time(),
                available: true,
                unavailable: null,
                primes: [],
                projectSeats: [vacant],
                programme: null,
                note: "n",
              }
            : name === "organization.role-project"
              ? {
                  observedAt: time(),
                  available: true,
                  unavailable: null,
                  projectId: B,
                  summary: {
                    id: B,
                    name: "Shared memory",
                    description: null,
                    status: "in_progress",
                  },
                  membership: null,
                  leader: vacant,
                  primes: [],
                  progress: null,
                  needed: [],
                  blockers: [],
                  sessions: [],
                  note: "n",
                }
              : name === "organization.project-session-requests"
                ? { observedAt: time(), available: true, unavailable: null, requests: [] }
                : name === "organization.role-allowances"
                  ? { observedAt: time(), available: true, unavailable: null, allowances: [] }
                  : name === "organization.session-ownership"
                    ? { ownership: {} }
                    : {
                        observedAt: time(),
                        partial: false,
                        scanned: 0,
                        total: 0,
                        missing: 0,
                        unavailable: 0,
                        nextCursor: null,
                        entries: [],
                      },
    ),
  );
  mount(
    h(PrimeSurface, {
      theme,
      host: { id: "srv_example_mini" },
      layout: { compact: false, platform: "web" },
      navigation: { openAgent: () => {} },
      onTask: () => {},
    }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Project overview: Shared memory" }));
  await screen.findByText(
    /This project has no assigned orchestrator, so work cannot be routed through one/,
  );
  // The empty state is an action, not a dead label.
  fireEvent.click(screen.getByRole("button", { name: "Assign an orchestrator for Shared memory" }));
  await screen.findByText("Who is accountable for Shared memory");
  assert(screen.getByRole("button", { name: "Record this session as accountable" }));
  assert.equal(
    screen.queryByRole("button", { name: "Ask this project's orchestrator for a session" }),
    null,
  );
});

test("Recovery: the cards directly under the headline are the headline restart; older ones follow under their own label", async () => {
  const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const card = (n, since, boot, extra = {}) => ({
    interruptionId: U(100 + n),
    sessionId: U(n),
    task: null,
    mode: "human",
    generation: 3,
    cause: "boot",
    state: "idle-at-restart",
    turn: "ended",
    since,
    previousBoot: null,
    observedBoot: boot,
    doing: null,
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
  const items = [
    card(1, "2026-09-23T23:32:16.281Z", "boot-h2"),
    card(2, "2026-09-24T07:16:45.922Z", "boot-h4"),
    card(3, "2026-09-24T07:16:46.239Z", "boot-h4"),
  ];
  setHandler((name) => {
    assert.equal(name, "organization.recovery");
    return Promise.resolve({
      status: "observed",
      observedAt: time(),
      recovery: { items, unsettled: [], error: null, note: "" },
    });
  });
  mount(
    h(RecoveryBanner, {
      theme,
      navigation: null,
      titles: { [U(1)]: "H2 worker", [U(2)]: "H4 worker", [U(3)]: "H4 orchestrator" },
    }),
  );
  const toggle = await screen.findByRole("button", {
    name: /^Recovery: Host restart at 24 Sep 07:16 UTC: 2 sessions interrupted/,
  });
  fireEvent.click(toggle);
  const latest = screen.getByTestId("recovery-section-latest"),
    earlier = screen.getByTestId("recovery-section-earlier");
  assert.match(latest.textContent, /H4 worker/);
  assert.match(latest.textContent, /H4 orchestrator/);
  assert.doesNotMatch(latest.textContent, /H2 worker|23 Sep/);
  assert.match(earlier.textContent, /^Earlier restarts and other takeovers/);
  assert.match(earlier.textContent, /H2 worker/);
  assert.equal(
    calls.filter((c) => c.name !== "organization.recovery").length,
    0,
    "reading and opening details calls nothing else",
  );
});

// J0 (J7 walkthrough #2): during a controller stall the tabs went empty. A tab that is opened again after its query
// cache is gone, while reads miss their deadline, shows the last good result with one plain notice.
test("Sessions keeps the last good list through a stall, even after its cache is gone, and says so plainly", async () => {
  const at = time(),
    data = {
      observedAt: at,
      total: 1,
      partial: false,
      note: "Fixture",
      nodes: [
        {
          id: S,
          task: A,
          host: "mini",
          agentId: S,
          title: "Steady author",
          provider: "claude",
          mode: "delegated",
          status: "idle",
          pending: 0,
        },
      ],
      tasks: [{ id: A, title: "Owned task", identifier: "AIN-73" }],
      edges: [],
    };
  let stalled = false;
  setFleetHandler((name) =>
    name === "organization.fleet"
      ? stalled
        ? Promise.reject(
            new Error(
              "organization.fleet did not finish within 20 s; the controller or daemon is slow to answer. Refresh to try again.",
            ),
          )
        : Promise.resolve(data)
      : Promise.resolve({
          observedAt: at,
          available: true,
          partial: false,
          projects: [],
          membership: [],
          note: "",
        }),
  );
  const first = mount(
    h(FleetSurface, { theme, layout: { compact: false, platform: "web" }, onTask() {} }),
  );
  await screen.findByRole("button", { name: "Inspect Steady author" });
  first.unmount();
  first.client.clear();
  stalled = true;
  mount(h(FleetSurface, { theme, layout: { compact: false, platform: "web" }, onTask() {} }));
  await screen.findByText(/^Last updated just now · Fulcra is slow to answer; retrying/);
  assert(
    screen.getByRole("button", { name: "Inspect Steady author" }),
    "the last good list, not an empty tab",
  );
});

// J0-8 (R-A): a task opened from Sessions opens the Manage task sheet, and Back returns to Sessions, not Organisation.
test("Manage task opened from Sessions keeps its tab id and Back returns to Sessions", async () => {
  const nodes = [
    {
      id: S,
      task: A,
      host: "mini",
      agentId: S,
      title: "Steady author",
      provider: "claude",
      mode: "delegated",
      status: "idle",
      pending: 0,
      observedAt: time(),
      updatedAt: time(),
    },
  ];
  setFleetHandler((name, input) =>
    name === "organization.fleet"
      ? Promise.resolve({
          observedAt: time(),
          total: 1,
          partial: false,
          note: "Fixture",
          nodes,
          tasks: [{ id: A, title: "Owned task", identifier: "AIN-73" }],
          edges: [],
        })
      : base(name, input),
  );
  mount(
    h(HomeSurface, {
      theme,
      layout: { compact: true, platform: "web" },
      host: { id: "sheet-host" },
    }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "More views" }));
  fireEvent.click(await screen.findByTestId("organization-tab-sessions"));
  fireEvent.click(await screen.findByRole("button", { name: "Inspect Steady author" }));
  fireEvent.click(await screen.findByRole("button", { name: "Open task decisions and work" }));
  const back = await screen.findByRole("button", { name: "Back to Sessions" });
  assert.equal(screen.getByTestId("organization-tab-task").getAttribute("aria-selected"), "true");
  assert.equal(
    screen.getByTestId("organization-tab-organisation").getAttribute("aria-selected"),
    "true",
    "the sheet lives inside Organisation",
  );
  fireEvent.click(back);
  await waitFor(() =>
    assert.equal(
      screen.getByTestId("organization-tab-sessions").getAttribute("aria-selected"),
      "true",
    ),
  );
  assert.equal(screen.queryByTestId("organization-sheet-back"), null);
});

test("Changes is visible and older hosts get plain navigation instructions", async () => {
  setHandler(() => Promise.reject(Error("Fixture read unavailable")));
  mount(
    h(HomeSurface, { theme, layout: { compact: false, platform: "web" }, host: { id: "fixture" } }),
  );
  fireEvent.click(await screen.findByTestId("organization-tab-changes"));
  assert(screen.getByTestId("changes-entry"));
  assert.match(
    screen.getByTestId("changes-navigation-unavailable").textContent,
    /Architecture map/,
  );
});

test("a broken session view leaves tabs usable and retry is scoped to that view", async () => {
  setFleetHandler((name, input) =>
    name === "organization.fleet"
      ? Promise.resolve({
          observedAt: time(),
          total: 1,
          partial: false,
          nodes: [null],
          tasks: [],
          edges: [],
          note: "Broken observation",
        })
      : base(name, input),
  );
  mount(
    h(HomeSurface, {
      theme,
      layout: { compact: false, platform: "web" },
      host: { id: "broken-tab" },
    }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "More views" }));
  fireEvent.click(await screen.findByTestId("organization-tab-sessions"));
  await screen.findByRole("button", { name: "Retry this view" });
  assert(screen.getByTestId("organization-tab-today"));
  fireEvent.click(screen.getByTestId("organization-tab-changes"));
  assert(screen.getByTestId("changes-entry"));
  assert.equal(screen.queryByRole("button", { name: "Retry this view" }), null);
});

test("Sessions sends paging and search to the server and replaces the displayed page", async () => {
  const makeNode = (id, title) => ({
    id,
    task: A,
    host: "mini",
    agentId: id,
    title,
    provider: "codex",
    mode: "human",
    status: "idle",
    pending: 0,
  });
  setHandler(async (name, input) => {
    if (name !== "organization.fleet") return base(name, input);
    const older = input.offset === 64 || input.search === "Quiet session";
    return {
      observedAt: time(),
      total: 100,
      matching: input.search ? 1 : 100,
      partial: false,
      note: "Fixture",
      nodes: [makeNode(older ? B : S, older ? "Quiet session" : "Recent session")],
      tasks: [{ id: A, title: "Fixture work" }],
      edges: [],
      nextOffset: older ? null : 64,
    };
  });
  mount(
    h(FleetSurface, {
      theme,
      layout: { compact: false, platform: "web" },
      host: { id: "paging-fixture" },
      onTask: () => {},
    }),
  );
  await screen.findByRole("button", { name: "Inspect Recent session" });
  fireEvent.click(screen.getByRole("button", { name: "Next sessions" }));
  await screen.findByRole("button", { name: "Inspect Quiet session" });
  assert.equal(screen.queryByRole("button", { name: "Inspect Recent session" }), null);
  assert(calls.some((c) => c.name === "organization.fleet" && c.input.offset === 64));
  fireEvent.change(screen.getByRole("textbox", { name: "Find work" }), {
    target: { value: "Quiet session" },
  });
  await waitFor(() =>
    assert(
      calls.some(
        (c) =>
          c.name === "organization.fleet" &&
          c.input.search === "Quiet session" &&
          c.input.offset === 0,
      ),
    ),
  );
  await screen.findByRole("button", { name: "Inspect Quiet session" });
});

test("controller retry remains reachable before any task can be loaded", async () => {
  let ready = false;
  const selected = [];
  setHandler((name, input) => {
    if (name === "organization.manage") {
      if (input.action === "retry-controller") ready = true;
      return Promise.resolve({
        status: ready ? "observed" : "error",
        message: ready
          ? "Controller connection confirmed"
          : "Controller failed. Retry when startup is complete.",
        observedAt: time(),
      });
    }
    if (name === "organization.tasks") return Promise.reject(Error("Controller unavailable"));
    return Promise.resolve({ status: "error", message: "Unavailable", observedAt: time() });
  });
  mount(h(TaskControls, { theme, selected: "", onSelect: (id) => selected.push(id) }));
  const retry = await screen.findByRole("button", { name: "Retry controller" });
  fireEvent.click(retry);
  await waitFor(() =>
    assert.equal(screen.queryByRole("button", { name: "Retry controller" }), null),
  );
  assert.deepEqual(selected, []);
  assert(
    calls.some((c) => c.name === "organization.manage" && c.input.action === "retry-controller"),
  );
});

function intakeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fulcra-intake-ui-")),
    store = new OrganizationStore(path.join(root, "state.sqlite"));
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const host = "srv_example_book",
    company = "srv_example_mini",
    ship = { serverId: host, projectId: "prj_ship", name: "Ship It" },
    demo = { serverId: host, projectId: "prj_demo", name: "Demo Day" };
  const update = (command) =>
    store.mutate({ requestId: randomUUID(), expectedRevision: store.read().revision, command });
  update({ action: "create-workspace", name: "AI Game Dev", prime: null });
  const workspaceId = store.read().workspaces[0].id;
  for (const project of [ship, demo]) update({ action: "add-project", workspaceId, project });
  const created = [],
    opened = [];
  const contexts = [ship, demo].map((project) => ({
    id: `wks_${project.projectId}`,
    projectId: project.projectId,
    name: "main",
    status: "idle",
    workspaceDirectory: `/fixture/${project.projectId}`,
    projectRootPath: `/fixture/${project.projectId}`,
  }));
  const api = {
    projects: {
      list: async () => ({
        projects: [ship, demo].map((project) => ({
          projectId: project.projectId,
          projectDisplayName: project.name,
        })),
      }),
      create: () => assert.fail("No project allocation"),
    },
    workspaces: {
      list: async () => ({ entries: contexts, pageInfo: { hasMore: false } }),
      create: () => assert.fail("No workspace allocation"),
      ref: (id) => ({
        refresh: async () => contexts.find((context) => context.id === id),
        agents: {
          create: async (options) => {
            created.push({ workspaceId: id, options });
            return { id: options.agentId };
          },
        },
      }),
    },
    agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) },
    providers: {
      snapshot: async (options) => {
        assert(contexts.some((context) => context.workspaceDirectory === options?.cwd));
        return {
          entries: [
            {
              provider: "codex",
              label: "Codex",
              defaultModeId: "auto-review",
              modes: [{ id: "auto-review", label: "Auto review" }],
              enabled: true,
              status: "ready",
              models: [
                {
                  id: "gpt-6.1-sol",
                  provider: "codex",
                  label: "GPT-6.1 Sol",
                  thinkingOptions: [{ id: "high", label: "High" }],
                },
              ],
            },
          ],
        };
      },
    },
  };
  setNativeHostCatalog(
    [{ serverId: host, label: "Book", status: "online" }],
    new Map([[host, api]]),
  );
  setHandler((name, input) => {
    if (name === "organization.workspace.get_directory.request") return store.read();
    if (name === "organization.workspace.update.request") return store.mutate(input);
    if (name === "organization.session-defaults") return { roles: {}, modes: {} };
    throw Error(`Unexpected intake RPC ${name}`);
  });
  const intakeId = randomUUID();
  const props = {
    theme,
    host: { id: company, label: "Mini" },
    layout: { compact: false, platform: "web" },
    organizationDraft: {
      id: intakeId,
      text: "Improve Ship It onboarding",
      setText() {},
      bindSource() {},
    },
    navigation: {
      openAgentOnHost: (input) => {
        opened.push(input);
        return "requested";
      },
    },
    organizationNavigation: { canReuseContext: () => true },
  };
  return { store, update, workspaceId, ship, demo, created, opened, props, intakeId, host };
}
test("company intake visibly owns a named request and starts one chat in its existing Book context", async (t) => {
  const f = intakeFixture(t);
  mount(h(IntakeSurface, f.props));
  await screen.findByText(/Responsible intake: you/);
  const start = await screen.findByRole("button", { name: "Start chat in Ship It" });
  await waitFor(() => assert.equal(start.disabled, false));
  fireEvent.click(start);
  await waitFor(() => assert.equal(f.store.read().intakes[0].conversations[0].state, "created"));
  await waitFor(() => assert.equal(screen.queryByText("Updating this retained request…"), null));
  await screen.findByRole("button", { name: "Open original conversation (same history)" });
  assert.equal(f.created[0].workspaceId, "wks_prj_ship");
  assert.equal(f.created[0].options.labels["fulcra.intake"], f.intakeId);
  assert.equal(f.created[0].options.config.provider, "codex/gpt-6.1-sol");
  assert.equal(f.created[0].options.config.thinkingOptionId, "high");
  assert.deepEqual(f.opened, [{ serverId: f.host, agentId: f.created[0].options.agentId }]);
  assert.equal(f.store.read().intakes.length, 1);
});
test("correcting the visible project destination preserves the original conversation without replay", async (t) => {
  const f = intakeFixture(t),
    agentId = randomUUID(),
    deliveryId = randomUUID();
  f.update({
    action: "begin-intake",
    workspaceId: f.workspaceId,
    intakeId: f.intakeId,
    text: f.props.organizationDraft.text,
    projectKey: null,
  });
  f.update({
    action: "route",
    workspaceId: f.workspaceId,
    intakeId: f.intakeId,
    projectKey: projectReferenceKey(f.ship),
    context: { serverId: f.host, projectId: f.ship.projectId, workspaceId: "wks_prj_ship" },
  });
  f.update({
    action: "reserve-chat",
    workspaceId: f.workspaceId,
    intakeId: f.intakeId,
    deliveryId,
    agentId,
  });
  f.update({
    action: "chat-result",
    workspaceId: f.workspaceId,
    intakeId: f.intakeId,
    deliveryId,
    state: "created",
    taskId: null,
  });
  mount(h(IntakeSurface, f.props));
  await screen.findByText(/Destination: Ship It/);
  fireEvent.click(screen.getByRole("button", { name: "Change destination project" }));
  fireEvent.click(screen.getByRole("button", { name: "Demo Day" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Save corrected destination for future requests" }),
  );
  await screen.findByText(/destination correction is saved/);
  assert.equal(f.created.length, 0);
  assert.equal(f.store.read().intakes[0].conversations[0].agentId, agentId);
  assert.equal(f.store.read().intakes[0].projectKey, projectReferenceKey(f.demo));
  fireEvent.click(
    screen.getByRole("button", { name: "Open original conversation (same history)" }),
  );
  assert.deepEqual(f.opened, [{ serverId: f.host, agentId }]);
});

test("empty workspace intake retains ownership without spending a prime turn or allocating technical placement", async (t) => {
  const f = intakeFixture(t);
  f.update({
    action: "create-workspace",
    name: "Empty planning workspace",
    prime: { serverId: "srv_example_mini", agentId: S, seat: "delivery", label: "Delivery prime" },
  });
  const workspaceId = f.store.read().workspaces[1].id;
  mount(
    h(IntakeSurface, {
      ...f.props,
      organizationDraft: { ...f.props.organizationDraft, workspaceId },
    }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Retain this request" }));
  await screen.findByText(
    "Your request is retained. Add an existing project in Workspaces before asking the prime to route it.",
  );
  assert.equal(f.store.read().intakes[0].id, f.intakeId);
  assert.equal(f.store.read().intakes[0].prime.agentId, S);
  assert.equal(f.created.length, 0);
  assert.equal(
    calls.filter((call) =>
      ["organization.workspace.receiver.request", "organization.operator-invoke"].includes(
        call.name,
      ),
    ).length,
    0,
  );
});

test("task-first Home keeps primary tasks clear, Inbox direct and extra history routes available", async () => {
  setFleetHandler((name) =>
    name === "organization.inbox"
      ? {
          version: 1,
          observedAt: time(),
          partial: false,
          stale: false,
          error: null,
          items: [],
          counts: {
            now: 0,
            today: 0,
            fyi: 0,
            decisions: 0,
            approvals: 0,
            held: 0,
            digests: 0,
            total: 0,
          },
        }
      : Promise.reject(new Error("Fixture source unavailable")),
  );
  mount(
    h(HomeSurface, {
      theme,
      layout: { compact: true, platform: "web" },
      host: { id: "task-first", label: "Fixture host" },
    }),
  );
  for (const label of ["Home", "Projects", "Team", "Changes & impact", "Settings"])
    assert(screen.getByRole("button", { name: label }));
  assert.equal(screen.queryByTestId("organization-tab-sessions"), null);
  fireEvent.click(screen.getByRole("button", { name: "Open Inbox" }));
  await screen.findByTestId("inbox-list");
  assert(screen.getByTestId("organization-tab-inbox"));
  assert(screen.getByRole("button", { name: /^All activity and history/ }));
  for (const key of ["sessions", "environments", "trackers"])
    assert(screen.getByTestId(`organization-tab-${key}`));
  assert(
    calls.every(
      (call) =>
        !call.name.includes("choose") &&
        !call.name.includes("send") &&
        !call.name.includes("release"),
    ),
    "navigation grants no write authority",
  );
});

test("Settings opens Accounts & models and retains Devices, Channels and Clean-up under Advanced", async () => {
  setFleetHandler(() => Promise.reject(new Error("Fixture source unavailable")));
  mount(
    h(HomeSurface, {
      theme,
      layout: { compact: true, platform: "web" },
      host: { id: "settings-default", label: "Fixture host" },
      initialPillar: "settings",
    }),
  );
  assert.equal(
    screen.getByTestId("organization-tab-accounts").getAttribute("aria-selected"),
    "true",
  );
  for (const key of ["devices", "channels", "cleanup"])
    assert.equal(screen.queryByTestId(`organization-tab-${key}`), null);
  fireEvent.click(screen.getByRole("button", { name: "Show advanced settings" }));
  for (const key of ["devices", "channels", "cleanup"])
    assert(screen.getByTestId(`organization-tab-${key}`));
  fireEvent.click(screen.getByTestId("organization-tab-devices"));
  assert.equal(
    screen.getByTestId("organization-tab-devices").getAttribute("aria-selected"),
    "true",
  );
});

test("Recovery: at the top of a page a restart shows once; Home's activity still shows it after that", async () => {
  const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const item = {
    interruptionId: U(201),
    sessionId: U(21),
    task: null,
    mode: "human",
    generation: 3,
    cause: "boot",
    state: "idle-at-restart",
    turn: "ended",
    since: "2026-10-02T09:00:00.000Z",
    previousBoot: null,
    observedBoot: "boot-once",
    doing: null,
    grants: { role: false, seated: false, permission: null },
    owner: null,
    repo: { repos: [] },
    observeError: null,
    currentStatus: "idle",
    resumable: true,
    reason: null,
    disposition: "resume",
  };
  setHandler(() =>
    Promise.resolve({
      status: "observed",
      observedAt: time(),
      recovery: { items: [item], unsettled: [], error: null, note: "" },
    }),
  );
  const host = { id: "srv_once_fixture" };
  const banner = (props) => h(RecoveryBanner, { theme, navigation: null, host, ...props });
  const first = mount(banner({ once: true }));
  await screen.findByRole("button", { name: /^Recovery: Host restart at 2 Oct/ });
  first.unmount();
  mount(banner({ once: true }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(screen.queryByRole("button", { name: /^Recovery: Host restart/ }), null);
  cleanup();
  mount(banner({}));
  await screen.findByRole("button", { name: /^Recovery: Host restart at 2 Oct/ });
});
