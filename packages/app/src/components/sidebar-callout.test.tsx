/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 0: 0, 1: 4, 2: 8, 3: 12, 4: 16 },
    iconSize: { sm: 14, md: 18 },
    borderWidth: { 1: 1 },
    borderRadius: { sm: 4, md: 6, lg: 8, xl: 12, "2xl": 16, full: 999 },
    fontSize: { xs: 11, sm: 13, base: 15 },
    fontWeight: { normal: "400", medium: "500", semibold: "600" },
    opacity: { 50: 0.5 },
    shadow: { md: {} },
    colors: {
      surfaceSidebar: "#111",
      surface0: "#000",
      surface1: "#111",
      surface2: "#222",
      surface3: "#333",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      border: "#555",
      borderAccent: "#666",
      accent: "#0a84ff",
      accentForeground: "#fff",
      destructive: "#ff4444",
      primary: "#0a84ff",
      palette: { white: "#fff" },
    },
  },
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function" ? (factory as (t: typeof theme) => unknown)(theme) : factory,
  },
  useUnistyles: () => ({ theme }),
}));

vi.mock("lucide-react-native", () => {
  const createIcon = (name: string) => (props: Record<string, unknown>) =>
    React.createElement("span", { ...props, "data-icon": name });
  return {
    X: createIcon("X"),
    CheckCircle2: createIcon("CheckCircle2"),
    AlertTriangle: createIcon("AlertTriangle"),
  };
});

vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

import { SidebarCallout } from "./sidebar-callout";

type SidebarCalloutActions = React.ComponentProps<typeof SidebarCallout>["actions"];

function buildSingleAction(onPress: () => void): SidebarCalloutActions {
  return [{ label: "Undo", onPress }];
}

function buildTwoActions(onWhatsNew: () => void, onInstall: () => void): SidebarCalloutActions {
  return [
    { label: "What's new", onPress: onWhatsNew },
    { label: "Install & restart", onPress: onInstall, variant: "primary" },
  ];
}

const calloutTitleIcon = <span data-testid="callout-title-icon" />;

describe("SidebarCallout", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    root = null;
    container?.remove();
    container = null;
  });

  it("renders title and description", () => {
    act(() => {
      root?.render(
        <SidebarCallout title="Update available" description="v1.2.3 is ready to install." />,
      );
    });

    expect(container?.textContent).toContain("Update available");
    expect(container?.textContent).toContain("v1.2.3 is ready to install.");
  });

  it("renders an icon next to the title", () => {
    act(() => {
      root?.render(<SidebarCallout title="Update available" icon={calloutTitleIcon} />);
    });

    expect(container?.querySelector('[data-testid="callout-title-icon"]')).not.toBeNull();
  });

  it("renders one action when one is provided", () => {
    const onPress = vi.fn();
    const actions = buildSingleAction(onPress);
    act(() => {
      root?.render(<SidebarCallout description="Saved." actions={actions} testID="callout" />);
    });

    const button = container?.querySelector(
      '[data-testid="callout-action-0"]',
    ) as HTMLElement | null;
    expect(button).not.toBeNull();
    expect(button?.textContent).toContain("Undo");
  });

  it("renders up to two actions", () => {
    const actions = buildTwoActions(vi.fn(), vi.fn());
    act(() => {
      root?.render(
        <SidebarCallout
          title="Update available"
          description="v1 ready."
          actions={actions}
          testID="callout"
        />,
      );
    });

    expect(container?.querySelector('[data-testid="callout-action-0"]')?.textContent).toContain(
      "What's new",
    );
    expect(container?.querySelector('[data-testid="callout-action-1"]')?.textContent).toContain(
      "Install & restart",
    );
  });

  it("renders no action row when no actions are provided", () => {
    act(() => {
      root?.render(<SidebarCallout description="Copied" testID="callout" />);
    });

    expect(container?.querySelector('[data-testid="callout-actions"]')).toBeNull();
  });

  it("renders the dismiss X in the top-left when onDismiss is provided", () => {
    const onDismiss = vi.fn();
    act(() => {
      root?.render(<SidebarCallout description="Saved" onDismiss={onDismiss} testID="callout" />);
    });

    const dismissButton = container?.querySelector(
      '[data-testid="callout-dismiss"]',
    ) as HTMLElement | null;
    expect(dismissButton).not.toBeNull();
  });

  it("omits the dismiss button when onDismiss is not provided", () => {
    act(() => {
      root?.render(<SidebarCallout description="Saved" testID="callout" />);
    });

    expect(container?.querySelector('[data-testid="callout-dismiss"]')).toBeNull();
  });
});

