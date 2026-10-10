import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { darkTheme } from "@/styles/theme";

// The sidebar's Fulcra block in real Chromium with the app's dark theme (Fulcra 0.2.8 spec "sidebar main assistant
// across hosts"): the MacBook app with the main assistant on the Mac mini, the Mac mini offline, no main assistant
// anywhere, and two main assistants. Measured at 375, 390, 768 and 1440 px and phone landscape: every new control is
// at least 48 px, no text is cut off, no rows overlap, nothing scrolls sideways. Saves the pictures to
// .vitest-screenshots/sidebar/.

const theme = vi.hoisted(() => ({ current: null as unknown }));

// The shared unistyles stub pins one light test theme and ignores `uniProps`. Here styles resolve
// against whichever real theme is current, and `uniProps` mappings are applied, as on device.
vi.mock("react-native-unistyles", async () => {
  const ReactModule = await import("react");
  const resolve = <T,>(styles: T | ((t: unknown) => T)): T =>
    typeof styles === "function" ? (styles as (t: unknown) => T)(theme.current) : styles;
  return {
    StyleSheet: {
      create: <T extends object>(styles: T | ((t: unknown) => T)) =>
        new Proxy({} as T, {
          get: (_target, key) => (resolve(styles) as Record<PropertyKey, unknown>)[key],
        }),
    },
    withUnistyles:
      (Component: React.ComponentType<Record<string, unknown>>) =>
      ({ uniProps, ...props }: Record<string, unknown> & { uniProps?: (t: unknown) => object }) =>
        ReactModule.createElement(Component, {
          ...props,
          ...(uniProps ? uniProps(theme.current) : {}),
        }),
    UnistylesRuntime: { setTheme: () => undefined, themeName: "light" },
    useUnistyles: () => ({ theme: theme.current, rt: { themeName: "dark" } }),
  };
});

interface Scenario {
  name: string;
  offline: string[];
  directories: Record<string, unknown>;
  remembered: Record<string, { seat: string; sessionId: string }>;
  expectText: string[];
  absentText: string[];
}
const prime = (sessionId: string) => ({
  seat: "main",
  role: "prime",
  state: "assigned",
  sessionPresent: true,
  sessionId,
});
const empty = { available: true, primes: [], projectSeats: [] };
const withLeads = (primes: unknown[]) => ({
  available: true,
  primes,
  projectSeats: [
    {
      seat: "p1",
      role: "project-orchestrator",
      projectId: "proj-1",
      state: "assigned",
      sessionPresent: true,
      sessionId: "lead-1",
    },
  ],
});
const SCENARIOS: Scenario[] = [
  {
    name: "on-other-host",
    offline: [],
    directories: { book: withLeads([]), mini: { available: true, primes: [prime("prime-1")] } },
    remembered: {},
    expectText: ["Main assistant · Mac-mini.local", "Use the main assistant on Mac-mini.local"],
    absentText: ["No main assistant yet"],
  },
  {
    name: "host-offline",
    offline: ["mini"],
    directories: { book: withLeads([]) },
    remembered: { mini: { seat: "main", sessionId: "prime-1" } },
    expectText: ["Main assistant · Mac-mini.local · offline", "Not connected"],
    absentText: ["No main assistant yet"],
  },
  {
    name: "none-anywhere",
    offline: [],
    directories: { book: withLeads([]), mini: empty },
    remembered: {},
    expectText: ["No main assistant yet · Set up"],
    absentText: ["Main assistant ·"],
  },
  {
    name: "two-hosts",
    offline: [],
    directories: {
      book: withLeads([prime("prime-2")]),
      mini: { available: true, primes: [prime("prime-1")] },
    },
    remembered: {},
    expectText: ["Main assistant · MacBook Pro", "Main assistant · Mac-mini.local"],
    absentText: ["No main assistant yet"],
  },
  // Fulcra 0.2.11: the main assistant first in Leads, chat names, and a lead on another computer (read-only).
  {
    name: "leads-both-hosts",
    offline: [],
    directories: {
      book: withLeads([prime("prime-2")]),
      mini: {
        available: true,
        primes: [],
        projectSeats: [
          {
            seat: "g1",
            role: "project-orchestrator",
            projectId: "proj-g",
            state: "assigned",
            sessionPresent: true,
            sessionId: "gag-1",
          },
        ],
      },
    },
    remembered: {},
    expectText: [
      "Main assistant · Idle · MacBook Pro",
      "Forecast",
      "Lead · weather-cli · Waiting for you · MacBook Pro",
      "AI gag games lead: Ship It and Demo Day planning",
      "Lead · AI gag games · Idle · Mac-mini.local",
    ],
    absentText: ["Lead · weather-cli conversation"],
  },
];
// Below 768 px the sidebar is the full-width phone drawer; from 768 px it is the 320 px desktop sidebar.
const SIZES = [
  { name: "375", width: 375, height: 700, sidebar: 375 },
  { name: "390", width: 390, height: 700, sidebar: 390 },
  { name: "768", width: 768, height: 700, sidebar: 320 },
  { name: "1440", width: 1440, height: 700, sidebar: 320 },
  { name: "landscape", width: 844, height: 390, sidebar: 320 },
] as const;

