import { describe, expect, it } from "vitest";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";
import { createSidebarWorkspaceEntry } from "@/hooks/sidebar-workspaces-view-model";
import { selectHostBadges, defaultHostAppearance } from "@/hosts/appearance";
import { hostDisplayName, UNNAMED_HOST } from "@/hosts/host-display-name";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store/navigation";
import { normalizeWorkspaceDescriptor, type WorkspaceDescriptor } from "@/stores/session-store";
import { readBackgroundWorkCount } from "@/utils/background-work-count";
import { buildSidebarProjection, type SidebarProjectionInput } from "./sidebar-projection";
import {
  OFFLINE_HOSTS_GROUP_KEY,
  UNREACHABLE_GRACE_MS,
  evaluateHostAvailability,
  isUnreachableHostStatus,
  markOfflineHostEntries,
  msUntilUnreachable,
  offlineGroupLabel,
  parseHostAvailability,
  selectOfflineServerIds,
  serializeHostAvailability,
  type OfflineHostSummary,
} from "./sidebar-offline-hosts";

// Two fictional hosts. Server ids are opaque; people only ever see the names.
const STUDIO = "srv_fixture_studio";
const LAPTOP = "srv_fixture_laptop";

function row(
  serverId: string,
  id: string,
  statusBucket: SidebarWorkspaceEntry["statusBucket"],
  enteredAt: string | null = null,
): { placement: SidebarWorkspacePlacement; entry: SidebarWorkspaceEntry } {
  const placement: SidebarWorkspacePlacement = {
    workspaceKey: `${serverId}:${id}`,
    serverId,
    workspaceId: id,
    projectViewKey: "tally",
    projectName: "Tally",
    projectKind: "git",
    workspaceKind: "worktree",
    name: id,
  };
  return {
    placement,
    entry: {
      ...placement,
      workspaceDirectory: "",
      workspaceDirectoryLabel: "",
      title: null,
      currentBranch: null,
      statusBucket,
      statusEnteredAt: enteredAt ? new Date(enteredAt) : null,
      archivingAt: null,
      diffStat: null,
      prHint: null,
      archiveHasUncommittedChanges: null,
      archiveUnpushedCommitCount: null,
      scripts: [],
      hasRunningScripts: false,
      backgroundWorkCount: 0,
    },
  };
}

function project(rows: SidebarWorkspacePlacement[]): SidebarProjectEntry {
  return {
    viewKey: "tally",
    projectName: "Tally",
    projectKind: "git",
    iconWorkingDir: "/fixture/tally",
    hosts: [STUDIO, LAPTOP].map((serverId) => ({
      serverId,
      projectId: "tally",
      iconWorkingDir: "/fixture/tally",
      worktreeSupport: "supported" as const,
    })),
    workspaces: rows,
  };
}

function statusInput(
  rows: Array<ReturnType<typeof row>>,
  entries: ReadonlyMap<string, SidebarWorkspaceEntry>,
  offlineHosts?: ReadonlyMap<string, OfflineHostSummary>,
): SidebarProjectionInput {
  return {
    projects: [project(rows.map((r) => r.placement))],
    pinnedKeys: { pinnedWorkspaceKeys: [], pinnedAtByKey: {} },
    pinnedWorkspaceOrder: [],
    workspaceEntriesByKey: entries,
    projectNamesByViewKey: new Map([["tally", "Tally"]]),
    offlineHosts,
    groupMode: "status",
    pinnedCollapsed: false,
    collapsedProjectKeys: new Set<string>(),
    collapsedWorkspaceGroupKeys: new Set<string>(),
  };
}

const entriesOf = (rows: Array<ReturnType<typeof row>>) =>
  new Map(rows.map((r) => [r.entry.workspaceKey, r.entry] as const));

