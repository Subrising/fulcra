// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ status: "offline", pairingRequired: null as string | null, push: vi.fn() }));
vi.mock("expo-router", () => ({ router: { push: f.push } }));
vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => [{ serverId: "srv_iixMAQ25WLEs", label: "MacBook-Pro.local" }, { serverId: "srv_rZHPKXRko4Gq", label: "MacBook-Pro.local" }],
  useHostRuntimeSnapshot: () => ({ connectionStatus: f.status, pairingRequired: f.pairingRequired }),
}));
vi.mock("@/constants/layout", () => ({ useIsCompactFormFactor: () => false }));
vi.mock("@/constants/platform", () => ({ isNative: false }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("react-native", () => ({ Text: ({ children }: { children: React.ReactNode }) => <span>{children}</span>, View: ({ children, testID }: { children: React.ReactNode; testID?: string }) => <div data-testid={testID}>{children}</div>, Pressable: () => null }));
vi.mock("@/components/ui/button", () => ({ Button: ({ children, onPress }: { children: React.ReactNode; onPress: () => void }) => <button type="button" onClick={onPress}>{children}</button> }));
import { PinnedHostConnectionNotice } from "./pinned-section-header";
afterEach(cleanup);
beforeEach(() => { f.status = "offline"; f.pairingRequired = null; f.push.mockReset(); });
const pins = [{ serverId: "srv_iixMAQ25WLEs" }, { serverId: "srv_iixMAQ25WLEs" }];
it("retains one actionable cached-pin explanation per unavailable host and routes its exact identity", () => {
  render(<PinnedHostConnectionNotice workspaces={pins} />);
  expect(screen.getAllByText("MacBook-Pro.local · Cached pins")).toHaveLength(1);
  expect(screen.getByText("This host is disconnected. Current sessions and running status are unavailable.")).toBeTruthy();
  expect(screen.getByText("Host identity: srv_iixMAQ25WLEs")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Review host connection" }));
  expect(f.push).toHaveBeenCalledExactlyOnceWith("/settings/hosts/srv_iixMAQ25WLEs");
});
it("same-named daemon hosts stay separate instead of merging equal workspace ids or adopting the local host", () => {
  render(<PinnedHostConnectionNotice workspaces={[...pins, { serverId: "srv_rZHPKXRko4Gq" }]} />);
  expect(screen.getAllByRole("button", { name: "Review host connection" })).toHaveLength(2);
  fireEvent.click(screen.getAllByRole("button", { name: "Review host connection" })[1]);
  expect(f.push).toHaveBeenCalledExactlyOnceWith("/settings/hosts/srv_rZHPKXRko4Gq");
});
it("pairing-required pins keep their cached rows and explain why current data cannot refresh", () => {
  f.pairingRequired = "pairing-upgraded"; render(<PinnedHostConnectionNotice workspaces={pins} />);
  expect(screen.getByText("Pair again to refresh this host’s pins and sessions.")).toBeTruthy();
  expect(screen.queryByText("This host is disconnected. Current sessions and running status are unavailable.")).toBeNull();
});
it("the notice disappears when that exact host reconnects, without affecting the pins", () => {
  const view = render(<PinnedHostConnectionNotice workspaces={pins} />);
  f.status = "online"; view.rerender(<PinnedHostConnectionNotice workspaces={pins} />);
  expect(screen.queryByRole("button", { name: "Review host connection" })).toBeNull(); expect(view.container.textContent).toBe("");
});
