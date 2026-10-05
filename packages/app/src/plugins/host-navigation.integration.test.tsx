/** @vitest-environment jsdom */
import { renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { router } from "expo-router";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { openExplorerSidebarView } from "@/workspace-tabs/explorer-sidebar";
import { usePluginHostNavigation } from "./host-navigation";

const fixture = vi.hoisted(() => ({
  hosts: [{ serverId: "mini" }, { serverId: "book" }],
  sessions: {} as Record<
    string,
    {
      agents: Map<string, { workspaceId: string }>;
      agentDetails?: Map<string, never>;
      workspaces?: Map<string, { id: string; projectKind: string; workspaceDirectory: string }>;
      client?: object;
      clientGeneration?: number;
    }
  >,
  client: {} as object,
  online: true,
  swapped: false,
  reads: 0,
}));
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({
    getHostRegistryStatus: () => "ready",
    getHosts: () => fixture.hosts,
    getSnapshot: () => {
      fixture.reads++;
      return {
        connectionStatus: fixture.online ? "online" : "offline",
        client: fixture.swapped && fixture.reads > 1 ? {} : fixture.client,
        clientGeneration: 1,
      };
    },
  }),
}));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: { getState: () => ({ sessions: fixture.sessions }) },
}));
vi.mock("expo-router", () => ({ router: { navigate: vi.fn() } }));
vi.mock("@/stores/navigation-active-workspace-store", () => ({
  navigateToWorkspace: vi.fn(() => "/workspace"),
}));

beforeEach(() => {
  vi.clearAllMocks();
  fixture.hosts = [{ serverId: "mini" }, { serverId: "book" }];
  fixture.online = true;
  fixture.swapped = false;
  fixture.reads = 0;
  fixture.sessions = {
    mini: { agents: new Map([["shared-agent", { workspaceId: "mini-workspace" }]]) },
    book: { agents: new Map([["shared-agent", { workspaceId: "book-workspace" }]]) },
  };
});

it("resolves the target host's workspace even when both hosts share an agent ID", () => {
  const { result } = renderHook(() => usePluginHostNavigation("mini"));
  expect(result.current.openAgentOnHost?.({ serverId: "book", agentId: "shared-agent" })).toBe(
    "requested",
  );
  expect(navigateToWorkspace).toHaveBeenCalledExactlyOnceWith({
    serverId: "book",
    workspaceId: "book-workspace",
    target: { kind: "agent", agentId: "shared-agent" },
    pin: undefined,
  });
  expect(router.navigate).not.toHaveBeenCalled();
});

it("uses the Book agent route before its session data loads, then preserves legacy Mini routing", () => {
  delete fixture.sessions.book;
  const { result } = renderHook(() => usePluginHostNavigation("mini"));
  expect(result.current.openAgentOnHost?.({ serverId: "book", agentId: "shared-agent" })).toBe(
    "requested",
  );
  expect(router.navigate).toHaveBeenCalledExactlyOnceWith("/h/book/agent/shared-agent");
  expect(navigateToWorkspace).not.toHaveBeenCalled();
  result.current.openAgent({ agentId: "shared-agent" });
  expect(navigateToWorkspace).toHaveBeenCalledExactlyOnceWith({
    serverId: "mini",
    workspaceId: "mini-workspace",
    target: { kind: "agent", agentId: "shared-agent" },
    pin: undefined,
  });
});

it("refuses a removed host even if its conversation remains in the session cache", () => {
  const { result } = renderHook(() => usePluginHostNavigation("mini"));
  fixture.hosts = [{ serverId: "mini" }];
  expect(result.current.openAgentOnHost?.({ serverId: "book", agentId: "shared-agent" })).toBe(
    "host-unavailable",
  );
  expect(router.navigate).not.toHaveBeenCalled();
  expect(navigateToWorkspace).not.toHaveBeenCalled();
});

vi.mock("@/constants/layout", () => ({ useIsCompactFormFactor: () => false }));
vi.mock("@/workspace-tabs/explorer-sidebar", () => ({ openExplorerSidebarView: vi.fn() }));

it("Book Changes uses the Book workspace and existing native Changes surface", () => {
  fixture.sessions.book.client = fixture.client;
  fixture.sessions.book.clientGeneration = 1;
  fixture.sessions.book.workspaces = new Map([
    [
      "book-workspace",
      { id: "book-workspace", projectKind: "git", workspaceDirectory: "/book/work" },
    ],
  ]);
  const { result } = renderHook(() => usePluginHostNavigation("mini"));
  expect(
    result.current.openAgentChangesOnHost?.({ serverId: "book", agentId: "shared-agent" }),
  ).toBe("requested");
  expect(navigateToWorkspace).toHaveBeenCalledExactlyOnceWith({
    serverId: "book",
    workspaceId: "book-workspace",
    target: { kind: "agent", agentId: "shared-agent" },
    pin: undefined,
  });
  expect(openExplorerSidebarView).toHaveBeenCalledExactlyOnceWith({
    isCompact: false,
    workspaceKey: "book:book-workspace",
    checkout: { serverId: "book", cwd: "/book/work", isGit: true },
    view: "changes",
  });
});

it("Changes refuses unknown workspace, stale client and disconnect instead of routing to Mini", () => {
  const { result } = renderHook(() => usePluginHostNavigation("mini"));
  const target = { serverId: "book", agentId: "shared-agent" };
  expect(result.current.openAgentChangesOnHost?.(target)).toBe("changes-unavailable");
  fixture.sessions.book.client = fixture.client;
  fixture.sessions.book.clientGeneration = 1;
  fixture.sessions.book.workspaces = new Map([
    ["unrelated", { id: "other", projectKind: "git", workspaceDirectory: "/book/work" }],
  ]);
  expect(result.current.openAgentChangesOnHost?.(target)).toBe("changes-unavailable");
  fixture.sessions.book.workspaces = new Map([
    [
      "book-workspace",
      { id: "book-workspace", projectKind: "git", workspaceDirectory: "/book/work" },
    ],
  ]);
  fixture.swapped = true;
  fixture.reads = 0;
  expect(result.current.openAgentChangesOnHost?.(target)).toBe("host-unavailable");
  fixture.online = false;
  expect(result.current.openAgentChangesOnHost?.(target)).toBe("host-unavailable");
  expect(navigateToWorkspace).not.toHaveBeenCalled();
  expect(openExplorerSidebarView).not.toHaveBeenCalled();
});
