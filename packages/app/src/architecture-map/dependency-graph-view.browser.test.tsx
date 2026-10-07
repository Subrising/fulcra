import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { ArchitectureGraph } from "@getpaseo/protocol/messages";
import { i18n } from "@/i18n/i18next";
import { darkTheme } from "@/styles/theme";
import { DependencyGraphView } from "./dependency-graph-view";

// The code map in real Chromium: each box says what it does and how big it is, the part a pull request changed has
// an amber outline, lines say "uses", and opening a part shows What it does / Connected to / Inside / Open code /
// Show what calls this. Saves the pictures to .vitest-screenshots/map/.

const theme = vi.hoisted(() => ({ current: null as unknown }));

// As in the review test: styles resolve against the real current theme and `uniProps` mappings apply.
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

// react-native-svg's primitives as DOM SVG elements; onPress becomes a click so boxes can be pressed.
vi.mock("react-native-svg", async () => {
  const ReactModule = await import("react");
  const make = (tag: string) =>
    function SvgPrimitive({ testID, children, onPress, ...props }: Record<string, unknown>) {
      return ReactModule.createElement(
        tag,
        {
          ...props,
          ...(typeof testID === "string" ? { "data-testid": testID } : {}),
          ...(typeof onPress === "function" ? { onClick: onPress } : {}),
        },
        children as React.ReactNode,
      );
    };
  return {
    default: make("svg"),
    G: make("g"),
    Line: make("line"),
    Polygon: make("polygon"),
    Rect: make("rect"),
    Text: make("text"),
  };
});

const asked = vi.hoisted(() => ({ paths: [] as (string | null)[] }));
vi.mock("./use-generated-change", () => ({
  useReviewExplanation: (input: { kind: string; path: string | null; enabled: boolean }) => {
    if (input.enabled) asked.paths.push(input.path);
    return {
      data:
        input.enabled && input.kind === "module"
          ? {
              status: "ok",
              text: "Sends the app's requests to the host and hands back the answers.",
              files: [
                "packages/client/src/index.ts",
                "packages/client/src/daemon-client.ts",
                "packages/client/src/daemon-client.test.ts",
              ],
              usedToday: 4,
              dailyLimit: 30,
            }
          : undefined,
      isLoading: false,
      error: null,
    };
  },
}));
vi.mock("@/runtime/host-features", () => ({ useHostFeatureAvailability: () => true }));

const box = (id: string, group: string, kind: string, files: number, x: number) => ({
  id,
  label: id,
  folder: `packages/${group}/src${id === group ? "" : `/${id}`}`,
  kind,
  group,
  files,
  code: files - 1,
  tests: 1,
  x,
  y: 40,
  width: 230,
  height: 66,
});

const graph: ArchitectureGraph = {
  commit: "c".repeat(40),
  rules: 1,
  nodes: [
    box("screens", "app", "frontend", 40, 40),
    box("hooks", "app", "frontend", 12, 300),
    box("client", "client", "service", 3, 560),
    box("protocol", "protocol", "messagebus", 6, 820),
  ],
  edges: [
    { from: "screens", to: "hooks", imports: 20 },
    { from: "hooks", to: "client", imports: 15 },
    { from: "client", to: "protocol", imports: 9 },
  ],
  highlighted: ["client"],
  changedFiles: 2,
};

