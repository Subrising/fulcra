import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { JSDOM } from "jsdom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ChangesSurface, UNAVAILABLE } from "./changes";
import { setHandler, setPaseo, calls } from "./ui-test-adapters.mjs";
import { forgetAll } from "./last-good";
const dom = new JSDOM("<html><body></body></html>", { url: "http://component.test" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { render, screen, cleanup, fireEvent, waitFor } = await import("@testing-library/react");
const theme = {
  colors: {
    foreground: "#fff",
    foregroundMuted: "#ccc",
    border: "#888",
    surface0: "#111",
    surface1: "#222",
  },
};
const PROJECT = "22222222-2222-4222-8222-000000000001";
const now = new Date().toISOString();
const item = {
  key: "pr:github:example/shop#17",
  connector: "github",
  kind: "pr",
  ref: "#17",
  title: "Improve checkout",
  state: "open",
  url: "https://github.com/example/shop/pull/17",
  updatedAt: now,
  assignee: null,
  labels: [],
};
function setup(
  items = [item],
  workspaces = [{ id: "checkout", gitRuntime: { remoteUrl: "git@github.com:example/shop.git" } }],
) {
  setPaseo({ workspaces: { list: async () => ({ entries: workspaces }) } });
  setHandler((name) => {
    if (name === "organization.trackers.directory")
      return {
        available: true,
        partial: false,
        note: "",
        projects: [{ id: PROJECT, name: "Example shop", mapping: null, tasks: [], sessions: [] }],
      };
    if (name === "organization.tracker-view")
      return {
        version: 1,
        observedAt: now,
        partial: false,
        trackers: [],
        items: items.map((item) => ({ item, stale: false, observedAt: now, trail: [], links: [] })),
      };
    throw Error("Unexpected read");
  });
}
const mount = (navigation) =>
  render(
    React.createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }) },
      React.createElement(ChangesSurface, {
        theme,
        layout: { compact: false },
        host: { id: "fixture-host", label: "Example host" },
        navigation,
      }),
    ),
  );
