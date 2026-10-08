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
  // Fulcra 0.2.8: each connected computer's role directory and fleet, for the pinned main assistant.
  hosts: [] as { serverId: string; label: string }[],
  remote: {} as Record<string, { directory: unknown; fleet?: unknown }>,
  companyHost: null as string | null,
  chooseCompany: vi.fn(),
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
  useHosts: () => f.hosts,
  getHostRuntimeStore: () => ({
    getHostRegistryStatus: () => (f.registryReady ? "ready" : "loading"),
    getHosts: () => (f.registeredHost && f.host ? [{ serverId: f.host }] : []),
    getSnapshot: (serverId: string) =>
      f.remote[serverId]
        ? {
            client: {
              invokePluginRpc: async (_plugin: string, method: string) =>
                method === "organization.fleet"
                  ? f.remote[serverId]!.fleet
                  : f.remote[serverId]!.directory,
            },
          }
        : undefined,
  }),
}));
vi.mock("@/stores/organization-intake-preferences-store", () => ({
  useOrganizationIntakePreferences: (
    select: (state: { companyHost: string | null; chooseCompany: (id: string) => void }) => unknown,
  ) => select({ companyHost: f.companyHost, chooseCompany: f.chooseCompany }),
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
import { PinnedMainAssistant, PrimeSidebarRows } from "./prime-sidebar";
const clients: QueryClient[] = [];
const fastRetry = () => 1;
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <PrimeSidebarRows serverId="mini" retryDelay={fastRetry} />
    </QueryClientProvider>,
  );
}
function mountPinned() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <PinnedMainAssistant />
    </QueryClientProvider>,
  );
}
const prime = (over: Record<string, unknown> = {}) => ({
  seat: "main",
  role: "prime",
  state: "assigned",
  sessionPresent: true,
  sessionId: "original-prime",
  dispatch: { supported: true },
  ...over,
});
beforeEach(() => {
  f.hosts = [{ serverId: "mini", label: "Davids-Mac-mini.local" }];
  f.remote = {};
  f.companyHost = null;
  f.chooseCompany.mockReset();
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
it("pins the main assistant at the top with its status and computer, and opens its chat", async () => {
  f.remote.mini = {
    directory: {
      available: true,
      primes: [prime(), prime({ seat: "research", state: "vacant", sessionId: null })],
    },
    fleet: { nodes: [{ id: "original-prime", host: "Mac mini", status: "running", pending: 0 }] },
  };
  mountPinned();
  fireEvent.click(await screen.findByRole("button", { name: "Open Main assistant conversation" }));
  expect(screen.getByText("Working · Mac mini")).toBeTruthy();
  expect(f.open).toHaveBeenCalledWith({ serverId: "mini", agentId: "original-prime" });
  expect(screen.queryByText(/Research/)).toBeNull();
});

it("shows the main assistant of another computer on this device, with that computer's name", async () => {
  f.host = "mini";
  f.hosts = [
    { serverId: "book", label: "MacBook Pro" },
    { serverId: "mini", label: "Davids-Mac-mini.local" },
  ];
  f.companyHost = "book";
  f.remote = {
    book: { directory: { available: true, primes: [] } },
    mini: { directory: { available: true, primes: [prime()] } },
  };
  mountPinned();
  expect(await screen.findByText("Davids-Mac-mini.local")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open Main assistant conversation" }));
  expect(f.open).toHaveBeenCalledWith({ serverId: "mini", agentId: "original-prime" });
});

it("an unreachable main assistant chat says so and opens Leads instead", async () => {
  f.host = null;
  f.remote.mini = { directory: { available: true, primes: [prime({ sessionPresent: false })] } };
  mountPinned();
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Manage Main assistant · Not connected · Davids-Mac-mini.local",
    }),
  );
  expect(f.open).not.toHaveBeenCalled();
  expect(f.push).toHaveBeenCalledWith("/h/mini/plugin/orca-organization-next/surface/leadership");
});

it("shows nothing pinned when no connected computer has a main assistant", async () => {
  f.remote.mini = { directory: { available: true, primes: [] } };
  mountPinned();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(screen.queryByRole("button")).toBeNull();
});

