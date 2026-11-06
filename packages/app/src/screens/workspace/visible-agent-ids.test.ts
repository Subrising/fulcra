import { expect, test } from "vitest";
import type { WorkspaceLayout } from "@/stores/workspace-layout-store";
import type { WorkspaceTab } from "@/workspace-tabs/model";
import { agentIdForViewedTab, selectVisibleAgentIds } from "./visible-agent-ids";

test("selects only the active agent tab in every visible pane", () => {
  const layout: WorkspaceLayout = {
    focusedPaneId: "left",
    root: {
      kind: "group",
      group: {
        id: "root",
        direction: "horizontal",
        sizes: [0.5, 0.5],
        children: [
          { kind: "pane", pane: { id: "left", tabIds: ["a", "hidden"], focusedTabId: "a" } },
          { kind: "pane", pane: { id: "right", tabIds: ["b"], focusedTabId: "b" } },
        ],
      },
    },
  };
  const tabs: WorkspaceTab[] = [
    { tabId: "a", target: { kind: "agent", agentId: "agent-a" }, createdAt: 1 },
    { tabId: "hidden", target: { kind: "agent", agentId: "agent-hidden" }, createdAt: 2 },
    { tabId: "b", target: { kind: "agent", agentId: "agent-b" }, createdAt: 3 },
  ];

  expect(
    selectVisibleAgentIds({ layout, tabs, routeFocused: true, focusedPaneOnly: false }),
  ).toEqual(["agent-a", "agent-b"]);
});

test("route blur publishes no viewed agents", () => {
  const layout: WorkspaceLayout = {
    focusedPaneId: "main",
    root: { kind: "pane", pane: { id: "main", tabIds: ["a"], focusedTabId: "a" } },
  };
  const tabs: WorkspaceTab[] = [
    { tabId: "a", target: { kind: "agent", agentId: "agent-a" }, createdAt: 1 },
  ];

  expect(
    selectVisibleAgentIds({ layout, tabs, routeFocused: false, focusedPaneOnly: false }),
  ).toEqual([]);
});

test("compact and focus modes contribute only the focused pane", () => {
  const layout: WorkspaceLayout = {
    focusedPaneId: "right",
    root: {
      kind: "group",
      group: {
        id: "root",
        direction: "horizontal",
        sizes: [0.5, 0.5],
        children: [
          { kind: "pane", pane: { id: "left", tabIds: ["a"], focusedTabId: "a" } },
          { kind: "pane", pane: { id: "right", tabIds: ["b"], focusedTabId: "b" } },
        ],
      },
    },
  };
  const tabs: WorkspaceTab[] = [
    { tabId: "a", target: { kind: "agent", agentId: "agent-a" }, createdAt: 1 },
    { tabId: "b", target: { kind: "agent", agentId: "agent-b" }, createdAt: 2 },
  ];

  expect(
    selectVisibleAgentIds({ layout, tabs, routeFocused: true, focusedPaneOnly: true }),
  ).toEqual(["agent-b"]);
});

test("pane retargeting replaces the viewed agent and duplicate panes collapse to one ID", () => {
  const layout: WorkspaceLayout = {
    focusedPaneId: "left",
    root: {
      kind: "group",
      group: {
        id: "root",
        direction: "horizontal",
        sizes: [0.5, 0.5],
        children: [
          { kind: "pane", pane: { id: "left", tabIds: ["active"], focusedTabId: "active" } },
          { kind: "pane", pane: { id: "right", tabIds: ["duplicate"], focusedTabId: "duplicate" } },
        ],
      },
    },
  };
  const duplicateTabs: WorkspaceTab[] = [
    { tabId: "active", target: { kind: "agent", agentId: "agent-a" }, createdAt: 1 },
    { tabId: "duplicate", target: { kind: "agent", agentId: "agent-a" }, createdAt: 2 },
  ];
  const retargetedTabs: WorkspaceTab[] = [
    { tabId: "active", target: { kind: "agent", agentId: "agent-b" }, createdAt: 1 },
    { tabId: "duplicate", target: { kind: "agent", agentId: "agent-a" }, createdAt: 2 },
  ];

  expect({
    duplicate: selectVisibleAgentIds({
      layout,
      tabs: duplicateTabs,
      routeFocused: true,
      focusedPaneOnly: false,
    }),
    retargeted: selectVisibleAgentIds({
      layout,
      tabs: retargetedTabs,
      routeFocused: true,
      focusedPaneOnly: false,
    }),
  }).toEqual({ duplicate: ["agent-a"], retargeted: ["agent-a", "agent-b"] });
});

