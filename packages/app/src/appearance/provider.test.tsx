// @vitest-environment jsdom
import React, { useCallback, useState } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { darkTheme, PLUGIN_THEME_NAMES, type ThemePreference } from "@/styles/theme";
import type { PluginThemeOption } from "@/plugins/themes";
import { AppearanceProvider } from "./provider";

// Model the observed Android ordering: native colour changes before the styling
// library updates its selected theme. Device acceptance exercises the real bridge.
const bridge = vi.hoisted(() => {
  const options: PluginThemeOption[] = [];
  const settings: { theme: ThemePreference; pluginThemeId: string } = {
    theme: "auto",
    pluginThemeId: "",
  };
  const runtime = {
    colorScheme: "light",
    themeName: "light",
    hasAdaptiveThemes: true,
    setAdaptiveThemes(enabled: boolean) {
      runtime.hasAdaptiveThemes = enabled;
      if (enabled) runtime.themeName = runtime.colorScheme;
    },
    setTheme(name: string) {
      runtime.themeName = name;
    },
    updateTheme: vi.fn(),
  };
  return {
    isLoading: false,
    runtime,
    appearance: new Set<() => void>(),
    appState: new Set<(state: string) => void>(),
    platform: { OS: "android", select: <T,>(values: { default: T }) => values.default },
    options,
    settings,
  };
});
vi.mock("react-native", () => ({
  Platform: bridge.platform,
  Appearance: {
    addChangeListener(listener: () => void) {
      bridge.appearance.add(listener);
      return { remove: () => bridge.appearance.delete(listener) };
    },
  },
  AppState: {
    addEventListener(_event: string, listener: (state: string) => void) {
      bridge.appState.add(listener);
      return { remove: () => bridge.appState.delete(listener) };
    },
  },
}));
vi.mock("react-native-unistyles", () => ({ UnistylesRuntime: bridge.runtime }));
vi.mock("@/hooks/use-settings", () => ({
  DEFAULT_THEME_PREFERENCE: "auto",
  useAppSettings: () => ({
    settings: bridge.settings,
    isLoading: bridge.isLoading,
    updateSettings: vi.fn(),
  }),
}));
vi.mock("@/plugins/themes", () => ({
  usePluginThemeCatalog: () => bridge.options,
  rememberPluginThemeHost: vi.fn(),
}));
vi.mock("./apply", () => ({ applyAppearance: vi.fn() }));

beforeEach(() => {
  vi.stubGlobal("React", React);
  bridge.platform.OS = "android";
  bridge.isLoading = false;
  bridge.settings.theme = "auto";
  bridge.settings.pluginThemeId = "";
  bridge.options = [];
  bridge.runtime.colorScheme = "light";
  bridge.runtime.themeName = "light";
  bridge.runtime.hasAdaptiveThemes = true;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function RetainedWork() {
  const [selection, setSelection] = useState("original");
  const changeSelection = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    setSelection(event.target.value);
  }, []);
  return <input aria-label="Selected work" value={selection} onChange={changeSelection} />;
}

function changeSystemAppearance(scheme: string) {
  act(() => {
    bridge.runtime.colorScheme = scheme;
    bridge.appearance.forEach((listener) => listener());
  });
}

it("mounts work after the first appearance is applied and retains it on later settings loads", () => {
  bridge.isLoading = true;
  const firstAppearance: string[] = [];
  function Work() {
    useState(() => firstAppearance.push(bridge.runtime.themeName));
    return <RetainedWork />;
  }
  const content = () => (
    <AppearanceProvider>
      <Work />
    </AppearanceProvider>
  );
  const view = render(content());
  expect(view.queryByRole("textbox")).toBeNull();
  bridge.settings.theme = "dark";
  bridge.isLoading = false;
  view.rerender(content());
  expect(firstAppearance).toEqual(["dark"]);
  const field = view.getByRole("textbox");
  fireEvent.change(field, { target: { value: "saved-book-session" } });
  bridge.isLoading = true;
  view.rerender(content());
  expect(view.getByRole("textbox")).toBe(field);
  bridge.settings.theme = "auto";
  bridge.isLoading = false;
  view.rerender(content());
  changeSystemAppearance("dark");
  expect(bridge.runtime.themeName).toBe("dark");
  expect(view.getByRole("textbox")).toBe(field);
  expect(field).toHaveProperty("value", "saved-book-session");
  expect(firstAppearance).toEqual(["dark"]);
});