it("distinguishes unavailable role records from an empty directory and allows retry", async () => {
  f.read.mockResolvedValue({ available: false, primes: [] });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Couldn't load leads · Retry" }));
  expect(screen.queryByText("No main assistant yet · Set up")).toBeNull();
  expect(f.open).not.toHaveBeenCalled();
});

it("keeps setup reachable for an empty organization", async () => {
  f.read.mockResolvedValue({ available: true, primes: [] });
  f.remote.mini = { directory: { available: true, primes: [] } };
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "No main assistant yet · Set up" }));
  expect(
    screen.getByRole("button", { name: "Leads: your main assistant and project leads" }),
  ).toBeTruthy();
  expect(f.push).toHaveBeenCalledOnce();
});

it("offers the main assistant on another computer as the first setup choice", async () => {
  f.hosts = [
    { serverId: "mini", label: "MacBook Pro" },
    { serverId: "other", label: "Davids-Mac-mini.local" },
  ];
  f.read.mockResolvedValue({ available: true, primes: [] });
  f.remote = {
    mini: { directory: { available: true, primes: [] } },
    other: { directory: { available: true, primes: [prime()] } },
  };
  mount();
  const use = await screen.findByRole("button", {
    name: "Use the main assistant on Davids-Mac-mini.local",
  });
  const buttons = screen.getAllByRole("button").map((b) => b.textContent);
  expect(buttons.indexOf(use.textContent)).toBeLessThan(
    buttons.indexOf("Set up a main assistant here"),
  );
  fireEvent.click(use);
  expect(f.chooseCompany).toHaveBeenCalledWith("other");
});

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
    name: "Open Lead · weather-cli conversation",
  });
  expect(await screen.findByText("Waiting for you · MacBook Pro")).toBeTruthy();
  expect(screen.queryByText(/proj-2/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "New work for Lead · weather-cli" }));
  fireEvent.change(screen.getByTestId("sidebar-new-work-input"), {
    target: { value: "Add a --days flag" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send to Lead · weather-cli" }));
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
  const lead = {
    seat: "p1",
    role: "project-orchestrator",
    projectId: "proj-1",
    state: "assigned",
    sessionPresent: true,
    sessionId: "original-prime",
  };
  f.projects.mockResolvedValue({ projects: [{ id: "proj-1", name: "weather-cli" }] });
  f.read
    .mockRejectedValueOnce(new Error("plugin not ready"))
    .mockResolvedValueOnce({ available: false, primes: [] })
    .mockResolvedValue({ available: true, primes: [prime()], projectSeats: [lead] });
  f.fleet
    .mockReset()
    .mockRejectedValueOnce(new Error("plugin not ready"))
    .mockResolvedValue({
      nodes: [
        { id: "original-prime", host: "Mac mini", status: "idle", pending: 0, title: "Main" },
      ],
    });
  mount();
  expect(
    await screen.findByRole("button", { name: "Open Lead · weather-cli conversation" }),
  ).toBeTruthy();
  expect(screen.queryByText("Couldn't load leads · Retry")).toBeNull();
  expect(f.read).toHaveBeenCalledTimes(3);
  expect(f.fleet).toHaveBeenCalledTimes(2);
});

it("Retry reads the lead status again, not only the main assistant list", async () => {
  f.read.mockResolvedValue({ available: false, primes: [] });
  f.fleet.mockReset().mockRejectedValue(new Error("plugin not ready"));
  mount();
  const retry = await screen.findByRole("button", { name: "Couldn't load leads · Retry" });
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
  f.projects.mockResolvedValue({ projects: [{ id: "proj-1", name: "weather-cli" }] });
  fireEvent.click(retry);
  await vi.waitFor(() => expect(f.fleet.mock.calls.length).toBeGreaterThan(fleetCalls));
  expect(await screen.findByText(/Idle · MacBook Pro/)).toBeTruthy();
  expect(screen.queryByText(/Status unknown/)).toBeNull();
});