import { SidebarSessions } from "./sidebar/sidebar-sessions";
import { useSessionStore } from "@/stores/session-store";
import { normalizeAgentSnapshot } from "@/utils/agent-snapshots";
const SERVER_ID = "sidebar-session-test";
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}));
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
const sessionNavigation = vi.hoisted(() => vi.fn());
vi.mock("@/utils/navigate-to-agent", () => ({ navigateToAgent: sessionNavigation }));
vi.mock("@/sessions/session-account-info", () => ({
  SessionAccountInfo: ({
    account,
    testID,
  }: {
    account: { name: string | null } | null;
    testID: string;
  }) => <span data-testid={testID}>{account?.name ?? "Account unavailable"}</span>,
}));
describe("mounted all-session sidebar", () => {
  let container: HTMLDivElement;
  let root: Root;
  const agent = (id: string, workspaceId: string | null = "shared") =>
    normalizeAgentSnapshot(
      {
        id,
        provider: "codex",
        cwd: "/fixtures/project",
        workspaceId: workspaceId ?? undefined,
        title: `Session ${id}`,
        model: null,
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
        lastUserMessageAt: null,
        status: "idle",
        capabilities: {
          supportsStreaming: true,
          supportsSessionPersistence: true,
          supportsDynamicModes: false,
          supportsMcpServers: true,
          supportsReasoningStream: true,
          supportsToolInvocations: true,
          supportsRewindConversation: false,
          supportsRewindFiles: false,
          supportsRewindBoth: false,
        },
        currentModeId: null,
        availableModes: [],
        pendingPermissions: [],
        persistence: null,
        labels: { "fulcra.account-name": `Account ${id}` },
      },
      SERVER_ID,
    );
  beforeEach(async () => {
    await act(async () => {
      useSessionStore.getState().initializeSession(SERVER_ID, null as never);
    });
    sessionNavigation.mockReset();
    useSidebarViewStore.setState({ hostFilters: [] });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  it("shows an explicit total beyond the preview, opens exact sessions and reacts to account switches", async () => {
    const agents = Array.from({ length: 10 }, (_, i) =>
      agent(String(i), i === 9 ? null : "shared"),
    );
    const initialAgents = new Map(agents.map((a) => [a.id, a]));
    await act(async () => {
      useSessionStore.getState().setAgents(SERVER_ID, initialAgents);
    });
    await act(async () => root.render(<SidebarSessions serverIds={[SERVER_ID]} />));
    expect(container.textContent).toContain("All sessions (10)");
    expect(container.querySelectorAll('[data-testid^="sidebar-session-open-"]')).toHaveLength(8);
    await act(async () =>
      (container.querySelector('[data-testid="sidebar-all-sessions-more"]') as HTMLElement).click(),
    );
    expect(container.querySelectorAll('[data-testid^="sidebar-session-open-"]')).toHaveLength(10);
    await act(async () =>
      (
        container.querySelector(
          `[data-testid="sidebar-session-open-${SERVER_ID}-9"]`,
        ) as HTMLElement
      ).click(),
    );
    expect(sessionNavigation).toHaveBeenCalledWith({
      serverId: SERVER_ID,
      agentId: "9",
      workspaceId: null,
    });
    const switched = { ...agents[0], labels: { "fulcra.account-name": "Switched B" } };
    const switchedAgents = new Map([switched, ...agents.slice(1)].map((a) => [a.id, a]));
    await act(async () => {
      useSessionStore.getState().setAgents(SERVER_ID, switchedAgents);
    });
    expect(
      container.querySelector(`[data-testid="sidebar-session-account-${SERVER_ID}-0"]`)
        ?.textContent,
    ).toBe("Switched B");
    expect(
      container.querySelector(`[data-testid="sidebar-session-account-${SERVER_ID}-1"]`)
        ?.textContent,
    ).toBe("Account 1");
  });
  it("keeps idle sessions visible apart from workspace collapse and applies host/closed/archive filters", async () => {
    const idle = agent("idle");
    const closed = { ...agent("closed"), status: "closed" as const };
    const archived = { ...agent("archived"), archivedAt: new Date("2026-10-01T00:00:00.000Z") };
    const visible = new Map([idle, closed, archived].map((a) => [a.id, a]));
    await act(async () => {
      useSessionStore.getState().setAgents(SERVER_ID, visible);
    });
    await act(async () => root.render(<SidebarSessions serverIds={[SERVER_ID, "other-host"]} />));
    expect(container.textContent).toContain("All sessions (1)");
    expect(
      container.querySelector(`[data-testid="sidebar-session-open-${SERVER_ID}-idle"]`),
    ).not.toBeNull();
    expect(container.textContent).not.toContain("Session closed");
    expect(container.textContent).not.toContain("Session archived");
    await act(async () => {
      useSidebarViewStore.setState({ hostFilters: ["other-host"] });
    });
    expect(container.querySelector('[data-testid="sidebar-all-sessions"]')).toBeNull();
    await act(async () => {
      useSidebarViewStore.setState({ hostFilters: [] });
    });
    await act(async () =>
      (
        container.querySelector('[data-testid="sidebar-all-sessions-toggle"]') as HTMLElement
      ).click(),
    );
    expect(container.textContent).toContain("All sessions (1)");
    expect(
      container.querySelector(`[data-testid="sidebar-session-open-${SERVER_ID}-idle"]`),
    ).toBeNull();
  });
});
