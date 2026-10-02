import { describe, expect, test } from "vitest";
import { createProjectViewKey } from "@/projects/workspace-structure";
import type { ProjectDescriptor, WorkspaceDescriptor } from "@/stores/session-store";
import { buildProjects, getProjectSummaryForHostProject } from "./projects";

function descriptor(
  id: string,
  key: string,
  root: string,
  iconRevision?: string,
): ProjectDescriptor {
  return {
    projectId: id,
    projectKey: key,
    projectDisplayName: "acme/app",
    projectCustomName: null,
    projectIconRevision: iconRevision,
    projectRootPath: root,
    projectKind: "git",
  };
}

function workspace(id: string, projectId: string, root: string): WorkspaceDescriptor {
  return {
    id,
    projectId,
    projectDisplayName: "acme/app",
    projectCustomName: null,
    projectRootPath: root,
    workspaceDirectory: root,
    projectKind: "git",
    workspaceKind: "local_checkout",
    name: "main",
    status: "done",
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    scripts: [],
  };
}

describe("buildProjects", () => {
  test("uses the grouped project list while retaining each host project id", () => {
    const key = "remote:github.com/acme/app";
    const result = buildProjects({
      hosts: [
        {
          serverId: "host-a",
          serverName: "Host A",
          isOnline: true,
          projects: [descriptor("prj_a", key, "/a/app", "revision-a")],
          workspaces: [workspace("ws-a", "prj_a", "/a/app")],
        },
        {
          serverId: "host-b",
          serverName: "Host B",
          isOnline: false,
          projects: [descriptor("prj_b", key, "/b/app", "revision-b")],
          workspaces: [workspace("ws-b", "prj_b", "/b/app")],
        },
      ],
    });

    expect(result.projects).toEqual([
      expect.objectContaining({
        viewKey: createProjectViewKey({ kind: "equivalence", projectKey: key }),
        hostCount: 2,
        onlineHostCount: 1,
        totalWorkspaceCount: 2,
        hosts: [
          expect.objectContaining({
            serverId: "host-a",
            projectId: "prj_a",
            iconRevision: "revision-a",
          }),
          expect.objectContaining({
            serverId: "host-b",
            projectId: "prj_b",
            iconRevision: "revision-b",
          }),
        ],
      }),
    ]);
  });

  test("includes a project with no workspaces", () => {
    const result = buildProjects({
      hosts: [
        {
          serverId: "host-a",
          serverName: "Host A",
          isOnline: true,
          projects: [descriptor("prj_a", "local-a", "/a/app")],
          workspaces: [],
        },
      ],
    });

    expect(result.projects[0]).toMatchObject({
      totalWorkspaceCount: 0,
      hosts: [{ projectId: "prj_a", repoRoot: "/a/app" }],
    });
  });

  test("a grouped project retains each host's own renamed display name", () => {
    const primary = descriptor("prj_a", "shared", "/a/app");
    primary.projectCustomName = "Primary-only name";
    const secondary = descriptor("prj_b", "shared", "/b/app");
    const result = buildProjects({
      hosts: [
        {
          serverId: "host-a",
          serverName: "Host A",
          isOnline: true,
          projects: [primary],
          workspaces: [],
        },
        {
          serverId: "host-b",
          serverName: "Host B",
          isOnline: true,
          projects: [secondary],
          workspaces: [],
        },
      ],
    });
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0]).toMatchObject({
      projectName: "Primary-only name",
      hosts: [
        { serverId: "host-a", projectId: "prj_a", projectName: "Primary-only name" },
        { serverId: "host-b", projectId: "prj_b", projectName: "acme/app" },
      ],
    });
    expect(secondary.projectCustomName).toBeNull();
  });

  test("keeps a new project's own root when it has not created a workspace", () => {
    const result = buildProjects({
      hosts: [
        {
          serverId: "host-a",
          serverName: "Host A",
          isOnline: true,
          projects: [descriptor("prj_a", "local-a", "/a/new-project")],
          workspaces: [],
        },
      ],
    });

    expect(result.projects[0]?.hosts[0]?.repoRoot).toBe("/a/new-project");
  });

  test("looks up a grouped project by host-local identity", () => {
    const project = buildProjects({
      hosts: [
        {
          serverId: "host-a",
          serverName: "Host A",
          isOnline: true,
          projects: [descriptor("prj_a", "shared", "/a/app")],
          workspaces: [],
        },
      ],
    }).projects[0];

    expect(getProjectSummaryForHostProject(project ? [project] : [], "host-a", "prj_a")).toBe(
      project,
    );
  });
});

