/**
 * @vitest-environment jsdom
 */
import React, { createRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Text, type View } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CurrentSessionAccountInfo, SessionAccountInfo } from "@/sessions/session-account-info";
import { useSessionStore } from "@/stores/session-store";
import { normalizeAgentSnapshot } from "@/utils/agent-snapshots";
import { AccountRundown } from "@/provider-usage/account-rundown";
import { MenuRoot, MenuTrigger } from "./menu-root";

const ACCOUNT_A = { providerLabel: "Codex", name: "A" };
const ACCOUNT_B = { providerLabel: "Codex", name: "B" };
const ACCOUNT_UNAVAILABLE = { providerLabel: "Claude", name: null };

beforeEach(() => vi.stubGlobal("React", React));
afterEach(() => {
  cleanup();
  useSessionStore.getState().clearSession("account-display-host");
});

describe("MenuTrigger", () => {
  it("forwards its rendered trigger to callers", () => {
    const triggerRef = createRef<View>();

    render(
      <MenuRoot>
        <MenuTrigger ref={triggerRef} accessibilityLabel="Open menu">
          <Text>Open</Text>
        </MenuTrigger>
      </MenuRoot>,
    );

    expect(triggerRef.current).not.toBeNull();
  });
});

describe("session account information trigger", () => {
  it("opens current account information without navigating its parent row, then follows wire switches", () => {
    const navigate = vi.fn();
    const { rerender } = render(
      <div onClick={navigate}>
        <SessionAccountInfo account={ACCOUNT_A} testID="account" />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Session info, Codex, Account: A" }));
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByText("Provider: Codex")).toBeTruthy();
    rerender(
      <div onClick={navigate}>
        <SessionAccountInfo account={ACCOUNT_B} testID="account" />
      </div>,
    );
    expect(screen.getByRole("button", { name: "Session info, Codex, Account: B" })).toBeTruthy();
    rerender(<SessionAccountInfo account={ACCOUNT_A} testID="account" />);
    expect(screen.getByRole("button", { name: "Session info, Codex, Account: A" })).toBeTruthy();
  });
  it("discloses unavailable account information without inventing a saved login", () => {
    render(<SessionAccountInfo account={ACCOUNT_UNAVAILABLE} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Session info, Claude, Account unavailable" }),
    );
    expect(screen.getByText("Provider: Claude")).toBeTruthy();
    expect(screen.queryByText("Personal")).toBeNull();
  });
});

it("the mounted header follows live projected store upserts A to B to A and missing ownership", () => {
  const host = "account-display-host";
  const store = useSessionStore.getState();
  store.initializeSession(host, null);
  const snapshot = normalizeAgentSnapshot(
    {
      id: "same-chat",
      provider: "codex",
      cwd: "/fixture",
      model: null,
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-01T00:00:00Z",
      lastUserMessageAt: null,
      status: "idle",
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
      title: "Same chat",
      labels: { "fulcra.account-name": "A" },
    },
    host,
  );
  store.setAgents(host, new Map([[snapshot.id, snapshot]]));
  render(<CurrentSessionAccountInfo serverId={host} agentId={snapshot.id} />);
  for (const name of ["A", "B", "A"]) {
    act(() =>
      store.setAgents(
        host,
        new Map([[snapshot.id, { ...snapshot, labels: { "fulcra.account-name": name } }]]),
      ),
    );
    expect(
      screen.getByRole("button", { name: `Session info, Codex, Account: ${name}` }),
    ).toBeTruthy();
  }
  act(() =>
    store.setAgents(
      host,
      new Map([[snapshot.id, { ...snapshot, labels: { "saved-login": "Personal" } }]]),
    ),
  );
  expect(
    screen.getByRole("button", { name: "Session info, Codex, Account unavailable" }),
  ).toBeTruthy();
  expect(screen.queryByText("Personal")).toBeNull();
});

it("the mounted rundown displays qualified counts and explicit legacy unavailability", () => {
  const base = {
    provider: "codex" as const,
    source: null,
    observedAt: null,
    status: "unavailable" as const,
    fiveHour: null,
    weekly: null,
    inUse: true,
  };
  const { container } = render(
    <AccountRundown
      accounts={[
        { ...base, accountId: "one", name: "One", sessionCount: 1 },
        { ...base, accountId: "zero", name: "Zero", sessionCount: 0 },
        { ...base, accountId: "legacy", name: "Legacy" },
      ]}
    />,
  );
  expect(container.textContent).toContain("1 session on this host");
  expect(container.textContent).toContain("0 sessions on this host");
  expect(container.textContent).toContain("Session count unavailable");
});
