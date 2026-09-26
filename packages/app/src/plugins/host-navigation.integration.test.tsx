/** @vitest-environment jsdom */
import { renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { router } from "expo-router";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { usePluginHostNavigation } from "./host-navigation";

const fixture = vi.hoisted(() => ({
  hosts: [{ serverId: "mini" }, { serverId: "book" }],
  sessions: {} as Record<string, { agents: Map<string, { workspaceId: string }> }>,
}));
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({
    getHostRegistryStatus: () => "ready",
    getHosts: () => fixture.hosts,
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
