import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { page } from "vitest/browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HostRepairBanner, HostRepairBoundary } from "./host-repair-banner";
import type { HostProfile } from "@/types/host-connection";
import { defaultHostAppearance } from "@/hosts/appearance";

const fixture = vi.hoisted(() => ({
  reason: null as string | null,
  hosts: [] as unknown[],
  removeHost: null as unknown as (serverId: string) => Promise<void>,
  replaceHost: null as unknown as (older: string, newer: string) => Promise<void>,
  online: new Set<string>(),
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => fixture.hosts,
  useHostMutations: () => ({ removeHost: fixture.removeHost, replaceHost: fixture.replaceHost }),
  useHostRuntimeConnectionStatuses: (ids: readonly string[]) =>
    new Map(ids.map((id) => [id, fixture.online.has(id) ? "online" : "offline"])),
  useHostRuntimeSnapshot: () => ({ pairingRequired: fixture.reason }),
  storedHostPairingReason: () => null,
}));
// The real banner owns the interaction; the existing modal is represented by its public contract.
vi.mock("@/components/pair-link-modal", () => ({
  PairLinkModal: ({
    visible,
    repairHost,
    onSaved,
  }: {
    visible: boolean;
    repairHost?: HostProfile;
    onSaved?: () => void;
  }) =>
    visible ? (
      <button type="button" onClick={onSaved}>
        Pairing flow for {repairHost?.label}
      </button>
    ) : null,
}));
// L41: the confirm sheet and i18n by their public contract (title, message, children).
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: { name?: string }) => (values?.name ? `${key}: ${values.name}` : key),
  }),
}));
vi.mock("@/components/adaptive-modal-sheet", () => ({
  AdaptiveModalSheet: ({
    header,
    children,
    testID,
  }: {
    header: { title: string };
    children: ReactNode;
    testID?: string;
  }) => (
    <div role="dialog" data-testid={testID} aria-label={header.title}>
      {children}
    </div>
  ),
}));
const host: HostProfile = {
  serverId: "srv_never_display",
  label: "Studio Mac",
  appearance: defaultHostAppearance(),
  lifecycle: {},
  connections: [],
  preferredConnectionId: null,
  createdAt: "",
  updatedAt: "",
};
const unnamedHost = { ...host, label: host.serverId };
let root: Root | undefined;
let container: HTMLDivElement;

function render(children: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(children));
  return { rerender: (next: ReactNode) => act(() => root!.render(next)) };
}

// The default browser project uses the classic JSX runtime for app sources (as in the pairing fixture).
beforeEach(() => {
  vi.stubGlobal("React", React);
  fixture.removeHost = vi.fn(async () => undefined);
  fixture.replaceHost = vi.fn(async () => undefined);
  fixture.online = new Set();
});
afterEach(() => {
  vi.unstubAllGlobals();
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  fixture.reason = null;
  fixture.hosts = [];
});

it.each(["pairing-upgraded", "device-removed"] as const)(
  "shows named-host %s explanation and opens pairing with one button",
  async (reason) => {
    render(<HostRepairBanner host={host} reason={reason} />);
    expect(container.textContent).toContain("Pair Studio Mac again");
    expect(container.textContent).not.toContain("srv_never_display");
    expect(container.textContent).toContain(
      reason === "device-removed"
        ? "This device was removed from Studio Mac. Pair again to reconnect."
        : "Fulcra's pairing got safer, so devices paired with Studio Mac before this update need a new pairing code.",
    );
    await page.getByRole("button", { name: "Pair again", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "Pairing flow for Studio Mac", exact: true }))
      .toBeVisible();
    await page.getByRole("button", { name: "Pairing flow for Studio Mac", exact: true }).click();
    expect(container.textContent).not.toContain("Pairing flow for Studio Mac");
  },
);

it("uses a plain fallback rather than exposing an id when the old record has no name", () => {
  render(<HostRepairBanner host={unnamedHost} reason="pairing-upgraded" />);
  expect(container.textContent).toContain("Pair this host again");
  expect(container.textContent).not.toContain("srv_never_display");
});

