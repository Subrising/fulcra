import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { darkTheme } from "@/styles/theme";

// The sidebar's Fulcra block in real Chromium with the app's dark theme: Team map, then the main assistant and each
// project lead with a plain status and its computer, and the plain question shown only when home is ambiguous.
// Saves the pictures to .vitest-screenshots/sidebar/.

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

const f = vi.hoisted(() => ({ push: vi.fn(), open: vi.fn() }));
vi.mock("expo-router", () => ({ router: { push: f.push }, usePathname: () => "/" }));
vi.mock("./host-navigation", () => ({
  usePluginHostNavigation: () => ({ openAgentOnHost: () => "requested" }),
}));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: (select: (state: unknown) => unknown) =>
    select({
      sessions: {
        mini: {
          agents: new Map([
            ["prime-1", {}],
            ["lead-1", {}],
            ["lead-2", {}],
          ]),
        },
      },
    }),
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => ({ sendAgentMessage: async () => undefined }),
  useHosts: () => [{ serverId: "mini", label: "Mac mini" }],
  getHostRuntimeStore: () => ({ getSnapshot: () => null }),
}));
vi.mock("./registry", () => ({
  useControllerPlugin: () => null,
  pluginRegistry: { controllerPluginId: () => "orca-organization-next" },
}));
vi.mock("../../../../control/orca-organization/client/use-contract", () => ({
  useContract: (contract: { name: string }) => async () =>
    ({
      "organization.role-directory": {
        available: true,
        primes: [
          {
            seat: "delivery",
            role: "prime",
            state: "assigned",
            sessionPresent: true,
            sessionId: "prime-1",
          },
        ],
        projectSeats: [
          {
            seat: "p1",
            role: "project-orchestrator",
            projectId: "proj-1",
            state: "assigned",
            sessionPresent: true,
            sessionId: "lead-1",
          },
          {
            seat: "p2",
            role: "project-orchestrator",
            projectId: "proj-2",
            state: "assigned",
            sessionPresent: true,
            sessionId: "lead-2",
          },
        ],
      },
      "organization.fleet": {
        nodes: [
          { id: "prime-1", host: "Mac mini", status: "running", pending: 0, title: "Main" },
          { id: "lead-1", host: "MacBook Pro", status: "idle", pending: 1, title: "Forecast" },
          { id: "lead-2", host: "Mac mini", status: "running", pending: 0, title: "Habits" },
        ],
      },
      "organization.projects": {
        projects: [
          { id: "proj-1", name: "weather-cli" },
          { id: "proj-2", name: "habit-tracker" },
        ],
      },
    })[contract.name],
}));

import { PrimeSidebarRows } from "./prime-sidebar";
import { homeChoiceLabel } from "./sidebar-items/company";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { Network } from "lucide-react-native";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const noop = () => undefined;

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

for (const size of [
  { name: "desktop", width: 300, height: 420 },
  { name: "phone", width: 390, height: 420 },
] as const) {
  describe(`sidebar leads at ${size.name} width`, () => {
    it("lists Team map, the main assistant and each project lead in plain words", async () => {
      theme.current = darkTheme;
      await page.viewport(size.width, size.height);
      document.body.style.margin = "0";
      document.body.style.backgroundColor = darkTheme.colors.surfaceSidebar;
      container = document.createElement("div");
      container.style.width = `${size.width}px`;
      container.style.padding = "8px 0";
      document.body.appendChild(container);
      root = createRoot(container);
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const ask = homeChoiceLabel(
        { kind: "ask", candidates: [] },
        { hydrated: true, hydrationError: null, computer: () => "Mac mini" },
      );
      act(() =>
        root?.render(
          <QueryClientProvider client={client}>
            <SidebarHeaderRow icon={Network} label={ask.label} onPress={noop} variant="compact" />
            <PrimeSidebarRows serverId="mini" hasTeamMap />
          </QueryClientProvider>,
        ),
      );
      await vi.waitFor(() =>
        expect(container!.textContent).toContain("Project lead · habit-tracker"),
      );
      const text = container.textContent ?? "";
      expect(text).toContain("Which computer runs your main assistant?");
      expect(text).toContain("Team map");
      expect(text).toContain("Delivery main assistant");
      expect(text).toContain("Working · Mac mini");
      expect(text).toContain("Project lead · weather-cli");
      expect(text).toContain("Waiting for you · MacBook Pro");
      await page.screenshot({
        element: container,
        path: `../../.vitest-screenshots/sidebar/leads-${size.name}.png`,
      });
    });
  });
}
