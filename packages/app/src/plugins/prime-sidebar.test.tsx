// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
const f = vi.hoisted(() => ({
  read: vi.fn(),
  fleet: vi.fn(),
  projects: vi.fn(),
  send: vi.fn(),
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
vi.mock("@/constants/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/constants/platform")>()),
  getIsElectron: () => false,
  isWeb: true,
  isNative: false,
}));
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
vi.mock("./registry", () => ({
  useControllerPlugin: () => null,
  pluginRegistry: { controllerPluginId: () => "orca-organization-next" },
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => ({ sendAgentMessage: f.send }),
  getHostRuntimeStore: () => ({
    getHostRegistryStatus: () => (f.registryReady ? "ready" : "loading"),
    getHosts: () => (f.registeredHost && f.host ? [{ serverId: f.host }] : []),
  }),
}));
vi.mock("./installation-provider", () => ({ PluginInstallationProvider: () => null }));
vi.mock("../../../../control/orca-organization/client/use-contract", () => ({
  useContract: (contract: { name: string }) =>
    ({ "organization.fleet": f.fleet, "organization.projects": f.projects })[contract.name] ??
    f.read,
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
      <PrimeSidebarRows serverId="mini" retryDelay={() => 1} />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  f.open.mockClear();
  f.push.mockClear();
  f.read.mockReset();
  f.send.mockReset();
  f.fleet.mockReset().mockResolvedValue({ nodes: [] });
  f.projects.mockReset().mockResolvedValue({ projects: [] });
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
  fireEvent.click(
    await screen.findByRole("button", { name: "Open Delivery main assistant conversation" }),
  );
  expect(f.open).toHaveBeenCalledWith({ serverId: "mini", agentId: "original-prime" });
  fireEvent.click(
    screen.getByRole("button", { name: "Manage Research main assistant · Empty slot" }),
  );
  expect(f.push).toHaveBeenCalledWith("/h/mini/plugin/orca-organization-next/surface/leadership");
  expect(f.read).toHaveBeenCalledWith({});
});
it("distinguishes unavailable role records from an empty directory and allows retry", async () => {
  f.read.mockResolvedValue({ available: false, primes: [] });
  mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "Couldn't load main assistants · Retry" }),
  );
  expect(screen.queryByText("No main assistant yet · Set up")).toBeNull();
  expect(f.open).not.toHaveBeenCalled();
});
it("keeps top primes and setup reachable for an empty organization", async () => {
  f.read.mockResolvedValue({ available: true, primes: [] });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "No main assistant yet · Set up" }));
  expect(
    screen.getByRole("button", { name: "Leads: your main assistant and project leads" }),
  ).toBeTruthy();
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
    await screen.findByRole("button", { name: "Manage Delivery main assistant · Unavailable" }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Manage Research main assistant · Unavailable" }),
  );
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
  fireEvent.click(
    await screen.findByRole("button", { name: "Open Research main assistant conversation" }),
  );
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
      await screen.findByRole("button", { name: "Open Research main assistant conversation" }),
    );
    expect(f.open).not.toHaveBeenCalled();
    expect(f.push).toHaveBeenCalledWith("/h/mini/plugin/orca-organization-next/surface/leadership");
    expect(f.push).toHaveBeenCalledTimes(1);
  });
}

