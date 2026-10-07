// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({
  status: "offline",
  pairingRequired: null as string | null,
  push: vi.fn(),
  removeHost: vi.fn(async () => undefined),
  confirm: true,
  local: false,
}));
vi.mock("expo-router", () => ({ router: { push: f.push } }));
vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => [
    { serverId: "srv_hostOne00001", label: "MacBook-Pro.local" },
    { serverId: "srv_hostTwo00002", label: "MacBook-Pro.local" },
  ],
  useHostMutations: () => ({ removeHost: f.removeHost }),
  useHostRuntimeSnapshot: () => ({
    connectionStatus: f.status,
    pairingRequired: f.pairingRequired,
  }),
}));
vi.mock("@/utils/confirm-dialog", () => ({ confirmDialog: async () => f.confirm }));
vi.mock("@/hooks/use-is-local-daemon", () => ({ useIsLocalDaemon: () => f.local }));
vi.mock("@/constants/layout", () => ({ useIsCompactFormFactor: () => false }));
vi.mock("@/constants/platform", () => ({ isNative: false }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("react-native", () => ({
  Text: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  View: ({ children, testID }: { children: React.ReactNode; testID?: string }) => (
    <div data-testid={testID}>{children}</div>
  ),
  Pressable: () => null,
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onPress }: { children: React.ReactNode; onPress: () => void }) => (
    <button type="button" onClick={onPress}>
      {children}
    </button>
  ),
}));
import { PinnedHostConnectionNotice } from "./pinned-section-header";
afterEach(cleanup);
beforeEach(() => {
  f.status = "offline";
  f.pairingRequired = null;
  f.push.mockReset();
  f.removeHost.mockClear();
  f.confirm = true;
  f.local = false;
});
const pins = [{ serverId: "srv_hostOne00001" }, { serverId: "srv_hostOne00001" }];
it("retains one plain notice per unavailable host and routes its exact identity", () => {
  render(<PinnedHostConnectionNotice workspaces={pins} />);
  expect(screen.getAllByText("MacBook-Pro.local isn't connected")).toHaveLength(1);
  expect(
    screen.getByText(
      "These pins are from the last time it was connected. They update when it reconnects.",
    ),
  ).toBeTruthy();
  expect(screen.queryByText(/srv_hostOne00001/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Review connection" }));
  expect(f.push).toHaveBeenCalledExactlyOnceWith("/settings/hosts/srv_hostOne00001");
});
it("same-named daemon hosts stay separate instead of merging equal workspace ids or adopting the local host", () => {
  render(<PinnedHostConnectionNotice workspaces={[...pins, { serverId: "srv_hostTwo00002" }]} />);
  expect(screen.getAllByRole("button", { name: "Review connection" })).toHaveLength(2);
  fireEvent.click(screen.getAllByRole("button", { name: "Review connection" })[1]);
  expect(f.push).toHaveBeenCalledExactlyOnceWith("/settings/hosts/srv_hostTwo00002");
});
it("pairing-required pins keep their cached rows and explain why current data cannot refresh", () => {
  f.pairingRequired = "pairing-upgraded";
  render(<PinnedHostConnectionNotice workspaces={pins} />);
  expect(
    screen.getByText("Pair it again to see its pinned chats and sessions as they are now."),
  ).toBeTruthy();
  expect(screen.queryByText(/last time it was connected/)).toBeNull();
});
it("the notice disappears when that exact host reconnects, without affecting the pins", () => {
  const view = render(<PinnedHostConnectionNotice workspaces={pins} />);
  f.status = "online";
  view.rerender(<PinnedHostConnectionNotice workspaces={pins} />);
  expect(screen.queryByRole("button", { name: "Review connection" })).toBeNull();
  expect(view.container.textContent).toBe("");
});
it("Remove asks first, then removes only that host; this computer's own host offers no Remove", async () => {
  render(<PinnedHostConnectionNotice workspaces={pins} />);
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  await vi.waitFor(() => expect(f.removeHost).toHaveBeenCalledExactlyOnceWith("srv_hostOne00001"));
  cleanup();
  f.confirm = false;
  f.removeHost.mockClear();
  render(<PinnedHostConnectionNotice workspaces={pins} />);
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(f.removeHost).not.toHaveBeenCalled();
  cleanup();
  f.local = true;
  render(<PinnedHostConnectionNotice workspaces={pins} />);
  expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
});
