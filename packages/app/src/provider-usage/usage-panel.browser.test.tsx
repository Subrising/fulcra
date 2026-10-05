import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { i18n } from "@/i18n/i18next";
import { UsagePanel, type UsagePanelProps } from "./usage-panel";

const now = Date.parse("2026-10-04T12:00:00Z");
const mounted: { root: Root; container: HTMLDivElement }[] = [];
afterEach(() => {
  for (const item of mounted.splice(0)) {
    act(() => item.root.unmount());
    item.container.remove();
  }
});
function props(): UsagePanelProps {
  return {
    chat: {
      provider: "claude",
      model: "Opus",
      effort: "high",
      host: "MacBook Pro",
      contextUsed: 365000,
      contextLimit: 1000000,
      recorded: {
        provider: "claude",
        source: "claude-sdk-result",
        observedAt: new Date(now).toISOString(),
        latest: {
          scope: "unknown",
          tokens: {
            inputNew: 100,
            cacheRead: 400,
            cacheWritten: 50,
            output: 25,
            reasoningOutput: 10,
          },
        },
        total: {
          scope: "provider-query",
          tokens: { inputNew: 1200, cacheRead: 9000, cacheWritten: 80, output: 300 },
        },
        estimate: { scope: "provider-query", kind: "provider-api-estimate", amountUsd: 155.41 },
      },
    },
    account: {
      accountId: "work",
      name: "Work account with a deliberately long display name",
      provider: "claude",
      status: "ok",
      observedAt: new Date(now - 3600000).toISOString(),
      source: "session",
      fiveHour: { usedPct: 40, resetsAt: new Date(now + 7200000).toISOString() },
      weekly: null,
      inUse: true,
      sessionCount: 13,
    },
    accountName: "Work account with a deliberately long display name",
    identityAvailable: true,
    accounts: [],
    status: "ready",
    readingAt: now,
  };
}
function mount(input: UsagePanelProps) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  const render = (next: UsagePanelProps) => act(() => root.render(<UsagePanel {...next} />));
  render(input);
  return { container, render };
}
function click(container: HTMLElement, id: string) {
  const target = container.querySelector(`[data-testid="${id}"]`);
  if (!(target instanceof HTMLElement)) throw new Error(`Missing control ${id}`);
  act(() => target.click());
}

it("separates current context, bound allowance, partial windows and scoped token categories", async () => {
  await i18n.changeLanguage("en");
  const panel = mount(props());
  expect(panel.container.textContent).toContain("This chat");
  expect(panel.container.textContent).toContain("365,000 / 1,000,000 tokens");
  expect(panel.container.textContent).toContain("40% used · 60% remaining");
  expect(
    panel.container.querySelector('[data-testid="usage-window-bound-7d"]')?.textContent,
  ).toContain("Not reported");
  expect(panel.container.textContent).not.toContain("Session cost");
  expect(panel.container.textContent).not.toContain("$155.41");
  click(panel.container, "usage-token-details");
  expect(panel.container.textContent).toContain("Current provider query total");
  expect(panel.container.textContent).toContain("Latest provider report · scope unknown");
  expect(panel.container.textContent).toContain("Cache written");
  expect(panel.container.textContent).toContain("Reasoning (within output)");
  expect(panel.container.textContent).toContain("Provider-query API estimate: $155.41");
  expect(panel.container.textContent).toContain("not a subscription bill");
  expect(panel.container.textContent).toContain(
    "Last-request counters are not reported separately.",
  );
});
it("missing binding or unsupported host cannot adopt a host-default account", async () => {
  await i18n.changeLanguage("en");
  const input = props();
  input.chat.recorded = undefined;
  input.account = null;
  input.accountName = null;
  input.identityAvailable = false;
  input.status = "unsupported";
  const panel = mount(input);
  expect(panel.container.textContent).toContain("Update this host");
  expect(panel.container.textContent).toContain("Bound account not reported");
  expect(panel.container.querySelectorAll('[role="progressbar"]').length).toBe(0);
  expect(panel.container.querySelector('[data-testid="usage-observation-refresh"]')).toBeNull();
  click(panel.container, "usage-token-details");
  expect(panel.container.textContent).not.toContain("API estimate:");
});
it("other accounts expand with full host-scoped resident counts, not working-session claims", async () => {
  await i18n.changeLanguage("en");
  const input = props();
  input.accounts = [
    {
      ...input.account!,
      accountId: "other",
      name: "Other account with a long name",
      sessionCount: 13,
    },
    input.account!,
  ];
  const panel = mount(input);
  expect(panel.container.textContent).not.toContain("Other account with a long name");
  click(panel.container, "usage-other-accounts");
  expect(panel.container.textContent).toContain("Resident sessions on MacBook Pro: 13");
  expect(panel.container.textContent).toContain("not a complete account roster");
  expect(panel.container.textContent).not.toContain("Ready");
});
it("expired resets, 100 percent, and a pending manual reread retain the last observed figures", async () => {
  await i18n.changeLanguage("en");
  const input = props();
  input.account = {
    ...input.account!,
    status: "limited",
    weekly: { usedPct: 100, resetsAt: new Date(now - 1).toISOString() },
  };
  let reads = 0;
  input.onRefresh = () => {
    reads++;
  };
  const panel = mount(input);
  expect(panel.container.textContent).toContain("100% used · 0% remaining");
  expect(panel.container.textContent).toContain("Reset passed");
  click(panel.container, "usage-observation-refresh");
  expect(reads).toBe(1);
  panel.render({ ...input, busy: true });
  click(panel.container, "usage-observation-refresh");
  expect(reads).toBe(1);
  expect(panel.container.textContent).toContain("40% used · 60% remaining");
});
it("unknown or unloaded chat metrics remain unavailable across languages", async () => {
  await i18n.changeLanguage("ja");
  const input = props();
  input.chat = { ...input.chat, contextUsed: null, contextLimit: null, recorded: undefined };
  input.status = "offline";
  input.account = null;
  input.accountName = null;
  input.identityAvailable = false;
  const panel = mount(input);
  expect(panel.container.textContent).toContain("このチャット");
  expect(panel.container.textContent).toContain("報告なし");
  click(panel.container, "usage-token-details");
  expect(panel.container.textContent).not.toContain("155");
  expect(panel.container.textContent).not.toContain("usagePanel.");
});