describe("one sidebar across hosts", () => {
  const studioBuild = row(STUDIO, "studio-build", "running", "2026-09-27T09:00:00.000Z");
  const laptopDocs = row(LAPTOP, "laptop-docs", "running", "2026-09-27T09:05:00.000Z");
  const studioReview = row(STUDIO, "studio-review", "attention", "2026-09-27T08:00:00.000Z");
  const rows = [studioBuild, laptopDocs, studioReview];

  it("puts both hosts' working rows in one Working group, newest first across hosts", () => {
    const groups = buildSidebarProjection(statusInput(rows, entriesOf(rows))).workspaceGroups;

    const working = groups.find((group) => group.key === "running");
    expect(working?.label).toBe("Working");
    expect(working?.rows.map((r) => r.workspaceKey)).toEqual([
      laptopDocs.entry.workspaceKey,
      studioBuild.entry.workspaceKey,
    ]);
    expect(groups.map((group) => group.key)).toEqual(["attention", "running"]);
  });

  it("moves an offline host's rows out of the status groups into a trailing offline group", () => {
    const offline = new Map<string, OfflineHostSummary>([
      [LAPTOP, { name: "Laptop", since: new Date("2026-09-27T09:10:00.000Z") }],
    ]);
    const entries = markOfflineHostEntries(entriesOf(rows), offline);
    const groups = buildSidebarProjection(statusInput(rows, entries, offline)).workspaceGroups;

    const working = groups.find((group) => group.key === "running");
    // The laptop's last word was "working"; it is not current, so it is not counted.
    expect(working?.rows.map((r) => r.workspaceKey)).toEqual([studioBuild.entry.workspaceKey]);

    const last = groups.at(-1);
    expect(last?.key).toBe(OFFLINE_HOSTS_GROUP_KEY);
    expect(last?.leading).toEqual({ kind: "offline" });
    expect(last?.label).toMatch(/^Offline · Laptop · since /);
    expect(last?.rows.map((r) => [r.workspaceKey, r.hostOffline, r.statusBucket])).toEqual([
      [laptopDocs.entry.workspaceKey, true, "done"],
    ]);
  });

  it("names several offline hosts together and orders their rows by host name", () => {
    const offline = new Map<string, OfflineHostSummary>([
      [STUDIO, { name: "Studio", since: null }],
      [LAPTOP, { name: "Laptop", since: null }],
    ]);
    const entries = markOfflineHostEntries(entriesOf(rows), offline);
    const groups = buildSidebarProjection(statusInput(rows, entries, offline)).workspaceGroups;

    expect(groups.map((group) => group.key)).toEqual([OFFLINE_HOSTS_GROUP_KEY]);
    expect(groups[0]?.label).toBe("Offline hosts");
    expect(groups[0]?.rows.map((r) => r.serverId)).toEqual([LAPTOP, STUDIO, STUDIO]);
  });

  it("leaves the entries untouched when every host is reachable", () => {
    const entries = entriesOf(rows);
    expect(markOfflineHostEntries(entries, new Set())).toBe(entries);
    expect(markOfflineHostEntries(entries, new Set(["srv_fixture_elsewhere"]))).toBe(entries);
  });

  it("keeps an offline row's identity stable across projections", () => {
    const offline = new Set([LAPTOP]);
    const first = markOfflineHostEntries(entriesOf(rows), offline);
    const second = markOfflineHostEntries(entriesOf(rows), offline);
    expect(second.get(laptopDocs.entry.workspaceKey)).toBe(
      first.get(laptopDocs.entry.workspaceKey),
    );
  });

  it("counts offline and error at once, and a retrying host only after the grace", () => {
    const now = 100_000;
    const statuses = new Map([
      ["a", "online"],
      ["b", "connecting"],
      ["c", "idle"],
      ["d", "offline"],
      ["e", "error"],
      ["f", "connecting"],
      ["g", "connecting"],
    ] as const);
    const since = new Map([
      ["b", now - 5_000],
      ["f", now - UNREACHABLE_GRACE_MS],
    ]);
    expect([...selectOfflineServerIds(statuses, since, now)]).toEqual(["d", "e", "f"]);
    expect(isUnreachableHostStatus(undefined)).toBe(false);
    // A host still connecting with no record of when it went unavailable (app launch) stays live.
    expect(isUnreachableHostStatus("connecting", null)).toBe(false);
    expect(msUntilUnreachable("connecting", 5_000)).toBe(UNREACHABLE_GRACE_MS - 5_000);
    expect(msUntilUnreachable("connecting", UNREACHABLE_GRACE_MS)).toBeNull();
    expect(msUntilUnreachable("online", 5_000)).toBeNull();
  });

  it("round-trips the availability snapshot and evaluates it against the clock", () => {
    const hosts = [
      { serverId: "a", status: "online" as const, since: null },
      { serverId: "b", status: "connecting" as const, since: 1_000 },
      { serverId: "c", status: "error" as const, since: 2_000 },
      { serverId: "d", status: undefined, since: null },
    ];
    const snapshot = serializeHostAvailability(hosts);
    expect(parseHostAvailability(snapshot)).toEqual(hosts);
    expect(parseHostAvailability("")).toEqual([]);
    expect(evaluateHostAvailability(hosts, 5_000)).toEqual({
      offlineIds: ["c"],
      nextCheckMs: UNREACHABLE_GRACE_MS - 4_000,
    });
    expect(evaluateHostAvailability(hosts, 1_000 + UNREACHABLE_GRACE_MS)).toEqual({
      offlineIds: ["b", "c"],
      nextCheckMs: null,
    });
  });

  it("labels one offline host with the time it was lost", () => {
    const since = new Date("2026-09-27T09:10:00.000Z");
    expect(offlineGroupLabel([{ name: "Laptop", since }], () => "10:10")).toBe(
      "Offline · Laptop · since 10:10",
    );
    expect(offlineGroupLabel([{ name: "Laptop", since: null }])).toBe("Offline · Laptop");
  });
});

