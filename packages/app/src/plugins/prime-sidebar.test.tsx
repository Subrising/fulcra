// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
const f = vi.hoisted(() => ({
  read: vi.fn(),
  open: vi.fn(),
  push: vi.fn(),
  host: "mini" as string | null,
  registryReady: true,
  registeredHost: true,
}));
vi.mock("expo-router", () => ({ router: { push: f.push } }));
vi.mock("./host-navigation-model", () => ({ createPluginHostNavigation: () => ({}) }));
vi.mock("@/utils/navigate-to-agent", () => ({ navigateToAgent: f.open }));
vi.mock("@/stores/navigation-active-workspace-store", () => ({ navigateToWorkspace: vi.fn() }));
vi.mock("@/constants/platform", () => ({ getIsElectron: () => false }));
vi.mock("@/desktop/browser/store", () => ({ createWorkspaceBrowser: vi.fn() }));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: (
    select: (state: { sessions: Record<string, { agents: Map<string, object> }> }) => string | null,
  ) =>
    select({
      sessions: f.host
        ? {
            [f.host]: {
              agents: new Map([
                ["original-prime", {}],
                ["remote", {}],
              ]),
            },
          }
        : {},
    }),
}));
vi.mock("./registry", () => ({ useInstalledPlugin: () => null }));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => null,
  getHostRuntimeStore: () => ({
    getHostRegistryStatus: () => (f.registryReady ? "ready" : "loading"),
    getHosts: () => (f.registeredHost && f.host ? [{ serverId: f.host }] : []),
  }),
}));
vi.mock("./runtime-boundary", () => ({ PluginRuntimeBoundary: () => null }));
vi.mock("./command-centre-connection", () => ({
  COMMAND_CENTRE_PLUGIN_ID: "orca-organization-next",
}));
vi.mock("../../../../control/orca-organization/client/use-contract", () => ({
  useContract: () => f.read,
}));
vi.mock("@/components/sidebar/sidebar-header-row", () => ({
  SidebarHeaderRow: ({
    label,
    accessibilityLabel,
    onPress,
  }: {
    label: string;
    accessibilityLabel?: string;
    onPress: () => void;
  }) => (
    <button type="button" aria-label={accessibilityLabel ?? label} onClick={onPress}>
      {label}
    </button>
  ),
}));
import { PrimeSidebarRows } from "./prime-sidebar";
const clients: QueryClient[] = [];
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <PrimeSidebarRows serverId="mini" />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  f.open.mockClear();
  f.push.mockClear();
  f.read.mockReset();
  f.host = "mini";
  f.registryReady = true;
  f.registeredHost = true;
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((c) => c.clear());
});
it("opens the recorded prime identity and manages vacant slots through Leadership", async () => {
  f.read.mockResolvedValue({
    available: true,
    primes: [
      {
        seat: "delivery",
        state: "assigned",
        sessionPresent: true,
        sessionId: "original-prime",
        dispatch: { supported: true },
      },
      { seat: "research", state: "vacant", sessionId: null },
    ],
  });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Open Delivery prime conversation" }));
  expect(f.open).toHaveBeenCalledWith({ serverId: "mini", agentId: "original-prime" });
  fireEvent.click(screen.getByRole("button", { name: "Manage Research prime · Empty slot" }));
  expect(f.push).toHaveBeenCalledWith("/h/mini/plugin/orca-organization-next/surface/leadership");
  expect(f.read).toHaveBeenCalledWith({});
});
it("distinguishes unavailable role records from an empty directory and allows retry", async () => {
  f.read.mockResolvedValue({ available: false, primes: [] });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Prime slots unavailable · Retry" }));
  expect(screen.queryByText("No prime slots · Set up")).toBeNull();
  expect(f.open).not.toHaveBeenCalled();
});
it("keeps top primes and setup reachable for an empty organization", async () => {
  f.read.mockResolvedValue({ available: true, primes: [] });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "No prime slots · Set up" }));
  expect(screen.getByRole("button", { name: "Top primes" })).toBeTruthy();
  expect(f.push).toHaveBeenCalledOnce();
});
it("does not open a missing or unloaded identity on the controller host", async () => {
  f.host = null;
  f.read.mockResolvedValue({
    available: true,
    primes: [
      {
        seat: "delivery",
        state: "assigned",
        sessionPresent: false,
        sessionId: "old",
        dispatch: { supported: true },
      },
      {
        seat: "research",
        state: "assigned",
        sessionPresent: true,
        sessionId: "remote",
        dispatch: { supported: false },
      },
    ],
  });
  mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "Manage Delivery prime · Unavailable" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Manage Research prime · Unavailable" }));
  expect(f.open).not.toHaveBeenCalled();
  expect(f.push).toHaveBeenCalledTimes(2);
});

it("opens a Book prime on its original host instead of the controller", async () => {
  f.host = "book";
  f.read.mockResolvedValue({
    available: true,
    primes: [
      {
        seat: "research",
        state: "assigned",
        sessionPresent: true,
        sessionId: "remote",
        dispatch: { supported: true },
      },
    ],
  });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Open Research prime conversation" }));
  expect(f.open).toHaveBeenCalledWith({ serverId: "book", agentId: "remote" });
});

for (const refusal of ["missing-host", "registry-not-ready"] as const) {
  it(`retains the cached Book prime identity and opens Leadership when ${refusal}`, async () => {
    f.host = "book";
    f.registeredHost = refusal !== "missing-host";
    f.registryReady = refusal !== "registry-not-ready";
    f.read.mockResolvedValue({
      available: true,
      primes: [
        {
          seat: "research",
          state: "assigned",
          sessionPresent: true,
          sessionId: "remote",
          dispatch: { supported: true },
        },
      ],
    });
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "Open Research prime conversation" }),
    );
    expect(f.open).not.toHaveBeenCalled();
    expect(f.push).toHaveBeenCalledWith("/h/mini/plugin/orca-organization-next/surface/leadership");
    expect(f.push).toHaveBeenCalledTimes(1);
  });
}
