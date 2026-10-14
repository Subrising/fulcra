import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { darkTheme } from "@/styles/theme";

vi.mock("react-native-unistyles", async () => {
  const resolve = <T,>(styles: T | ((theme: unknown) => T)): T =>
    typeof styles === "function" ? (styles as (theme: unknown) => T)(darkTheme) : styles;
  return {
    StyleSheet: {
      create: <T extends object>(styles: T | ((theme: unknown) => T)) =>
        new Proxy({} as T, {
          get: (_target, key) => (resolve(styles) as Record<PropertyKey, unknown>)[key],
        }),
    },
  };
});
vi.mock("@/stores/session-store", async () => {
  const { create } = await import("zustand");
  const agent = (id: string, status: string, background = 0) => ({
    id,
    title: `Session ${id}`,
    status,
    provider: "claude",
    workspaceId: "shared-workspace",
    pendingPermissions: [],
    labels: {},
    backgroundWork: background ? { count: background } : undefined,
  });
  return {
    useSessionStore: create(() => ({
      sessions: {
        mini: {
          agents: new Map(
            Array.from({ length: 10 }, (_, i) => {
              const id = `mini-${i}`;
              return [id, agent(id, i === 0 ? "running" : "idle", i === 1 ? 2 : 0)];
            }),
          ),
        },
        book: {
          agents: new Map([
            ["book-0", agent("book-0", "running")],
            ["book-1", agent("book-1", "idle")],
          ]),
        },
      },
    })),
  };
});
vi.mock("@/stores/sidebar-view-store", () => ({
  useSidebarViewStore: (select: (state: unknown) => unknown) => select({ hostFilters: [] }),
}));
vi.mock("@/stores/sidebar-collapsed-sections-store", () => ({
  useSidebarCollapsedSectionsStore: (select: (state: unknown) => unknown) =>
    select({
      collapsedAllSessions: false,
      toggleAllSessionsCollapsed: () => {},
    }),
}));
vi.mock("./sidebar-touch", () => ({
  useSidebarTouchRows: () => false,
  sidebarTouchStyles: { stack: { minHeight: 48, justifyContent: "center" } },
}));
vi.mock("@/sessions/session-account-info", () => ({ SessionAccountInfo: () => null }));
vi.mock("@/utils/navigate-to-agent", () => ({ navigateToAgent: vi.fn() }));

import { navigateToAgent } from "@/utils/navigate-to-agent";

import { SidebarSessions } from "./sidebar-sessions";
let root: Root | null = null;
let container: HTMLDivElement | null = null;
beforeEach(() => {
  vi.clearAllMocks();
  document.body.style.margin = "0";
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  document.body.style.removeProperty("margin");
  vi.unstubAllGlobals();
});

it("renders host counts, waiting jobs and visible overflow at each viewport", async () => {
  for (const [name, width, height, sidebarWidth] of [
    ["375", 375, 700, 375],
    ["768", 768, 700, 320],
    ["1440", 1440, 700, 320],
    ["landscape", 812, 375, 320],
  ] as const) {
    await page.viewport(width, height);
    container = document.createElement("div");
    container.style.width = `${sidebarWidth}px`;
    container.style.height = `${height}px`;
    container.style.overflowY = "auto";
    container.style.background = "#151718";
    document.body.append(container);
    root = createRoot(container);
    act(() =>
      root?.render(
        <SidebarSessions
          serverIds={["mini", "book"]}
          hostNames={
            new Map([
              ["mini", "Mini"],
              ["book", "Book"],
            ])
          }
        />,
      ),
    );
    expect(container.textContent).toContain("All sessions (12)");
    expect(container.textContent).toContain("2 running · 1 waiting on background jobs · 9 idle");
    expect(container.textContent).toContain("Mini (10)");
    expect(container.textContent).toContain("Book (2)");
    expect(container.textContent).toContain("2 more");
    expect(container.textContent).toContain("Waiting on 2 background jobs");
    const box = container.getBoundingClientRect();
    expect(container.scrollWidth).toBeLessThanOrEqual(container.clientWidth + 1);
    for (const control of container.querySelectorAll<HTMLElement>("[role=button]")) {
      const rect = control.getBoundingClientRect();
      expect(rect.width).toBeGreaterThanOrEqual(48);
      expect(rect.height).toBeGreaterThanOrEqual(48);
      expect(rect.right).toBeLessThanOrEqual(box.right + 1);
    }
    await page.screenshot({
      element: container,
      path: `../../.vitest-screenshots/sidebar/sessions-${name}.png`,
    });
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    await page.getByTestId("sidebar-session-open-mini-mini-0").click();
    expect(navigateToAgent).toHaveBeenLastCalledWith({
      serverId: "mini",
      agentId: "mini-0",
      workspaceId: "shared-workspace",
    });
    await page.getByTestId("sidebar-all-sessions-more").click();
    expect(container.querySelectorAll("[data-testid^='sidebar-session-open-']")).toHaveLength(12);
    expect(container.textContent).toContain("Show fewer sessions");
    await page.getByTestId("sidebar-session-open-book-book-1").click();
    expect(navigateToAgent).toHaveBeenLastCalledWith({
      serverId: "book",
      agentId: "book-1",
      workspaceId: "shared-workspace",
    });
    await page.screenshot({
      element: container,
      path: `../../.vitest-screenshots/sidebar/sessions-${name}-expanded.png`,
    });
    act(() => root?.unmount());
    container.remove();
    root = null;
    container = null;
  }
});
