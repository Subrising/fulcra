import { expect, it } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { WorkspaceDescriptorPayload } from "@getpaseo/protocol/messages";
import {
  normalizeProjectDescriptor,
  normalizeWorkspaceDescriptor,
  useSessionStore,
} from "@/stores/session-store";
import {
  clearWorkspaceArchivePending,
  markWorkspaceArchivePending,
} from "@/contexts/session-workspace-upserts";
import { useWorkspaceSetupStore } from "@/stores/workspace-setup-store";
import { WorkspaceDirectoryReplica } from "./workspace-replica";

function workspace(id: string, projectId = "project"): WorkspaceDescriptorPayload {
  return {
    id,
    projectId,
    projectDisplayName: projectId,
    projectRootPath: `/repo/${projectId}`,
    workspaceDirectory: `/repo/${projectId}/${id}`,
    projectKind: "git",
    workspaceKind: "worktree",
    name: id,
    title: id,
    status: "done",
    activityAt: null,
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    scripts: [],
  };
}

it("commits workspace and project-parent state with filtered removals", () => {
  const serverId = "workspace-replica";
  const store = useSessionStore.getState();
  store.initializeSession(serverId, null as unknown as DaemonClient);
  const replica = new WorkspaceDirectoryReplica(serverId);
  const empty = normalizeProjectDescriptor({
    projectId: "empty",
    projectDisplayName: "Empty",
    projectRootPath: "/repo/empty",
    projectKind: "git",
  });
  replica.commitSnapshot(
    {
      workspaces: new Map([
        ["kept", normalizeWorkspaceDescriptor(workspace("kept"))],
        ["filtered", normalizeWorkspaceDescriptor(workspace("filtered", "filtered-project"))],
      ]),
      projects: new Map([[empty.projectId, empty]]),
    },
    [{ kind: "remove", id: "filtered", removedProjectId: "filtered-project" }],
  );

  const session = useSessionStore.getState().sessions[serverId];
  expect(Array.from(session?.workspaces.keys() ?? [])).toEqual(["kept"]);
  expect(Array.from(session?.projects.keys() ?? [])).toEqual(["empty"]);
  store.clearSession(serverId);
});

it("commits the authoritative snapshot before buffered project updates", () => {
  const serverId = "project-update-replica";
  const store = useSessionStore.getState();
  store.initializeSession(serverId, null as unknown as DaemonClient);
  const replica = new WorkspaceDirectoryReplica(serverId);
  const attachedMain = normalizeWorkspaceDescriptor(workspace("attached-main", "attached"));
  const attachedFeature = normalizeWorkspaceDescriptor(workspace("attached-feature", "attached"));
  const removed = normalizeWorkspaceDescriptor(workspace("removed", "removed"));
  const unrelated = normalizeWorkspaceDescriptor(workspace("unrelated", "unrelated"));
  const staleAttachedProject = normalizeProjectDescriptor({
    projectId: "attached",
    projectDisplayName: "Stale attached project",
    projectRootPath: "/repo/attached",
    projectKind: "git",
  });
  const removedProject = normalizeProjectDescriptor({
    projectId: "removed",
    projectDisplayName: "Removed project",
    projectRootPath: "/repo/removed",
    projectKind: "git",
  });
  const unchangedEmptyProject = normalizeProjectDescriptor({
    projectId: "unchanged-empty",
    projectDisplayName: "Unchanged empty project",
    projectRootPath: "/repo/unchanged-empty",
    projectKind: "git",
  });

  replica.commitSnapshot(
    {
      workspaces: new Map([
        [attachedMain.id, attachedMain],
        [attachedFeature.id, attachedFeature],
        [removed.id, removed],
        [unrelated.id, unrelated],
      ]),
      projects: new Map([
        [staleAttachedProject.projectId, staleAttachedProject],
        [removedProject.projectId, removedProject],
        [unchangedEmptyProject.projectId, unchangedEmptyProject],
      ]),
    },
    [
      {
        kind: "upsert",
        project: {
          projectId: "attached",
          projectKey: "remote:github.com/acme/attached",
          projectDisplayName: "Renamed attached project",
          projectCustomName: "Personal name",
          projectRootPath: "/moved/attached",
          projectKind: "directory",
        },
      },
      {
        kind: "upsert",
        project: {
          projectId: "new-empty",
          projectDisplayName: "New empty project",
          projectRootPath: "/repo/new-empty",
          projectKind: "directory",
        },
      },
      { kind: "remove", projectId: "removed" },
    ],
  );

  const session = useSessionStore.getState().sessions[serverId];
  expect(session?.workspaces.get(attachedMain.id)).toMatchObject({
    projectDisplayName: "Renamed attached project",
    projectCustomName: "Personal name",
    projectRootPath: "/moved/attached",
    projectKind: "directory",
  });
  expect(session?.workspaces.get(attachedFeature.id)).toMatchObject({
    projectDisplayName: "Renamed attached project",
    projectRootPath: "/moved/attached",
  });
  expect(session?.workspaces.has(removed.id)).toBe(false);
  expect(session?.workspaces.get(unrelated.id)).toBe(unrelated);
  expect(Array.from(session?.projects.keys() ?? [])).toEqual([
    "attached",
    "unchanged-empty",
    "new-empty",
  ]);
  expect(session?.projects.get("unchanged-empty")).toBe(unchangedEmptyProject);
  expect(session?.projects.get("new-empty")).toMatchObject({
    projectDisplayName: "New empty project",
    projectRootPath: "/repo/new-empty",
  });
  store.clearSession(serverId);
});

