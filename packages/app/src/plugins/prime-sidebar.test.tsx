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
  remote: {} as Record<string, { directory: unknown; fleet?: unknown; projects?: unknown }>,
  companyHost: null as string | null,
  chooseCompany: vi.fn(),
  offline: new Set<string>(),
  // Fulcra 0.2.14: chats from the app's chat list, by computer, and the records of the two default chats.
  untrusted: [] as { serverId: string; id: string }[],
  chats: {} as Record<string, Record<string, object>>,
  records: {} as Record<string, object>,
  cached: null as null | { key: string; value: unknown },
  state() {
    // One object while nothing changes, as the real store gives, so a selector's result stays stable.
    const key = JSON.stringify([this.host, this.chats, this.records]);
    if (this.cached?.key === key) return this.cached.value as never;
    const sessions: Record<string, { agents: Map<string, object> }> = this.host
      ? {
          [this.host]: {
            agents: new Map<string, object>([
              ["original-prime", this.records["original-prime"] ?? {}],
              ["remote", this.records["remote"] ?? {}],
            ]),
          },
        }
      : {};
    for (const [server, chats] of Object.entries(this.chats)) {
      sessions[server] ??= { agents: new Map() };
      for (const [id, chat] of Object.entries(chats)) sessions[server]!.agents.set(id, chat);
    }
    this.cached = { key, value: { sessions } };
    return this.cached.value as never;
  },
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
    select: (state: { sessions: Record<string, { agents: Map<string, object> }> }) => unknown,
  ) => select(f.state()),
}));
vi.mock("@/stores/leads-memory-store", async () => {
  const { create } = await import("zustand");
  interface Lead {
    seat: string;
    sessionId: string;
    project: string;
    title: string;
  }
  const useLeadsMemory = create<{
    byHost: Record<string, Lead[]>;
    remember: (id: string, leads: Lead[]) => void;
    forget: (id: string) => void;
  }>()((set, get) => ({
    byHost: {},
    remember: (id, leads) => {
      if (JSON.stringify(get().byHost[id] ?? []) === JSON.stringify(leads)) return;
      const { [id]: _old, ...rest } = get().byHost;
      set({ byHost: leads.length ? { ...rest, [id]: leads } : rest });
    },
    forget: () => {},
  }));
  return { useLeadsMemory };
});
vi.mock("./registry", () => ({
  useUntrustedPlugins: () => f.untrusted,
  useControllerPlugin: () => null,
  pluginRegistry: { controllerPluginId: () => "orca-organization-next" },
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => ({ sendAgentMessage: f.send }),
  useHosts: () => f.hosts,
  useHostRegistryLoaded: () => true,
  useHostRuntimeConnectionStatuses: (ids: readonly string[]) =>
    new Map(ids.map((id) => [id, f.offline.has(id) ? "offline" : "online"])),
  getHostRuntimeStore: () => ({
    getHostRegistryStatus: () => (f.registryReady ? "ready" : "loading"),
    getHosts: () => (f.registeredHost && f.host ? [{ serverId: f.host }] : []),
    getSnapshot: (serverId: string) =>
      f.remote[serverId]
        ? {
            client: {
              invokePluginRpc: async (_plugin: string, method: string) =>
                ({
                  "organization.fleet": f.remote[serverId]!.fleet,
                  "organization.projects": f.remote[serverId]!.projects,
                })[method] ?? f.remote[serverId]!.directory,
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
vi.mock("@/stores/main-assistant-memory-store", async () => {
  const { create } = await import("zustand");
  type Memory = Record<string, { seat: string; sessionId: string }>;
  const useMainAssistantMemory = create<{
    byHost: Memory;
    remember: (id: string, v: { seat: string; sessionId: string }) => void;
    forget: (id: string) => void;
  }>()((set, get) => ({
    byHost: {},
    remember: (id, v) => {
      const c = get().byHost[id];
      if (c?.seat !== v.seat || c?.sessionId !== v.sessionId)
        set({ byHost: { ...get().byHost, [id]: v } });
    },
    forget: (id) => {
      if (!(id in get().byHost)) return;
      const next = { ...get().byHost };
      delete next[id];
      set({ byHost: next });
    },
  }));
  return { useMainAssistantMemory };
});
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
import {
  leadsFailureLabel,
  PinnedMainAssistant,
  PrimeSidebarRows,
  rememberedNote,
  SIDEBAR_REFRESH_MS,
} from "./prime-sidebar";
import { useMainAssistantMemory } from "@/stores/main-assistant-memory-store";
import { useLeadsMemory } from "@/stores/leads-memory-store";
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
  f.hosts = [{ serverId: "mini", label: "Mac-mini.local" }];
  f.remote = {};
  f.companyHost = null;
  f.offline = new Set();
  useMainAssistantMemory.setState({ byHost: {} });
  f.chooseCompany.mockReset();
  f.open.mockClear();
  f.push.mockClear();
  f.chats = {};
  f.records = {};
  f.untrusted = [];
  useLeadsMemory.setState({ byHost: {} });
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
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Open Main assistant · Mac-mini.local conversation",
    }),
  );
  expect(screen.getByText("Working · Mac mini")).toBeTruthy();
  expect(f.open).toHaveBeenCalledWith({ serverId: "mini", agentId: "original-prime" });
  expect(screen.queryByText(/Research/)).toBeNull();
});

it("shows the main assistant of another computer on this device, with that computer's name", async () => {
  f.host = "mini";
  f.hosts = [
    { serverId: "book", label: "MacBook Pro" },
    { serverId: "mini", label: "Mac-mini.local" },
  ];
  f.companyHost = "book";
  f.remote = {
    book: { directory: { available: true, primes: [] } },
    mini: { directory: { available: true, primes: [prime()] } },
  };
  mountPinned();
  expect(await screen.findByText("Main assistant · Mac-mini.local")).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", {
      name: "Open Main assistant · Mac-mini.local conversation",
    }),
  );
  expect(f.open).toHaveBeenCalledWith({ serverId: "mini", agentId: "original-prime" });
});

