import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { JSDOM } from "jsdom";
import { QueryClient, QueryClientProvider, skipToken } from "@tanstack/react-query";
import { FleetSurface } from "./fleet";
import { useWorkView, normalizeWorkView } from "./work-view";
import { calls, setHandler } from "./ui-test-adapters.mjs";
import { forgetAll } from "./last-good";
const dom = new JSDOM("<html><body></body></html>", { url: "http://component.test" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { render, renderHook, screen, fireEvent, waitFor, cleanup, act } =
  await import("@testing-library/react");
const h = React.createElement,
  S = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
  T = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const theme = {
  colors: {
    foreground: "#eee",
    foregroundMuted: "#ccc",
    border: "#777",
    surface0: "#111",
    surface1: "#191f2a",
    surface2: "#263246",
    accent: "#8ab4ff",
    accentForeground: "#102030",
  },
};
const clients = [],
  client = () => {
    const c = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    clients.push(c);
    return c;
  };
const wrap =
  (c) =>
  ({ children }) =>
    h(QueryClientProvider, { client: c }, children);
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((c) => c.clear());
  forgetAll();
});
const fleet = () => ({
  observedAt: new Date().toISOString(),
  total: 1,
  partial: false,
  note: "Fixture",
  tasks: [{ id: T, title: "Chosen task" }],
  edges: [],
  nodes: [
    {
      id: S,
      task: T,
      agentId: S,
      host: "macbook",
      title: "Chosen session",
      provider: "claude",
      status: "idle",
      mode: "human",
      pending: 0,
    },
  ],
});
// C2b (d85d6473): the Sessions list is read per host, server-side search, host filter and page offset.
const fleetKey = (hostId = "host-a", search = "", host = "all", offset = 0) => [
  "orca-fleet",
  hostId,
  search,
  host,
  offset,
];
function fixture() {
  setHandler((name, input) =>
    Promise.resolve(
      name === "organization.fleet"
        ? fleet()
        : {
            observedAt: new Date().toISOString(),
            sessionId: input.sessionId,
            taskId: T,
            note: "History fixture",
            receipts: [],
            activity: [],
            cursor: null,
          },
    ),
  );
}
test("normalization retains valid upper-case UUIDs and bounds every preference", () => {
  assert.deepEqual(
    normalizeWorkView({
      graphOpen: 1,
      host: "x".repeat(257),
      search: "x".repeat(1000),
      selected: "not-an-id",
      frozen: "true",
      authority: true,
    }),
    {
      graphOpen: false,
      host: "all",
      search: "x".repeat(160),
      selected: null,
      frozen: false,
      graphIntent: null,
    },
  );
  // Portable hosts (1bea30f2): any configured host name is a valid filter; only empty or oversized names fall back.
  assert.equal(normalizeWorkView({ host: "macbook" }).host, "macbook");
  assert.equal(normalizeWorkView({ host: "" }).host, "all");
  assert.equal(normalizeWorkView({ selected: S }).selected, S);
  for (const graphIntent of [
    { zoom: NaN, x: 1, y: 2 },
    { zoom: 3, x: 1, y: 2 },
    { zoom: 1, x: Infinity, y: 2 },
    { zoom: 1, x: -1, y: 2 },
    { zoom: 1, x: 1, y: 1_000_001 },
  ]) {
    assert.equal(normalizeWorkView({ graphIntent }).graphIntent, null);
  }
  assert.deepEqual(
    normalizeWorkView({ graphIntent: { zoom: 1.25, x: 220, y: 160, authority: true } }).graphIntent,
    { zoom: 1.25, x: 220, y: 160 },
  );
});
test("controlled search input updates synchronously across consecutive native-style changes", async () => {
  fixture();
  const c = client();
  render(
    h(
      wrap(c),
      null,
      h(FleetSurface, { theme, host: { id: "host-a" }, layout: { compact: true }, onTask() {} }),
    ),
  );
  const input = screen.getByLabelText("Find work");
  fireEvent.change(input, { target: { value: "Ch" } });
  assert.equal(input.value, "Ch");
  fireEvent.change(input, { target: { value: "Cho" } });
  assert.equal(input.value, "Cho");
});
test("both appearance remount directions retain actual FleetSurface selections and frozen cached data", async () => {
  fixture();
  const c = client();
  c.setQueryData(fleetKey(), fleet());
  const surface = (key) =>
    h(
      QueryClientProvider,
      { client: c },
      h(FleetSurface, {
        key,
        theme,
        host: { id: "host-a" },
        layout: { compact: true },
        onTask() {},
      }),
    );
  const view = render(surface("light"));
  fireEvent.click(await screen.findByRole("button", { name: "macbook" }));
  fireEvent.change(screen.getByLabelText("Find work"), { target: { value: "Chosen" } });
  // The search reaches the server after a short pause; let it settle before counting reads.
  await waitFor(() =>
    assert(
      calls.some(
        (c) =>
          c.name === "organization.fleet" &&
          c.input.search === "Chosen" &&
          c.input.host === "macbook",
      ),
    ),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Inspect Chosen session" }));
  fireEvent.click(screen.getByRole("button", { name: "Freeze view" }));
  await screen.findByRole("button", { name: "Resume updates" });
  fireEvent.click(screen.getByRole("button", { name: "Open work graph" }));
  await screen.findByTestId("work-graph-viewport");
  const reads = calls.filter((c) => c.name === "organization.fleet").length;
  for (const key of ["dark", "light-again"]) {
    view.rerender(surface(key));
    await screen.findByTestId("work-graph-viewport");
    assert(screen.getByRole("button", { name: "Resume updates" }));
    assert(screen.getAllByText("Chosen session").length > 0);
    assert.equal(calls.filter((c) => c.name === "organization.fleet").length, reads);
  }
  fireEvent.click(screen.getByRole("button", { name: "Back to work list" }));
  await screen.findByLabelText("Find work");
  assert.equal(screen.getByLabelText("Find work").value, "Chosen");
  assert.equal(
    screen.getByRole("button", { name: "macbook" }).getAttribute("aria-selected"),
    "true",
  );
  fireEvent.click(screen.getByRole("button", { name: "Refresh work" }));
  await waitFor(() =>
    assert.equal(calls.filter((c) => c.name === "organization.fleet").length, reads + 1),
  );
  assert(
    calls.every((c) =>
      [
        "organization.fleet",
        "organization.projects",
        "organization.activity-history",
        "organization.outcome",
      ].includes(c.name),
    ),
  );
});
test("host isolation, installation replacement and missing identities do not share preferences", async () => {
  const c = client(),
    wrapper = wrap(c),
    view = renderHook(({ id }) => useWorkView(id), { wrapper, initialProps: { id: "host-a" } });
  act(() =>
    view.result.current[1]({ host: "macbook", search: "one", selected: S, graphOpen: true }),
  );
  await waitFor(() => assert.equal(view.result.current[0].search, "one"));
  view.rerender({ id: "host-b" });
  assert.equal(view.result.current[0].search, "");
  act(() => view.result.current[1]({ search: "two" }));
  await waitFor(() => assert.equal(view.result.current[0].search, "two"));
  view.rerender({ id: "host-a" });
  assert.equal(view.result.current[0].search, "one");
  view.unmount();
  const replacement = renderHook(() => useWorkView("host-a"), { wrapper: wrap(client()) });
  assert.equal(replacement.result.current[0].search, "");
  replacement.unmount();
  c.clear();
  const disposed = renderHook(() => useWorkView("host-a"), { wrapper });
  assert.equal(disposed.result.current[0].search, "");
  disposed.unmount();
  for (const id of [undefined, "", " ", "x".repeat(257)]) {
    const local = renderHook(() => useWorkView(id), { wrapper });
    act(() => local.result.current[1]({ search: "local" }));
    assert.equal(local.result.current[0].search, "local");
    const other = renderHook(() => useWorkView(id), { wrapper });
    assert.equal(other.result.current[0].search, "");
    assert.equal(c.getQueryData(["orca-work-view-v1", null]), undefined);
    local.unmount();
    other.unmount();
  }
});
test("removed nodes render no retained details while partial snapshots retain preference for recovery", async () => {
  fixture();
  const c = client();
  c.setQueryData(
    ["orca-work-view-v1", "host-a"],
    normalizeWorkView({ selected: S, graphOpen: true, frozen: true }),
  );
  c.setQueryData(fleetKey(), { ...fleet(), nodes: [], partial: true });
  render(
    h(
      wrap(c),
      null,
      h(FleetSurface, { theme, host: { id: "host-a" }, layout: { compact: true }, onTask() {} }),
    ),
  );
  assert.equal(screen.queryByText("Chosen session"), null);
  assert.equal(c.getQueryData(["orca-work-view-v1", "host-a"]).selected, S);
  await act(async () => c.setQueryData(fleetKey(), fleet()));
  await screen.findByText("Chosen session");
  await act(async () => c.setQueryData(fleetKey(), { ...fleet(), nodes: [], partial: false }));
  await waitFor(() => assert.equal(screen.queryByText("Chosen session"), null));
  assert.equal(screen.queryByRole("button", { name: "Open original conversation" }), null);
});
test("frozen without cached fleet reads once, never polls, and explicit refresh remains available", async (t) => {
  fixture();
  const c = client();
  c.setQueryData(["orca-work-view-v1", "host-a"], normalizeWorkView({ frozen: true }));
  const intervals = [];
  const original = globalThis.setInterval;
  t.mock.method(globalThis, "setInterval", (fn, ms, ...args) => {
    intervals.push(ms);
    return original(fn, ms, ...args);
  });
  render(
    h(
      wrap(c),
      null,
      h(FleetSurface, { theme, host: { id: "host-a" }, layout: { compact: true }, onTask() {} }),
    ),
  );
  await screen.findByRole("button", { name: "Inspect Chosen session" });
  assert(screen.getByRole("button", { name: "Resume updates" }));
  assert.equal(calls.filter((c) => c.name === "organization.fleet").length, 1);
  assert(!intervals.includes(15000));
  fireEvent.click(screen.getByRole("button", { name: "Refresh work" }));
  await waitFor(() => assert.equal(calls.filter((c) => c.name === "organization.fleet").length, 2));
});

test("only the host-scoped local view opts into reconnect retention", async () => {
  fixture();
  const c = client();
  render(
    h(
      wrap(c),
      null,
      h(FleetSurface, { theme, host: { id: "host-a" }, layout: { compact: true }, onTask() {} }),
    ),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Inspect Chosen session" }));
  await waitFor(() => assert(calls.some((call) => call.name === "organization.activity-history")));
  const queries = c.getQueryCache().getAll(),
    opted = queries.filter((q) => q.meta?.paseoLocalView === true);
  assert.equal(opted.length, 1);
  assert.deepEqual(opted[0].queryKey, ["orca-work-view-v1", "host-a"]);
  assert.equal(opted[0].options.queryFn, skipToken);
  assert.equal(opted[0].options.enabled, false);
  assert(queries.filter((q) => q !== opted[0]).length >= 2);
  assert(queries.filter((q) => q !== opted[0]).every((q) => q.meta?.paseoLocalView !== true));
});

test("graph pan and zoom survive list remount and reconnect with only presentation data", async () => {
  fixture();
  const c = client();
  const surface = (cache) =>
    h(
      wrap(cache),
      null,
      h(FleetSurface, { theme, host: { id: "host-a" }, layout: { compact: true }, onTask() {} }),
    );
  let view = render(surface(c));
  fireEvent.click(await screen.findByRole("button", { name: "Inspect Chosen session" }));
  fireEvent.click(screen.getByRole("button", { name: "Open work graph" }));
  fireEvent.click(await screen.findByRole("button", { name: "Map controls" }));
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  fireEvent.click(screen.getByRole("button", { name: "Pan right" }));
  const status = () => {
    const toggle = screen.getByRole("button", { name: "Map controls" });
    if (toggle.getAttribute("aria-expanded") !== "true") fireEvent.click(toggle);
    return screen.getByText(/125%.*nodes \/.*links/).textContent;
  };
  const before = status();
  fireEvent.click(screen.getByRole("button", { name: "Back to work list" }));
  fireEvent.click(screen.getByRole("button", { name: "Open work graph" }));
  await waitFor(() => assert.equal(status(), before));
  const saved = JSON.parse(JSON.stringify(c.getQueryData(["orca-work-view-v1", "host-a"])));
  view.unmount();
  c.clear();
  const next = client();
  next.setQueryData(["orca-work-view-v1", "host-a"], saved);
  const reads = calls.filter((call) => call.name === "organization.fleet").length;
  view = render(surface(next));
  await waitFor(() => assert.equal(status(), before));
  assert(calls.filter((call) => call.name === "organization.fleet").length > reads);
  view.unmount();
});