<<<<<<< HEAD
test("the selected agent panel keeps its native chat visible and focused", () => {
  const target = {
    kind: "plugin" as const,
    pluginId: "orca-organization-next",
    panelId: "switch-account",
    context: "agent" as const,
    agentId: "viewed",
  };
  const layout: WorkspaceLayout = {
    focusedPaneId: "main",
    root: { kind: "pane", pane: { id: "main", tabIds: ["panel", "other"], focusedTabId: "panel" } },
  };
  const tabs: WorkspaceTab[] = [
    { tabId: "panel", target, createdAt: 1 },
    { tabId: "other", target: { kind: "agent", agentId: "hidden" }, createdAt: 2 },
  ];
  expect(agentIdForViewedTab(target)).toBe("viewed");
  expect(
    selectVisibleAgentIds({ layout, tabs, routeFocused: true, focusedPaneOnly: true }),
  ).toEqual(["viewed"]);
  expect(
    agentIdForViewedTab({
      kind: "plugin",
      pluginId: "orca-organization-next",
      panelId: "settings",
      context: "workspace",
    }),
  ).toBeNull();
  expect(agentIdForViewedTab({ kind: "terminal", terminalId: "terminal" })).toBeNull();
  expect(
    selectVisibleAgentIds({ layout, tabs, routeFocused: false, focusedPaneOnly: true }),
  ).toEqual([]);
});
=======
test("the agent shown in the workspace sheet is viewed alongside the pane under it", () => {
  const layout: WorkspaceLayout = {
    focusedPaneId: "main",
    root: { kind: "pane", pane: { id: "main", tabIds: ["a"], focusedTabId: "a" } },
  };
  const tabs: WorkspaceTab[] = [
    { tabId: "a", target: { kind: "agent", agentId: "agent-a" }, createdAt: 1 },
  ];
  const sheetTab: WorkspaceTab = {
    tabId: "sheet",
    target: { kind: "agent", agentId: "agent-child" },
    createdAt: 2,
  };

  expect(
    selectVisibleAgentIds({ layout, tabs, sheetTab, routeFocused: true, focusedPaneOnly: true }),
  ).toEqual(["agent-a", "agent-child"]);
  expect(
    selectVisibleAgentIds({ layout, tabs, sheetTab, routeFocused: false, focusedPaneOnly: true }),
  ).toEqual([]);
});

test("single-pane tablet includes its visible Explorer agent without including other splits", () => {
  const layout: WorkspaceLayout = {
    focusedPaneId: "main",
    root: {
      kind: "group",
      group: {
        id: "root",
        direction: "horizontal",
        sizes: [0.5, 0.25, 0.25],
        children: [
          { kind: "pane", pane: { id: "main", tabIds: ["a"], focusedTabId: "a" } },
          { kind: "pane", pane: { id: "explorer", tabIds: ["b"], focusedTabId: "b" } },
          { kind: "pane", pane: { id: "other", tabIds: ["c"], focusedTabId: "c" } },
        ],
      },
    },
  };
  const tabs: WorkspaceTab[] = ["a", "b", "c"].map((id) => ({
    tabId: id,
    createdAt: 1,
    target: { kind: "agent", agentId: id },
  }));
  expect(
    selectVisibleAgentIds({
      layout,
      tabs,
      routeFocused: true,
      focusedPaneOnly: true,
      explorerPaneId: "explorer",
    }),
  ).toEqual(["a", "b"]);
});
>>>>>>> refs/remotes/upstream/tags/v0.13.0