afterEach(() => {
  cleanup();
  forgetAll();
});
test("old apps retain the plain message and perform no reads", async () => {
  setup();
  mount({ openWorkspace() {}, openAgent() {} });
  assert.ok(screen.getByText(UNAVAILABLE));
  assert.equal(calls.length, 0);
});
test("opens the selected repository workspace and PR with no IDs in the visible copy", async () => {
  setup();
  const opened = [];
  mount({ openArchitectureChange: (input) => opened.push(input) });
  fireEvent.click(
    await screen.findByRole("button", { name: "Open change view for Improve checkout" }),
  );
  assert.deepEqual(opened, [
    { workspaceId: "checkout", pullRequest: 17, serverId: "fixture-host" },
  ]);
  assert.equal(document.body.textContent.includes(PROJECT), false);
  assert.equal(document.body.textContent.includes("pr:github"), false);
});
test("shows the requested empty state", async () => {
  setup([]);
  mount({ openArchitectureChange() {} });
  assert.ok(await screen.findByText("No open or recent pull requests"));
});
test("U5-D12: a PR with no served checkout shows that state up front, with a way to add the checkout, and no dead button", async () => {
  setup([item], []);
  let opened = false;
  mount({
    openArchitectureChange() {
      opened = true;
    },
  });
  assert.ok(
    await screen.findByText(
      "No workspace on this host is a checkout of github.com/example/shop. Add its folder below to open this change.",
    ),
  );
  assert.ok(screen.getByLabelText("Folder of the github.com/example/shop checkout"));
  assert.equal(
    screen.queryByRole("button", { name: "Open change view for Improve checkout" }),
    null,
  );
  assert.equal(document.body.textContent.includes("not a workspace this host serves"), false);
  assert.equal(opened, false);
});
test("U5-D12: adding the checkout folder (any remote name) opens the change in the workspace the host returned", async () => {
  const added = [];
  setup(
    [item],
    [{ id: "other", gitRuntime: { remoteUrl: "https://github.com/example/other.git" } }],
  );
  setPaseo({
    workspaces: {
      list: async () => ({
        entries: [
          { id: "other", gitRuntime: { remoteUrl: "https://github.com/example/other.git" } },
          ...added,
        ],
      }),
      open: async (cwd) => {
        assert.equal(cwd, "/Users/me/code/shop");
        added.push({
          id: "shop-fork",
          gitRuntime: { remoteUrl: "https://github.com/me/shop.git" },
        });
        return { id: "shop-fork" };
      },
    },
  });
  const opened = [];
  mount({ openArchitectureChange: (input) => opened.push(input) });
  fireEvent.change(await screen.findByLabelText("Folder of the github.com/example/shop checkout"), {
    target: { value: "  /Users/me/code/shop " },
  });
  fireEvent.click(
    screen.getByRole("button", {
      name: "Add folder and open the change for github.com/example/shop",
    }),
  );
  await waitFor(() =>
    assert.deepEqual(opened, [
      { workspaceId: "shop-fork", pullRequest: 17, serverId: "fixture-host" },
    ]),
  );
  // The choice is kept: the PR is now ready in that workspace, and the add form is gone.
  assert.ok(await screen.findByRole("button", { name: "Open change view for Improve checkout" }));
  assert.equal(screen.queryByLabelText("Folder of the github.com/example/shop checkout"), null);
});
test("U5-D12: a device that may not add workspaces, or a bad path, gets words to act on", async () => {
  setup([item], []);
  setPaseo({
    workspaces: {
      list: async () => ({ entries: [] }),
      open: async () => {
        throw Error("Missing permission workspace.manage");
      },
    },
  });
  mount({ openArchitectureChange() {} });
  const field = await screen.findByLabelText("Folder of the github.com/example/shop checkout");
  fireEvent.change(field, { target: { value: "shop" } });
  fireEvent.click(
    screen.getByRole("button", {
      name: "Add folder and open the change for github.com/example/shop",
    }),
  );
  assert.ok(await screen.findByText(/Enter the full path of the checkout's folder/));
  fireEvent.change(field, { target: { value: "/Users/me/code/shop" } });
  fireEvent.click(
    screen.getByRole("button", {
      name: "Add folder and open the change for github.com/example/shop",
    }),
  );
  assert.ok(await screen.findByText(/This device cannot add workspaces on this host/));
  assert.equal(document.body.textContent.includes("workspace.manage"), false);
});
test("navigation failure stays visible", async () => {
  setup();
  mount({
    openArchitectureChange() {
      throw Error("private details");
    },
  });
  fireEvent.click(
    await screen.findByRole("button", { name: "Open change view for Improve checkout" }),
  );
  assert.ok(await screen.findByText(/change view could not be opened/));
  assert.equal(document.body.textContent.includes("private details"), false);
});
test("L36: opening Changes refreshes each project, so its pull requests appear without a stored copy", async () => {
  setup([]);
  // As the real store: the read returns what the refresh stored, and nothing before it ran.
  const stored = {
    version: 1,
    observedAt: now,
    partial: false,
    trackers: [],
    items: [{ item, stale: false, observedAt: now, trail: [], links: [] }],
  };
  let refreshed = false;
  setHandler((name, input) => {
    if (name === "organization.trackers.directory")
      return {
        available: true,
        partial: false,
        note: "",
        projects: [{ id: PROJECT, name: "Example shop", mapping: null, tasks: [], sessions: [] }],
      };
    if (name === "organization.tracker-view")
      return refreshed
        ? stored
        : { version: 1, observedAt: now, partial: false, trackers: [], items: [] };
    if (name === "organization.tracker-refresh") {
      refreshed = true;
      return stored;
    }
    throw Error("Unexpected read");
  });
  mount({ openArchitectureChange() {} });
  assert.ok(await screen.findByRole("button", { name: "Open change view for Improve checkout" }));
  assert.ok(
    calls.some((c) => c.name === "organization.tracker-refresh" && c.input?.projectId === PROJECT),
  );
});