describe("hosts are named, never shown by id", () => {
  it("uses the label, and 'Unnamed host' when the label is empty or only repeats the id", () => {
    expect(hostDisplayName({ serverId: STUDIO, label: " Studio " })).toBe("Studio");
    expect(hostDisplayName({ serverId: STUDIO, label: "" })).toBe(UNNAMED_HOST);
    expect(hostDisplayName({ serverId: STUDIO, label: STUDIO })).toBe(UNNAMED_HOST);
    expect(hostDisplayName({ serverId: STUDIO, label: null })).toBe(UNNAMED_HOST);
  });

  it("gives row badges a name even for a host paired without one", () => {
    const badges = selectHostBadges({
      hosts: [
        { serverId: STUDIO, label: "Studio", appearance: defaultHostAppearance() },
        { serverId: LAPTOP, label: LAPTOP, appearance: defaultHostAppearance() },
      ],
      localServerId: null,
      enabled: true,
    });
    expect([...badges.values()].map((badge) => badge.label)).toEqual(["Studio", UNNAMED_HOST]);
    for (const badge of badges.values()) expect(badge.label).not.toMatch(/^srv_/);
  });
});

describe("background jobs reach the row (display only, optional on the wire)", () => {
  const payload = {
    id: "w1",
    projectId: "p1",
    projectDisplayName: "Tally",
    projectRootPath: "/fixture/tally",
    workspaceDirectory: "/fixture/tally",
    projectKind: "git" as const,
    workspaceKind: "checkout" as const,
    name: "main",
    archivingAt: null,
    status: "done" as const,
    statusEnteredAt: null,
    activityAt: null,
    diffStat: null,
    scripts: [],
  };
  const normalize = (extra: Record<string, unknown>) =>
    normalizeWorkspaceDescriptor({ ...payload, ...extra } as Parameters<
      typeof normalizeWorkspaceDescriptor
    >[0]);

  it("carries a host's count through the store to the sidebar entry", () => {
    const workspace = normalize({ backgroundWorkCount: 2 });
    expect(workspace.backgroundWorkCount).toBe(2);
    const entry = createSidebarWorkspaceEntry({ serverId: STUDIO, workspace });
    expect(entry.backgroundWorkCount).toBe(2);
  });

  it("reads an absent or malformed count as none, and leaves older hosts' descriptors unchanged", () => {
    expect("backgroundWorkCount" in normalize({})).toBe(false);
    for (const bad of [0, -1, 1.5, 1000, "3", null, Number.NaN]) {
      expect(readBackgroundWorkCount({ backgroundWorkCount: bad })).toBe(0);
    }
    const entry = createSidebarWorkspaceEntry({
      serverId: STUDIO,
      workspace: normalize({}) as WorkspaceDescriptor,
    });
    expect(entry.backgroundWorkCount).toBe(0);
  });

  it("drops the count on an offline host's rows, since it is the host's last word", () => {
    const busy = row(LAPTOP, "busy", "running");
    const entry = { ...busy.entry, backgroundWorkCount: 3 };
    const marked = markOfflineHostEntries(
      new Map([[entry.workspaceKey, entry]]),
      new Set([LAPTOP]),
    );
    expect(marked.get(entry.workspaceKey)?.backgroundWorkCount).toBe(0);
  });
});

describe("opening a row goes to that row's host", () => {
  function deps() {
    const routes: string[] = [];
    const lookedUp: string[] = [];
    return {
      routes,
      lookedUp,
      value: {
        getSessionWorkspaces: (serverId: string) => {
          lookedUp.push(serverId);
          return null;
        },
        getSessionAgents: () => [],
        isWorkspaceLayoutHydrated: () => true,
        openTab: () => null,
        rememberLastWorkspace: () => undefined,
        navigateToRoute: (route: string) => routes.push(route),
      },
    };
  }

  it("routes each merged row, online or offline, to its own host and never the current one", () => {
    const studio = row(STUDIO, "studio-build", "running");
    const laptop = row(LAPTOP, "laptop-docs", "running");
    const entries = markOfflineHostEntries(entriesOf([studio, laptop]), new Set([LAPTOP]));
    const d = deps();

    for (const entry of entries.values()) {
      navigateToWorkspace({ serverId: entry.serverId, workspaceId: entry.workspaceId }, d.value);
    }

    expect(d.routes).toEqual([
      `/h/${STUDIO}/workspace/studio-build`,
      `/h/${LAPTOP}/workspace/laptop-docs`,
    ]);
    expect(d.lookedUp).toEqual([STUDIO, LAPTOP]);
  });
});
