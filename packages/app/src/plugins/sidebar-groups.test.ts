import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { InstalledPlugin } from "./types";
import { groupPluginSidebarContributions } from "./sidebar-groups";

function installed(serverId: string, contributionId = "main"): InstalledPlugin {
  return {
    id: "example",
    cleanup: () => undefined,
    serverId,
    clientBundle: serverId,
    lifetime: new AbortController(),
    queryClient: new QueryClient(),
    settingsScreens: [],
    surfaces: [{ id: "surface", Component: () => null }],
    sidebarItems: [
      {
        id: contributionId,
        title: "Example",
        icon: "Blocks",
        surface: "surface",
      },
    ],
    workspacePanels: [],
    commandCenterItems: [],
    clientSlashCommands: [],
    attachmentSources: [],
    themes: [],
    timelineTransformers: [],
    timelineRenderers: [],
  };
}

describe("groupPluginSidebarContributions", () => {
  it("coalesces the same plugin contribution across hosts", () => {
    const groups = groupPluginSidebarContributions([installed("host-a"), installed("host-b")]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.targets.map((target) => target.plugin.serverId)).toEqual([
      "host-a",
      "host-b",
    ]);
  });

  it("keeps different contribution ids separate", () => {
    const groups = groupPluginSidebarContributions([
      installed("host-a", "main"),
      installed("host-b", "settings"),
    ]);

    expect(groups.map((group) => group.key)).toEqual([
      "example/sidebar/main",
      "example/sidebar/settings",
    ]);
  });
});

import {
  organizationContextEntries,
  selectOrganizationSource,
  bindIntakeSource,
} from "./workspace-organization-model";
describe("company organization projection", () => {
  it("keeps the recorded company source through disconnect instead of using another available host", () => {
    const mini = { serverId: "mini" },
      book = { serverId: "book" };
    expect(selectOrganizationSource([mini, book], "book")).toEqual(book);
    expect(selectOrganizationSource([mini], "book")).toEqual(null);
    expect(selectOrganizationSource([mini, book], null)).toEqual(null);
    expect(selectOrganizationSource([book], null)).toEqual(book);
  });
  it("groups exact native project identities and leaves identically named remote contexts outside", () => {
    const selected = { workspaceKey: "book:original", serverId: "book", name: "main" };
    const foreign = { workspaceKey: "mini:original", serverId: "mini", name: "main" };
    const props = {
      projects: [
        {
          hosts: [
            { serverId: "book", projectId: "ship" },
            { serverId: "mini", projectId: "another-project" },
          ],
          workspaces: [selected, foreign],
        },
      ],
      entries: new Map([
        [selected.workspaceKey, selected],
        [foreign.workspaceKey, foreign],
      ]),
    };
    expect(
      organizationContextEntries({ placements: [{ serverId: "book", projectId: "ship" }] }, props),
    ).toEqual([selected]);
  });
  it("does not infer a project from an ambiguous native placement or conflicting workspace membership", () => {
    const entry = { workspaceKey: "book:original", serverId: "book" };
    const entries = new Map([[entry.workspaceKey, entry]]);
    const project = { placements: [{ serverId: "book", projectId: "ship" }] };
    expect(
      organizationContextEntries(project, {
        entries,
        projects: [
          {
            hosts: [
              { serverId: "book", projectId: "ship" },
              { serverId: "book", projectId: "demo" },
            ],
            workspaces: [entry],
          },
        ],
      }),
    ).toEqual([]);
    expect(
      organizationContextEntries(project, {
        entries,
        projects: ["ship", "demo"].map((projectId) => ({
          hosts: [{ serverId: "book", projectId }],
          workspaces: [entry],
        })),
      }),
    ).toEqual([]);
  });
  it("retains one request's original company source independently of future company preference", () => {
    const bound = bindIntakeSource({}, "request", "book");
    expect(bindIntakeSource(bound, "request", "book")).toBe(bound);
    expect(() => bindIntakeSource(bound, "request", "mini")).toThrow("original company intake");
    expect(bindIntakeSource(bound, "second-request", "mini")).toEqual({
      request: "book",
      "second-request": "mini",
    });
  });
});
