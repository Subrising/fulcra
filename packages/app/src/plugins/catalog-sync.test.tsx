// @vitest-environment jsdom
import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { PluginCatalogSync } from "./catalog-sync";
const state = vi.hoisted(() => ({
  prepare: vi.fn(async (entries: unknown[]) => entries),
  connected: false,
  paging: false,
  // Null is the cold-start value: connected, features not sent yet.
  supported: null as boolean | null,
  registry: {
    suspendHost: vi.fn(),
    clearHostInputPolicy: vi.fn(),
    removeHost: vi.fn(),
    installCatalog: vi.fn(),
    markCatalogSettled: vi.fn(),
    getSnapshot: () => [],
  },
}));
vi.mock("@/runtime/host-runtime", () => ({ useHostRuntimeIsConnected: () => state.connected }));
vi.mock("@/runtime/host-features", () => ({
  useHostFeatureAvailability: (_server: string, feature: string) =>
    feature === "pluginCatalogPaging" ? state.paging : state.supported,
}));
vi.mock("./bundle-trust", () => ({ preparePluginCatalog: state.prepare }));
vi.mock("./registry", () => ({ pluginRegistry: state.registry }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  state.connected = false;
  state.paging = false;
  state.supported = null;
});

it("suspends before feature knowledge arrives, fences late catalogs, and removes unsupported/deleted hosts", async () => {
  const resolves: ((catalog: { plugins: { id: string; clientBundle: string }[] }) => void)[] = [];
  // The component observes catalog/settings events and releases the observation
  // on cleanup; `release` stands in for the old `on()` unsubscribe.
  const release = vi.fn(() => Promise.resolve());
  // The real observation delivers a snapshot as soon as it opens, which is what
  // drives the component's first catalog fetch.
  const subscribe = vi.fn((handlers: { snapshot: () => void }) => handlers.snapshot());
  const client = {
    subscribeConnectionStatus: () => () => {},
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
  state.paging = false;
  state.supported = false;
  view.rerender(React.createElement(PluginCatalogSync, { serverId: "host", client }));
  await act(async () => resolves[0]!({ plugins: [{ id: "stale", clientBundle: "old" }] }));
  expect(state.registry.installCatalog).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledOnce();
  state.connected = true;
  state.supported = true;
  await act(async () =>
    view.rerender(React.createElement(PluginCatalogSync, { serverId: "host", client })),
  );
  const fresh = [{ id: "fresh", clientBundle: "new" }];
  await act(async () => resolves[1]!({ plugins: fresh }));
  expect(state.registry.installCatalog).toHaveBeenCalledExactlyOnceWith("host", fresh, {
    client,
    replacePluginId: undefined,
    trustedPlugins: undefined,
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
    subscribeConnectionStatus: () => () => {},
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

it("m2 installs only prepared catalog entries after preparation completes", async () => {
  state.connected = true;
  state.supported = true;
  const raw = [{ id: "example", clientBundle: "raw" }],
    prepared = [Object.freeze({ ...raw[0] })];
  let finish!: (value: unknown[]) => void;
  state.prepare.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const client = {
    subscribeConnectionStatus: () => () => {},
    getPluginCatalog: vi.fn(async () => ({ plugins: raw })),
    observeEvents: () => ({
      subscribe: (handlers: { snapshot: () => void }) => handlers.snapshot(),
      release: async () => {},
    }),
  } as unknown as DaemonClient;
  await act(async () => {
    render(React.createElement(PluginCatalogSync, { serverId: "host", client }));
  });
  expect(state.prepare).toHaveBeenCalledWith(raw);
  expect(state.registry.installCatalog).not.toHaveBeenCalled();
  await act(async () => {
    finish(prepared);
  });
  expect(state.registry.installCatalog.mock.calls[0][1]).toBe(prepared);
  expect(state.registry.installCatalog.mock.calls[0][1]).not.toBe(raw);
});

it("uses the explicit paging method only and cancels a held read on disconnect", async () => {
  state.connected = true;
  state.supported = true;
  state.paging = true;
  let finish!: (value: { plugins: { id: string; clientBundle: string }[] }) => void;
  let signal: AbortSignal | undefined;
  const paged = vi.fn((options: { signal?: AbortSignal }) => {
    signal = options.signal;
    return new Promise<{ plugins: { id: string; clientBundle: string }[] }>((resolve) => {
      finish = resolve;
    });
  });
  const client = {
    subscribeConnectionStatus: () => () => {},
    getPluginCatalog: vi.fn(),
    getPagedPluginCatalog: paged,
    observeEvents: () => ({
      subscribe: (handlers: { snapshot: () => void }) => handlers.snapshot(),
      release: async () => {},
    }),
  } as unknown as DaemonClient;
  const view = render(React.createElement(PluginCatalogSync, { serverId: "host", client }));
  await act(async () => {});
  expect(paged).toHaveBeenCalledOnce();
  expect(client.getPluginCatalog).not.toHaveBeenCalled();
  state.connected = false;
  view.rerender(React.createElement(PluginCatalogSync, { serverId: "host", client }));
  expect(signal?.aborted).toBe(true);
  await act(async () => finish({ plugins: [{ id: "late", clientBundle: "never evaluated" }] }));
  expect(state.prepare).not.toHaveBeenCalled();
  expect(state.registry.installCatalog).not.toHaveBeenCalled();
});
it("paging refusal suspends prior surfaces and never falls back to the legacy bulk read", async () => {
  state.connected = true;
  state.supported = true;
  state.paging = true;
  const client = {
    subscribeConnectionStatus: () => () => {},
    getPluginCatalog: vi.fn(),
    getPagedPluginCatalog: vi.fn(async () => {
      throw new Error("read_revoked");
    }),
    observeEvents: () => ({
      subscribe: (handlers: { snapshot: () => void }) => handlers.snapshot(),
      release: async () => {},
    }),
  } as unknown as DaemonClient;
  await act(async () => {
    render(React.createElement(PluginCatalogSync, { serverId: "host", client }));
  });
  expect(client.getPluginCatalog).not.toHaveBeenCalled();
  expect(state.registry.suspendHost).toHaveBeenCalledWith("host");
  expect(state.registry.markCatalogSettled).toHaveBeenCalledWith("host");
  expect(state.registry.installCatalog).not.toHaveBeenCalled();
});

it("retains actual trusted input-hook metadata without another catalog read or bundle evaluation", async () => {
  state.connected = true;
  state.supported = true;
  const trustedPlugins = [
    { id: "orca-organization-next", contract: "1.1", hooks: ["input", "mcp"] },
  ];
  const client = {
    subscribeConnectionStatus: () => () => {},
    getPluginCatalog: vi.fn(async () => ({ plugins: [], trustedPlugins })),
    observeEvents: () => ({
      subscribe: (handlers: { snapshot: () => void }) => handlers.snapshot(),
      release: async () => {},
    }),
  } as unknown as DaemonClient;
  await act(async () => {
    render(React.createElement(PluginCatalogSync, { serverId: "srv_-gsApGw5dJdC", client }));
  });
  expect(client.getPluginCatalog).toHaveBeenCalledOnce();
  expect(state.prepare).toHaveBeenCalledExactlyOnceWith([]);
  expect(state.registry.installCatalog).toHaveBeenCalledExactlyOnceWith("srv_-gsApGw5dJdC", [], {
    client,
    replacePluginId: undefined,
    trustedPlugins,
  });
});
it("clears policy synchronously on a connection drop even before a reconnect render", async () => {
  state.connected = true;
  state.supported = true;
  let connectionChanged!: (status: { status: string }) => void;
  const releaseConnection = vi.fn();
  const client = {
    subscribeConnectionStatus: (listener: typeof connectionChanged) => {
      connectionChanged = listener;
      return releaseConnection;
    },
    getPluginCatalog: vi.fn(async () => ({ plugins: [], trustedPlugins: [] })),
    observeEvents: () => ({
      subscribe: (handlers: { snapshot: () => void }) => handlers.snapshot(),
      release: async () => {},
    }),
  } as unknown as DaemonClient;
  const view = render(React.createElement(PluginCatalogSync, { serverId: "same-host", client }));
  await act(async () => {});
  state.registry.clearHostInputPolicy.mockClear();
  act(() => connectionChanged({ status: "disconnected" }));
  expect(state.registry.clearHostInputPolicy).toHaveBeenCalledExactlyOnceWith("same-host", client);
  view.unmount();
  expect(releaseConnection).toHaveBeenCalledOnce();
});

it.each([false, true])(
  "fences a held preparation synchronously through drop (same-client reconnect: %s)",
  async (reconnect) => {
    state.connected = true;
    state.supported = true;
    state.paging = true;
    let connectionChanged!: (status: { status: string }) => void;
    let snapshot!: () => void;
    let completePreparation!: (entries: unknown[]) => void;
    let signal: AbortSignal | undefined;
    let policy: "unknown" | "standalone" = "unknown";
    state.registry.clearHostInputPolicy.mockImplementation(() => {
      policy = "unknown";
    });
    state.registry.installCatalog.mockImplementation(() => {
      policy = "standalone";
    });
    state.prepare.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          completePreparation = resolve;
        }),
    );
    const client = {
      subscribeConnectionStatus: (listener: typeof connectionChanged) => {
        connectionChanged = listener;
        return () => {};
      },
      getPagedPluginCatalog: vi.fn(async (options: { signal: AbortSignal }) => {
        signal = options.signal;
        return { plugins: [], trustedPlugins: [] };
      }),
      observeEvents: () => ({
        subscribe: (handlers: { snapshot: () => void }) => {
          snapshot = handlers.snapshot;
          snapshot();
        },
        release: async () => {},
      }),
    } as unknown as DaemonClient;
    try {
      await act(async () => {
        render(React.createElement(PluginCatalogSync, { serverId: "same-host", client }));
      });
      expect(state.prepare).toHaveBeenCalledOnce();
      act(() => connectionChanged({ status: "disconnected" }));
      expect(signal?.aborted).toBe(true);
      if (reconnect) act(() => connectionChanged({ status: "connected" }));
      // No rerender or effect cleanup occurred. The production listener owns invalidation.
      await act(async () => completePreparation([]));
      expect(state.registry.installCatalog).not.toHaveBeenCalled();
      expect(policy).toBe("unknown");
      expect(client.getPagedPluginCatalog).toHaveBeenCalledOnce();
      if (reconnect) {
        await act(async () => snapshot());
        expect(client.getPagedPluginCatalog).toHaveBeenCalledTimes(2);
        expect(state.registry.installCatalog).toHaveBeenCalledExactlyOnceWith("same-host", [], {
          client,
          replacePluginId: undefined,
          trustedPlugins: [],
        });
        expect(policy).toBe("standalone");
      }
    } finally {
      state.registry.clearHostInputPolicy.mockReset();
      state.registry.installCatalog.mockReset();
    }
  },
);
