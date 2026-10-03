// @vitest-environment jsdom
import React from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSidebarWorkspacePinController } from "./use-sidebar-workspace-pin";
const f = vi.hoisted(() => ({
  state: { sessions: {} as Record<string, { workspaces: Map<string, { id: string; pinnedAt: string | null }> }> },
  clients: new Map<string, { setWorkspacePinned: ReturnType<typeof vi.fn> }>(),
  offline: new Set<string>(),
  refresh: vi.fn(), error: vi.fn(),
}));
vi.mock("@/stores/session-store", () => ({ useSessionStore: { getState: () => f.state } }));
vi.mock("@/contexts/toast-context", () => ({ useToast: () => ({ error: f.error }) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/runtime/host-runtime", () => ({ getHostRuntimeStore: () => ({
  getClient: (serverId: string) => f.clients.get(serverId),
  getSnapshot: (serverId: string) => ({ connectionStatus: f.offline.has(serverId) ? "offline" : "online" }),
  refreshWorkspaceDirectory: f.refresh,
}) }));

import type {
  SidebarProjectEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/sidebar-workspaces-view-model";
import { splitPinnedSidebarGroups } from "@/hooks/use-sidebar-pins";

function placement(workspaceKey: string): SidebarWorkspacePlacement {
  return {
    workspaceKey,
    serverId: "s1",
    workspaceId: workspaceKey,
    projectViewKey: "p1",
    projectName: "Project 1",
    projectKind: "git",
    workspaceKind: "worktree",
    name: workspaceKey,
  };
}

function project(projectKey: string, workspaces: SidebarWorkspacePlacement[]): SidebarProjectEntry {
  return {
    viewKey: projectKey,
    projectName: projectKey,
    projectKind: "git",
    iconWorkingDir: "",
    hosts: [],
    workspaces,
  };
}

describe("splitPinnedSidebarGroups", () => {
  it("keeps the project shell reachable when every chat is pinned", () => {
    const only = placement("w1");
    const projects = [project("p1", [only])];
    const result = splitPinnedSidebarGroups({
      projects,
      keys: {
        pinnedWorkspaceKeys: ["w1"],
        pinnedAtByKey: { w1: "2026-01-01T00:00:00Z" },
      },
      pinnedWorkspaceOrder: [],
    });
    expect(result.pinnedChats).toHaveLength(1);
    expect(result.unpinnedProjects).toEqual([{ ...projects[0], workspaces: [] }]);
  });

  it("keeps a genuinely empty project so its new-workspace row stays reachable", () => {
    const projects = [project("p1", [])];
    const result = splitPinnedSidebarGroups({
      projects,
      keys: { pinnedWorkspaceKeys: [], pinnedAtByKey: {} },
      pinnedWorkspaceOrder: [],
    });
    expect(result.unpinnedProjects).toHaveLength(1);
  });

  it("keeps remaining chats when only some are pinned", () => {
    const projects = [project("p1", [placement("w1"), placement("w2")])];
    const result = splitPinnedSidebarGroups({
      projects,
      keys: {
        pinnedWorkspaceKeys: ["w1"],
        pinnedAtByKey: { w1: "2026-01-01T00:00:00Z" },
      },
      pinnedWorkspaceOrder: [],
    });
    expect(result.pinnedChats.map((w) => w.workspaceKey)).toEqual(["w1"]);
    expect(result.unpinnedProjects[0]?.workspaces.map((w) => w.workspaceKey)).toEqual(["w2"]);
  });

  it("orders pinned chats by most-recently-pinned first", () => {
    const projects = [project("p1", [placement("older"), placement("newer")])];
    const result = splitPinnedSidebarGroups({
      projects,
      keys: {
        pinnedWorkspaceKeys: ["older", "newer"],
        pinnedAtByKey: {
          older: "2026-01-01T00:00:00Z",
          newer: "2026-02-01T00:00:00Z",
        },
      },
      pinnedWorkspaceOrder: [],
    });

    expect(result.pinnedChats.map((workspace) => workspace.workspaceKey)).toEqual([
      "newer",
      "older",
    ]);
  });

  it("applies the saved order while keeping a newly pinned chat first", () => {
    const projects = [project("p1", [placement("older"), placement("newer"), placement("new")])];
    const result = splitPinnedSidebarGroups({
      projects,
      keys: {
        pinnedWorkspaceKeys: ["older", "newer", "new"],
        pinnedAtByKey: {
          older: "2026-01-01T00:00:00Z",
          newer: "2026-02-01T00:00:00Z",
          new: "2026-03-01T00:00:00Z",
        },
      },
      pinnedWorkspaceOrder: ["older", "newer"],
    });

    expect(result.pinnedChats.map((workspace) => workspace.workspaceKey)).toEqual([
      "new",
      "older",
      "newer",
    ]);
  });
});

const queryClients: QueryClient[] = [];
function controller() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { gcTime: 0 } } });
  queryClients.push(client);
  return renderHook(useSidebarWorkspacePinController, { wrapper: ({ children }) => React.createElement(QueryClientProvider, { client, children }) });
}
function seedPin(host: string, pinnedAt: string | null = null) {
  f.state.sessions[host] = { workspaces: new Map([["same-id", { id: "same-id", pinnedAt }]]) };
  const write = vi.fn().mockResolvedValue({ pinnedAt: "saved-pin" });
  f.clients.set(host, { setWorkspacePinned: write });
  return { write, row: { serverId: host, workspaceId: "same-id", workspaceKey: `${host}:same-id`, pinnedAt: null } };
}
beforeEach(() => { f.state.sessions = {}; f.clients.clear(); f.offline.clear(); f.refresh.mockReset(); f.refresh.mockResolvedValue(undefined); f.error.mockReset(); });
afterEach(async () => { cleanup(); for (const client of queryClients.splice(0)) { await client.cancelQueries(); client.clear(); } });
describe("host-qualified pin submission", () => {
  it("toggles current host state instead of a stale row retained before a peer pin", async () => {
    const { write, row } = seedPin("book", "peer-pin"); write.mockResolvedValue({ pinnedAt: null });
    const view = controller(); act(() => view.result.current(row));
    await waitFor(() => expect(write).toHaveBeenCalledWith("same-id", false));
    await act(async () => { await Promise.resolve(); });
  });
  it("holds the shared guard through acknowledgement-to-directory hydration across controllers", async () => {
    const { write, row } = seedPin("mini");
    let finish!: () => void;
    f.refresh.mockImplementation(() => new Promise<void>((resolve) => { finish = () => { f.state.sessions.mini.workspaces.set("same-id", { id: "same-id", pinnedAt: "saved-pin" }); resolve(); }; }));
    const first = controller(), second = controller();
    act(() => first.result.current(row));
    await waitFor(() => expect(f.refresh).toHaveBeenCalledWith({ serverId: "mini" }));
    act(() => second.result.current({ ...row, workspaceKey: "stale-row-key" }));
    expect(write).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    write.mockResolvedValue({ pinnedAt: null });
    f.refresh.mockResolvedValue(undefined);
    act(() => second.result.current(row));
    await waitFor(() => expect(write).toHaveBeenNthCalledWith(2, "same-id", false));
  });
  it("routes equal opaque workspace ids independently on Mini and Book", async () => {
    const mini = seedPin("mini"), book = seedPin("book"); const view = controller();
    act(() => { view.result.current(mini.row); view.result.current(book.row); });
    await waitFor(() => { expect(mini.write).toHaveBeenCalledOnce(); expect(book.write).toHaveBeenCalledOnce(); });
    await act(async () => { await Promise.resolve(); });
  });
  it("refuses offline writes instead of queuing a stale toggle until reconnect", async () => {
    const { write, row } = seedPin("offline"); f.offline.add("offline"); const view = controller(); act(() => view.result.current(row));
    await waitFor(() => expect(f.error).toHaveBeenCalledWith("sidebar.workspace.toasts.hostDisconnected")); expect(write).not.toHaveBeenCalled();
    f.offline.delete("offline"); act(() => view.result.current(row));
    await waitFor(() => expect(write).toHaveBeenCalledOnce()); await act(async () => { await Promise.resolve(); });
  });
  it("keeps a later peer descriptor and refreshes authority instead of applying an older reply", async () => {
    const { write, row } = seedPin("peer");
    let reply!: (result: { pinnedAt: string | null }) => void;
    write.mockImplementation(() => new Promise((resolve) => { reply = resolve; }));
    const view = controller(); act(() => view.result.current(row)); await waitFor(() => expect(write).toHaveBeenCalledOnce());
    f.state.sessions.peer.workspaces.set("same-id", { id: "same-id", pinnedAt: "newer-peer-pin" });
    await act(async () => reply({ pinnedAt: "saved-pin" }));
    expect(f.refresh).toHaveBeenCalledWith({ serverId: "peer" }); expect(f.state.sessions.peer.workspaces.get("same-id")?.pinnedAt).toBe("newer-peer-pin");
  });
  it("reports confirmed persistence separately from a failed refresh and permits recovery", async () => {
    const { row } = seedPin("refresh-failed"); f.refresh.mockRejectedValue(Error("connection lost")); const view = controller(); act(() => view.result.current(row));
    await waitFor(() => expect(f.error).toHaveBeenCalledWith("Pin saved. Reconnect to this host to refresh its workspace list."));
  });
});