describe("workspace change request number", () => {
  function summarize(overrides: Partial<WorkspaceDescriptor>) {
    const result = buildProjects({
      hosts: [
        {
          serverId: "host-a",
          serverName: "Host A",
          isOnline: true,
          projects: [descriptor("prj_a", "shared", "/a/app")],
          workspaces: [{ ...workspace("ws-a", "prj_a", "/a/app"), ...overrides }],
        },
      ],
    });
    return result.projects[0]?.hosts[0]?.workspaces[0]?.changeRequestNumber;
  }

  const pullRequest = {
    url: "https://github.com/acme/app/pull/42",
    title: "Refactor payments",
    state: "open",
    baseRefName: "main",
    headRefName: "feature/checkout",
    isMerged: false,
  };

  test("prefers the number the daemon sent over parsing the url", () => {
    expect(
      summarize({
        // The url says 999, the authoritative field says 42 — the field wins.
        githubRuntime: {
          pullRequest: { ...pullRequest, number: 42, url: "https://example.test/pull/999" },
        },
        forge: "github",
      }),
    ).toBe(42);
  });

  test("falls back to the url when the daemon omits the number", () => {
    expect(summarize({ githubRuntime: { pullRequest }, forge: "github" })).toBe(42);
  });

  test("parses a gitlab merge request url", () => {
    expect(
      summarize({
        githubRuntime: {
          pullRequest: { ...pullRequest, url: "https://gitlab.com/acme/app/-/merge_requests/7" },
        },
        forge: "gitlab",
      }),
    ).toBe(7);
  });

  test("resolves the number when an old daemon omits the forge", () => {
    expect(summarize({ githubRuntime: { pullRequest: { ...pullRequest, number: 42 } } })).toBe(42);
  });

  test("is null when the workspace has no pull request", () => {
    expect(summarize({})).toBeNull();
    expect(summarize({ githubRuntime: { pullRequest: null } })).toBeNull();
  });

  test("is null when the number is absent and the url is unparseable", () => {
    expect(
      summarize({
        githubRuntime: { pullRequest: { ...pullRequest, url: "not-a-url" } },
        forge: "github",
      }),
    ).toBeNull();
  });
});

test("search and project summaries show session titles or a friendly fallback for UUID folders", () => {
  const uuid = "00000000-0000-4000-8000-000000000001";
  const p: ProjectDescriptor = {
    ...descriptor("project", "", `/tasks/${uuid}`),
    projectDisplayName: uuid,
  };
  const w: WorkspaceDescriptor = {
    ...workspace("session", "project", `/tasks/${uuid}`),
    name: uuid,
  };
  const hosts = [
    { serverId: "fixture", serverName: "Fixture", isOnline: true, projects: [p], workspaces: [w] },
  ];
  const labels = new Map([
    ["fixture:session", { workspaceName: "Fixture research", projectName: "Fixture research" }],
  ]);
  const titled = buildProjects({ hosts, conversationLabels: labels }).projects[0]!;
  expect(titled.projectName).toBe("Fixture research");
  expect(titled.hosts[0]!.workspaces[0]!.name).toBe("Fixture research");
  const untitled = buildProjects({ hosts }).projects[0]!;
  expect(untitled.projectName).toBe("Untitled session");
  expect(untitled.hosts[0]!.workspaces[0]!.name).toBe("Untitled session");
  w.title = "Custom session";
  p.projectCustomName = "Custom project";
  const custom = buildProjects({ hosts, conversationLabels: labels }).projects[0]!;
  expect(custom.projectName).toBe("Custom project");
  expect(custom.hosts[0]!.workspaces[0]!.name).toBe("Custom session");
});
