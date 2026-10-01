// @vitest-environment jsdom
import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@/stores/session-store";
import type { AccountUsageRow, ProviderUsageListPayload } from "@/provider-usage/types";
import { describeAccountRow } from "@/provider-usage/account-rundown-format";
import { ContextAccountSummary, ContextSessionMetadata } from "./account-sessions";

const harness = vi.hoisted(() => ({
  info: {
    serverId: "host",
    permissions: ["workspace.read", "daemon.read"],
    features: { providerUsageList: true, pooledAccountUsageList: true },
  },
  connected: true,
  events: new Set<() => void>(),
  connections: new Set<() => void>(),
  storeListeners: new Set<() => void>(),
  agents: new Map<string, Agent>(),
  generation: 1,
  read: vi.fn(),
}));
const client = {
  get isConnected() {
    return harness.connected;
  },
  getLastServerInfoMessage: () => harness.info,
  listProviderUsage: harness.read,
  subscribe: (notify: () => void) => {
    harness.events.add(notify);
    return () => harness.events.delete(notify);
  },
  subscribeConnectionStatus: (notify: () => void) => {
    harness.connections.add(notify);
    notify();
    return () => harness.connections.delete(notify);
  },
};
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => client,
  useHostRuntimeIsConnected: () => harness.connected,
}));
vi.mock("@/stores/session-store", async () => {
  const { useSyncExternalStore } = await import("react");
  const makeState = () => ({
    sessions: {
      host: {
        client,
        clientGeneration: harness.generation,
        agents: harness.agents,
        workspaces: new Map([["workspace", { id: "workspace" }]]),
      },
    },
  });
  let cached: ReturnType<typeof makeState> | undefined;
  const state = () => {
    if (
      !cached ||
      cached.sessions.host.agents !== harness.agents ||
      cached.sessions.host.clientGeneration !== harness.generation
    )
      cached = makeState();
    return cached;
  };
  const subscribe = (notify: () => void) => {
    harness.storeListeners.add(notify);
    return () => {
      harness.storeListeners.delete(notify);
    };
  };
  const useSessionStore = Object.assign(
    <T,>(select: (value: ReturnType<typeof state>) => T) =>
      useSyncExternalStore(
        subscribe,
        () => select(state()),
        () => select(state()),
      ),
    { getState: state, subscribe },
  );
  return { useSessionStore };
});
vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  return {
    View: ({ children }: { children: React.ReactNode }) => createElement("div", null, children),
    Text: ({ children }: { children: React.ReactNode }) => createElement("span", null, children),
  };
});
vi.mock("react-native-unistyles", () => ({
  StyleSheet: { create: () => ({ metadata: {}, detail: {} }) },
}));
vi.mock("@/sessions/session-account-info", () => ({
  SessionAccountInfo: ({ account }: { account: { name: string | null } | null }) =>
    account ? (
      <span>{account.name ? `Account: ${account.name}` : "Account unavailable"}</span>
    ) : null,
}));
vi.mock("@/provider-usage/account-rundown", () => ({
  AccountRundown: ({ accounts }: { accounts: AccountUsageRow[] }) => (
    <div>
      {accounts.map((row) => (
        <span key={row.accountId}>
          {row.name} · {describeAccountRow(row).sessionCountLabel}
        </span>
      ))}
    </div>
  ),
}));

