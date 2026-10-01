// @vitest-environment jsdom
import React from "react";
import { render, fireEvent, screen, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ push: vi.fn() }));
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
import { PluginSidebarItemRow } from "./sidebar-items";
import { groupPluginSidebarContributions } from "./sidebar-groups";
afterEach(cleanup);
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
