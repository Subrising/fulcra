// @vitest-environment jsdom
import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { PluginCatalogSync } from "./catalog-sync";
const state = vi.hoisted(() => ({
  connected: false,
  // Null is the cold-start value: connected, features not sent yet.
  supported: null as boolean | null,
  registry: {
    suspendHost: vi.fn(),
    removeHost: vi.fn(),
    installCatalog: vi.fn(),
    getSnapshot: () => [],
  },
}));
vi.mock("@/runtime/host-runtime", () => ({ useHostRuntimeIsConnected: () => state.connected }));
vi.mock("@/runtime/host-features", () => ({
  useHostFeatureAvailability: () => state.supported,
}));
vi.mock("./registry", () => ({ pluginRegistry: state.registry }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  state.connected = false;
  state.supported = null;
});

it("suspends before feature knowledge arrives, fences late catalogs, and removes unsupported/deleted hosts", async () => {
  const resolves: ((catalog: { id: string; clientBundle: string }[]) => void)[] = [];
  // The component observes catalog/settings events and releases the observation
  // on cleanup; `release` stands in for the old `on()` unsubscribe.
  const release = vi.fn(() => Promise.resolve());
  // The real observation delivers a snapshot as soon as it opens, which is what
  // drives the component's first catalog fetch.
  const subscribe = vi.fn((handlers: { snapshot: () => void }) => handlers.snapshot());
  const client = {
    getPluginCatalog: vi.fn(() => new Promise((resolve) => resolves.push(resolve))),
    observeEvents: vi.fn(() => ({ subscribe, release })),
  } as unknown as DaemonClient;
  const view = render(React.createElement(PluginCatalogSync, { serverId: "host", client }));
  expect(state.registry.suspendHost).toHaveBeenCalledWith("host");
  expect(state.registry.removeHost).not.toHaveBeenCalled();
  state.connected = true;
  state.supported = true;
  await act(async () =>
    view.rerender(React.createElement(PluginCatalogSync, { serverId: "host", client })),
  );
  expect(resolves).toHaveLength(1);
  state.connected = false;
  state.supported = false;
  view.rerender(React.createElement(PluginCatalogSync, { serverId: "host", client }));
  await act(async () => resolves[0]!([{ id: "stale", clientBundle: "old" }]));
  expect(state.registry.installCatalog).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledOnce();
  state.connected = true;
  state.supported = true;
  await act(async () =>
    view.rerender(React.createElement(PluginCatalogSync, { serverId: "host", client })),
  );
  const fresh = [{ id: "fresh", clientBundle: "new" }];
  await act(async () => resolves[1]!(fresh));
  expect(state.registry.installCatalog).toHaveBeenCalledExactlyOnceWith("host", fresh, {
    client,
    replacePluginId: undefined,
  });
  state.supported = false;
  view.rerender(React.createElement(PluginCatalogSync, { serverId: "host", client }));
  expect(state.registry.removeHost).toHaveBeenCalledWith("host");
  state.registry.removeHost.mockClear();
  view.unmount();
  expect(state.registry.removeHost).toHaveBeenCalledExactlyOnceWith("host");
});

// Connected but silent is not the same as "this host has no plugins". Removing the host there
// settles the catalog, and the host index reads that as a permanent absence.
it("waits instead of settling the catalog while the host has not reported features", async () => {
  const client = {
    getPluginCatalog: vi.fn(() => new Promise(() => {})),
    observeEvents: vi.fn(() => ({ subscribe: vi.fn(), release: vi.fn(() => Promise.resolve()) })),
  } as unknown as DaemonClient;
  state.connected = true;
  state.supported = null;

  render(React.createElement(PluginCatalogSync, { serverId: "host", client }));

  expect(state.registry.suspendHost).toHaveBeenCalledWith("host");
  expect(state.registry.removeHost).not.toHaveBeenCalled();
  expect(client.getPluginCatalog).not.toHaveBeenCalled();
});
