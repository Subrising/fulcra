import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { i18n } from "@/i18n/i18next";
import { darkTheme } from "@/styles/theme";
import { PullRequestReviewView } from "./pull-request-review-view";

// The review screen in real Chromium with a sample pull request: the riskiest file is marked "Start here" and opens
// first, and every file says in plain words what the change is. Saves the pictures to .vitest-screenshots/review/.

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

const review = vi.hoisted(() => ({
  status: "ok" as const,
  requestId: "r1",
  cwd: "/repo",
  base: "base-oid",
  head: "head-oid",
  pullRequest: {
    number: 12,
    title: "Add --days forecast table",
    baseRefName: "main",
    headRefName: "feat/forecast",
  },
  files: [
    {
      path: "README.md",
      status: "modified",
      additions: 4,
      deletions: 0,
      part: "docs",
      partLabel: "Docs",
      kind: "other",
      tests: 0,
      risk: "LOW",
    },
    {
      path: "test_weather.py",
      status: "added",
      additions: 41,
      deletions: 0,
      part: "cli",
      partLabel: "Command line",
      kind: "test",
      tests: 0,
      risk: "LOW",
    },
    {
      path: "weather.py",
      status: "modified",
      additions: 38,
      deletions: 4,
      part: "cli",
      partLabel: "Command line",
      kind: "code",
      tests: 4,
      risk: "NORMAL",
    },
    {
      path: "api/fetch.py",
      status: "modified",
      additions: 12,
      deletions: 2,
      part: "api",
      partLabel: "Forecast API",
      kind: "code",
      tests: 0,
      risk: "HIGH",
    },
  ],
}));

vi.mock("./use-generated-change", () => ({
  usePullRequestReview: () => ({ data: review, isLoading: false, error: null }),
  // fetch.py, the file opened first, adds a network call with no timeout and a token read.
  useReviewFileDiff: () => ({
    data: {
      file: {
        path: "api/fetch.py",
        isNew: false,
        isDeleted: false,
        additions: 3,
        deletions: 0,
        hunks: [
          {
            oldStart: 8,
            oldCount: 2,
            newStart: 8,
            newCount: 5,
            lines: [
              { type: "context", content: "def forecast(city, days):" },
              { type: "add", content: '    key = os.environ["WEATHER_API_KEY"]' },
              {
                type: "add",
                content: "    res = requests.get(URL, params={'q': city, 'key': key})",
              },
              { type: "add", content: "    return res.json()" },
              { type: "context", content: "" },
            ],
          },
        ],
      },
    },
    isLoading: false,
    error: null,
  }),
  useReviewExplanation: (input: { kind: string }) => ({
    data:
      input.kind === "summary"
        ? {
            status: "ok",
            text: "Reads the forecast for a city from the weather service and returns it as data.",
            usedToday: 3,
            dailyLimit: 30,
          }
        : undefined,
    isLoading: false,
    error: null,
  }),
}));
vi.mock("./review-inbox", () => ({ recordReviewInInbox: async () => "unavailable" }));
vi.mock("@/runtime/host-features", () => ({ useHostFeatureAvailability: () => true }));
vi.mock("@/git/diff-document", () => ({ DiffDocument: () => null }));
vi.mock("@/hooks/use-settings", () => ({ useAppSettings: () => ({ settings: {} }) }));
vi.mock("@/components/ui/text-input", () => ({ EditingTextInput: () => null }));
vi.mock("@/components/ui/switch", () => ({ Switch: () => null }));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: (select: (state: { sessions: Record<string, unknown> }) => unknown) =>
    select({ sessions: {} }),
}));

const NAMES = ["fetch.py", "weather.py", "test_weather.py", "README.md"];
const nameOf = (row: string) => NAMES.find((name) => row.startsWith(name));

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

describe("Pull request review in a browser", () => {
  it("lists the riskiest file first and describes every change in plain words", async () => {
    theme.current = darkTheme;
    await i18n.changeLanguage("en");
    await page.viewport(1280, 800);
    document.body.style.margin = "0";
    document.body.style.backgroundColor = darkTheme.colors.surface0;
    container = document.createElement("div");
    container.style.width = "1280px";
    container.style.height = "800px";
    container.style.display = "flex";
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <PullRequestReviewView
          serverId="s1"
          cwd="/repo"
          pullRequest={12}
          onBack={noop}
          onShowInMap={null}
        />,
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 150));

    const rows = [...container.querySelectorAll('[data-testid="pull-request-review-file"]')].map(
      (row) => row.textContent ?? "",
    );
    expect(rows.map(nameOf)).toEqual(["fetch.py", "weather.py", "test_weather.py", "README.md"]);
    expect(rows[0]).toContain("Start here");
    expect(rows[0]).toContain("· api");
    expect(rows[0]).toContain("Changes code no test reaches");
    expect(rows[1]).toContain("Changes code that 4 tests reach");
    expect(rows[2]).toContain("New test file");
    expect(rows[3]).toContain("Changes docs or settings");
    const look =
      container.querySelector('[data-testid="pull-request-review-look-here"]')?.textContent ?? "";
    expect(look).toContain("Line 9 · Passwords, keys or permissions");
    expect(look).toContain("Line 10 · Network call without a timeout");
    const checklist =
      container.querySelector('[data-testid="pull-request-review-checklist"]')?.textContent ?? "";
    expect(checklist).toContain("Before you approve");
    expect(checklist).toContain("2 places to look at in 1 opened file of 4");
    const plain =
      container.querySelector('[data-testid="pull-request-review-plain-words"]')?.textContent ?? "";
    expect(plain).toContain("In plain words");
    expect(plain).toContain("Reads the forecast for a city");
    expect(plain).toContain("Show pseudocode of the change");
    expect(plain).toContain("3 of 30 written explanations used today");
    await page.screenshot({
      element: container,
      path: "../../.vitest-screenshots/review/review-desktop-dark.png",
    });
  });
});
