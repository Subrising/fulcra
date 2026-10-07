import { describe, expect, it } from "vitest";
import type { ArchitectureGraph } from "@getpaseo/protocol/messages";
import {
  callersOnly,
  drawnEdges,
  expandInPlace,
  facets,
  nearestOnly,
  nodeRole,
  packageOverview,
  searchModules,
  selectModule,
  visibleNodes,
} from "./dependency-graph-model";

const node = (id: string, group: string, kind: string, files = 10) => ({
  id,
  label: `${group} › ${id}`,
  folder: `packages/${group}/${id}`,
  kind,
  group,
  files,
  code: files,
  tests: 0,
  x: 0,
  y: 0,
  width: 230,
  height: 66,
});

// screen -> hooks -> client -> protocol, and relay -> protocol (a busy connection), plus one quiet import.
const graph: ArchitectureGraph = {
  commit: "a".repeat(40),
  rules: 1,
  nodes: [
    node("screen", "app", "frontend", 5),
    node("hooks", "app", "frontend", 7),
    node("client", "client", "frontend", 3),
    node("protocol", "protocol", "messagebus", 4),
    node("relay", "relay", "messagebus", 2),
  ],
  edges: [
    { from: "screen", to: "hooks", imports: 6 },
    { from: "hooks", to: "client", imports: 9 },
    { from: "client", to: "protocol", imports: 12 },
    { from: "relay", to: "protocol", imports: 5 },
    { from: "screen", to: "relay", imports: 1 },
  ],
  highlighted: ["client"],
  changedFiles: 2,
};
const none = { query: "", hiddenKinds: new Set<string>(), hiddenGroups: new Set<string>() };