it("preserves unchanged project identity when another project changes", () => {
  const serverId = "project-identity";
  const store = useSessionStore.getState();
  store.initializeSession(serverId, null as unknown as DaemonClient);
  const replica = new WorkspaceDirectoryReplica(serverId);
  const first = normalizeProjectDescriptor({
    projectId: "first",
    projectDisplayName: "First",
    projectRootPath: "/repo/first",
    projectKind: "git",
  });
  const second = normalizeProjectDescriptor({
    projectId: "second",
    projectDisplayName: "Second",
    projectRootPath: "/repo/second",
    projectKind: "git",
  });
  replica.commitSnapshot(
    {
      workspaces: new Map(),
      projects: new Map([
        ["first", first],
        ["second", second],
      ]),
    },
    [],
  );
  const previousSecond = useSessionStore.getState().sessions[serverId]?.projects.get("second");

  replica.commitSnapshot(
    {
      workspaces: new Map(),
      projects: new Map([
        ["first", { ...first, projectDisplayName: "Updated" }],
        ["second", { ...second }],
      ]),
    },
    [],
  );

  expect(useSessionStore.getState().sessions[serverId]?.projects.get("second")).toBe(
    previousSecond,
  );
  store.clearSession(serverId);
});

it("does not invent a null-key project from a workspace update", () => {
  const serverId = "workspace-before-project-update";
  const store = useSessionStore.getState();
  store.initializeSession(serverId, null as unknown as DaemonClient);
  const replica = new WorkspaceDirectoryReplica(serverId);

  replica.applyDelta({ kind: "upsert", workspace: workspace("main", "fresh-project") });

  const session = useSessionStore.getState().sessions[serverId];
  expect(session?.workspaces.has("main")).toBe(true);
  expect(session?.projects.has("fresh-project")).toBe(false);
  store.clearSession(serverId);
});

it("does not restore a targeted cached workspace while its archive is pending", () => {
  const serverId = "cached-workspace-during-archive";
  const workspaceId = "archived-workspace";
  const store = useSessionStore.getState();
  store.initializeSession(serverId, null as unknown as DaemonClient);
  const replica = new WorkspaceDirectoryReplica(serverId);
  markWorkspaceArchivePending({ serverId, workspaceId });

  try {
    replica.commitCachedWorkspace(normalizeWorkspaceDescriptor(workspace(workspaceId)), undefined);

    expect(useSessionStore.getState().sessions[serverId]?.workspaces.has(workspaceId)).toBe(false);
  } finally {
    clearWorkspaceArchivePending({ serverId, workspaceId });
    store.clearSession(serverId);
  }
});

