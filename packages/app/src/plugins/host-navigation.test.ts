import { describe, expect, it } from "vitest";
<<<<<<< HEAD
import {
  changeViewRequestKey,
  useChangeViewRequests,
} from "@/architecture-map/change-view-request";
=======
import { buildHostAgentDetailRoute, buildHostWorkspaceRoute } from "@/utils/host-routes";
>>>>>>> refs/remotes/upstream/tags/v0.18.1
import { createPluginHostNavigation } from "./host-navigation-model";
import { useSidebarViewStore } from "../stores/sidebar-view-store";

describe("plugin host navigation", () => {
  function setup(electron = true) {
    const destinations: unknown[] = [];
    const browsers: string[] = [];
    const focusedHosts: string[] = [];
    const workspaces = new Set(["selected:one", "remote:two"]);
    const navigation = createPluginHostNavigation("selected", {
      browserAvailable: electron,
      isHostRegistered: (serverId: string) => serverId === "selected" || serverId === "remote",
      resolveWorkspace: ({ serverId, workspaceId }) =>
        workspaces.has(`${serverId}:${workspaceId}`) ? workspaceId : null,
      openAgent: (input) => {
        destinations.push(input);
        return buildHostAgentDetailRoute(input.serverId, input.agentId);
      },
      openWorkspace: (input) => {
        destinations.push(input);
        return buildHostWorkspaceRoute(input.serverId, input.workspaceId);
      },
      focusHost: (serverId) => {
        focusedHosts.push(serverId);
        useSidebarViewStore.getState().focusHost(serverId);
      },
      createBrowser: ({ initialUrl }) => {
        browsers.push(initialUrl);
        return { browserId: `browser-${browsers.length}` };
      },
    });
    return { navigation, destinations, browsers, workspaces, focusedHosts };
  }

  it("focuses the destination host and clears filters that could hide its workspace", () => {
    useSidebarViewStore.setState({
      groupMode: "status",
      hostFilters: ["selected", "other"],
      projectFilters: ["old-project"],
      labelFilter: { labels: ["urgent"] },
    });
    const { navigation, destinations, focusedHosts } = setup(false);
    navigation.openAgent({ serverId: "remote", agentId: "agent-2", focusHost: true });
    expect(focusedHosts).toEqual(["remote"]);
    expect(destinations).toEqual([{ serverId: "remote", agentId: "agent-2" }]);
    expect(useSidebarViewStore.getState()).toMatchObject({
      groupMode: "status",
      hostFilters: ["remote"],
      projectFilters: [],
      labelFilter: { labels: [] },
    });
  });

  it("creates and focuses a local browser in the selected or explicit host workspace", () => {
    const { navigation, destinations, browsers } = setup();
    navigation.openBrowser!({ url: "https://example.com/one", workspaceId: "one" });
    navigation.openBrowser!({
      url: "https://example.com/two",
      workspaceId: "two",
      serverId: "remote",
    });
    expect(browsers).toEqual(["https://example.com/one", "https://example.com/two"]);
    expect(destinations).toEqual([
      {
        serverId: "selected",
        workspaceId: "one",
        target: { kind: "browser", browserId: "browser-1" },
      },
      {
        serverId: "remote",
        workspaceId: "two",
        target: { kind: "browser", browserId: "browser-2" },
      },
    ]);
  });

<<<<<<< HEAD
  it("opens the main architecture map of a known workspace and refuses an unknown one", () => {
    const { navigation, destinations } = setup();
    navigation.openArchitectureMap!({ workspaceId: "two", serverId: "remote" });
    expect(destinations).toEqual([
      { serverId: "remote", workspaceId: "two", target: { kind: "architecture_map" } },
    ]);
    expect(() => navigation.openArchitectureMap!({ workspaceId: "missing" })).toThrow(
      "Workspace is unavailable",
    );
    expect(destinations).toHaveLength(1);
=======
  it("can return from a remote workspace to the installation host without toggling it off", () => {
    const { navigation, destinations, focusedHosts } = setup();
    navigation.openWorkspace({ serverId: "remote", workspaceId: "two", focusHost: true });
    navigation.openWorkspace({ workspaceId: "one", focusHost: true });
    navigation.openWorkspace({ workspaceId: "one", focusHost: true });
    expect(focusedHosts).toEqual(["remote", "selected", "selected"]);
    expect(destinations).toEqual([
      { serverId: "remote", workspaceId: "two" },
      { serverId: "selected", workspaceId: "one" },
      { serverId: "selected", workspaceId: "one" },
    ]);
    expect(useSidebarViewStore.getState().hostFilters).toEqual(["selected"]);
  });

  it("focuses the host in the returned route for padded host IDs", () => {
    const { navigation, destinations, focusedHosts } = setup();
    navigation.openAgent({ serverId: " remote ", agentId: "agent-2", focusHost: true });
    navigation.openWorkspace({ serverId: " selected ", workspaceId: "one", focusHost: true });

    expect(destinations).toEqual([
      { serverId: " remote ", agentId: "agent-2" },
      { serverId: " selected ", workspaceId: "one" },
    ]);
    expect(focusedHosts).toEqual(["remote", "selected"]);
    expect(useSidebarViewStore.getState().hostFilters).toEqual(["selected"]);
  });

  it("leaves existing sidebar filters alone unless explicitly requested", () => {
    useSidebarViewStore.setState({
      hostFilters: ["remote"],
      projectFilters: ["pinned-project"],
      labelFilter: { labels: ["urgent"] },
    });
    const { navigation, destinations, focusedHosts } = setup();
    navigation.openAgent({ agentId: "agent-1", serverId: " remote " });
    navigation.openWorkspace({ workspaceId: "one", serverId: " selected ", focusHost: false });
    expect(destinations).toEqual([
      { serverId: " remote ", agentId: "agent-1" },
      { serverId: " selected ", workspaceId: "one" },
    ]);
    expect(focusedHosts).toEqual([]);
    expect(useSidebarViewStore.getState()).toMatchObject({
      hostFilters: ["remote"],
      projectFilters: ["pinned-project"],
      labelFilter: { labels: ["urgent"] },
    });
    expect(navigation.supportsFocusHost).toBe(true);
  });

  it("preserves sidebar filters when the navigation route has no destination", () => {
    const filters = {
      hostFilters: ["selected"],
      projectFilters: ["pinned-project"],
      labelFilter: { labels: ["urgent"] },
    };
    useSidebarViewStore.setState(filters);
    const { navigation } = setup();
    navigation.openAgent({ serverId: "remote", agentId: " ", focusHost: true });
    navigation.openWorkspace({ serverId: "remote", workspaceId: "", focusHost: true });

    expect(useSidebarViewStore.getState()).toMatchObject(filters);
  });

  it("preserves sidebar filters when the destination host has been removed", () => {
    const filters = {
      hostFilters: ["selected"],
      projectFilters: ["pinned-project"],
      labelFilter: { labels: ["urgent"] },
    };
    useSidebarViewStore.setState(filters);
    const { navigation, destinations } = setup();
    navigation.openAgent({ serverId: "removed", agentId: "agent-2", focusHost: true });
    navigation.openWorkspace({ serverId: "removed", workspaceId: "two", focusHost: true });

    expect(useSidebarViewStore.getState()).toMatchObject(filters);
    expect(destinations).toEqual([
      { serverId: "removed", agentId: "agent-2" },
      { serverId: "removed", workspaceId: "two" },
    ]);
  });

  it("does not change the filter when navigation rejects the target", () => {
    const focusedHosts: string[] = [];
    const unavailable = () => {
      throw new Error("Target unavailable");
    };
    const navigation = createPluginHostNavigation("selected", {
      browserAvailable: false,
      isHostRegistered: () => true,
      resolveWorkspace: () => null,
      openAgent: unavailable,
      openWorkspace: unavailable,
      createBrowser: unavailable,
      focusHost: (serverId) => focusedHosts.push(serverId),
    });
    expect(() => navigation.openAgent({ agentId: "missing", focusHost: true })).toThrow(
      "Target unavailable",
    );
    expect(() => navigation.openWorkspace({ workspaceId: "missing", focusHost: true })).toThrow(
      "Target unavailable",
    );
    expect(focusedHosts).toEqual([]);
>>>>>>> refs/remotes/upstream/tags/v0.18.1
  });

  it("refuses unknown or removed workspaces before creating browser records", () => {
    const { navigation, destinations, browsers, workspaces } = setup();
    expect(() =>
      navigation.openBrowser!({ url: "https://example.com", workspaceId: "missing" }),
    ).toThrow("Workspace is unavailable");
    expect(() =>
      navigation.openBrowser!({
        url: "https://example.com",
        workspaceId: "one",
        serverId: "unknown",
      }),
    ).toThrow("Workspace is unavailable");
    workspaces.delete("selected:one");
    expect(() =>
      navigation.openBrowser!({ url: "https://example.com", workspaceId: "one" }),
    ).toThrow("Workspace is unavailable");
    expect(destinations).toEqual([]);
    expect(browsers).toEqual([]);
  });

  it("exposes no browser capability outside Electron and creates no tabs", () => {
    const { navigation, destinations, browsers } = setup(false);
    expect(navigation.openBrowser).toBeUndefined();
    expect(destinations).toEqual([]);
    expect(browsers).toEqual([]);
  });

  it.each(["javascript:alert(1)", "file:///tmp/file", "/relative", "invalid"])(
    "rejects %s before creating a browser",
    (url) => {
      const { navigation, browsers, destinations } = setup();
      expect(() => navigation.openBrowser!({ url, workspaceId: "one" })).toThrow("HTTP(S)");
      expect(browsers).toEqual([]);
      expect(destinations).toEqual([]);
    },
  );

  it("rejects an empty workspace before creating a browser", () => {
    const { navigation, browsers } = setup();
    expect(() => navigation.openBrowser!({ url: "https://example.com", workspaceId: "" })).toThrow(
      "workspaceId",
    );
    expect(browsers).toEqual([]);
  });
});

describe("architecture change navigation", () => {
  const destinations: unknown[] = [];
  const navigation = createPluginHostNavigation("local", {
    browserAvailable: false,
    openAgent() {},
    createBrowser: () => ({ browserId: "unused" }),
    openWorkspace: (input) => destinations.push(input),
    resolveWorkspace: ({ serverId, workspaceId }) =>
      serverId === "remote" && workspaceId === "alias" ? "canonical" : null,
  });
  it.each([{ pullRequest: 27 }, { commit: { base: "a".repeat(40), head: "b".repeat(40) } }])(
    "routes a selected change and keeps its identity",
    (selection) => {
      navigation.openArchitectureChange!({
        workspaceId: "alias",
        serverId: "remote",
        ...selection,
      });
      expect(destinations.at(-1)).toEqual({
        serverId: "remote",
        workspaceId: "canonical",
        target: { kind: "architecture_map" },
      });
      expect(
        useChangeViewRequests.getState().consume(changeViewRequestKey("remote", "canonical")),
      ).toEqual(selection);
      expect(
        useChangeViewRequests.getState().consume(changeViewRequestKey("remote", "canonical")),
      ).toBe(false);
    },
  );
  it.each([
    {},
    { pullRequest: 0 },
    { pullRequest: -1 },
    { pullRequest: 1.5 },
    { pullRequest: Infinity },
    { pullRequest: "27" },
    { commit: { base: "main", head: "a".repeat(40) } },
    { pullRequest: 27, commit: { base: "a".repeat(40), head: "b".repeat(40) } },
  ])("refuses invalid selectors before navigation", (selection) => {
    const before = destinations.length;
    expect(() =>
      navigation.openArchitectureChange!({
        workspaceId: "alias",
        serverId: "remote",
        ...selection,
      } as never),
    ).toThrow("Choose one pull request or two full commit SHAs.");
    expect(destinations).toHaveLength(before);
  });
  it("gives a plain message for an unknown workspace", () => {
    expect(() =>
      navigation.openArchitectureChange!({ workspaceId: "missing", pullRequest: 27 }),
    ).toThrow("Workspace is unavailable on the requested host.");
  });
});

import {
  createIntakeNavigation,
  globalIntakeRoute,
  newIntakeId,
} from "./organization-navigation-model";
describe("organization intake navigation", () => {
  it("reopens the same intake on its original company and keeps new requests distinct without creating placement", () => {
    const destinations: string[] = [],
      selected: string[] = [];
    let next = 0;
    const online = new Set(["book"]);
    const navigation = createIntakeNavigation("company", {
      push: (path) => destinations.push(path),
      newId: () => `new-${++next}`,
      chooseCompany: (id) => selected.push(id),
      projectRoute: (host, project) => `/settings/hosts/${host}/projects/${project}`,
      connection: (host) => ({ online: online.has(host), workspaceMultiplicity: host === "book" }),
    });
    navigation.openIntake("same-request", "AI Game Dev");
    navigation.openIntake("same-request", "AI Game Dev");
    navigation.newIntake();
    navigation.newIntake();
    expect(destinations).toEqual([
      "/intake?thread=same-request&controller=company&workspace=AI%20Game%20Dev",
      "/intake?thread=same-request&controller=company&workspace=AI%20Game%20Dev",
      "/intake?thread=new-1&controller=company",
      "/intake?thread=new-2&controller=company",
    ]);
    navigation.setDefaultCompanySource();
    expect(selected).toEqual(["company"]);
    expect(navigation.canReuseContext("book")).toBe(true);
    online.clear();
    expect(navigation.canReuseContext("book")).toBe(false);
    online.add("old-host");
    expect(navigation.canReuseContext("old-host")).toBe(false);
    navigation.openProject("book", "unchanged-project");
    navigation.createProject();
    expect(destinations.slice(-2)).toEqual([
      "/settings/hosts/book/projects/unchanged-project",
      "/open-project",
    ]);
  });
});

it("global New chat uses a persistent UUID without requiring a host/project/workspace route", () => {
  const first = globalIntakeRoute(),
    second = globalIntakeRoute();
  expect(first).toMatch(
    /^\/intake\?thread=[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i,
  );
  expect(second).not.toEqual(first);
  expect(newIntakeId()).toMatch(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i);
});
