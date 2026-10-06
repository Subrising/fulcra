/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { usePluginHostNavigation } from "./host-navigation";

vi.mock("@/utils/navigate-to-agent", () => ({
  navigateToAgent: vi.fn(),
}));
vi.mock("@/stores/navigation-active-workspace-store", () => ({
  navigateToWorkspace: vi.fn(),
}));
vi.mock("@/runtime/host-runtime", () => ({ getHostRuntimeStore: vi.fn() }));

const navigateToAgentMock = vi.mocked(navigateToAgent);
const navigateToWorkspaceMock = vi.mocked(navigateToWorkspace);
const getHostRuntimeStoreMock = vi.mocked(getHostRuntimeStore);
const runtime = {
  getHostRegistryStatus: vi.fn<() => "loading" | "ready">(),
  getHosts: vi.fn<() => { serverId: string }[]>(),
  getSnapshot: vi.fn(),
};

describe("usePluginHostNavigation", () => {
  beforeEach(() => {
    navigateToAgentMock.mockReset();
    navigateToWorkspaceMock.mockReset();
    getHostRuntimeStoreMock.mockReset();
    runtime.getHostRegistryStatus.mockReset().mockReturnValue("ready");
    runtime.getHosts.mockReset().mockReturnValue([{ serverId: "host-1" }, { serverId: "host-2" }]);
    runtime.getSnapshot.mockReset();
    getHostRuntimeStoreMock.mockReturnValue(
      runtime as unknown as ReturnType<typeof getHostRuntimeStore>,
    );
  });

  it("opens agents and workspaces on the rendering host", () => {
    const { result } = renderHook(() => usePluginHostNavigation("host-1"));

    act(() => result.current.openAgent({ agentId: "agent-1" }));
    act(() => result.current.openWorkspace({ workspaceId: "workspace-1" }));

    expect(navigateToAgentMock).toHaveBeenCalledWith({ serverId: "host-1", agentId: "agent-1" });
    expect(navigateToWorkspaceMock).toHaveBeenCalledWith({
      serverId: "host-1",
      workspaceId: "workspace-1",
    });
    expect(getHostRuntimeStoreMock).not.toHaveBeenCalled();
  });

  it.each(["idle", "connecting", "online", "offline", "error"])(
    "requests the saved target host without gating on connection status %s",
    (connectionStatus) => {
      runtime.getSnapshot.mockReturnValue({ connectionStatus });
      const { result } = renderHook(() => usePluginHostNavigation("host-1"));
      expect(result.current.openAgentOnHost?.({ serverId: "host-2", agentId: "agent-2" })).toBe(
        "requested",
      );
      expect(navigateToAgentMock).toHaveBeenCalledExactlyOnceWith({
        serverId: "host-2",
        agentId: "agent-2",
      });
      expect(runtime.getSnapshot).not.toHaveBeenCalled();
      expect(navigateToWorkspaceMock).not.toHaveBeenCalled();
    },
  );

  it("never queues a loading-registry request and permits an explicit retry", () => {
    runtime.getHostRegistryStatus.mockReturnValue("loading");
    const { result } = renderHook(() => usePluginHostNavigation("host-1"));
    const input = { serverId: "host-2", agentId: "agent-2" };
    expect(result.current.openAgentOnHost?.(input)).toBe("host-unavailable");
    runtime.getHostRegistryStatus.mockReturnValue("ready");
    expect(navigateToAgentMock).not.toHaveBeenCalled();
    expect(result.current.openAgentOnHost?.(input)).toBe("requested");
    expect(navigateToAgentMock).toHaveBeenCalledExactlyOnceWith(input);
  });

  it("rechecks membership on every invocation without falling back to the rendering host", () => {
    const { result, rerender } = renderHook(() => usePluginHostNavigation("host-1"));
    const navigation = result.current;
    const input = { serverId: "host-3", agentId: "agent-3" };
    expect(navigation.openAgentOnHost?.(input)).toBe("host-unavailable");
    expect(navigateToAgentMock).not.toHaveBeenCalled();
    runtime.getHosts.mockReturnValue([{ serverId: "host-3" }]);
    expect(navigation.openAgentOnHost?.(input)).toBe("requested");
    runtime.getHosts.mockReturnValue([]);
    expect(navigation.openAgentOnHost?.(input)).toBe("host-unavailable");
    expect(navigateToAgentMock).toHaveBeenCalledExactlyOnceWith(input);
    rerender();
    expect(result.current).toBe(navigation);
  });

  it("keeps the capability stable until the rendering host changes", () => {
    const { result, rerender } = renderHook(({ serverId }) => usePluginHostNavigation(serverId), {
      initialProps: { serverId: "host-1" },
    });
    const initialNavigation = result.current;

    rerender({ serverId: "host-1" });
    expect(result.current).toBe(initialNavigation);

    rerender({ serverId: "host-2" });
    expect(result.current).not.toBe(initialNavigation);

    act(() => result.current.openAgent({ agentId: "agent-2" }));
    act(() => result.current.openWorkspace({ workspaceId: "workspace-2" }));
    expect(navigateToAgentMock).toHaveBeenCalledWith({ serverId: "host-2", agentId: "agent-2" });
    expect(navigateToWorkspaceMock).toHaveBeenCalledWith({
      serverId: "host-2",
      workspaceId: "workspace-2",
    });
  });
});

vi.mock("@/constants/layout", () => ({ useIsCompactFormFactor: () => false }));
vi.mock("@/workspace-tabs/explorer-sidebar", () => ({ openExplorerSidebarView: vi.fn() }));
