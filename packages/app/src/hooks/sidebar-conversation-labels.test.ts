import type { WorkspaceDescriptor } from "@/stores/session-store";
import { describe, expect, it } from "vitest";
import {
  applySidebarConversationLabels,
  equalSidebarConversationLabels,
  selectSidebarConversationLabels,
} from "./sidebar-conversation-labels";
import {
  buildSidebarWorkspaceEntries,
  buildSidebarWorkspacePlacementModel,
} from "./sidebar-workspaces-view-model";
const uuid = "123e4567-e89b-42d3-a456-426614174000";
const agent = (id = "a", title: string | null = "Product launch", serverId = "mini") => ({
  id,
  title,
  serverId,
  workspaceId: "ws",
  parentAgentId: null as string | null,
  archivedAt: null as Date | null,
  createdAt: new Date(1000),
});
const workspace = () => ({
  id: "ws",
  projectId: "project",
  projectKind: "non_git" as const,
  name: uuid,
  title: null as string | null,
  projectDisplayName: uuid,
  projectCustomName: null as string | null,
});
const session = (agents = [agent()], workspaces = [workspace()]) => ({
  agents: new Map(agents.map((a) => [a.id, a])),
  workspaces: new Map(workspaces.map((w) => [w.id, w])),
});
const labels = (s = session()) => selectSidebarConversationLabels({ mini: s }, ["mini"]);
const model = (keys = ["mini:ws"]) =>
  buildSidebarWorkspacePlacementModel({
    projects: [
      {
        viewKey: "project",
        projectKey: null,
        projectName: uuid,
        projectKind: "non_git",
        iconWorkingDir: "/tasks/" + uuid,
        hosts: [
          {
            serverId: "mini",
            projectId: "project",
            iconWorkingDir: "/tasks/" + uuid,
            worktreeSupport: "unsupported",
          },
        ],
        workspaceKeys: keys,
      },
    ],
  });

