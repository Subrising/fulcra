import type { AgentProfilePicker } from "@/agent-profiles/presentation";
import { NotificationModeCardContent } from "@/screens/settings/notification-mode-card-content";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { i18n } from "@/i18n/i18next";
import {
  buildSelectableProviderSelectorProviders,
  resolveSelectedModelLabel,
} from "@/provider-selection/provider-selection";
import { ModelBrowser, type ModelBrowserState } from "./model-browser";
import type { ModelBrowserView } from "./model-browser-view";

const cached: ProviderSnapshotEntry = {
  provider: "codex",
  label: "Codex",
  enabled: true,
  status: "error",
  error: "Model discovery timed out",
  fetchedAt: "2026-01-01T00:00:00.000Z",
  models: [{ provider: "codex", id: "known", label: "Known model" }],
};
const mounted: { root: Root; container: HTMLDivElement }[] = [];
afterEach(() => {
  for (const item of mounted.splice(0)) {
    act(() => item.root.unmount());
    item.container.remove();
  }
});
function mount(
  entry: ProviderSnapshotEntry,
  view: ModelBrowserView,
  query = "",
  profiles: AgentProfilePicker | null = null,
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  const selections: string[][] = [],
    retries: string[] = [];
  const onSelect = (provider: string, model: string) => {
    selections.push([provider, model]);
  };
  const onRetry = (provider: string) => {
    retries.push(provider);
  };
  const render = (next: ProviderSnapshotEntry, retrying = false) => {
    const providers = buildSelectableProviderSelectorProviders([next]);
    const label = resolveSelectedModelLabel({
      providers,
      selectedProvider: "codex",
      selectedModel: "known",
      isLoading: false,
    });
    const state: ModelBrowserState = {
      serverId: null,
      providers,
      selectedProvider: "codex",
      selectedModel: "known",
      profiles,
      view,
      searchQuery: query,
      isSearchFocused: !!query,
      header: { title: "Models" },
      selectedModelLabel: label,
      triggerLabel: label,
      desktopFixedHeight: undefined,
      isProviderView: view.kind === "provider",
      prepareToOpen() {},
      showAll() {},
      reset() {},
      drillDown() {},
    };
    act(() =>
      root.render(
        React.createElement(ModelBrowser, {
          state,
          onSelect,
          onApplyProfile: profiles?.applyProfile,
          onRetryProvider: onRetry,
          isRetryingProvider: retrying,
          scrolling: "sheet",
          searchAllOnFocus: true,
        }),
      ),
    );
  };
  render(entry);
  return { container, selections, retries, render };
}
function button(container: HTMLElement, id: string): HTMLElement {
  const result = container.querySelector(`[data-testid="${id}"]`);
  if (!(result instanceof HTMLElement)) throw new Error(`Model browser did not render ${id}`);
  return result;
}
it("renders cached models alongside their error and scoped Retry, then removes the warning after ready", async () => {
  await i18n.changeLanguage("en");
  const browser = mount(cached, { kind: "provider", providerId: "codex", providerLabel: "Codex" });
  expect(browser.container.textContent).toContain("Showing previously loaded Codex models.");
  expect(browser.container.textContent).toContain("Model discovery timed out");
  const model = button(browser.container, "model-row-codex-known");
  expect(model.getAttribute("aria-selected")).toBe("true");
  act(() => model.click());
  expect(browser.selections).toEqual([["codex", "known"]]);
  act(() => button(browser.container, "model-provider-retry-codex").click());
  expect(browser.retries).toEqual(["codex"]);
  browser.render(cached, true);
  expect(
    button(browser.container, "model-provider-retry-codex").getAttribute("aria-disabled"),
  ).toBe("true");
  browser.render({ ...cached, status: "ready", error: undefined });
  expect(browser.container.querySelector('[data-testid="model-provider-error-codex"]')).toBeNull();
  expect(button(browser.container, "model-row-codex-known").getAttribute("aria-selected")).toBe(
    "true",
  );
  expect(browser.container.textContent).not.toContain("previously loaded");
});
it("keeps the failure and Retry visible in cross-provider search results", async () => {
  await i18n.changeLanguage("en");
  const browser = mount(cached, { kind: "all" }, "known");
  expect(browser.container.textContent).toContain("Model discovery timed out");
  act(() => button(browser.container, "model-row-codex-known").click());
  act(() => button(browser.container, "model-provider-retry-codex").click());
  expect(browser.selections).toEqual([["codex", "known"]]);
  expect(browser.retries).toEqual(["codex"]);
});
it("keeps empty errors actionable without manufacturing a model row", async () => {
  await i18n.changeLanguage("en");
  const browser = mount(
    { ...cached, models: [] },
    { kind: "provider", providerId: "codex", providerLabel: "Codex" },
  );
  expect(browser.container.textContent).toContain("Model discovery timed out");
  expect(browser.container.querySelector('[data-testid="model-row-codex-known"]')).toBeNull();
  act(() => button(browser.container, "model-provider-retry-codex").click());
  expect(browser.retries).toEqual(["codex"]);
  browser.render({ ...cached, models: [], status: "loading", error: undefined });
  expect(browser.container.textContent).toContain("Loading");
  expect(browser.container.querySelector('[data-testid="model-provider-retry-codex"]')).toBeNull();
  browser.render({ ...cached, models: [], status: "unavailable", error: undefined });
  expect(browser.container.textContent).toContain("not installed");
  act(() => button(browser.container, "model-provider-retry-codex").click());
  expect(browser.retries).toEqual(["codex", "codex"]);
});

it("an unsupported host policy never renders an effective mode switch from a defaulted primes value", () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  const changes: string[] = [];
  const onChange = (mode: "all" | "primes" | "off") => {
    changes.push(mode);
  };
  act(() =>
    root.render(
      React.createElement(NotificationModeCardContent, {
        unavailableReason: "Update this host to use notification controls.",
        mode: "primes",
        error: null,
        onChange,
      }),
    ),
  );
  expect(container.textContent).toContain("Update this host");
  expect(container.querySelector('[data-testid="host-page-notification-mode"]')).toBeNull();
  expect(changes).toEqual([]);
  act(() =>
    root.render(
      React.createElement(NotificationModeCardContent, {
        unavailableReason: null,
        mode: "off",
        error: null,
        onChange,
      }),
    ),
  );
  expect(container.querySelector('[data-testid="host-page-notification-mode"]')).not.toBeNull();
  expect(container.textContent).toContain("Off");
  expect(container.textContent).not.toContain("Update this host");
});

it("public presentation keeps the real profile glyph row and application action in the model picker", async () => {
  await i18n.changeLanguage("en");
  const applied: string[] = [];
  const profiles: AgentProfilePicker = {
    rows: [
      {
        id: "saved",
        provider: "codex",
        modelId: "known",
        icon: "code",
        color: "blue",
        name: "Saved profile",
        summary: "Codex · Known model",
      },
    ],
    applyProfile: (id) => {
      applied.push(id);
    },
  };
  const browser = mount(
    { ...cached, status: "ready", error: undefined },
    { kind: "provider", providerId: "codex", providerLabel: "Codex" },
    "",
    profiles,
  );
  expect(browser.container.textContent).toContain("Saved profile");
  act(() => button(browser.container, "model-profile-row-saved").click());
  expect(applied).toEqual(["saved"]);
  expect(button(browser.container, "model-row-codex-known").getAttribute("aria-selected")).toBe(
    "true",
  );
});
