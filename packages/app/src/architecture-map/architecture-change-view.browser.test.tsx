import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { i18n } from "@/i18n/i18next";
import { darkTheme, lightTheme } from "@/styles/theme";
import { buildArchitectureChange, type ArchitectureChange } from "./architecture-change";
import { ArchitectureChangeView } from "./architecture-change-view";
import baseMap from "./fixtures/change-base.ir.json";
import headMap from "./fixtures/change-head.ir.json";
import { pullRequestMaps } from "./pull-request-maps.test.helpers";

// The Change view in real Chromium, with the app's real dark and light themes and real SVG, at a
// desktop and a phone size. It checks the pictures are drawn in the theme's status colours and
// saves the screenshots used in the docs (to the git-ignored .vitest-screenshots/changes/).

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
  };
});

// react-native-svg's primitives as DOM SVG elements; React maps the camelCase props to attributes.
vi.mock("react-native-svg", async () => {
  const ReactModule = await import("react");
  const make = (tag: string) =>
    function SvgPrimitive({
      testID,
      children,
      onPress: _onPress,
      ...props
    }: Record<string, unknown>) {
      return ReactModule.createElement(
        tag,
        { ...props, ...(typeof testID === "string" ? { "data-testid": testID } : {}) },
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

// The fixture pair as text; the diff below is built from these same strings.
const base = `${JSON.stringify(baseMap, null, 2)}\n`;
const head = `${JSON.stringify(headMap, null, 2)}\n`;

type Ready = Extract<ArchitectureChange, { kind: "ready" }>;
const MAP = ".fulcra/architecture/shop.ir.json";

// The branch diff of the map, as the host would send it: one hunk per changed line group, taken
// from the fixture pair itself so the picture is the same one the unit tests check.
function change(): Ready {
  const result = buildArchitectureChange({
    mapPath: MAP,
    headText: head,
    mapDiff: wholeFileDiff(base, head),
    changedFiles: [
      { path: MAP, isDeleted: false },
      { path: "services/orders/stock.ts", isDeleted: false },
      { path: "services/orders/stock.test.ts", isDeleted: false },
      { path: "services/search/index.ts", isDeleted: false },
      { path: "services/search/query.ts", isDeleted: false },
      { path: "services/reports/weekly.ts", isDeleted: true },
      { path: "docs/search.md", isDeleted: false },
    ],
    siblings: new Map([
      ["services/orders", ["stock.ts", "stock.test.ts"]],
      ["services/search", ["index.ts", "query.ts", "query.test.ts"]],
    ]),
    // A pull request is compared at its own commits (v1.16), read through the host.
    pullRequest: { number: 17 },
    pullRequestMaps: pullRequestMaps(base, head),
  });
  if (result.kind !== "ready") throw new Error(JSON.stringify(result));
  return result;
}

// One hunk that replaces every line: exact, and needs no git in the browser.
function wholeFileDiff(before: string, after: string) {
  const oldLines = before.replace(/\n$/, "").split("\n");
  const newLines = after.replace(/\n$/, "").split("\n");
  return {
    isNew: false,
    isDeleted: false,
    hunks: [
      {
        oldStart: 1,
        oldCount: oldLines.length,
        newStart: 1,
        newCount: newLines.length,
        lines: [
          ...oldLines.map((content) => ({ type: "remove" as const, content })),
          ...newLines.map((content) => ({ type: "add" as const, content })),
        ],
      },
    ],
  };
}

// The privacy gate for the saved pictures (anchored token rule): no home or
// volume path, private host name, email address or token may appear in anything the view renders,
// visible or not. A hit fails the test before its screenshot is written.
const PERSONAL: readonly RegExp[] = [
  /\/Users\/|\/Volumes\/|\/home\/|~\//,
  /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:ts\.net|local)(?![a-z0-9-]|\.[a-z0-9])/i,
  /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/i,
  /(?<![A-Za-z0-9])(ghp_|gho_|github_pat_|sk-|xox[bp]-)[A-Za-z0-9_-]{8,}/,
];
function renderedLabels(element: HTMLElement): string[] {
  const labels = [element.textContent ?? ""];
  for (const node of element.querySelectorAll("*")) {
    for (const attribute of ["aria-label", "title", "placeholder"]) {
      const value = node.getAttribute(attribute);
      if (value) labels.push(value);
    }
  }
  return labels;
}

const openPullRequest = () => undefined;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  // The app's modules use the automatic JSX runtime; this project compiles them classically.
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

const SIZES = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "phone", width: 390, height: 844 },
] as const;
const THEMES = [
  { name: "dark", value: darkTheme },
  { name: "light", value: lightTheme },
] as const;

describe("Architecture change view in a browser", () => {
  for (const size of SIZES) {
    for (const mode of THEMES) {
      it(`draws the fixture change at ${size.width}x${size.height} in the ${mode.name} theme`, async () => {
        theme.current = mode.value;
        await i18n.changeLanguage("en");
        await page.viewport(size.width, size.height);
        document.body.style.margin = "0";
        document.body.style.backgroundColor = mode.value.colors.surface0;
        container = document.createElement("div");
        container.style.width = `${size.width}px`;
        container.style.height = `${size.height}px`;
        container.style.display = "flex";
        document.body.appendChild(container);
        root = createRoot(container);
        act(() => {
          root?.render(
            <ArchitectureChangeView
              change={change()}
              title="Example shop"
              baseLabel="main"
              onOpenPullRequest={openPullRequest}
              initialWidth={size.width - 34}
            />,
          );
        });
        await new Promise((resolve) => setTimeout(resolve, 150));

        const added = container.querySelector(
          '[data-testid="architecture-change-node-added"] rect',
        );
        const removed = container.querySelector(
          '[data-testid="architecture-change-node-removed"] rect',
        );
        expect(added?.getAttribute("stroke")).toBe(mode.value.colors.statusSuccess);
        expect(removed?.getAttribute("stroke")).toBe(mode.value.colors.statusDanger);
        expect(container.textContent).toContain("Touches 3 parts of the system.");
        if (size.name === "desktop") {
          expect(
            container.querySelector('[data-testid="architecture-change-before"]'),
          ).not.toBeNull();
          expect(
            container.querySelector('[data-testid="architecture-change-after"]'),
          ).not.toBeNull();
        } else {
          expect(
            container.querySelector('[data-testid="architecture-change-delta"]'),
          ).not.toBeNull();
        }
        const personal = renderedLabels(container).filter((label) =>
          PERSONAL.some((pattern) => pattern.test(label)),
        );
        expect(personal).toEqual([]);
        await page.screenshot({
          element: container,
          path: `../../.vitest-screenshots/changes/change-${size.name}-${mode.name}.png`,
        });
      });
    }
  }
});