describe("generated workspace conversation labels", () => {
  it("uses exact host and workspace identity, including host filters", () => {
    const s = { mini: session(), book: session([agent("a", "Book research", "book")]) };
    expect(selectSidebarConversationLabels(s, ["mini", "book"]).get("book:ws")?.workspaceName).toBe(
      "Book research",
    );
    expect(selectSidebarConversationLabels(s, ["mini"]).has("book:ws")).toBe(false);
    expect(labels(session([agent("a", "Foreign", "book")])).size).toBe(0);
    expect(labels(session([{ ...agent(), workspaceId: "other" }])).size).toBe(0);
  });
  it("preserves explicit workspace/project titles, including intentionally UUID-shaped titles", () => {
    const w = { ...workspace(), title: uuid, projectCustomName: uuid };
    expect(labels(session([agent()], [w])).size).toBe(0);
    const s = {
      ...session(),
      projects: new Map([["project", { projectDisplayName: uuid, projectCustomName: uuid }]]),
    };
    expect(labels(s).get("mini:ws")).toEqual({
      workspaceName: "Product launch",
      projectName: null,
    });
  });
  it("preserves repository and meaningful directory names", () => {
    expect(
      labels(
        session([agent()], [{ ...workspace(), name: "Research", projectDisplayName: "Product" }]),
      ).size,
    ).toBe(0);
    const git = { ...workspace(), projectKind: "git" as const };
    expect(
      selectSidebarConversationLabels(
        { mini: { agents: new Map([["a", agent()]]), workspaces: new Map([["ws", git]]) } },
        ["mini"],
      ).size,
    ).toBe(0);
  });
  it("does not invent labels for missing, archived or unidentified titles", () => {
    for (const title of [null, " ", uuid])
      expect(labels(session([agent("a", title)])).size).toBe(0);
    expect(labels(session([{ ...agent(), archivedAt: new Date() }])).size).toBe(0);
    expect(labels(session([])).size).toBe(0);
    expect(selectSidebarConversationLabels({}, ["missing"]).size).toBe(0);
  });
  it("excludes same-workspace child conversations and unresolved parents", () => {
    const parent = agent("parent", "Lead"),
      child = { ...agent("child", "Internal helper"), parentAgentId: "parent" };
    expect(labels(session([child, parent])).get("mini:ws")?.workspaceName).toBe("Lead");
    expect(labels(session([child])).size).toBe(0);
    expect(
      labels(session([child, { ...parent, workspaceId: "another" }])).get("mini:ws")?.workspaceName,
    ).toBe("Internal helper");
  });
  it("selects the oldest observed root deterministically, not by incoming event order", () => {
    const old = agent("z", "Established work"),
      recent = { ...agent("a", "New work"), createdAt: new Date(2000) };
    for (const rows of [
      [old, recent],
      [recent, old],
    ])
      expect(labels(session(rows)).get("mini:ws")?.workspaceName).toBe("Established work");
    expect(labels(session([agent("b", "B"), agent("a", "A")])).get("mini:ws")?.workspaceName).toBe(
      "A",
    );
  });
  it("detects renames/removal while ignoring unchanged metadata projections", () => {
    expect(equalSidebarConversationLabels(labels(), labels())).toBe(true);
    expect(equalSidebarConversationLabels(labels(), labels(session([agent("a", "Renamed")])))).toBe(
      false,
    );
    expect(equalSidebarConversationLabels(labels(), new Map())).toBe(false);
    expect(
      equalSidebarConversationLabels(
        labels(),
        new Map([["book:ws", { workspaceName: "Product launch", projectName: "Product launch" }]]),
      ),
    ).toBe(false);
  });
  it("keeps routing and paths intact and does not mutate the source model", () => {
    const source = model(),
      result = applySidebarConversationLabels(source, labels());
    expect(result.projects[0]?.projectName).toBe("Product launch");
    expect(result.workspaces[0]).toMatchObject({
      serverId: "mini",
      workspaceId: "ws",
      workspaceKey: "mini:ws",
      projectViewKey: "project",
      conversationName: "Product launch",
      projectRootPath: "/tasks/" + uuid,
    });
    expect(result.projectNamesByViewKey.get("project")).toBe("Product launch");
    expect(source.projects[0]?.projectName).toBe(uuid);
    expect(applySidebarConversationLabels(source, new Map())).toBe(source);
  });
  it("uses a neutral multi-workspace header regardless of eligible title count", () => {
    const source = model(["mini:ws", "mini:second"]);
    const first = labels(),
      both = new Map([
        ...first,
        ["mini:second", { workspaceName: "Research", projectName: "Research" }] as const,
      ]);
    for (const hints of [first, both])
      expect(applySidebarConversationLabels(source, hints).projects[0]?.projectName).toBe(
        "Saved conversations",
      );
  });
  it("ignores stale hints when a project becomes a Git repository", () => {
    const source = model();
    source.projects[0]!.projectKind = "git";
    const projected = applySidebarConversationLabels(source, labels());
    expect(projected.projects[0]).toBe(source.projects[0]);
    expect(projected.workspaces[0]).toBe(source.workspaces[0]);
  });
});

it("projects labels into the actual sidebar entries while respecting newer authoritative names", () => {
  const projected = applySidebarConversationLabels(model(), labels());
  const full: WorkspaceDescriptor = {
    ...workspace(),
    projectRootPath: "/tasks/" + uuid,
    workspaceDirectory: "/tasks/" + uuid,
    workspaceKind: "checkout",
    status: "done",
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    scripts: [],
  };
  const entries = (w: WorkspaceDescriptor) =>
    buildSidebarWorkspaceEntries({
      placements: projected.workspaces,
      sessions: [
        { serverId: "mini", workspaces: new Map([[w.id, w]]), workspaceAgentActivity: new Map() },
      ],
    });
  expect(entries(full).get("mini:ws")).toMatchObject({
    name: "Product launch",
    projectName: "Product launch",
    workspaceId: "ws",
    title: null,
  });
  expect(
    entries({
      ...full,
      name: "Explicit rename",
      title: "Explicit rename",
      projectCustomName: "Project rename",
    }).get("mini:ws"),
  ).toMatchObject({ name: "Explicit rename", projectName: "Project rename" });
  expect(
    entries({
      ...full,
      name: "Meaningful directory",
      projectDisplayName: "Meaningful project",
    }).get("mini:ws"),
  ).toMatchObject({ name: "Meaningful directory", projectName: "Meaningful project" });
  expect(entries({ ...full, projectKind: "git" }).get("mini:ws")?.name).toBe(uuid);
});