it("follows Android light-dark-light without remounting the selected work", () => {
  const view = render(
    <AppearanceProvider>
      <RetainedWork />
    </AppearanceProvider>,
  );
  const field = view.getByRole("textbox");
  fireEvent.change(field, { target: { value: "saved-book-session" } });
  changeSystemAppearance("dark");
  expect(bridge.runtime.themeName).toBe("dark");
  changeSystemAppearance("light");
  expect(bridge.runtime.themeName).toBe("light");
  expect(view.getByRole("textbox")).toBe(field);
  expect(field).toHaveProperty("value", "saved-book-session");
});

it("catches up on resume when no appearance event was delivered", () => {
  render(
    <AppearanceProvider>
      <RetainedWork />
    </AppearanceProvider>,
  );
  bridge.runtime.colorScheme = "dark";
  act(() => bridge.appState.forEach((listener) => listener("background")));
  expect(bridge.runtime.themeName).toBe("light");
  act(() => bridge.appState.forEach((listener) => listener("active")));
  expect(bridge.runtime.themeName).toBe("dark");
});

it.each(["light", "dark"] as const)(
  "preserves explicit %s then resumes System following",
  (theme) => {
    const view = render(
      <AppearanceProvider>
        <RetainedWork />
      </AppearanceProvider>,
    );
    bridge.settings.theme = theme;
    view.rerender(
      <AppearanceProvider>
        <RetainedWork />
      </AppearanceProvider>,
    );
    changeSystemAppearance("dark");
    changeSystemAppearance("light");
    act(() => bridge.appState.forEach((listener) => listener("active")));
    expect(bridge.runtime.themeName).toBe(theme);
    expect(bridge.runtime.hasAdaptiveThemes).toBe(false);
    bridge.settings.theme = "auto";
    view.rerender(
      <AppearanceProvider>
        <RetainedWork />
      </AppearanceProvider>,
    );
    changeSystemAppearance("dark");
    expect(bridge.runtime.themeName).toBe("dark");
    expect(bridge.appearance.size).toBe(1);
    expect(bridge.appState.size).toBe(1);
  },
);

it("preserves a contributed theme and follows System if the contribution disappears", () => {
  bridge.options = [
    { id: "custom", serverId: "saved-host", name: "Custom", swatch: "#123456", theme: darkTheme },
  ];
  bridge.settings.theme = "plugin";
  bridge.settings.pluginThemeId = "custom";
  const view = render(
    <AppearanceProvider>
      <RetainedWork />
    </AppearanceProvider>,
  );
  changeSystemAppearance("light");
  act(() => bridge.appState.forEach((listener) => listener("active")));
  expect(bridge.runtime.themeName).toBe(PLUGIN_THEME_NAMES.dark);
  bridge.options = [];
  view.rerender(
    <AppearanceProvider>
      <RetainedWork />
    </AppearanceProvider>,
  );
  changeSystemAppearance("dark");
  expect(bridge.runtime.themeName).toBe("dark");
});

it("removes both subscriptions when the appearance owner unmounts", () => {
  const view = render(
    <AppearanceProvider>
      <RetainedWork />
    </AppearanceProvider>,
  );
  expect(bridge.appearance.size).toBe(1);
  expect(bridge.appState.size).toBe(1);
  view.unmount();
  expect(bridge.appearance.size).toBe(0);
  expect(bridge.appState.size).toBe(0);
  changeSystemAppearance("dark");
  expect(bridge.runtime.themeName).toBe("light");
});

it.each(["ios", "web"])("does not add Android subscriptions on %s", (platform) => {
  bridge.platform.OS = platform;
  render(
    <AppearanceProvider>
      <RetainedWork />
    </AppearanceProvider>,
  );
  expect(bridge.appearance.size).toBe(0);
  expect(bridge.appState.size).toBe(0);
});
