import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { InstalledPlugin } from "./types";
import { pluginConnectionRefusal, pluginSurfaceUnavailable } from "./surface-refusal";
import {
  getPluginSurfaceContributionServerIds,
  resolvePluginSurfaceContribution,
} from "./surface-contribution";

function installation(
  serverId: string,
  surfaces: string[],
  sidebarItems: Array<{ id: string; surface: string }> = [],
  pluginId = "review",
): InstalledPlugin {
  return {
    id: pluginId,
    serverId,
    clientBundle: serverId,
    lifetime: new AbortController(),
    queryClient: new QueryClient(),
    cleanup: () => undefined,
    settingsScreens: [],
    surfaces: surfaces.map((id) => ({ id, Component: () => null })),
    sidebarItems: sidebarItems.map((item) => ({
      ...item,
      title: item.id,
      icon: "Blocks",
    })),
    workspacePanels: [],
    commandCenterItems: [],
    clientSlashCommands: [],
    attachmentSources: [],
    themes: [],
    timelineTransformers: [],
    timelineRenderers: [],
  };
}

describe("plugin surface contribution identity", () => {
  const installations = [
    installation(
      "host-v1",
      ["overview", "surface-v1"],
      [{ id: "overview", surface: "surface-v1" }],
    ),
    installation(
      "host-v2",
      ["overview", "surface-v2"],
      [{ id: "overview", surface: "surface-v2" }],
    ),
    installation("same-surface", ["overview"]),
    installation("other-contribution", ["surface-v1"], [{ id: "other", surface: "surface-v1" }]),
    installation(
      "other-plugin",
      ["overview", "surface-v1"],
      [{ id: "overview", surface: "surface-v1" }],
      "other",
    ),
  ];

  it("resolves a sidebar contribution by its explicit identity across host version drift", () => {
    const identity = { kind: "sidebar", id: "overview" } as const;
    const resolved = resolvePluginSurfaceContribution(installations[0] ?? null, identity);

    expect(resolved.sidebarItem?.id).toBe("overview");
    expect(resolved.surface?.id).toBe("surface-v1");
    expect(getPluginSurfaceContributionServerIds(installations, "review", identity)).toEqual([
      "host-v1",
      "host-v2",
    ]);
  });

  it("does not let a same-id sidebar contribution capture a direct surface", () => {
    const identity = { kind: "surface", id: "overview" } as const;
    const resolved = resolvePluginSurfaceContribution(installations[0] ?? null, identity);

    expect(resolved.sidebarItem).toBeNull();
    expect(resolved.surface?.id).toBe("overview");
    expect(getPluginSurfaceContributionServerIds(installations, "review", identity)).toEqual([
      "host-v1",
      "host-v2",
      "same-surface",
    ]);
  });
});

import { pluginSurfaceTitle } from "./surface-contribution";
it("P2 unavailable bundled surface uses its host-owned product name", () => {
  expect(pluginSurfaceTitle("orca-organization-next")).toBe("Fulcra Command Centre");
  expect(pluginSurfaceTitle("other", "A surface")).toBe("A surface");
});

describe("safe plugin connection refusal", () => {
  const snapshot = {
    lastError: null,
    authFailureReason: null,
    pairingRequired: null,
    connectionStatus: "error",
  } as const;

  it("uses typed authentication reasons without publishing arbitrary exception text", () => {
    expect(
      pluginConnectionRefusal({
        ...snapshot,
        authFailureReason: "password_required",
        lastError: "throwaway-secret /private/operator",
      }),
    ).toBe("This host requires its configured password. Connect it from Settings.");
    expect(pluginConnectionRefusal({ ...snapshot, authFailureReason: "incorrect_password" })).toBe(
      "This host refused the configured password. Update it in Settings.",
    );
  });

  it("recognizes only exact host preflight diagnostics", () => {
    expect(
      pluginConnectionRefusal({
        ...snapshot,
        lastError: "Desktop daemon authentication unavailable. Retry from Settings.",
      }),
    ).toBe("Desktop daemon authentication is unavailable. Retry from Settings.");
    expect(
      pluginConnectionRefusal({
        ...snapshot,
        lastError: "Desktop daemon is starting or unavailable. Retrying.",
      }),
    ).toBe("Desktop daemon is starting or unavailable. Retry the connection.");
    expect(
      pluginConnectionRefusal({
        ...snapshot,
        lastError:
          "Desktop daemon authentication unavailable. Retry from Settings. token=throwaway",
      }),
    ).toBe("The plugin host connection is unavailable. Retry the connection.");
  });

  it("leaves unknown failures unclassified and clears recovered connection diagnostics", () => {
    expect(
      pluginConnectionRefusal({
        ...snapshot,
        lastError: "password token=throwaway-secret /private/operator",
      }),
    ).toBe("The plugin host connection is unavailable. Retry the connection.");
    expect(pluginConnectionRefusal({ ...snapshot, connectionStatus: "online" })).toBeNull();
    expect(pluginConnectionRefusal(null)).toBeNull();
    expect(pluginSurfaceUnavailable(null, true, false)).toBe("This plugin could not be loaded.");
    expect(pluginSurfaceUnavailable("The plugin host is offline.", false, true)).toBe(
      "The plugin host is offline.",
    );
  });
});
