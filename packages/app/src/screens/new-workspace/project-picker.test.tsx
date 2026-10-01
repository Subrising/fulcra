// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { HostProjectListItem } from "@/projects/host-projects";
import type { SidebarConversationLabel } from "@/hooks/sidebar-conversation-labels";
import { resolveProjectPickerLabel, useNewWorkspaceProjectPicker } from "./project-picker";

function project(input: {
  viewKey: string;
  projectKey: string | null;
  projectId: string;
  projectName: string;
}): HostProjectListItem {
  return {
    ...input,
    projectKind: "git",
    iconWorkingDir: `/work/${input.projectId}`,
    hosts: [
      {
        serverId: "host",
        projectId: input.projectId,
        iconWorkingDir: `/work/${input.projectId}`,
        worktreeSupport: "supported",
      },
    ],
    workspaceKeys: [],
  };
}

describe("useNewWorkspaceProjectPicker", () => {
  it("preserves a manual choice when the routed project hydrates", () => {
    const routePlacement = project({
      viewKey: '["host","route-local"]',
      projectKey: null,
      projectId: "route-local",
      projectName: "Route project",
    });
    const hydratedRouteProject = project({
      viewKey: "remote:github.com/acme/route",
      projectKey: "remote:github.com/acme/route",
      projectId: "route-local",
      projectName: "Route project",
    });
    const manualProject = project({
      viewKey: "remote:github.com/acme/manual",
      projectKey: "remote:github.com/acme/manual",
      projectId: "manual-local",
      projectName: "Manual project",
    });
    const { result, rerender } = renderHook(
      ({ routeProject, projects }) =>
        useNewWorkspaceProjectPicker({
          selectedServerId: "host",
          projects,
          routeProject,
          routeProjectContextViewKey: routePlacement.viewKey,
          lastActiveProject: null,
          allowAllProjects: true,
        }),
      {
        initialProps: {
          routeProject: routePlacement,
          projects: [routePlacement, manualProject],
        },
      },
    );

    const manualOption = result.current.projectPickerOptions.find(
      (option) => option.label === manualProject.projectName,
    );
    expect(manualOption).toBeDefined();
    act(() => result.current.handleSelectProjectOption(manualOption!.id));
    expect(result.current.selectedProject).toEqual(manualProject);

    rerender({
      routeProject: hydratedRouteProject,
      projects: [hydratedRouteProject, manualProject],
    });

    expect(result.current.selectedProject).toEqual(manualProject);
  });
});

// J6: the picker names a project the way the sidebar does, never by a raw id.
const CHAT_ID = "0a2a9b27-e6eb-4de9-bef1-2c1f6f1b0e7a";

function chatProject(input: {
  projectName: string;
  iconWorkingDir: string;
  workspaceKeys: string[];
}): HostProjectListItem {
  return {
    viewKey: JSON.stringify(["host", CHAT_ID]),
    projectKey: null,
    projectName: input.projectName,
    projectKind: "directory",
    iconWorkingDir: input.iconWorkingDir,
    hosts: [
      {
        serverId: "host",
        projectId: CHAT_ID,
        iconWorkingDir: input.iconWorkingDir,
        worktreeSupport: "unsupported",
      },
    ],
    workspaceKeys: input.workspaceKeys,
  };
}

function labels(
  entries: Record<string, string | null>,
): ReadonlyMap<string, SidebarConversationLabel> {
  return new Map(
    Object.entries(entries).map(([key, projectName]) => [
      key,
      { workspaceName: null, projectName },
    ]),
  );
}

describe("J6: resolveProjectPickerLabel", () => {
  it("keeps a project's own display name", () => {
    const named = chatProject({
      projectName: "Fulcra product",
      iconWorkingDir: `/work/${CHAT_ID}`,
      workspaceKeys: ["host:ws1"],
    });
    expect(resolveProjectPickerLabel(named, labels({ "host:ws1": "Some title" }))).toBe(
      "Fulcra product",
    );
  });

  it("shows the conversation title for a project named by a generated id, as the sidebar does", () => {
    const chat = chatProject({
      projectName: CHAT_ID,
      iconWorkingDir: `/tasks/${CHAT_ID}`,
      workspaceKeys: ["host:ws1"],
    });
    expect(
      resolveProjectPickerLabel(chat, labels({ "host:ws1": "Orca phone interface acceptance" })),
    ).toBe("Orca phone interface acceptance");
  });

  it("names a generated-id project with several conversations like the sidebar does", () => {
    const chat = chatProject({
      projectName: CHAT_ID,
      iconWorkingDir: `/tasks/${CHAT_ID}`,
      workspaceKeys: ["host:ws1", "host:ws2"],
    });
    expect(resolveProjectPickerLabel(chat, labels({ "host:ws1": "One", "host:ws2": "Two" }))).toBe(
      "Saved conversations",
    );
  });

  it("falls back to the folder name when there is no title", () => {
    const chat = chatProject({
      projectName: CHAT_ID,
      iconWorkingDir: "/Users/me/notes",
      workspaceKeys: ["host:ws1"],
    });
    expect(resolveProjectPickerLabel(chat, new Map())).toBe("notes");
  });

  it("never shows the project id itself, even when it is not a UUID", () => {
    const routeOnly: HostProjectListItem = {
      ...chatProject({ projectName: "proj-7", iconWorkingDir: "/w/proj-7", workspaceKeys: [] }),
      hosts: [
        {
          serverId: "host",
          projectId: "proj-7",
          iconWorkingDir: "/w/proj-7",
          worktreeSupport: "unknown",
        },
      ],
    };
    expect(resolveProjectPickerLabel(routeOnly, new Map())).toBe("Untitled project");
  });

  it("uses the same name for the options and the trigger", () => {
    const chat = chatProject({
      projectName: CHAT_ID,
      iconWorkingDir: `/tasks/${CHAT_ID}`,
      workspaceKeys: ["host:ws1"],
    });
    const { result } = renderHook(() =>
      useNewWorkspaceProjectPicker({
        selectedServerId: "host",
        projects: [chat],
        routeProject: null,
        routeProjectContextViewKey: null,
        lastActiveProject: chat,
        allowAllProjects: true,
        conversationLabels: labels({ "host:ws1": "Orca phone interface acceptance" }),
      }),
    );
    expect(result.current.projectPickerOptions.map((option) => option.label)).toEqual([
      "Orca phone interface acceptance",
    ]);
    expect(result.current.projectTriggerLabel).toBe("Orca phone interface acceptance");
  });
});

it("keeps an explicit UUID-shaped project title", () => {
  const named = {
    ...chatProject({
      projectName: CHAT_ID,
      iconWorkingDir: `/tasks/${CHAT_ID}`,
      workspaceKeys: ["host:ws1"],
    }),
    projectCustomName: CHAT_ID,
  };
  expect(resolveProjectPickerLabel(named, labels({ "host:ws1": "Fixture research" }))).toBe(
    CHAT_ID,
  );
});