function agent(runtimeInstanceId = "instance-1", name = "A"): Agent {
  return {
    serverId: "server",
    id: "agent",
    workspaceId: "workspace",
    provider: "codex",
    status: "idle",
    turn: { phase: "idle", cancellationRequestId: null },
    lastUserMessageAt: null,
    lastActivityAt: new Date(1),
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: false,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: false,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: null,
    cwd: "/fixture-workspace",
    model: null,
    parentAgentId: null,
    labels: { "fulcra.account-name": name },
    createdAt: new Date(0),
    updatedAt: new Date(1),
    runtimeInstanceId,
  };
}
function payload(name: string, sessionCount?: number): ProviderUsageListPayload {
  return {
    requestId: "fixture",
    fetchedAt: new Date(0).toISOString(),
    providers: [],
    accounts: [
      {
        accountId: "immutable",
        provider: "codex",
        name,
        status: "unavailable",
        observedAt: null,
        source: null,
        fiveHour: null,
        weekly: null,
        inUse: true,
        ...(sessionCount === undefined ? {} : { sessionCount }),
      },
    ],
  };
}
function notifyAll(listeners: Set<() => void>) {
  const snapshot = [...listeners];
  for (const notify of snapshot) notify();
}
function held() {
  let resolve!: (value: ProviderUsageListPayload) => void;
  const promise = new Promise<ProviderUsageListPayload>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const props = { serverId: "host", workspaceId: "workspace", active: true, agentId: "agent" };

beforeEach(() => {
  // This unit runner uses classic JSX; Expo uses the automatic runtime.
  vi.stubGlobal("React", React);
  harness.generation = 1;
  harness.connected = true;
  harness.info.permissions = ["workspace.read", "daemon.read"];
  harness.agents = new Map([["agent", agent()]]);
  harness.read.mockReset().mockResolvedValue(payload("fresh", 0));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  harness.events.clear();
  harness.connections.clear();
  harness.storeListeners.clear();
});

describe("Context account surface lifecycle", () => {
  it("shows each managed row's own live label and updates it on switch", () => {
    const view = render(<ContextSessionMetadata agent={agent("one", "child-own")} />);
    expect(screen.getByText("Account: child-own")).toBeTruthy();
    view.rerender(<ContextSessionMetadata agent={agent("two", "B")} />);
    expect(screen.queryByText("Account: child-own")).toBeNull();
    expect(screen.getByText("Account: B")).toBeTruthy();
    const unidentified = agent();
    unidentified.labels = {};
    view.rerender(<ContextSessionMetadata agent={unidentified} />);
    expect(screen.getByText("Account unavailable")).toBeTruthy();
  });

  it("uses explicit public counts and describes their host-wide scope", async () => {
    const view = render(<ContextAccountSummary {...props} />);
    expect(await screen.findByText("fresh · 0 sessions on this host")).toBeTruthy();
    expect(screen.getByText(/across workspaces/)).toBeTruthy();
    expect(harness.read).toHaveBeenCalledWith({ accounts: true });
    view.unmount();
    harness.read.mockResolvedValue(payload("legacy"));
    render(<ContextAccountSummary {...props} />);
    expect(await screen.findByText("legacy · Session count unavailable")).toBeTruthy();
  });

  it("does not read without daemon.read or when retained inactive", () => {
    harness.info.permissions = ["workspace.read"];
    const view = render(<ContextAccountSummary {...props} />);
    expect(screen.getByText("Account usage unavailable")).toBeTruthy();
    expect(harness.read).not.toHaveBeenCalled();
    view.rerender(<ContextAccountSummary {...props} active={false} />);
    expect(view.container.textContent).toBe("");
    expect(harness.read).not.toHaveBeenCalled();
  });

  it("a revoke/re-grant during a held read never resurrects its result", async () => {
    const old = held();
    harness.read.mockReturnValueOnce(old.promise).mockResolvedValue(payload("fresh", 1));
    render(<ContextAccountSummary {...props} />);
    act(() => {
      harness.info.permissions = ["workspace.read"];
      notifyAll(harness.events);
      harness.info.permissions = ["workspace.read", "daemon.read"];
      notifyAll(harness.events);
    });
    await act(async () => {
      old.resolve(payload("old-private-row", 9));
      await old.promise;
    });
    expect(screen.queryByText(/old-private-row/)).toBeNull();
    expect(await screen.findByText("fresh · 1 session on this host")).toBeTruthy();
  });

  it("a held A reply cannot replace the new A runtime after A-B-A", async () => {
    const old = held();
    harness.read.mockReturnValueOnce(old.promise).mockResolvedValue(payload("fresh", 2));
    render(<ContextAccountSummary {...props} />);
    act(() => {
      harness.agents = new Map([["agent", agent("instance-2", "B")]]);
      notifyAll(harness.storeListeners);
      harness.agents = new Map([["agent", agent("instance-3", "A")]]);
      notifyAll(harness.storeListeners);
    });
    expect(await screen.findByText("fresh · 2 sessions on this host")).toBeTruthy();
    await act(async () => {
      old.resolve(payload("old-A", 9));
      await old.promise;
    });
    expect(screen.queryByText(/old-A/)).toBeNull();
  });

  it("disconnect hides accepted rows and fences a pending read after unmount", async () => {
    const view = render(<ContextAccountSummary {...props} />);
    expect(await screen.findByText(/fresh ·/)).toBeTruthy();
    act(() => {
      harness.connected = false;
      notifyAll(harness.events);
      notifyAll(harness.connections);
    });
    expect(screen.queryByText(/fresh ·/)).toBeNull();
    view.unmount();
    expect(harness.events.size).toBe(0);
    expect(harness.connections.size).toBe(0);
    expect(harness.storeListeners.size).toBe(0);
  });
});