it("replaces the blocked host screen and restores it after pairing", () => {
  fixture.hosts = [host];
  fixture.reason = "device-removed";
  const view = render(
    <HostRepairBoundary serverId={host.serverId}>
      <div>Host workspace</div>
    </HostRepairBoundary>,
  );
  expect(container.textContent).not.toContain("Host workspace");
  fixture.reason = null;
  view.rerender(
    <HostRepairBoundary serverId={host.serverId}>
      <div>Host workspace</div>
    </HostRepairBoundary>,
  );
  expect(container.textContent).toContain("Host workspace");
});

// L41: the gate hides the host page's Remove host card, so a host that will never be paired again (an old Mac)
// is removable from the gate itself, behind the same confirmation, through the same removeHost.
it("removes a host from the Pair-again gate after the same confirmation", async () => {
  render(<HostRepairBanner host={host} reason="device-removed" />);
  expect(container.querySelector('[data-testid="remove-host-confirm-modal"]')).toBeNull();
  await page.getByRole("button", { name: "Remove this host", exact: true }).click();
  await expect.element(page.getByTestId("remove-host-confirm-modal")).toBeVisible();
  expect(container.textContent).toContain("settings.host.daemon.remove.confirmMessage: Studio Mac");
  expect(fixture.removeHost).not.toHaveBeenCalled();
  await page.getByTestId("remove-host-confirm").click();
  await vi.waitFor(() => expect(fixture.removeHost).toHaveBeenCalledWith("srv_never_display"));
  expect(fixture.removeHost).toHaveBeenCalledTimes(1);
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="remove-host-confirm-modal"]')).toBeNull(),
  );
});

it("cancelling the removal leaves the host alone", async () => {
  render(<HostRepairBanner host={host} reason="pairing-upgraded" />);
  await page.getByRole("button", { name: "Remove this host", exact: true }).click();
  await page.getByRole("button", { name: "common.actions.cancel", exact: true }).click();
  expect(container.querySelector('[data-testid="remove-host-confirm-modal"]')).toBeNull();
  expect(fixture.removeHost).not.toHaveBeenCalled();
});

// David's case: the MacBook came back with a new server id, so "MacBook-Pro.local" is offline beside an online
// "MacBook-Pro.local 2". The old host's gate offers to replace it; "Keep both" hides the offer.
it("offers to replace the old host with the newer same-name host that is online", async () => {
  const fresh = { ...host, serverId: "srv_newer", label: "Studio Mac 2" };
  fixture.hosts = [host, fresh];
  fixture.online = new Set(["srv_newer"]);
  render(<HostRepairBanner host={host} reason="device-removed" />);
  expect(container.textContent).toContain("Studio Mac was paired again");
  await page.getByTestId("host-replace-old").click();
  await vi.waitFor(() =>
    expect(fixture.replaceHost).toHaveBeenCalledWith("srv_never_display", "srv_newer"),
  );
  expect(fixture.removeHost).not.toHaveBeenCalled();
});

it("keeps both when asked, and offers nothing when the names differ", async () => {
  const fresh = { ...host, serverId: "srv_newer_2", label: "Studio Mac-2" };
  fixture.hosts = [host, fresh];
  fixture.online = new Set(["srv_newer_2"]);
  render(<HostRepairBanner host={host} reason="device-removed" />);
  await page.getByTestId("host-replace-keep-both").click();
  expect(container.querySelector('[data-testid="host-replace-card"]')).toBeNull();
  expect(fixture.replaceHost).not.toHaveBeenCalled();
  act(() => root?.unmount());
  fixture.hosts = [host, { ...host, serverId: "srv_other", label: "Office iMac" }];
  fixture.online = new Set(["srv_other"]);
  render(<HostRepairBanner host={host} reason="device-removed" />);
  expect(container.querySelector('[data-testid="host-replace-card"]')).toBeNull();
});
