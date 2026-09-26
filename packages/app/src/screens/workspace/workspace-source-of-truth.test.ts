import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;
});

import {
  resolveWorkspaceHeader,
  resolveWorkspaceHeaderRenderState,
  shouldRenderMissingWorkspaceDescriptor,
} from "./workspace-header-source";
import { createSidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { selectSidebarConversationLabels } from "@/hooks/sidebar-conversation-labels";

function createWorkspaceDescriptor(input: Partial<WorkspaceDescriptor> = {}): WorkspaceDescriptor {
  return {
    id: "/repo/main",
    projectId: "remote:github.com/getpaseo/paseo",
    projectDisplayName: "getpaseo/paseo",
    projectRootPath: "/repo/main",
    workspaceDirectory: "/repo/main",
    projectKind: "git",
    workspaceKind: "local_checkout",
    name: "feat/workspace-sot",
    status: "running",
    diffStat: null,
    scripts: [],
    statusEnteredAt: null,
    ...input,
    archivingAt: input.archivingAt ?? null,
  };
}

describe("workspace source of truth consumption", () => {
  const generatedName = "123e4567-e89b-42d3-a456-426614174000";
  function headerWithObservedConversation(
    workspace: WorkspaceDescriptor,
    agentServerId = "srv",
    agentWorkspaceId = workspace.id,
    title: string | null = "Team leadership",
  ) {
    const conversation = {
      id: "leader",
      serverId: agentServerId,
      workspaceId: agentWorkspaceId,
      title,
      createdAt: new Date(1000),
      archivedAt: null,
      parentAgentId: null,
    };
    const labels = selectSidebarConversationLabels(
      {
        srv: {
          agents: new Map([[conversation.id, conversation]]),
          workspaces: new Map([[workspace.id, workspace]]),
        },
      },
      ["srv"],
    );
    return resolveWorkspaceHeaderRenderState({
      workspace,
      checkoutState: { kind: "pending" },
      conversationLabel: labels.get(`srv:${workspace.id}`),
    });
  }

  it("uses the sidebar conversation label for generated non-git header names", () => {
    const workspace = createWorkspaceDescriptor({
      projectKind: "non_git",
      name: generatedName,
      projectDisplayName: generatedName,
    });
    const before = structuredClone(workspace);
    expect(headerWithObservedConversation(workspace)).toMatchObject({
      kind: "ready",
      title: "Team leadership",
      subtitle: "Team leadership",
      isSubtitleDistinct: false,
    });
    expect(workspace).toEqual(before);
  });

  it.each([
    { projectKind: "git" as const, name: generatedName, projectDisplayName: generatedName },
    { projectKind: "non_git" as const, name: "Research", projectDisplayName: "Research hub" },
    {
      projectKind: "non_git" as const,
      name: "My workspace",
      title: "My workspace",
      projectDisplayName: "My project",
      projectCustomName: "My project",
    },
  ])("keeps saved and git identity in header: $name", (input) => {
    const workspace = createWorkspaceDescriptor(input);
    expect(headerWithObservedConversation(workspace)).toMatchObject({
      title: workspace.name,
      subtitle: workspace.projectDisplayName,
    });
  });

  it.each([
    { host: "other-host", workspaceId: "/repo/main", title: "Foreign conversation" },
    { host: "srv", workspaceId: "/other-workspace", title: "Other workspace" },
    { host: "srv", workspaceId: "/repo/main", title: null },
  ])(
    "does not borrow missing or foreign conversation metadata: $host $workspaceId",
    ({ host, workspaceId, title }) => {
      const workspace = createWorkspaceDescriptor({
        projectKind: "non_git",
        name: generatedName,
        projectDisplayName: generatedName,
      });
      expect(headerWithObservedConversation(workspace, host, workspaceId, title)).toMatchObject({
        title: generatedName,
        subtitle: generatedName,
      });
    },
  );

  it("uses the same descriptor name in header and sidebar row", () => {
    const workspace = createWorkspaceDescriptor();

    const header = resolveWorkspaceHeader({ workspace });
    const sidebarWorkspace = createSidebarWorkspaceEntry({
      serverId: "srv",
      workspace,
    });

    expect(header.title).toBe("feat/workspace-sot");
    expect(header.subtitle).toBe("getpaseo/paseo");
    expect(sidebarWorkspace.name).toBe(header.title);
    expect(sidebarWorkspace.statusBucket).toBe("running");
  });

  it("maps the sidebar entry branch from gitRuntime.currentBranch", () => {
    const entry = createSidebarWorkspaceEntry({
      serverId: "srv",
      workspace: createWorkspaceDescriptor({
        name: "feat/workspace-sot",
        gitRuntime: {
          currentBranch: "feat/real-branch",
          isDirty: false,
          aheadOfOrigin: 0,
        },
      }),
    });

    expect(entry.currentBranch).toBe("feat/real-branch");
  });

  it("normalizes detached HEAD, blank, and missing branches to null", () => {
    const detached = createSidebarWorkspaceEntry({
      serverId: "srv",
      workspace: createWorkspaceDescriptor({
        gitRuntime: { currentBranch: "HEAD", isDirty: false, aheadOfOrigin: 0 },
      }),
    });
    const blank = createSidebarWorkspaceEntry({
      serverId: "srv",
      workspace: createWorkspaceDescriptor({
        gitRuntime: { currentBranch: "  ", isDirty: false, aheadOfOrigin: 0 },
      }),
    });
    const missing = createSidebarWorkspaceEntry({
      serverId: "srv",
      workspace: createWorkspaceDescriptor(),
    });

    expect(detached.currentBranch).toBeNull();
    expect(blank.currentBranch).toBeNull();
    expect(missing.currentBranch).toBeNull();
  });

  it("keeps the header skeleton while the workspace descriptor is missing", () => {
    expect(
      resolveWorkspaceHeaderRenderState({
        workspace: null,
        checkoutState: { kind: "pending" },
      }),
    ).toEqual({ kind: "skeleton" });
  });

  it("keeps cached git workspace identity visible while checkout status refreshes", () => {
    expect(
      resolveWorkspaceHeaderRenderState({
        workspace: createWorkspaceDescriptor({ projectKind: "git" }),
        checkoutState: { kind: "pending" },
      }),
    ).toEqual({
      kind: "ready",
      title: "feat/workspace-sot",
      subtitle: "getpaseo/paseo",
      isSubtitleDistinct: true,
      isGitCheckout: false,
      currentBranchName: null,
    });
  });

  it("renders known non-git workspace identity while checkout status is pending", () => {
    expect(
      resolveWorkspaceHeaderRenderState({
        workspace: createWorkspaceDescriptor({
          projectKind: "non_git",
          workspaceKind: "directory",
          name: "notes",
          projectDisplayName: "Local folders",
        }),
        checkoutState: { kind: "pending" },
      }),
    ).toEqual({
      kind: "ready",
      title: "notes",
      subtitle: "Local folders",
      isSubtitleDistinct: true,
      isGitCheckout: false,
      currentBranchName: null,
    });
  });

  it("renders git checkout headers with branch affordance after checkout status resolves", () => {
    expect(
      resolveWorkspaceHeaderRenderState({
        workspace: createWorkspaceDescriptor(),
        checkoutState: {
          kind: "ready",
          checkout: { isGit: true, currentBranch: "feat/workspace-sot" },
        },
      }),
    ).toEqual({
      kind: "ready",
      title: "feat/workspace-sot",
      subtitle: "getpaseo/paseo",
      isSubtitleDistinct: true,
      isGitCheckout: true,
      currentBranchName: "feat/workspace-sot",
    });
  });

  it("renders non-git checkout headers without branch affordance after checkout status resolves", () => {
    expect(
      resolveWorkspaceHeaderRenderState({
        workspace: createWorkspaceDescriptor({
          projectKind: "non_git",
          workspaceKind: "directory",
          name: "notes",
          projectDisplayName: "notes",
        }),
        checkoutState: {
          kind: "ready",
          checkout: { isGit: false, currentBranch: null },
        },
      }),
    ).toEqual({
      kind: "ready",
      title: "notes",
      subtitle: "notes",
      isSubtitleDistinct: false,
      isGitCheckout: false,
      currentBranchName: null,
    });
  });

  it("renders descriptor identity after checkout status errors", () => {
    expect(
      resolveWorkspaceHeaderRenderState({
        workspace: createWorkspaceDescriptor(),
        checkoutState: { kind: "error" },
      }),
    ).toEqual({
      kind: "ready",
      title: "feat/workspace-sot",
      subtitle: "getpaseo/paseo",
      isSubtitleDistinct: true,
      isGitCheckout: false,
      currentBranchName: null,
    });
  });

  it("renders explicit missing state only after workspace hydration", () => {
    expect(
      shouldRenderMissingWorkspaceDescriptor({
        workspace: null,
        hasHydratedWorkspaces: true,
      }),
    ).toBe(true);

    expect(
      shouldRenderMissingWorkspaceDescriptor({
        workspace: null,
        hasHydratedWorkspaces: false,
      }),
    ).toBe(false);
  });
});
