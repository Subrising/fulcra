// @vitest-environment jsdom
import React from "react";
import { render, fireEvent, screen, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({
  push: vi.fn(),
  companyHost: null as string | null,
  hydrated: true,
  hydrationError: null as string | null,
}));
vi.mock("expo-router", () => ({ router: { push: f.push }, usePathname: () => "/h/remote" }));
vi.mock("./icons", () => ({ resolvePluginIcon: () => () => null }));
vi.mock("./contribution-host", () => ({
  getPreferredPluginContributionHost: () => null,
  rememberPluginContributionHost: () => {},
}));
vi.mock("@/components/sidebar/sidebar-header-row", () => ({
  SidebarHeaderRow: ({
    label,
    accessibilityLabel,
    onPress,
  }: {
    label: string;
    accessibilityLabel: string;
    onPress: () => void;
  }) => (
    <button type="button" aria-label={accessibilityLabel} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("./prime-sidebar", () => ({ PrimeSidebar: () => null }));
// This row tests routing and trust presentation; host/runtime behavior is covered by prime-sidebar.test.
vi.mock("./command-centre-connection", () => ({
  COMMAND_CENTRE_PLUGIN_ID: "orca-organization-next",
}));
vi.mock("@/stores/organization-intake-preferences-store", () => ({
  useOrganizationIntakePreferences: (select: (state: typeof f) => unknown) => select(f),
}));
vi.mock("./organization-navigation-model", () => ({
  globalIntakeRoute: () => "/intake?thread=test",
}));
import { selectCompanyTarget } from "./workspace-organization-model";
import { PluginSidebarItemRow } from "./sidebar-items";
import { groupPluginSidebarContributions } from "./sidebar-groups";
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  f.companyHost = null;
  f.hydrated = true;
  f.hydrationError = null;
});
it("F1.2 untrusted sidebar entry stays visible and opens the host-owned explanation route", () => {
  const [group] = groupPluginSidebarContributions(
    [],
    [
      {
        id: "orca-organization-next",
        serverId: "remote",
        untrusted: true,
        sidebarItems: [
          { id: "organization", title: "Command Centre", icon: "Network", surface: "organization" },
        ],
      },
    ],
  );
  render(<PluginSidebarItemRow group={group} />);
  expect(screen.getByText("Command Centre · Not trusted")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Open for update instructions/ }));
  expect(f.push).toHaveBeenCalledWith(
    "/h/remote/plugin/orca-organization-next/sidebar/organization",
  );
});

it("the saved company target is exact and never follows an execution host or missing source", () => {
  const mini = { plugin: { serverId: "mini" } },
    book = { plugin: { serverId: "book" } };
  expect(selectCompanyTarget([book, mini], "mini")).toBe(mini);
  expect(selectCompanyTarget([book], "mini")).toBeNull();
  expect(selectCompanyTarget([book, mini], null)).toBeNull();
  expect(selectCompanyTarget([mini], null)).toBe(mini);
});
it("an unavailable saved company opens recovery rather than another company's route", () => {
  f.companyHost = "mini";
  const [group] = groupPluginSidebarContributions(
    [],
    [
      {
        id: "orca-organization-next",
        serverId: "book",
        untrusted: true,
        sidebarItems: [
          { id: "organization", title: "Fulcra", icon: "Network", surface: "organization" },
        ],
      },
    ],
  );
  render(<PluginSidebarItemRow group={group} />);
  fireEvent.click(
    screen.getByRole("button", { name: "Review the saved company connection in Hosts" }),
  );
  expect(f.push).toHaveBeenCalledExactlyOnceWith("/settings");
});
it("company preference hydration errors and loading never choose a different company", () => {
  const [group] = groupPluginSidebarContributions(
    [],
    [
      {
        id: "orca-organization-next",
        serverId: "book",
        untrusted: true,
        sidebarItems: [
          { id: "organization", title: "Fulcra", icon: "Network", surface: "organization" },
        ],
      },
    ],
  );
  f.hydrated = false;
  const view = render(<PluginSidebarItemRow group={group} />);
  fireEvent.click(screen.getByRole("button", { name: "Reading saved company organisation" }));
  expect(f.push).not.toHaveBeenCalled();
  f.hydrated = true;
  f.hydrationError = "bad preference";
  view.rerender(<PluginSidebarItemRow group={group} />);
  fireEvent.click(
    screen.getByRole("button", { name: "Retry the saved company organisation preference" }),
  );
  expect(f.push).toHaveBeenCalledExactlyOnceWith("/intake?thread=test");
});
