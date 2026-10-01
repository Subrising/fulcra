import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n/i18next";
import { lightTheme } from "@/styles/theme";

// L46: the real Command Centre surface screen, over a relay-only host and over a direct one.
const state = vi.hoisted(() => ({
  connection: { type: "relay" } as { type: string } | null,
  surfaceMounts: 0,
  invokes: 0,
}));

vi.mock("react-native-unistyles", async () => {
  const { lightTheme: theme } = await import("@/styles/theme");
  const resolve = <T,>(styles: T | ((t: unknown) => T)): T =>
    typeof styles === "function" ? (styles as (t: unknown) => T)(theme) : styles;
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
        React.createElement(Component, { ...props, ...(uniProps ? uniProps(theme) : {}) }),
    useUnistyles: () => ({ theme, rt: { themeName: "light" } }),
    UnistylesRuntime: { setTheme: () => undefined, themeName: "light" },
  };
});
vi.mock("expo-router", () => ({
  router: { canGoBack: () => false, back: () => undefined, replace: () => undefined },
  useLocalSearchParams: () => ({
    serverId: "srv_mini",
    pluginId: "orca-organization-next",
    contributionKind: "sidebar",
    contributionId: "organization",
  }),
}));
const client = {
  invokePluginRpc: async () => {
    state.invokes += 1;
    return {};
  },
  ensureConnected: () => undefined,
};
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => client,
  useHostRuntimeSnapshot: () => ({ activeConnection: state.connection, client }),
  useHostRuntimeLastError: () => null,
  useHosts: () => [{ serverId: "srv_mini", label: "Mini" }],
  getHostRuntimeStore: () => ({
    getHosts: () => [{ serverId: "srv_mini" }],
    getSnapshot: () => ({ client, activeConnection: state.connection }),
  }),
}));
vi.mock("@/components/hosts/host-picker", () => ({ HostPicker: () => null }));
vi.mock("./host-navigation", () => ({ usePluginHostNavigation: () => ({}) }));
function Surface() {
  React.useEffect(() => {
    state.surfaceMounts += 1;
  }, []);
  return <div>Command Centre content</div>;
}
const installed = {
  id: "orca-organization-next",
  serverId: "srv_mini",
  lifetime: new AbortController(),
  queryClient: new (await import("@tanstack/react-query")).QueryClient(),
  sidebarItems: [
    { id: "organization", title: "Command Centre", icon: "ShieldAlert", surface: "main" },
  ],
  surfaces: [{ id: "main", Component: Surface }],
};
vi.mock("./registry", () => ({
  useInstalledPlugin: () => installed,
  usePluginEvaluationError: () => null,
  usePluginInstallations: () => [installed],
}));

const { PluginSurfaceScreen } = await import("./surface-screen");

let root: Root | undefined;
let container: HTMLDivElement;
beforeEach(async () => {
  vi.stubGlobal("React", React);
  await i18n.changeLanguage("en");
  state.surfaceMounts = 0;
  state.invokes = 0;
  document.body.style.background = lightTheme.colors.surface0;
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.unstubAllGlobals();
});
async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<PluginSurfaceScreen />);
  });
}

describe("L46: Command Centre screens and the relay", () => {
  it("relay-only: the plain direct-connection notice, no surface and no read", async () => {
    state.connection = { type: "relay" };
    await mount();
    expect(container.querySelector('[data-testid="command-centre-relay-notice"]')).not.toBeNull();
    expect(container.textContent).toContain("Command Centre needs a direct connection to this Mac");
    expect(container.textContent).toContain("Add connection → Direct connection");
    expect(container.textContent).not.toContain("Management unavailable");
    expect(container.textContent).not.toContain("Command Centre content");
    expect(state.surfaceMounts).toBe(0);
    expect(state.invokes).toBe(0);
  });

  it("direct: the Command Centre surface renders as before", async () => {
    state.connection = { type: "directTcp" };
    await mount();
    expect(container.querySelector('[data-testid="command-centre-relay-notice"]')).toBeNull();
    expect(container.textContent).toContain("Command Centre content");
    expect(state.surfaceMounts).toBe(1);
  });
});
