import { beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({
  replace: vi.fn(),
  dismissTo: vi.fn(),
  restoreWorkspace: vi.fn(),
}));
vi.mock("expo-router", () => ({ router: navigation }));
vi.mock("@/stores/navigation-active-workspace-store", () => ({
  navigateToLastWorkspace: navigation.restoreWorkspace,
}));

import { returnFromSettings } from "./settings-navigation";
import { buildProjectsSettingsRoute, buildSettingsHostSectionRoute } from "@/utils/host-routes";

describe("returning from settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    navigation.restoreWorkspace.mockReturnValue(false);
  });

  it("returns a newly connected user to startup and the home plugin without requiring a project", () => {
    returnFromSettings({ kind: "root" });
    expect(navigation.replace).toHaveBeenCalledExactlyOnceWith("/");
    expect(navigation.dismissTo).not.toHaveBeenCalled();
  });

  it("preserves the existing workspace return when a conversation was open", () => {
    navigation.restoreWorkspace.mockReturnValue(true);
    returnFromSettings({ kind: "root" });
    expect(navigation.restoreWorkspace).toHaveBeenCalledOnce();
    expect(navigation.replace).not.toHaveBeenCalled();
    expect(navigation.dismissTo).not.toHaveBeenCalled();
  });

  it("returns plugin settings to the same host", () => {
    returnFromSettings({ kind: "plugin", serverId: "book", pluginId: "organization", screenId: "work" });
    expect(navigation.dismissTo).toHaveBeenCalledExactlyOnceWith(
      buildSettingsHostSectionRoute("book", "plugins"),
    );
    expect(navigation.restoreWorkspace).not.toHaveBeenCalled();
  });

  it("returns project settings to that host's projects", () => {
    returnFromSettings({ kind: "project", serverId: "mini", projectId: "project" });
    expect(navigation.dismissTo).toHaveBeenCalledExactlyOnceWith(
      buildProjectsSettingsRoute("mini"),
    );
    expect(navigation.restoreWorkspace).not.toHaveBeenCalled();
  });
});
