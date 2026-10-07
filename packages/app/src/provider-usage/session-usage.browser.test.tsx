import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { i18n } from "@/i18n/i18next";
import type { UsagePanelProps } from "./usage-panel";

const state = vi.hoisted(() => ({ pooled: false, refreshes: 0 }));

vi.mock("@/stores/session-store", () => ({
  useSessionStore: (select: (value: unknown) => unknown) =>
    select({
      sessions: {
        host: {
          serverInfo: { features: { pooledAccountUsageObservation: state.pooled } },
        },
      },
    }),
}));
vi.mock("@/usage", () => ({
  AgentUsage: () => <div data-testid="upstream-agent-usage" />,
}));
vi.mock("./use-usage-panel", () => ({
  useUsagePanel: (): UsagePanelProps => {
    const account = {
      accountId: "work",
      name: "Work",
      provider: "claude" as const,
      status: "ok" as const,
      observedAt: new Date().toISOString(),
      source: "session" as const,
      fiveHour: { usedPct: 40, resetsAt: null },
      weekly: null,
      inUse: true,
      sessionCount: 2,
    };
    return {
      chat: {
        provider: "claude",
        model: "Opus",
        effort: "high",
        host: "Mini",
        contextUsed: null,
        contextLimit: null,
      },
      account,
      accountName: "Work",
      identityAvailable: true,
      accounts: [account, { ...account, accountId: "personal", name: "Personal" }],
      status: "ready",
      readingAt: Date.now(),
      onRefresh: () => {
        state.refreshes++;
      },
    };
  },
}));

const { SessionUsage } = await import("./session-usage");

const mounted: { root: Root; container: HTMLDivElement }[] = [];
afterEach(() => {
  for (const item of mounted.splice(0)) {
    act(() => item.root.unmount());
    item.container.remove();
  }
});
function mount(refreshable: boolean) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  act(() =>
    root.render(<SessionUsage serverId="host" agentId="agent" refreshable={refreshable} />),
  );
  return container;
}

it("a pooled host shows the session's bound account and the other pool accounts, not upstream's cards", async () => {
  await i18n.changeLanguage("en");
  state.pooled = true;
  const container = mount(true);
  expect(container.querySelector('[data-testid="upstream-agent-usage"]')).toBeNull();
  expect(container.querySelector('[data-testid="chat-usage-panel"]')).not.toBeNull();
  expect(container.textContent).toContain("Work");
  expect(container.textContent).toContain("Other accounts (1)");
  // The context window details above it already show this chat's context.
  expect(container.textContent).not.toContain("This chat");
  const refresh = container.querySelector('[data-testid="usage-observation-refresh"]');
  act(() => (refresh as HTMLElement).click());
  expect(state.refreshes).toBe(1);
});
it("a surface that cannot be pressed gets no refresh", async () => {
  state.pooled = true;
  const container = mount(false);
  expect(container.querySelector('[data-testid="usage-observation-refresh"]')).toBeNull();
});
it("a host without the account pool keeps upstream's agent usage cards", async () => {
  state.pooled = false;
  const container = mount(true);
  expect(container.querySelector('[data-testid="upstream-agent-usage"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="chat-usage-panel"]')).toBeNull();
});