<<<<<<< HEAD
it("pin hydration retains opaque host identities and a buffered unpin wins its older snapshot", () => {
  const store = useSessionStore.getState();
  const serverIds = ["pin-mini", "pin-book"];
  for (const serverId of serverIds)
    store.initializeSession(serverId, null as unknown as DaemonClient);
  try {
    const mini = new WorkspaceDirectoryReplica(serverIds[0]);
    const book = new WorkspaceDirectoryReplica(serverIds[1]);
    const cached = normalizeWorkspaceDescriptor({
      ...workspace("same-id"),
      pinnedAt: "2026-10-01T00:00:00.000Z",
    });
    mini.commitCached({ workspaces: new Map([[cached.id, cached]]), projects: new Map() });
    book.commitCached({ workspaces: new Map([[cached.id, cached]]), projects: new Map() });
    mini.commitSnapshot({ workspaces: new Map([[cached.id, cached]]), projects: new Map() }, [
      { kind: "upsert", workspace: { ...workspace("same-id"), pinnedAt: null } },
    ]);
    expect(
      useSessionStore.getState().sessions[serverIds[0]]?.workspaces.get("same-id")?.pinnedAt,
    ).toBeNull();
    expect(
      useSessionStore.getState().sessions[serverIds[1]]?.workspaces.get("same-id")?.pinnedAt,
    ).toBe(cached.pinnedAt);
    mini.commitCached({ workspaces: new Map([[cached.id, cached]]), projects: new Map() });
    expect(
      useSessionStore.getState().sessions[serverIds[0]]?.workspaces.get("same-id")?.pinnedAt,
    ).toBeNull();
    book.commitSnapshot({ workspaces: new Map([[cached.id, cached]]), projects: new Map() }, []);
    expect(
      useSessionStore.getState().sessions[serverIds[1]]?.workspaces.get("same-id"),
    ).toMatchObject({ id: "same-id", pinnedAt: cached.pinnedAt, projectId: "project" });
  } finally {
    for (const serverId of serverIds) store.clearSession(serverId);
  }
});
it("pin deltas publish new store maps without mutating the prior sidebar snapshot", () => {
  const serverId = "pin-subscription";
  const store = useSessionStore.getState();
  store.initializeSession(serverId, null as unknown as DaemonClient);
  try {
    const replica = new WorkspaceDirectoryReplica(serverId);
    replica.commitSnapshot(
      {
        workspaces: new Map([
          ["same-id", normalizeWorkspaceDescriptor({ ...workspace("same-id"), pinnedAt: null })],
        ]),
        projects: new Map(),
      },
      [],
    );
    const previous = useSessionStore.getState().sessions[serverId]!.workspaces;
    let notifications = 0;
    const unsubscribe = useSessionStore.subscribe((state, before) => {
      if (state.sessions[serverId]?.workspaces !== before.sessions[serverId]?.workspaces)
        notifications++;
    });
    try {
      replica.applyDelta({
        kind: "upsert",
        workspace: { ...workspace("same-id"), pinnedAt: "2026-10-03T00:00:00.000Z" },
      });
      expect(notifications).toBe(1);
      expect(previous.get("same-id")?.pinnedAt).toBeNull();
      expect(
        useSessionStore.getState().sessions[serverId]!.workspaces.get("same-id")?.pinnedAt,
      ).toBe("2026-10-03T00:00:00.000Z");
    } finally {
      unsubscribe();
    }
=======
it("setup metadata from directory snapshots and transitions resets failure surfacing without details", () => {
  const serverId = "setup-metadata";
  useSessionStore.getState().initializeSession(serverId, null as unknown as DaemonClient);
  const replica = new WorkspaceDirectoryReplica(serverId);
  const identity = { serverId, workspaceId: "setup" };
  const store = useWorkspaceSetupStore.getState();
  replica.commitSnapshot(
    {
      workspaces: new Map([
        ["setup", normalizeWorkspaceDescriptor({ ...workspace("setup"), setupStatus: "blocked" })],
      ]),
      projects: new Map(),
    },
    [],
  );
  expect(useSessionStore.getState().sessions[serverId].workspaces.get("setup")?.setupStatus).toBe(
    "blocked",
  );
  expect(store.claimFailedSetupSurface({ ...identity, status: "blocked" })).toBe(true);
  replica.applyDelta({
    kind: "upsert",
    workspace: { ...workspace("setup"), setupStatus: "running" },
  });
  replica.applyDelta({
    kind: "upsert",
    workspace: { ...workspace("setup"), setupStatus: "failed" },
  });
  expect(useSessionStore.getState().sessions[serverId].workspaces.get("setup")?.setupStatus).toBe(
    "failed",
  );
  expect(store.claimFailedSetupSurface({ ...identity, status: "failed" })).toBe(true);
  expect(store.claimFailedSetupSurface({ ...identity, status: "failed" })).toBe(false);
  expect(useWorkspaceSetupStore.getState().snapshots).toEqual({});
});

it("keeps a live workspace update when an older creation snapshot arrives", () => {
  const serverId = "workspace-create-after-pin";
  const store = useSessionStore.getState();
  store.initializeSession(serverId, null as unknown as DaemonClient);
  const replica = new WorkspaceDirectoryReplica(serverId);
  const initial = workspace("new");
  const pinned = {
    ...initial,
    pinnedAt: "2026-09-26T00:00:00.000Z",
    title: "Updated title",
  };

  try {
    replica.applyDelta({ kind: "upsert", workspace: pinned });
    const accepted = useSessionStore.getState().sessions[serverId]?.workspaces.get(initial.id);

    expect(replica.acceptWorkspaces([normalizeWorkspaceDescriptor(initial)])).toEqual([]);
    expect(replica.snapshot().workspaces.get(initial.id)).toEqual(
      normalizeWorkspaceDescriptor(pinned),
    );
    expect(useSessionStore.getState().sessions[serverId]?.workspaces.get(initial.id)).toBe(
      accepted,
    );
>>>>>>> refs/remotes/upstream/tags/v0.13.1
  } finally {
    store.clearSession(serverId);
  }
});
<<<<<<< HEAD
=======

it("seeds missing workspaces before live updates and in a mixed creation batch", () => {
  const serverId = "workspace-create-before-pin";
  const store = useSessionStore.getState();
  store.initializeSession(serverId, null as unknown as DaemonClient);
  const replica = new WorkspaceDirectoryReplica(serverId);
  const initial = normalizeWorkspaceDescriptor(workspace("new"));
  const second = normalizeWorkspaceDescriptor(workspace("second"));
  const pinned = { ...workspace(initial.id), pinnedAt: "2026-09-26T00:00:00.000Z" };

  try {
    expect(replica.acceptWorkspaces([initial])).toEqual([
      { kind: "workspace", type: "upsert", id: initial.id, value: initial },
    ]);
    expect(useSessionStore.getState().sessions[serverId]?.workspaces.get(initial.id)).toEqual(
      initial,
    );

    replica.applyDelta({ kind: "upsert", workspace: pinned });
    expect(replica.acceptWorkspaces([initial, second])).toEqual([
      { kind: "workspace", type: "upsert", id: second.id, value: second },
    ]);
    expect([...useSessionStore.getState().sessions[serverId]!.workspaces.values()]).toEqual([
      normalizeWorkspaceDescriptor(pinned),
      second,
    ]);
  } finally {
    store.clearSession(serverId);
  }
});

it("keeps a manual unpin when a stale pinned snapshot arrives", () => {
  const serverId = "workspace-manual-unpin";
  const store = useSessionStore.getState();
  store.initializeSession(serverId, null as unknown as DaemonClient);
  const replica = new WorkspaceDirectoryReplica(serverId);
  const pinned = { ...workspace("new"), pinnedAt: "2026-09-26T00:00:00.000Z" };
  const unpinned = { ...pinned, pinnedAt: null };

  try {
    replica.acceptWorkspaces([normalizeWorkspaceDescriptor(pinned)]);
    replica.applyDelta({ kind: "upsert", workspace: unpinned });
    expect(replica.acceptWorkspaces([normalizeWorkspaceDescriptor(pinned)])).toEqual([]);
    expect(useSessionStore.getState().sessions[serverId]?.workspaces.get(pinned.id)).toEqual(
      normalizeWorkspaceDescriptor(unpinned),
    );
  } finally {
    store.clearSession(serverId);
  }
});

it("restores a missing workspace after an archive failure without replacing a live row", () => {
  const serverId = "workspace-archive-rollback";
  const store = useSessionStore.getState();
  store.initializeSession(serverId, null as unknown as DaemonClient);
  const replica = new WorkspaceDirectoryReplica(serverId);
  const initial = normalizeWorkspaceDescriptor(workspace("new"));

  try {
    replica.acceptWorkspaces([initial]);
    markWorkspaceArchivePending({ serverId, workspaceId: initial.id });
    replica.removeWorkspaceSnapshot(initial.id);
    expect(replica.acceptWorkspaces([initial])).toEqual([]);
    expect(useSessionStore.getState().sessions[serverId]?.workspaces.has(initial.id)).toBe(false);

    clearWorkspaceArchivePending({ serverId, workspaceId: initial.id });
    expect(replica.acceptWorkspaces([initial])).toEqual([
      { kind: "workspace", type: "upsert", id: initial.id, value: initial },
    ]);
    expect(useSessionStore.getState().sessions[serverId]?.workspaces.get(initial.id)).toEqual(
      initial,
    );

    const updated = { ...workspace(initial.id), title: "Updated during archive" };
    replica.applyDelta({ kind: "upsert", workspace: updated });
    expect(replica.acceptWorkspaces([initial])).toEqual([]);
    expect(useSessionStore.getState().sessions[serverId]?.workspaces.get(initial.id)).toEqual(
      normalizeWorkspaceDescriptor(updated),
    );
  } finally {
    clearWorkspaceArchivePending({ serverId, workspaceId: initial.id });
    store.clearSession(serverId);
  }
});
>>>>>>> refs/remotes/upstream/tags/v0.13.1