describe("code dependency map model", () => {
  it("counts what a module uses and what uses it, directly and through others", () => {
    const s = selectModule(graph, "client");
    expect(s.usesDirect).toEqual(["protocol"]);
    expect([...s.usesAll]).toEqual(["protocol"]);
    expect(s.usedByDirect).toEqual(["hooks"]);
    expect([...s.usedByAll].sort()).toEqual(["hooks", "screen"]);
    // hooks (7 files) and screen (5 files) can feel a change in client.
    expect(s.dependentFiles).toBe(12);
  });

  it("lights up only the paths through the selection, and keeps quiet imports hidden otherwise", () => {
    const visible = new Set(graph.nodes.map((n) => n.id));
    const idle = drawnEdges({ edges: graph.edges, visible, selection: null });
    expect(idle.map(({ edge }) => `${edge.from}>${edge.to}`)).not.toContain("screen>relay");
    const lit = drawnEdges({
      edges: graph.edges,
      visible,
      selection: selectModule(graph, "client"),
    })
      .filter((e) => e.lit)
      .map(({ edge }) => `${edge.from}>${edge.to}`)
      .sort();
    // relay -> protocol is not on a path through client, so it stays dim.
    expect(lit).toEqual(["client>protocol", "hooks>client", "screen>hooks"]);
  });

  it("filters by package and kind, marks search matches, and shows the pull request's modules", () => {
    const shown = visibleNodes(graph, { ...none, hiddenKinds: new Set(["messagebus"]) });
    expect(shown.map((n) => n.id)).toEqual(["screen", "hooks", "client"]);
    const highlighted = new Set(graph.highlighted);
    const role = (id: string, query = "") =>
      nodeRole({
        node: graph.nodes.find((n) => n.id === id)!,
        selection: null,
        query,
        highlighted,
      });
    expect(role("client")).toBe("edited");
    expect(role("relay")).toBe("dimmed");
    expect(role("hooks", "HOOK")).toBe("match");
    expect(facets(graph)).toEqual({
      groups: ["app", "client", "protocol", "relay"],
      kinds: ["frontend", "messagebus"],
    });
  });

  it("starts with one box per package and bundles the imports between packages", () => {
    const overview = packageOverview(graph);
    expect(overview.nodes.map((n) => n.id).sort()).toEqual([
      "pkg:app",
      "pkg:client",
      "pkg:protocol",
      "pkg:relay",
    ]);
    const app = overview.nodes.find((n) => n.id === "pkg:app");
    expect(app).toMatchObject({ files: 12, kind: "frontend" });
    // screen->hooks stays inside app; hooks->client (9) and screen->relay (1) leave it.
    expect(overview.edges).toEqual([
      { from: "pkg:app", to: "pkg:client", imports: 9 },
      { from: "pkg:app", to: "pkg:relay", imports: 1 },
      { from: "pkg:client", to: "pkg:protocol", imports: 12 },
      { from: "pkg:relay", to: "pkg:protocol", imports: 5 },
    ]);
    expect(overview.highlighted).toEqual(["pkg:client"]);
  });

  it("opens a package in place: its modules in a frame where its box was, the rest moved aside", () => {
    const overview = packageOverview(graph);
    const { graph: opened, frame } = expandInPlace(graph, "app");
    expect(opened.nodes.map((n) => n.id).sort()).toEqual([
      "hooks",
      "pkg:client",
      "pkg:protocol",
      "pkg:relay",
      "screen",
    ]);
    // Imports that touch app go to its modules; the rest stay bundled between packages.
    expect(opened.edges).toEqual([
      { from: "hooks", to: "pkg:client", imports: 9 },
      { from: "pkg:client", to: "pkg:protocol", imports: 12 },
      { from: "pkg:relay", to: "pkg:protocol", imports: 5 },
      { from: "screen", to: "hooks", imports: 6 },
      { from: "screen", to: "pkg:relay", imports: 1 },
    ]);
    expect(opened.highlighted).toEqual(["pkg:client"]);
    const at = (g: typeof opened, id: string) => g.nodes.find((n) => n.id === id)!;
    const appBox = at(overview, "pkg:app");
    expect(frame).toMatchObject({ group: "app", x: appBox.x, y: appBox.y });
    // Modules sit inside the frame, and the next package in the row moved past it.
    for (const id of ["hooks", "screen"]) {
      const m = at(opened, id);
      expect(m.x).toBeGreaterThanOrEqual(frame!.x);
      expect(m.x + m.width).toBeLessThanOrEqual(frame!.x + frame!.width);
      expect(m.y + m.height).toBeLessThanOrEqual(frame!.y + frame!.height);
    }
    expect(at(opened, "pkg:client").x).toBeGreaterThanOrEqual(frame!.x + frame!.width);
    expect(expandInPlace(graph, "missing").frame).toBeNull();
  });

  it("finds modules by name or folder, names that start with the query first", () => {
    expect(searchModules(graph, "re").map((n) => n.id)).toEqual(["relay", "screen"]);
    expect(searchModules(graph, "packages/client").map((n) => n.id)).toEqual(["client"]);
    expect(searchModules(graph, "  ")).toEqual([]);
  });

  it("lights up one hop by default and every level on request", () => {
    const full = selectModule(graph, "client");
    const near = nearestOnly(full);
    expect([...near.usedByAll]).toEqual(["hooks"]);
    expect([...full.usedByAll].sort()).toEqual(["hooks", "screen"]);
    const role = (id: string, s: typeof full) =>
      nodeRole({
        node: graph.nodes.find((n) => n.id === id)!,
        selection: s,
        query: "",
        highlighted: new Set(),
      });
    expect(role("screen", near)).toBe("dimmed");
    expect(role("screen", full)).toBe("dependent");
    const visible = new Set(graph.nodes.map((n) => n.id));
    const litNear = drawnEdges({ edges: graph.edges, visible, selection: near })
      .filter((e) => e.lit)
      .map(({ edge }) => `${edge.from}>${edge.to}`)
      .sort();
    // Only client's own connections: screen>hooks is two hops away.
    expect(litNear).toEqual(["client>protocol", "hooks>client"]);
  });

  it("shows only what calls a module, at every level, when asked", () => {
    const callers = callersOnly(selectModule(graph, "client"));
    const role = (id: string) =>
      nodeRole({
        node: graph.nodes.find((n) => n.id === id)!,
        selection: callers,
        query: "",
        highlighted: new Set(),
      });
    expect([role("screen"), role("hooks"), role("protocol")]).toEqual([
      "dependent",
      "dependent",
      "dimmed",
    ]);
    const visible = new Set(graph.nodes.map((n) => n.id));
    const lit = drawnEdges({ edges: graph.edges, visible, selection: callers })
      .filter((e) => e.lit)
      .map(({ edge }) => `${edge.from}>${edge.to}`)
      .sort();
    expect(lit).toEqual(["hooks>client", "screen>hooks"]);
  });
});
