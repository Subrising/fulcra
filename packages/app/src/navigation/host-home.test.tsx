import React from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveOrcaHomeAvailability } from "./host-runtime-bootstrap";

const state = vi.hoisted(() => ({
  selection: null as { serverId: string; workspaceId: string } | null,
  hydrated: true,
  // Orca home is a plugin surface, so the host entry can only send you there when the host
  // actually has that plugin. Installed by default here; the fresh-install case clears it.
  // Shaped like the real contribution lookup: a plugin is only Orca home when it actually
  // contributes the organization sidebar surface.
  organizationPlugin: {
    sidebarItems: [{ id: "organization", surface: "organization" }],
    surfaces: [{ id: "organization" }],
  } as object | null,
  connection: "online" as "idle" | "connecting" | "online" | "offline" | "error",
  // Null is the real cold-start value: connected, features not sent yet.
  pluginsSupported: true as boolean | null,
  catalogSettled: true,
  redirect: vi.fn((_props: { href: string }) => null),
}));
vi.mock("expo-router", () => ({ Redirect: state.redirect }));
vi.mock("@/navigation/host-route-context", () => ({ useHostRouteServerId: () => "book" }));
vi.mock("@/stores/navigation-active-workspace-store", () => ({
  useLastWorkspaceSelection: () => state.selection,
  useIsLastWorkspaceSelectionHydrated: () => state.hydrated,
}));
vi.mock("@/stores/session-store-hooks", () => ({
  useHasHydratedWorkspaces: () => false,
  useWorkspaceExists: () => false,
}));
vi.mock("@/screens/startup-splash-screen", () => ({ StartupSplashScreen: () => null }));
vi.mock("@/plugins/registry", () => ({
  useInstalledPlugin: () => state.organizationPlugin,
  useHostCatalogSettled: () => state.catalogSettled,
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeConnectionStatus: () => state.connection,
}));
vi.mock("@/runtime/host-features", () => ({
  useHostFeatureAvailability: () => state.pluginsSupported,
}));
import HostIndexRoute from "../app/h/[serverId]/index";

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  vi.stubGlobal("React", React);
  state.redirect.mockClear();
  state.selection = null;
  state.hydrated = true;
  state.organizationPlugin = {
    sidebarItems: [{ id: "organization", surface: "organization" }],
    surfaces: [{ id: "organization" }],
  };
  state.connection = "online";
  state.pluginsSupported = true;
  state.catalogSettled = true;
});

it("restores the saved Book conversation through the actual host entry component", () => {
  state.selection = { serverId: "book", workspaceId: "original" };
  renderToString(<HostIndexRoute />);
  expect(state.redirect.mock.calls[0]?.[0]).toEqual({ href: "/h/book/workspace/original" });
});

it("waits for saved selection hydration instead of losing the original conversation", () => {
  state.hydrated = false;
  renderToString(<HostIndexRoute />);
  expect(state.redirect).not.toHaveBeenCalled();
});

it("opens Orca home when no conversation is remembered", () => {
  renderToString(<HostIndexRoute />);
  expect(state.redirect.mock.calls[0]?.[0]).toEqual({
    href: "/h/book/plugin/orca-organization/sidebar/organization",
  });
});

it("opens the built-in project route when the host has no Orca home plugin", () => {
  state.organizationPlugin = null;
  renderToString(<HostIndexRoute />);
  expect(state.redirect.mock.calls[0]?.[0]).toEqual({ href: "/open-project" });
});

// The catalog lands after connect, and Redirect is permanent. Cold start must hold rather than
// throw a host that does have Orca home to the fallback.
it("waits through the cold-start catalog gap instead of redirecting", () => {
  state.organizationPlugin = null;
  state.catalogSettled = false;
  renderToString(<HostIndexRoute />);
  expect(state.redirect).not.toHaveBeenCalled();
});

it("opens Orca home once the delayed catalog arrives", () => {
  state.organizationPlugin = null;
  state.catalogSettled = false;
  renderToString(<HostIndexRoute />);
  expect(state.redirect).not.toHaveBeenCalled();

  state.organizationPlugin = {
    sidebarItems: [{ id: "organization", surface: "organization" }],
    surfaces: [{ id: "organization" }],
  };
  state.catalogSettled = true;
  renderToString(<HostIndexRoute />);
  expect(state.redirect.mock.calls[0]?.[0]).toEqual({
    href: "/h/book/plugin/orca-organization/sidebar/organization",
  });
});

it("does not wait forever on an offline host", () => {
  state.organizationPlugin = null;
  state.catalogSettled = false;
  state.connection = "offline";
  renderToString(<HostIndexRoute />);
  expect(state.redirect.mock.calls[0]?.[0]).toEqual({ href: "/open-project" });
});

it("does not wait forever on a host without plugin support", () => {
  state.organizationPlugin = null;
  state.catalogSettled = false;
  state.pluginsSupported = false;
  renderToString(<HostIndexRoute />);
  expect(state.redirect.mock.calls[0]?.[0]).toEqual({ href: "/open-project" });
});

// A host that has not sent its features has not said it lacks plugins. Reading that silence as
// "no plugins" is what sent a host with Orca home to the fallback, permanently.
it("waits while the host has not reported its features yet", () => {
  state.organizationPlugin = null;
  state.pluginsSupported = null;
  state.catalogSettled = true;
  renderToString(<HostIndexRoute />);
  expect(state.redirect).not.toHaveBeenCalled();
});

it("waits while the connection is still opening", () => {
  state.organizationPlugin = null;
  state.connection = "connecting";
  state.pluginsSupported = null;
  state.catalogSettled = true;
  renderToString(<HostIndexRoute />);
  expect(state.redirect).not.toHaveBeenCalled();
});

it("takes a remembered conversation without waiting on any of that", () => {
  state.selection = { serverId: "book", workspaceId: "original" };
  state.organizationPlugin = null;
  state.connection = "connecting";
  state.pluginsSupported = null;
  state.catalogSettled = false;
  renderToString(<HostIndexRoute />);
  expect(state.redirect.mock.calls[0]?.[0]).toEqual({ href: "/h/book/workspace/original" });
});

// The route arms this bound with a timer; this states what the bound decides. Waiting is only
// ever a pause, never a dead end, however silent the host is.
it("settles an unanswered host as absent once the startup bound passes", () => {
  const unanswered = {
    connection: "online" as const,
    pluginsSupported: null,
    catalogSettled: false,
    hasOrganizationSidebarSurface: false,
  };
  expect(resolveOrcaHomeAvailability(unanswered)).toBe("unknown");
  expect(resolveOrcaHomeAvailability({ ...unanswered, unknownSettledByBound: true })).toBe(
    "absent",
  );
  // A host that did answer keeps its answer when the bound passes.
  expect(
    resolveOrcaHomeAvailability({
      ...unanswered,
      hasOrganizationSidebarSurface: true,
      unknownSettledByBound: true,
    }),
  ).toBe("present");
});