const PULL_REQUEST = { number: 7, title: "Retry requests" };
const opened: string[] = [];
const openFile = (path: string) => {
  opened.push(path);
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const text = (testId: string) =>
  container?.querySelector(`[data-testid="${testId}"]`)?.textContent ?? "";

// Boxes are SVG text; buttons are role=button. A filter chip can share a box's name, so each is looked up apart.
function press(label: string, where: "box" | "button" = "button") {
  const selector = where === "box" ? "svg text" : "[role=button]";
  // The last match: an open package's frame title shares its name with a module, and modules draw after it.
  const target = [...(container?.querySelectorAll(selector) ?? [])].findLast(
    (el) => el.textContent === label,
  );
  if (!target) throw new Error(`Nothing to press called ${label}`);
  act(() => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  asked.paths = [];
  opened.length = 0;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

describe("Code map in a browser", () => {
  it("says what each part does, outlines the changed one and opens a part's side panel", async () => {
    theme.current = darkTheme;
    await i18n.changeLanguage("en");
    await page.viewport(1280, 1000);
    document.body.style.margin = "0";
    document.body.style.backgroundColor = darkTheme.colors.surface0;
    container = document.createElement("div");
    container.style.width = "1280px";
    container.style.height = "1000px";
    container.style.display = "flex";
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <DependencyGraphView
          graph={graph}
          refLabel="main"
          pullRequest={PULL_REQUEST}
          onClearPullRequest={null}
          initialWidth={1240}
          serverId="s1"
          cwd="/repo"
          onOpenFile={openFile}
        />,
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 150));

    const canvas = text("dependency-graph-canvas");
    expect(canvas).toContain("Screens people see and use");
    expect(canvas).toContain("Shared code other parts use");
    expect(canvas).toContain("52 files · 50 code · 2 tests");
    expect(canvas).toContain("uses · 15");
    expect(
      container.querySelectorAll('[data-testid="dependency-graph-node-changed"]'),
    ).toHaveLength(1);
    await page.screenshot({
      element: container,
      path: "../../.vitest-screenshots/map/map-overview-dark.png",
    });

    press("client", "box");
    // Opened in place: a frame with the package's module, the other packages still on the map.
    expect(container.querySelectorAll('[data-testid="dependency-graph-group-frame"]')).toHaveLength(
      1,
    );
    expect(text("dependency-graph-canvas")).toContain("Screens people see and use");
    // "Close" in plain words closes the frame; the package box comes back.
    expect(text("dependency-graph-group-close")).toBe("Close");
    press("Close", "box");
    expect(container.querySelectorAll('[data-testid="dependency-graph-group-frame"]')).toHaveLength(
      0,
    );
    press("client", "box");
    press("client", "box");
    expect(text("dependency-graph-breadcrumb")).toBe("All packages›client›client");
    const panel = text("dependency-graph-selection");
    expect(panel).toContain("What it does");
    expect(panel).toContain("Sends the app's requests to the host");
    expect(panel).toContain("Changed in this pull request");
    expect(panel).toContain("Connected to");
    expect(panel).toContain("Inside");
    expect(panel).toContain("daemon-client.ts");
    expect(panel).toContain("4 of 30 written explanations used today");
    expect(asked.paths).toContain("packages/client/src");
    press("Open code");
    expect(opened).toEqual(["packages/client/src/index.ts"]);
    press("Show what calls this");
    expect(text("dependency-graph-selection")).toContain("Show everything again");
    await page.screenshot({
      element: container,
      path: "../../.vitest-screenshots/map/map-part-dark.png",
    });

    // Search lists matching parts; choosing one opens its package and selects it, and the list closes.
    const search = container.querySelector('input[data-testid="dependency-graph-search"]');
    if (!(search instanceof HTMLInputElement)) throw new Error("No search box");
    await userEvent.fill(search, "proto");
    expect(text("dependency-graph-results")).toContain("protocol");
    const result = container.querySelector(
      '[data-testid="dependency-graph-results"] [role=button]',
    );
    if (!result) throw new Error("No search result");
    act(() => {
      result.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(text("dependency-graph-breadcrumb")).toBe("All packages›protocol›protocol");
    expect(text("dependency-graph-selection")).toContain("packages/protocol/src");
    expect(asked.paths).toContain("packages/protocol/src");
    expect(container.querySelector('[data-testid="dependency-graph-results"]')).toBeNull();
    await page.screenshot({
      element: container,
      path: "../../.vitest-screenshots/map/map-search-jump-dark.png",
    });
  });
});