it("an unreachable main assistant chat says so and opens Leads instead", async () => {
  f.host = null;
  f.remote.mini = { directory: { available: true, primes: [prime({ sessionPresent: false })] } };
  mountPinned();
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Manage Main assistant · Mac-mini.local · Not connected",
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
  fireEvent.click(await screen.findByRole("button", { name: /^Couldn't load leads/ }));
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
    { serverId: "other", label: "Mac-mini.local" },
  ];
  f.read.mockResolvedValue({ available: true, primes: [] });
  f.remote = {
    mini: { directory: { available: true, primes: [] } },
    other: { directory: { available: true, primes: [prime()] } },
  };
  mount();
  const use = await screen.findByRole("button", {
    name: "Use the main assistant on Mac-mini.local",
  });
  const buttons = screen.getAllByRole("button").map((b) => b.textContent);
  expect(buttons.indexOf(use.textContent)).toBeLessThan(
    buttons.indexOf("Make a chat the main assistant"),
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
  // Fulcra 0.2.11: each row names its chat; the role, project, status and computer follow.
  const lead = await screen.findByRole("button", { name: "Open Forecast conversation" });
  expect(
    await screen.findByText("Lead · weather-cli · Waiting for you · MacBook Pro"),
  ).toBeTruthy();
  expect(screen.queryByText(/proj-2/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "New work for Forecast" }));
  fireEvent.change(screen.getByTestId("sidebar-new-work-input"), {
    target: { value: "Add a --days flag" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send to Forecast" }));
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
  expect(await screen.findByTestId("sidebar-lead-p1")).toBeTruthy();
  expect(screen.queryByText(/^Couldn't load leads/)).toBeNull();
  expect(f.read).toHaveBeenCalledTimes(3);
  expect(f.fleet).toHaveBeenCalledTimes(2);
});

it("Retry reads the lead status again, not only the main assistant list", async () => {
  f.read.mockResolvedValue({ available: false, primes: [] });
  f.fleet.mockReset().mockRejectedValue(new Error("plugin not ready"));
  mount();
  const retry = await screen.findByRole("button", { name: /^Couldn't load leads/ });
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

it("keeps an offline computer's main assistant, marked offline, and opens its chat", async () => {
  f.hosts = [
    { serverId: "book", label: "MacBook Pro" },
    { serverId: "mini", label: "Mac-mini.local" },
  ];
  f.remote = {
    book: { directory: { available: true, primes: [] } },
    mini: { directory: { available: true, primes: [prime()] } },
  };
  mountPinned();
  await screen.findByText("Main assistant · Mac-mini.local");
  expect(useMainAssistantMemory.getState().byHost.mini).toEqual({
    seat: "main",
    sessionId: "original-prime",
  });
  cleanup();
  f.offline = new Set(["mini"]);
  mountPinned();
  const row = await screen.findByRole("button", {
    name: "Open Main assistant conversation. Mac-mini.local is offline.",
  });
  expect(screen.getByText("Main assistant · Mac-mini.local · offline")).toBeTruthy();
  expect(screen.queryByText(/No main assistant yet/)).toBeNull();
  fireEvent.click(row);
  expect(f.open).toHaveBeenCalledWith({ serverId: "mini", agentId: "original-prime" });
});

it("an offline computer's main assistant hides 'No main assistant yet' in Set up", async () => {
  f.hosts = [
    { serverId: "mini", label: "MacBook Pro" },
    { serverId: "other", label: "Mac-mini.local" },
  ];
  f.offline = new Set(["other"]);
  useMainAssistantMemory.setState({
    byHost: { other: { seat: "main", sessionId: "remote" } },
  });
  f.read.mockResolvedValue({ available: true, primes: [] });
  f.remote = { mini: { directory: { available: true, primes: [] } } };
  mount();
  expect(
    await screen.findByRole("button", { name: "Use the main assistant on Mac-mini.local" }),
  ).toBeTruthy();
  expect(screen.queryByText("No main assistant yet · Set up")).toBeNull();
});

it("shows both main assistants when two computers have one, each with its computer", async () => {
  f.host = "mini";
  f.hosts = [
    { serverId: "book", label: "MacBook Pro" },
    { serverId: "mini", label: "Mac-mini.local" },
  ];
  f.companyHost = "mini";
  f.remote = {
    book: { directory: { available: true, primes: [prime({ sessionId: "remote" })] } },
    mini: { directory: { available: true, primes: [prime()] } },
  };
  mountPinned();
  await screen.findByText("Main assistant · Mac-mini.local");
  expect(await screen.findByText("Main assistant · MacBook Pro")).toBeTruthy();
  const titles = screen.getAllByText(/^Main assistant · /).map((node) => node.textContent);
  expect(titles).toEqual(["Main assistant · Mac-mini.local", "Main assistant · MacBook Pro"]);
});

it("forgets a computer's main assistant when that computer says it has none", async () => {
  useMainAssistantMemory.setState({ byHost: { mini: { seat: "main", sessionId: "gone" } } });
  f.remote.mini = { directory: { available: true, primes: [] } };
  mountPinned();
  await vi.waitFor(() => expect(useMainAssistantMemory.getState().byHost.mini).toBeUndefined());
  expect(screen.queryByRole("button")).toBeNull();
});

it("says it is still finding the main assistant while another computer's read is pending", async () => {
  f.hosts = [
    { serverId: "mini", label: "MacBook Pro" },
    { serverId: "other", label: "Mac-mini.local" },
  ];
  let answer: (value: unknown) => void = () => undefined;
  f.read.mockResolvedValue({ available: true, primes: [] });
  f.remote = {
    mini: { directory: { available: true, primes: [] } },
    other: { directory: new Promise((resolve) => (answer = resolve)) },
  };
  mount();
  expect(await screen.findByText("Finding your main assistant…")).toBeTruthy();
  expect(screen.queryByText("No main assistant yet · Set up")).toBeNull();
  answer({ available: true, primes: [prime({ sessionId: "remote" })] });
  expect(
    await screen.findByRole("button", { name: "Use the main assistant on Mac-mini.local" }),
  ).toBeTruthy();
});

// Fulcra 0.2.9: with the Mac mini's controller stopped, the row said "Loading leads…" for about 35 s, then only
// "Couldn't load leads", with no reason.
it("gives the reason and the computer at the first failed reply, while it keeps retrying", async () => {
  f.hosts = [{ serverId: "mini", label: "Mac mini" }];
  let answer: (value: unknown) => void = () => undefined;
  f.read
    .mockResolvedValueOnce({ available: false, unavailable: "Management refused", primes: [] })
    .mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
  mount();
  expect(
    await screen.findByRole("button", {
      name: "Couldn't load leads: Command Centre is not answering on Mac mini · Retry",
    }),
  ).toBeTruthy();
  expect(screen.queryByText("Loading leads…")).toBeNull();
  // The automatic retries go on behind the reason; the first good reply replaces it.
  await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(2));
  answer({ available: true, primes: [prime()], projectSeats: [] });
  await vi.waitFor(() => expect(screen.queryByText(/^Couldn't load leads/)).toBeNull());
});

it("names a specific reason as it is, and a generic one as Command Centre not answering", () => {
  const relay = "Command Centre needs a direct connection to this Mac";
  expect(leadsFailureLabel(new Error(relay), "Mac mini")).toBe(
    `Couldn't load leads: ${relay} · Retry`,
  );
  for (const generic of [
    "Management refused",
    "Role records unavailable",
    "Controller stopped",
    "",
  ])
    expect(leadsFailureLabel(new Error(generic), "Mac mini")).toBe(
      "Couldn't load leads: Command Centre is not answering on Mac mini · Retry",
    );
});

// Fulcra 0.2.11 (the owner, 10 Oct): the main assistant was only pinned, not in Leads; rows said only "Lead · <project>".
it("lists the main assistant first in Leads, by its chat name, then the project leads", async () => {
  f.read.mockResolvedValue({
    available: true,
    primes: [prime()],
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
    nodes: [
      {
        id: "original-prime",
        host: "Mac mini",
        status: "running",
        pending: 0,
        title: "Fulcra main assistant",
      },
      { id: "remote", host: "Mac mini", status: "idle", pending: 0, title: "Fulcra lead" },
    ],
  });
  f.projects.mockResolvedValue({ projects: [{ id: "proj-1", name: "Fulcra" }] });
  mount();
  const main = await screen.findByTestId("sidebar-lead-main-assistant");
  const lead = await screen.findByTestId("sidebar-lead-p1");
  expect(main.textContent).toContain("Fulcra main assistant");
  expect(main.textContent).toContain("Main assistant · Working · Mac mini");
  expect(lead.textContent).toContain("Fulcra lead");
  expect(lead.textContent).toContain("Lead · Fulcra · Idle · Mac mini");
  // The main assistant comes first.
  expect(main.compareDocumentPosition(lead) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it("a row without a known chat name keeps the role as its name", async () => {
  f.read.mockResolvedValue({ available: true, primes: [prime()], projectSeats: [] });
  f.fleet.mockResolvedValue({ nodes: [] });
  mount();
  const main = await screen.findByTestId("sidebar-lead-main-assistant");
  expect(main.textContent).toContain("Main assistant");
  expect(main.textContent).toContain("Main assistant · Status unknown");
});

it("lists the leads of another connected computer read-only, with that computer's name", async () => {
  f.hosts = [
    { serverId: "mini", label: "Mac mini" },
    { serverId: "book", label: "MacBook Pro" },
  ];
  f.read.mockResolvedValue({ available: true, primes: [prime()], projectSeats: [] });
  f.remote.book = {
    directory: {
      available: true,
      primes: [],
      projectSeats: [
        {
          seat: "g1",
          role: "project-orchestrator",
          projectId: "proj-g",
          state: "assigned",
          sessionPresent: true,
          sessionId: "remote",
        },
        {
          seat: "old",
          role: "project-orchestrator",
          projectId: "proj-archived",
          state: "assigned",
          sessionPresent: true,
          sessionId: "remote",
        },
      ],
    },
    projects: { projects: [{ id: "proj-g", name: "Example project" }] },
    fleet: {
      nodes: [
        { id: "remote", host: "macbook", status: "idle", pending: 0, title: "Remote project lead" },
      ],
    },
  };
  mount();
  const row = await screen.findByTestId("sidebar-remote-lead-book-g1");
  expect(row.textContent).toContain("Remote project lead");
  expect(row.textContent).toContain("Lead · Example project · Idle · MacBook Pro");
  expect(row.textContent).not.toContain("macbook ·");
  // Read-only: no new work from here; a lead of an archived project is hidden.
  expect(screen.queryByTestId("sidebar-remote-lead-book-g1-new-work")).toBeNull();
  expect(screen.queryByTestId("sidebar-remote-lead-book-old")).toBeNull();
});

// Fulcra 0.2.11 (decision by the Fulcra lead, 10 Oct): Leads lists the home computer's main assistant first, so its
// automatic pinned row goes. Another computer's main assistant stays pinned, and the pin returns when Leads cannot
// list it.
function mountBoth() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <PinnedMainAssistant />
      <PrimeSidebarRows serverId="mini" retryDelay={fastRetry} />
    </QueryClientProvider>,
  );
}

it("drops the automatic pin of the main assistant that Leads lists; another computer's pin stays", async () => {
  f.hosts = [
    { serverId: "mini", label: "Mac-mini.local" },
    { serverId: "book", label: "MacBook Pro" },
  ];
  const directory = { available: true, primes: [prime()], projectSeats: [] };
  f.read.mockResolvedValue(directory);
  f.remote.mini = { directory, fleet: { nodes: [] } };
  f.remote.book = {
    directory: { available: true, primes: [prime({ sessionId: "remote" })] },
    fleet: { nodes: [] },
  };
  mountBoth();
  expect(await screen.findByTestId("sidebar-lead-main-assistant")).toBeTruthy();
  expect(
    await screen.findByRole("button", { name: /^Open Main assistant · MacBook Pro/ }),
  ).toBeTruthy();
  // The only pin left is the other computer's.
  await vi.waitFor(() =>
    expect(screen.getByTestId("sidebar-pinned-main-assistant").textContent).toContain(
      "MacBook Pro",
    ),
  );
  expect(screen.queryByText(/Main assistant · Mac-mini\.local/)).toBeNull();
});

it("keeps the pin when Leads cannot list the main assistant", async () => {
  f.read.mockResolvedValue({ available: false, primes: [] });
  f.remote.mini = {
    directory: { available: true, primes: [prime()] },
    fleet: { nodes: [] },
  };
  mountBoth();
  expect(await screen.findByRole("button", { name: /^Couldn't load leads/ })).toBeTruthy();
  const pin = await screen.findByTestId("sidebar-pinned-main-assistant");
  expect(pin.textContent).toContain("Main assistant · Mac-mini.local");
  expect(screen.queryByTestId("sidebar-lead-main-assistant")).toBeNull();
});

// Fulcra 0.2.14 (FU-51): leads missing from the sidebar.
it("shows a seated lead even when the projects read fails or lacks its project", async () => {
  f.read.mockResolvedValue({
    available: true,
    primes: [prime()],
    projectSeats: [
      {
        seat: "p9",
        role: "project-orchestrator",
        projectId: "proj-9",
        state: "assigned",
        sessionPresent: true,
        sessionId: "remote",
      },
    ],
  });
  f.projects.mockRejectedValue(new Error("projects unavailable"));
  mount();
  const lead = await screen.findByTestId("sidebar-lead-p9");
  expect(lead.textContent).toContain("Lead · project");
});

it("still hides the lead of an archived project when the projects list was read", async () => {
  f.read.mockResolvedValue({
    available: true,
    primes: [prime()],
    projectSeats: [
      {
        seat: "p9",
        role: "project-orchestrator",
        projectId: "gone",
        state: "assigned",
        sessionPresent: true,
        sessionId: "remote",
      },
    ],
  });
  f.projects.mockResolvedValue({ projects: [{ id: "other", name: "Other" }] });
  mount();
  await screen.findByTestId("sidebar-lead-main-assistant");
  expect(screen.queryByTestId("sidebar-lead-p9")).toBeNull();
});

it("lists a chat that reports to the main assistant without a seat, on any connected computer", async () => {
  f.read.mockResolvedValue({ available: true, primes: [prime()], projectSeats: [] });
  f.hosts = [
    { serverId: "mini", label: "Mac-mini.local" },
    { serverId: "book", label: "Second computer" },
  ];
  f.chats = {
    book: {
      "gag-lead": {
        id: "gag-lead",
        title: "Example project · Fulcra orchestrator",
        status: "idle",
        labels: { "fulcra.reports-to": "role:main-assistant" },
      },
      worker: {
        id: "worker",
        title: "A worker",
        status: "idle",
        labels: { "fulcra.reports-to": "gag-lead" },
      },
    },
  };
  mount();
  const row = await screen.findByTestId("sidebar-chat-lead-book-gag-lead");
  expect(row.textContent).toContain("Example project · Fulcra orchestrator");
  expect(row.textContent).toContain("Lead · Idle · last known · Second computer");
  expect(screen.queryByTestId("sidebar-chat-lead-book-worker")).toBeNull();
});

it("opens a chat lead's chat on its own computer", async () => {
  f.read.mockResolvedValue({ available: true, primes: [prime()], projectSeats: [] });
  f.chats = {
    mini: {
      "gag-lead": {
        id: "gag-lead",
        title: "Gag lead",
        status: "running",
        labels: { "fulcra.reports-to": "role:main-assistant" },
      },
    },
  };
  mount();
  const row = await screen.findByTestId("sidebar-chat-lead-mini-gag-lead");
  expect(row.textContent).toContain("Working · last known");
  fireEvent.click(row);
  expect(f.open).toHaveBeenCalled();
});

it("does not list a chat twice: a seated lead's chat and the main assistant stay single rows", async () => {
  f.read.mockResolvedValue({
    available: true,
    primes: [prime()],
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
  f.projects.mockResolvedValue({ projects: [{ id: "proj-1", name: "Fulcra" }] });
  f.records = {
    "original-prime": {
      status: "idle",
      title: "Main",
      labels: { "fulcra.reports-to": "role:main-assistant", "fulcra.seat": "main-assistant" },
    },
    remote: {
      status: "idle",
      title: "Lead",
      labels: { "fulcra.reports-to": "role:main-assistant" },
    },
  };
  mount();
  await screen.findByTestId("sidebar-lead-p1");
  expect(screen.queryByTestId("sidebar-chat-lead-mini-remote")).toBeNull();
  expect(screen.queryByTestId("sidebar-chat-lead-mini-original-prime")).toBeNull();
});

it("shows the main assistant's status from the chat list when its chat is not a fleet node", async () => {
  f.read.mockResolvedValue({ available: true, primes: [prime()], projectSeats: [] });
  f.fleet.mockResolvedValue({ nodes: [] });
  f.records = { "original-prime": { status: "idle", title: "Main", labels: {} } };
  mount();
  const main = await screen.findByTestId("sidebar-lead-main-assistant");
  expect(main.textContent).toContain("Main assistant · Idle · last known");
  expect(main.textContent).not.toContain("Status unknown");
});

it("reads the lead lists again every 30 s", () => {
  expect(SIDEBAR_REFRESH_MS).toBe(30_000);
});

// Fulcra 0.2.14 (FU-50): another computer's leads stay, greyed, while it is away.
const HOSTS = [
  { serverId: "mini", label: "Mac mini" },
  { serverId: "book", label: "MacBook Pro" },
];
const GAG = {
  seat: "g1",
  sessionId: "11111111-1111-4111-8111-111111111111",
  project: "Example project",
  title: "Remote project lead",
};
const bookReads = (available = true) => ({
  directory: {
    available,
    primes: [],
    projectSeats: [
      {
        seat: "g1",
        role: "project-orchestrator",
        projectId: "proj-g",
        state: "assigned",
        sessionPresent: true,
        sessionId: GAG.sessionId,
      },
    ],
  },
  projects: { projects: [{ id: "proj-g", name: "Example project" }] },
  fleet: {
    nodes: [{ id: GAG.sessionId, host: "macbook", status: "idle", pending: 0, title: GAG.title }],
  },
});

it("shows an offline computer's last known leads, greyed, with '<computer> offline'", async () => {
  f.hosts = HOSTS;
  f.offline = new Set(["book"]);
  f.read.mockResolvedValue({ available: true, primes: [prime()], projectSeats: [] });
  useLeadsMemory.setState({ byHost: { book: [GAG] } });
  mount();
  const row = await screen.findByTestId("sidebar-remembered-lead-book-g1");
  expect(row.textContent).toContain("Remote project lead");
  expect(row.textContent).toContain("Lead · Example project · MacBook Pro offline");
  expect(screen.queryByTestId("sidebar-remote-lead-book-g1")).toBeNull();
});

it("says 'update Fulcra on <computer>' when that computer's Fulcra is not trusted here", async () => {
  f.hosts = HOSTS;
  f.untrusted = [{ serverId: "book", id: "orca-organization-next" }];
  f.remote.book = bookReads();
  f.read.mockResolvedValue({ available: true, primes: [prime()], projectSeats: [] });
  useLeadsMemory.setState({ byHost: { book: [GAG] } });
  mount();
  const row = await screen.findByTestId("sidebar-remembered-lead-book-g1");
  expect(row.textContent).toContain("update Fulcra on MacBook Pro");
  expect(screen.queryByTestId("sidebar-remote-lead-book-g1")).toBeNull();
});

it("keeps the remembered leads when an online computer does not answer", async () => {
  f.hosts = HOSTS;
  f.remote.book = bookReads(false);
  f.read.mockResolvedValue({ available: true, primes: [prime()], projectSeats: [] });
  useLeadsMemory.setState({ byHost: { book: [GAG] } });
  mount();
  const row = await screen.findByTestId("sidebar-remembered-lead-book-g1");
  // Until the read answers the row is plain "last known"; then it says why it is greyed.
  expect(row.textContent).toContain("Lead · Example project · last known");
  await vi.waitFor(() =>
    expect(screen.getByTestId("sidebar-remembered-lead-book-g1").textContent).toContain(
      "Command Centre not answering on MacBook Pro",
    ),
  );
});

it("shows a read computer's leads live, remembers them, and lists no remembered row beside them", async () => {
  f.hosts = HOSTS;
  f.remote.book = bookReads();
  f.read.mockResolvedValue({ available: true, primes: [prime()], projectSeats: [] });
  mount();
  await screen.findByTestId("sidebar-remote-lead-book-g1");
  expect(screen.queryByTestId("sidebar-remembered-lead-book-g1")).toBeNull();
  await vi.waitFor(() => expect(useLeadsMemory.getState().byHost.book?.[0]?.seat).toBe("g1"));
  expect(useLeadsMemory.getState().byHost.book?.[0]?.title).toBe("Remote project lead");
});

it("lists a seated lead on another computer once, even when its chat reports to the main assistant", async () => {
  f.hosts = HOSTS;
  f.remote.book = bookReads();
  f.read.mockResolvedValue({ available: true, primes: [prime()], projectSeats: [] });
  f.chats = {
    book: {
      [GAG.sessionId]: {
        id: GAG.sessionId,
        title: GAG.title,
        status: "idle",
        labels: { "fulcra.reports-to": "role:main-assistant" },
      },
    },
  };
  mount();
  await screen.findByTestId("sidebar-remote-lead-book-g1");
  expect(screen.queryByTestId(`sidebar-chat-lead-book-${GAG.sessionId}`)).toBeNull();
});

it("does not list a remembered lead a second time from the chat list while its computer is away", async () => {
  f.hosts = HOSTS;
  f.offline = new Set(["book"]);
  f.read.mockResolvedValue({ available: true, primes: [prime()], projectSeats: [] });
  useLeadsMemory.setState({ byHost: { book: [GAG] } });
  f.chats = {
    book: {
      [GAG.sessionId]: {
        id: GAG.sessionId,
        title: GAG.title,
        status: "idle",
        labels: { "fulcra.reports-to": "role:main-assistant" },
      },
    },
  };
  mount();
  await screen.findByTestId("sidebar-remembered-lead-book-g1");
  expect(screen.queryByTestId(`sidebar-chat-lead-book-${GAG.sessionId}`)).toBeNull();
});

it("explains why remembered leads are greyed, and says nothing while a computer is still being read", () => {
  expect(rememberedNote("Book", true, true, [])).toBe("update Fulcra on Book");
  expect(rememberedNote("Book", false, false, undefined)).toBe("Book offline");
  expect(rememberedNote("Book", false, true, null)).toBe("Command Centre not answering on Book");
  expect(rememberedNote("Book", false, true, undefined)).toBeNull();
  expect(typeof rememberedNote("Book", false, true, [])).toBe("symbol");
});
