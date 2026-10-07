// @vitest-environment jsdom
import React from "react";
import { render, fireEvent, screen, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({
  push: vi.fn(),
  companyHost: null as string | null,
  hydrated: true,
  hydrationError: null as string | null,
  mainAssistantHosts: null as Set<string> | null,
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => [
    { serverId: "book", label: "MacBook Pro" },
    { serverId: "mini", label: "Mac mini" },
  ],
}));
vi.mock("./home-computer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./home-computer")>()),
  useMainAssistantHosts: (_ids: string[], enabled: boolean) =>
    enabled ? f.mainAssistantHosts : new Set<string>(),
}));
vi.mock("expo-router", () => ({ router: { push: f.push }, usePathname: () => "/h/remote" }));
vi.mock("./icons", () => ({ Icon: () => null, resolvePluginIcon: () => () => null }));
vi.mock("./contribution-host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./contribution-host")>()),
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
  isCommandCentrePlugin: (id: string) => id === "orca-organization-next",
}));
vi.mock("@/stores/organization-intake-preferences-store", () => ({
  useOrganizationIntakePreferences: (select: (state: typeof f) => unknown) => select(f),
}));
vi.mock("./organization-navigation-model", () => ({
  globalIntakeRoute: () => "/intake?thread=test",
}));
import { selectCompanyTarget } from "./workspace-organization-model";
import { CompanyPluginSidebarRow } from "./sidebar-items/company";
import { groupPluginSidebarContributions } from "./sidebar-groups";
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  f.companyHost = null;
  f.hydrated = true;
  f.hydrationError = null;
  f.mainAssistantHosts = null;
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
  render(<CompanyPluginSidebarRow group={group} />);
  expect(screen.getByText("Update Fulcra on your other computer")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Open for update steps/ }));
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
  render(<CompanyPluginSidebarRow group={group} />);
  fireEvent.click(
    screen.getByRole("button", {
      name: "Mac mini runs your main assistant but isn't connected. Review in Settings.",
    }),
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
  const view = render(<CompanyPluginSidebarRow group={group} />);
  fireEvent.click(screen.getByRole("button", { name: "Reading your saved choice" }));
  expect(f.push).not.toHaveBeenCalled();
  f.hydrated = true;
  f.hydrationError = "bad preference";
  view.rerender(<CompanyPluginSidebarRow group={group} />);
  fireEvent.click(
    screen.getByRole("button", { name: "Retry reading which computer runs your main assistant" }),
  );
  expect(f.push).toHaveBeenCalledExactlyOnceWith("/intake?thread=test");
});

it("with two computers, the one running the main assistant is home; otherwise it asks plainly", () => {
  const sidebarItems = [
    { id: "organization", title: "Fulcra", icon: "Network", surface: "organization" },
  ];
  const plugin = (serverId: string) =>
    ({
      id: "orca-organization-next",
      serverId,
      legacySidebarItems: sidebarItems,
      sidebarItems: { header: [], footer: [] },
    }) as never;
  const [group] = groupPluginSidebarContributions([plugin("mini"), plugin("book")]);
  const view = render(<CompanyPluginSidebarRow group={group} />);
  expect(screen.getByText("Finding your main assistant…")).toBeTruthy();
  f.mainAssistantHosts = new Set(["book"]);
  view.rerender(<CompanyPluginSidebarRow group={group} />);
  fireEvent.click(screen.getByRole("button", { name: "Fulcra" }));
  expect(f.push).toHaveBeenCalledExactlyOnceWith(
    "/h/book/plugin/orca-organization-next/sidebar/organization",
  );
  f.mainAssistantHosts = new Set();
  view.rerender(<CompanyPluginSidebarRow group={group} />);
  fireEvent.click(
    screen.getByRole("button", { name: "Choose which computer runs your main assistant" }),
  );
  expect(f.push).toHaveBeenLastCalledWith("/intake?thread=test");
});