it("pins project leads with a plain status and computer, and + sends new work then opens the chat", async () => {
  f.read.mockResolvedValue({
    available: true,
    primes: [
      {
        seat: "delivery",
        role: "prime",
        state: "assigned",
        sessionPresent: true,
        sessionId: "original-prime",
      },
    ],
    projectSeats: [
      {
        seat: "p1",
        role: "project-orchestrator",
        projectId: "proj-1",
        state: "assigned",
        sessionPresent: true,
        sessionId: "remote",
      },
      {
        seat: "p2",
        role: "project-orchestrator",
        projectId: "proj-2",
        state: "vacant",
        sessionId: null,
      },
    ],
  });
  f.fleet.mockResolvedValue({
    nodes: [
      { id: "original-prime", host: "Mac mini", status: "running", pending: 0, title: "Main" },
      { id: "remote", host: "MacBook Pro", status: "idle", pending: 1, title: "Forecast" },
    ],
  });
  f.projects.mockResolvedValue({ projects: [{ id: "proj-1", name: "weather-cli" }] });
  f.send.mockResolvedValue(undefined);
  mount();
  const lead = await screen.findByRole("button", {
    name: "Open Project lead · weather-cli conversation",
  });
  expect(await screen.findByText("Waiting for you · MacBook Pro")).toBeTruthy();
  expect(screen.getByText("Working · Mac mini")).toBeTruthy();
  expect(screen.queryByText(/proj-2/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "New work for Project lead · weather-cli" }));
  fireEvent.change(screen.getByTestId("sidebar-new-work-input"), {
    target: { value: "Add a --days flag" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send to Project lead · weather-cli" }));
  await vi.waitFor(() => expect(f.send).toHaveBeenCalledWith("remote", "Add a --days flag"));
  await vi.waitFor(() =>
    expect(f.open).toHaveBeenCalledWith({ serverId: "mini", agentId: "remote" }),
  );
  fireEvent.click(lead);
});

it("Team map is one click from the sidebar", async () => {
  f.read.mockResolvedValue({ available: true, primes: [] });
  mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "Team map: who leads whom and what each is doing" }),
  );
  expect(f.push).toHaveBeenCalledWith("/h/mini/plugin/orca-organization-next/surface/leadership");
});

// FULCRA(sidebar-retry): after a daemon restart the first reads fail; the sidebar must load without a Retry press.
it("retries the first load by itself after a restart", async () => {
  const delivery = {
    seat: "delivery",
    role: "prime",
    state: "assigned",
    sessionPresent: true,
    sessionId: "original-prime",
  };
  f.read
    .mockRejectedValueOnce(new Error("plugin not ready"))
    .mockResolvedValueOnce({ available: false, primes: [] })
    .mockResolvedValue({ available: true, primes: [delivery] });
  f.fleet
    .mockReset()
    .mockRejectedValueOnce(new Error("plugin not ready"))
    .mockResolvedValue({
      nodes: [{ id: "original-prime", host: "Mac mini", status: "idle", pending: 0, title: "Main" }],
    });
  mount();
  expect(
    await screen.findByRole("button", { name: "Open Delivery main assistant conversation" }),
  ).toBeTruthy();
  expect(screen.queryByText("Couldn't load main assistants · Retry")).toBeNull();
  expect(f.read).toHaveBeenCalledTimes(3);
  expect(f.fleet).toHaveBeenCalledTimes(2);
});

it("Retry reads the lead status again, not only the main assistant list", async () => {
  f.read.mockResolvedValue({ available: false, primes: [] });
  f.fleet.mockReset().mockRejectedValue(new Error("plugin not ready"));
  mount();
  const retry = await screen.findByRole("button", { name: "Couldn't load main assistants · Retry" });
  const fleetCalls = f.fleet.mock.calls.length;
  f.read.mockResolvedValue({
    available: true,
    primes: [],
    projectSeats: [
      {
        seat: "p1",
        role: "project-orchestrator",
        projectId: "proj-1",
        state: "assigned",
        sessionPresent: true,
        sessionId: "remote",
      },
    ],
  });
  f.fleet.mockResolvedValue({
    nodes: [{ id: "remote", host: "MacBook Pro", status: "idle", pending: 0, title: "Lead" }],
  });
  fireEvent.click(retry);
  await vi.waitFor(() => expect(f.fleet.mock.calls.length).toBeGreaterThan(fleetCalls));
  expect(await screen.findByText(/Idle · MacBook Pro/)).toBeTruthy();
  expect(screen.queryByText(/Status unknown/)).toBeNull();
});
