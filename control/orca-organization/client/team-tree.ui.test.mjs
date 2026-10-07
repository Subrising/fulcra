// The Team tree with synthetic component adapters (not a Paseo/phone UI test): plain roles and states, who reports to
// whom, and a card that opens its chat. The tree comes from the real model over a small fictional fleet.
import { TeamTreeView } from "./team-tree-view";
import { buildTeamTree } from "./team-tree";
import { FreshStartButton } from "./fresh-start-view";
import { setHandler, calls } from "./ui-test-adapters.mjs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://component.test",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { render, screen, fireEvent, cleanup, waitFor } = await import("@testing-library/react");
const h = React.createElement;
const theme = {
  colors: {
    foreground: "#fff",
    foregroundMuted: "#ccc",
    border: "#888",
    accent: "#06f",
    surface0: "#111",
    surface1: "#191f2a",
    surface2: "#263246",
    statusSuccess: "#6cb17b",
    statusWarning: "#c09664",
    statusDanger: "#d8847b",
  },
};
afterEach(() => cleanup());

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const base = {
  task: id(90),
  host: "Studio Mac",
  serverId: "srv_fixture",
  title: "Session",
  provider: "codex",
  model: "gpt-6.1-sol",
  mode: "default",
  status: "idle",
  pending: 0,
  observedAt: null,
  updatedAt: null,
  error: null,
};
const fleet = [
  {
    ...base,
    id: id(1),
    agentId: id(1),
    title: "Fulcra main",
    status: "running",
    provider: "claude",
    model: "Opus 5.5",
  },
  { ...base, id: id(2), agentId: id(2), title: "Forecast", parent: id(1), pending: 1 },
  { ...base, id: id(3), agentId: id(3), title: "Table", parent: id(2), status: "running" },
  { ...base, id: id(4), agentId: id(4), host: "Book", title: "Old work", status: "unavailable" },
  { ...base, id: id(5), agentId: id(5), host: "Book", title: "Older work", status: "unavailable" },
];

test("the tree reads top-down in plain words and a card opens its chat", () => {
  const tree = buildTeamTree({ nodes: fleet, mainSessionIds: new Set([id(1)]) });
  const opened = [];
  render(
    h(TeamTreeView, {
      cards: tree.roots,
      summary: tree.summary,
      theme,
      openAgent: (card) => opened.push(card.agentId),
    }),
  );
  assert.equal(
    screen.getByTestId("team-tree-summary").textContent,
    "2 working · 1 waiting for you · 2 offline",
  );
  assert.ok(screen.getByText("You"));
  assert.deepEqual(
    screen.getAllByTestId("team-card-state").map((node) => node.textContent),
    [
      "Working · Claude · Opus 5.5",
      "Waiting for you · Codex · gpt-6.1-sol",
      "Working · Codex · gpt-6.1-sol",
      "Offline",
    ],
  );
  assert.ok(screen.getByText("↳ Main assistant leads"));
  // The waiting card carries its question, answerable in place; other cards carry none.
  assert.equal(
    screen.getByTestId(`team-card-questions-${id(2)}`).getAttribute("data-server"),
    "srv_fixture",
  );
  assert.equal(screen.getAllByText(/^Question card for /).length, 1);
  assert.ok(screen.getByText("↳ Project lead runs"));
  assert.ok(screen.getByText("2 sessions on Book can't be reached right now"));
  assert.equal(screen.queryByTestId("team-card-detail"), null);
  fireEvent.click(screen.getByTestId(`team-card-${id(2)}`));
  assert.match(
    screen.getByTestId("team-card-detail").textContent,
    /Reports to Main assistant · runs 1/,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open chat to answer" }));
  assert.deepEqual(opened, [id(2)]);
});

test("an empty team says what will appear", () => {
  render(h(TeamTreeView, { cards: [], summary: "No sessions yet", theme, openAgent: null }));
  assert.ok(screen.getByText(/show here with who leads whom/));
});

function mountFreshStart(recovery) {
  setHandler((name, input) => {
    if (name === "organization.recovery")
      return { status: "observed", observedAt: new Date().toISOString(), recovery };
    if (name === "organization.recovery-act")
      return {
        status: "rotated",
        message:
          "Started fresh. The handoff is saved and the same chat continues in a new context.",
        observedAt: "",
        input,
      };
    throw Error(`unexpected ${name}`);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    h(
      QueryClientProvider,
      { client },
      h(FreshStartButton, { sessionId: id(2), theme, hostId: "mini" }),
    ),
  );
}

test("Fresh start is hidden until the controller supports it", async () => {
  mountFreshStart({ compactionLoops: { rotations: [] } });
  await waitFor(() => assert.ok(calls.some((c) => c.name === "organization.recovery")));
  assert.equal(screen.queryByRole("button", { name: "Fresh start" }), null);
});

test("Fresh start asks first, then sends one fresh-start action and says what happened", async () => {
  mountFreshStart({ compactionLoops: { freshStart: true, rotations: [] } });
  fireEvent.click(await screen.findByRole("button", { name: "Fresh start" }));
  assert.ok(screen.getByText(/Start fresh\? Fulcra saves a handoff/));
  assert.equal(calls.filter((c) => c.name === "organization.recovery-act").length, 0);
  fireEvent.click(screen.getByRole("button", { name: "Start fresh now" }));
  await waitFor(() =>
    assert.match(screen.getByTestId("fresh-start-notice").textContent, /^Started fresh/),
  );
  const acts = calls.filter((c) => c.name === "organization.recovery-act");
  assert.equal(acts.length, 1);
  assert.equal(acts[0].input.action, "fresh-start");
  assert.equal(acts[0].input.sessionId, id(2));
  assert.match(acts[0].input.messageId, /^[0-9a-f-]{36}$/);
});
