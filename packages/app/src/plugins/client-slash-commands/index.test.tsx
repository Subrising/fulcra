// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  installed: [] as unknown[],
  store: null as unknown as {
    (selector: (state: unknown) => unknown): unknown;
    getState(): { sessions: Record<string, unknown> };
    setState(next: unknown): void;
    subscribe: unknown;
  },
}));

vi.mock("@/stores/session-store", async () => {
  const { create: createStore } = await import("zustand");
  fake.store = createStore(() => ({ sessions: {} as Record<string, unknown> })) as never;
  return { useSessionStore: fake.store };
});
vi.mock("@/stores/session-store-hooks/selectors", () => ({
  selectWorkspace: (
    state: { sessions: Record<string, { workspaces: Map<string, unknown> } | undefined> },
    serverId: string,
    workspaceId: string,
  ) => state.sessions[serverId]?.workspaces.get(workspaceId) ?? null,
}));
vi.mock("../client-state/source", () => ({
  createPluginClientStateSource: (serverId: string) => ({
    getWorkspace: (id: string) =>
      (
        fake.store.getState().sessions[serverId] as { workspaces: Map<string, unknown> } | undefined
      )?.workspaces.get(id) ?? null,
    getAgent: (id: string) =>
      (
        fake.store.getState().sessions[serverId] as { agents: Map<string, unknown> } | undefined
      )?.agents.get(id) ?? null,
  }),
}));
vi.mock("../navigation", () => ({ createPluginNavigation: () => ({}) }));
vi.mock("../actions", () => ({
  createPluginAgentActionContext: () => ({ context: "agent" }),
  createPluginWorkspaceActionContext: () => ({ context: "workspace" }),
}));
vi.mock("../registry", () => ({ useInstalledPlugins: () => fake.installed }));

import { useSessionStore } from "@/stores/session-store";
import { usePluginClientSlashCommands } from "./index";

// Load the mocked store before any test reads it, even if the hook does not import it.
void useSessionStore;
const account = {
  id: "fulcra-controller",
  serverId: "mini",
  clientSlashCommands: [
    {
      name: "account",
      description: "Switch account",
      argumentHint: "<name>",
      context: "agent",
      onSubmit: async () => {},
    },
  ],
};

afterEach(() => {
  cleanup();
  fake.installed = [];
  fake.store.setState({ sessions: {} });
});

// Phone, 10 Oct: the chat and workspace records arrive after the first render. The list used to be built once, empty,
// and stay empty, so "/account work" said "Account switching is unavailable here".
it("lists the plugin commands once the chat and workspace records arrive", () => {
  fake.installed = [account];
  const { result } = renderHook(() =>
    usePluginClientSlashCommands({ serverId: "mini", workspaceId: "ws-1", agentId: "agent-1" }),
  );
  expect(result.current).toEqual([]);
  act(() => {
    fake.store.setState({
      sessions: {
        mini: {
          workspaces: new Map([["ws-1", { id: "ws-1" }]]),
          agents: new Map([["agent-1", { id: "agent-1" }]]),
          agentDetails: new Map(),
        },
      },
    });
  });
  expect(result.current.map((command) => command.name)).toEqual(["account"]);
});

it("lists nothing for a plugin installed on another host, or without a workspace", () => {
  fake.installed = [{ ...account, serverId: "book" }];
  fake.store.setState({
    sessions: {
      mini: {
        workspaces: new Map([["ws-1", {}]]),
        agents: new Map([["agent-1", {}]]),
        agentDetails: new Map(),
      },
    },
  });
  const other = renderHook(() =>
    usePluginClientSlashCommands({ serverId: "mini", workspaceId: "ws-1", agentId: "agent-1" }),
  );
  expect(other.result.current).toEqual([]);
  fake.installed = [account];
  const none = renderHook(() =>
    usePluginClientSlashCommands({ serverId: "mini", workspaceId: null, agentId: "agent-1" }),
  );
  expect(none.result.current).toEqual([]);
});