const f = vi.hoisted(() => ({
  push: vi.fn(),
  scenario: null as null | {
    offline: string[];
    directories: Record<string, unknown>;
  },
}));
vi.mock("expo-router", () => ({ router: { push: f.push }, usePathname: () => "/" }));
vi.mock("./host-navigation", () => ({
  usePluginHostNavigation: () => ({ openAgentOnHost: () => "requested" }),
}));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: (select: (state: unknown) => unknown) =>
    select({
      sessions: {
        book: {
          agents: new Map([
            ["prime-2", {}],
            ["lead-1", {}],
          ]),
        },
        mini: {
          agents: new Map([
            ["prime-1", {}],
            ["gag-1", {}],
          ]),
        },
      },
    }),
}));
const HOSTS = [
  { serverId: "book", label: "MacBook Pro" },
  { serverId: "mini", label: "Mac-mini.local" },
];
const FLEET = {
  nodes: [
    { id: "prime-1", host: "Mac-mini.local", status: "running", pending: 0, title: "Main" },
    { id: "prime-2", host: "MacBook Pro", status: "idle", pending: 0, title: "Main" },
    { id: "lead-1", host: "MacBook Pro", status: "idle", pending: 1, title: "Forecast" },
    {
      id: "gag-1",
      host: "mini",
      status: "idle",
      pending: 0,
      title: "AI gag games lead: Ship It and Demo Day planning",
    },
  ],
};
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => ({ sendAgentMessage: async () => undefined }),
  useHosts: () => HOSTS,
  useHostRegistryLoaded: () => true,
  useHostRuntimeConnectionStatuses: (ids: readonly string[]) =>
    new Map(ids.map((id) => [id, f.scenario?.offline.includes(id) ? "offline" : "online"])),
  getHostRuntimeStore: () => ({
    getSnapshot: (serverId: string) =>
      f.scenario?.offline.includes(serverId)
        ? null
        : {
            client: {
              invokePluginRpc: async (_plugin: string, method: string) =>
                ({
                  "organization.fleet": FLEET,
                  "organization.projects": { projects: [{ id: "proj-g", name: "AI gag games" }] },
                })[method] ?? f.scenario?.directories[serverId],
            },
          },
  }),
}));
vi.mock("@/stores/organization-intake-preferences-store", () => ({
  useOrganizationIntakePreferences: (select: (state: unknown) => unknown) =>
    select({ companyHost: "book", chooseCompany: () => undefined }),
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
vi.mock("./registry", () => ({
  useControllerPlugin: () => null,
  pluginRegistry: { controllerPluginId: () => "orca-organization-next" },
}));
vi.mock("../../../../control/orca-organization/client/use-contract", () => ({
  useContract: (contract: { name: string }) => async () =>
    ({
      "organization.role-directory": f.scenario?.directories.book,
      "organization.fleet": FLEET,
      "organization.projects": { projects: [{ id: "proj-1", name: "weather-cli" }] },
    })[contract.name],
}));

import { PinnedMainAssistant, PrimeSidebarRows } from "./prime-sidebar";
import { useMainAssistantMemory } from "@/stores/main-assistant-memory-store";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

const NEW_CONTROLS =
  /^(sidebar-pinned-main-assistant|sidebar-use-remote-main-assistant|sidebar-set-up-main-assistant|sidebar-lead-|sidebar-remote-lead-)/;

function measure(box: HTMLElement): string[] {
  const problems: string[] = [];
  if (box.scrollWidth > box.clientWidth + 1)
    problems.push(`scrolls sideways: ${box.scrollWidth} > ${box.clientWidth}`);
  const controls = [...box.querySelectorAll<HTMLElement>("[data-testid]")].filter((el) =>
    NEW_CONTROLS.test(el.dataset.testid ?? ""),
  );
  if (controls.length === 0) problems.push("no main assistant controls rendered");
  for (const el of controls) {
    const r = el.getBoundingClientRect();
    if (r.height < 48 || r.width < 48)
      problems.push(`${el.dataset.testid} is ${Math.round(r.width)}x${Math.round(r.height)} px`);
    if (r.right > box.getBoundingClientRect().right + 1)
      problems.push(`${el.dataset.testid} overflows the sidebar`);
  }
  for (let i = 0; i < controls.length; i++)
    for (let j = i + 1; j < controls.length; j++) {
      const a = controls[i]!.getBoundingClientRect();
      const b = controls[j]!.getBoundingClientRect();
      if (a.left < b.right && b.left < a.right && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5)
        problems.push(`${controls[i]!.dataset.testid} overlaps ${controls[j]!.dataset.testid}`);
    }
  for (const el of box.querySelectorAll<HTMLElement>("div[dir], span, div")) {
    if (el.children.length > 0 || !el.textContent?.trim()) continue;
    if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)
      problems.push(`text cut off: "${el.textContent}"`);
  }
  return problems;
}

for (const scenario of SCENARIOS)
  for (const size of SIZES)
    describe(`sidebar main assistant · ${scenario.name} · ${size.name}`, () => {
      it("shows the spec rows in plain words, measured", async () => {
        theme.current = darkTheme;
        f.scenario = scenario;
        useMainAssistantMemory.setState({ byHost: { ...scenario.remembered } });
        await page.viewport(size.width, size.height);
        document.body.style.margin = "0";
        document.body.style.backgroundColor = darkTheme.colors.surfaceSidebar;
        container = document.createElement("div");
        container.style.width = `${size.sidebar}px`;
        container.style.padding = "8px 0";
        container.style.overflowX = "auto";
        document.body.appendChild(container);
        root = createRoot(container);
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        act(() =>
          root?.render(
            <QueryClientProvider client={client}>
              <PinnedMainAssistant />
              <PrimeSidebarRows serverId="book" hasTeamMap />
            </QueryClientProvider>,
          ),
        );
        await vi.waitFor(() => {
          for (const text of scenario.expectText) expect(container!.textContent).toContain(text);
        });
        for (const text of scenario.absentText) expect(container.textContent).not.toContain(text);
        expect(measure(container)).toEqual([]);
        await page.screenshot({
          element: container,
          path: `../../.vitest-screenshots/sidebar/main-assistant-${scenario.name}-${size.name}.png`,
        });
      });
    });
