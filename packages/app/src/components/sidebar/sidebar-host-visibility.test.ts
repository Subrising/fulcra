import { describe, expect, it } from "vitest";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { buildSidebarProjection } from "./sidebar-projection";
import { INITIAL_VISIBLE_ITEMS, limitRowsPerHost } from "./use-limited-sidebar-group";
import { withHostCounts } from "./sidebar-projection";

// J15: a busy host (the Mini, ~130 sessions) and a quiet remote host (the MacBook, 13 idle) in one
// sidebar. A shared 20-row cut hid 10 of the 13 MacBook sessions behind "Show more".
const BUSY = "srv_fixture_busy";
const QUIET = "srv_fixture_quiet";

function entry(serverId: string, id: string, minutesAgo: number): SidebarWorkspaceEntry {
  return {
    workspaceKey: `${serverId}:${id}`,
    serverId,
    workspaceId: id,
    projectViewKey: "tally",
    projectName: "Tally",
    projectKind: "git",
    workspaceKind: "worktree",
    name: id,
    workspaceDirectory: "",
    workspaceDirectoryLabel: "",
    title: null,
    currentBranch: null,
    statusBucket: "done",
    statusEnteredAt: new Date(Date.parse("2026-09-27T12:00:00.000Z") - minutesAgo * 60_000),
    archivingAt: null,
    diffStat: null,
    prHint: null,
    archiveHasUncommittedChanges: null,
    archiveUnpushedCommitCount: null,
    scripts: [],
    hasRunningScripts: false,
    backgroundWorkCount: 0,
  };
}

// The busy host's 25 sessions are all more recent than the quiet host's 13.
const busy = Array.from({ length: 25 }, (_, i) => entry(BUSY, `busy-${i}`, i));
const quiet = Array.from({ length: 13 }, (_, i) => entry(QUIET, `quiet-${i}`, 100 + i));
const hostOf = (row: SidebarWorkspaceEntry) => row.serverId;

function doneGroup() {
  const rows = [...quiet, ...busy];
  return buildSidebarProjection({
    projects: [],
    pinnedKeys: { pinnedWorkspaceKeys: [], pinnedAtByKey: {} },
    pinnedWorkspaceOrder: [],
    workspaceEntriesByKey: new Map(rows.map((row) => [row.workspaceKey, row] as const)),
    projectNamesByViewKey: new Map([["tally", "Tally"]]),
    hostNames: new Map([
      [BUSY, "Mini"],
      [QUIET, "MacBook"],
    ]),
    groupMode: "status",
    pinnedCollapsed: false,
    collapsedProjectKeys: new Set<string>(),
    collapsedWorkspaceGroupKeys: new Set<string>(),
  }).workspaceGroups.find((group) => group.key === "done")!;
}

describe("another host's sessions are never hidden below the fold (MH4)", () => {
  it("a busy host plus a quiet remote host: all 13 quiet sessions are visible before Show more", () => {
    const group = doneGroup();
    expect(
      group.rows.slice(0, INITIAL_VISIBLE_ITEMS).filter((r) => r.serverId === QUIET),
    ).toHaveLength(0);

    const { visible, hidden } = limitRowsPerHost(group.rows, hostOf);
    expect(visible.filter((r) => r.serverId === QUIET)).toHaveLength(13);
    expect(visible.filter((r) => r.serverId === BUSY)).toHaveLength(INITIAL_VISIBLE_ITEMS);
    expect(hidden).toBe(5);
    // The group's own order (newest first) is kept.
    expect(visible.map((r) => r.workspaceKey)).toEqual(
      group.rows.filter((r) => visible.includes(r)).map((r) => r.workspaceKey),
    );
  });

  it("the busy host still folds its own oldest rows, and nothing folds when every host fits", () => {
    const { visible, hidden } = limitRowsPerHost(busy, hostOf);
    expect(visible.map((r) => r.workspaceId)).toEqual(busy.slice(0, 20).map((r) => r.workspaceId));
    expect(hidden).toBe(5);
    expect(limitRowsPerHost(quiet, hostOf)).toEqual({ visible: quiet, hidden: 0 });
  });

  it("a group spanning hosts says how many sessions each has, by name, busiest first", () => {
    expect(doneGroup().hostCounts).toEqual([
      { serverId: BUSY, name: "Mini", count: 25 },
      { serverId: QUIET, name: "MacBook", count: 13 },
    ]);
    const single = withHostCounts(
      { key: "done", label: "Done", rows: quiet, leading: { kind: "status", bucket: "done" } },
      undefined,
    );
    expect(single.hostCounts).toBeUndefined();
    const unnamed = withHostCounts(
      {
        key: "done",
        label: "Done",
        rows: [...busy, ...quiet],
        leading: { kind: "status", bucket: "done" },
      },
      new Map(),
    );
    expect(unnamed.hostCounts?.map((h) => h.name)).toEqual(["Unnamed host", "Unnamed host"]);
  });
});
