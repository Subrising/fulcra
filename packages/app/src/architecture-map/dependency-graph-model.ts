import type { ArchitectureGraph } from "@getpaseo/protocol/messages";

// The Code Dependency Map's rules, kept apart from drawing so they can be tested: which modules a selected module
// uses and is used by (directly and through others), what a filter or search keeps, and how each box is drawn.

export type GraphNode = ArchitectureGraph["nodes"][number];
export type GraphEdge = ArchitectureGraph["edges"][number];

/** Connections carrying fewer imports than this are drawn only when they touch the selected module. */
export const QUIET_EDGE_IMPORTS = 5;

export interface Selection {
  id: string;
  usesDirect: string[];
  usesAll: Set<string>;
  usedByDirect: string[];
  usedByAll: Set<string>;
  /** Files in every module that uses the selected one, directly or through others. */
  dependentFiles: number;
  /** One hop: only the selected module's own connections light up. */
  oneHop?: boolean;
  /** Only what uses the selected module: its own outgoing connections stay quiet too. */
  callersOnly?: boolean;
}

function adjacency(edges: readonly GraphEdge[], reverse: boolean): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const edge of edges) {
    const [from, to] = reverse ? [edge.to, edge.from] : [edge.from, edge.to];
    out.set(from, [...(out.get(from) ?? []), to]);
  }
  return out;
}

/** Every module reachable from `start` along `next`, `start` excluded. */
export function reachable(
  next: ReadonlyMap<string, readonly string[]>,
  start: string,
): Set<string> {
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) break;
    for (const to of next.get(id) ?? []) {
      if (to === start || seen.has(to)) continue;
      seen.add(to);
      queue.push(to);
    }
  }
  return seen;
}

export function selectModule(graph: ArchitectureGraph, id: string): Selection {
  const uses = adjacency(graph.edges, false);
  const usedBy = adjacency(graph.edges, true);
  const usedByAll = reachable(usedBy, id);
  const files = new Map(graph.nodes.map((node) => [node.id, node.files]));
  let dependentFiles = 0;
  for (const dependent of usedByAll) dependentFiles += files.get(dependent) ?? 0;
  return {
    id,
    usesDirect: [...new Set(uses.get(id) ?? [])].sort(),
    usesAll: reachable(uses, id),
    usedByDirect: [...new Set(usedBy.get(id) ?? [])].sort(),
    usedByAll,
    dependentFiles,
  };
}

export interface GraphFilter {
  query: string;
  hiddenKinds: ReadonlySet<string>;
  hiddenGroups: ReadonlySet<string>;
}

export function matchesQuery(node: GraphNode, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  return node.label.toLowerCase().includes(q) || node.folder.toLowerCase().includes(q);
}

/** The modules a filter keeps (search does not hide: it marks matches). */
export function visibleNodes(graph: ArchitectureGraph, filter: GraphFilter): GraphNode[] {
  return graph.nodes.filter(
    (node) => !filter.hiddenKinds.has(node.kind) && !filter.hiddenGroups.has(node.group),
  );
}

export type NodeRole =
  | "selected"
  | "dependency"
  | "dependent"
  | "match"
  | "edited"
  | "normal"
  | "dimmed";

export function nodeRole(input: {
  node: GraphNode;
  selection: Selection | null;
  query: string;
  highlighted: ReadonlySet<string>;
}): NodeRole {
  const { node, selection, query, highlighted } = input;
  if (selection) {
    if (node.id === selection.id) return "selected";
    if (selection.usesAll.has(node.id)) return "dependency";
    if (selection.usedByAll.has(node.id)) return "dependent";
    return "dimmed";
  }
  if (query.trim()) return matchesQuery(node, query) ? "match" : "dimmed";
  if (highlighted.size > 0) return highlighted.has(node.id) ? "edited" : "dimmed";
  return "normal";
}

/** The connections to draw: the busy ones, and every one that touches the selection. */
export function drawnEdges(input: {
  edges: readonly GraphEdge[];
  visible: ReadonlySet<string>;
  selection: Selection | null;
}): { edge: GraphEdge; lit: boolean }[] {
  const { edges, visible, selection } = input;
  // Lit: an edge on a path out of the selection (what it uses) or into it (what uses it).
  const onPath = (edge: GraphEdge) => {
    if (!selection) return false;
    const { id, usesAll, usedByAll } = selection;
    if (selection.oneHop) return edge.from === id || edge.to === id;
    const outward = (edge.from === id || usesAll.has(edge.from)) && usesAll.has(edge.to);
    const inward = usedByAll.has(edge.from) && (edge.to === id || usedByAll.has(edge.to));
    return outward || inward;
  };
  return edges.flatMap((edge) => {
    if (!visible.has(edge.from) || !visible.has(edge.to)) return [];
    const lit = onPath(edge);
    const direct =
      selection !== null &&
      (edge.to === selection.id || (edge.from === selection.id && !selection.callersOnly));
    if (!lit && !direct && edge.imports < QUIET_EDGE_IMPORTS) return [];
    return [{ edge, lit: lit || direct }];
  });
}

/** The groups (packages) and kinds present, for the filter chips, largest first. */
export function facets(graph: ArchitectureGraph): { groups: string[]; kinds: string[] } {
  const count = (key: (node: GraphNode) => string) => {
    const counts = new Map<string, number>();
    for (const node of graph.nodes) counts.set(key(node), (counts.get(key(node)) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
  };
  return { groups: count((node) => node.group), kinds: count((node) => node.kind) };
}

// ---- Levels: the package overview and one package expanded ----------------------------------------------------

export const PACKAGE_PREFIX = "pkg:";
const BOX_W = 230;
const BOX_H = 66;
const GAP_X = 90;
const GAP_Y = 60;
const ORIGIN = 40;

export const isPackageNode = (id: string) => id.startsWith(PACKAGE_PREFIX);
export const packageNodeId = (group: string) => `${PACKAGE_PREFIX}${group}`;

function dominant(values: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "service";
}

/** One box per package, sized like a module. `folder` lists its modules so search finds the package. */
function packageNode(
  group: string,
  members: readonly GraphNode[],
  x: number,
  y: number,
): GraphNode {
  return {
    id: packageNodeId(group),
    label: group,
    folder: members.map((m) => m.label).join(" "),
    kind: dominant(members.map((m) => m.kind)),
    group,
    files: members.reduce((n, m) => n + m.files, 0),
    code: members.reduce((n, m) => n + m.code, 0),
    tests: members.reduce((n, m) => n + m.tests, 0),
    x,
    y,
    width: BOX_W,
    height: BOX_H,
  };
}

function bundle(edges: Iterable<{ from: string; to: string; imports: number }>): GraphEdge[] {
  const sums = new Map<string, number>();
  for (const e of edges) {
    if (e.from === e.to) continue;
    const key = `${e.from}\0${e.to}`;
    sums.set(key, (sums.get(key) ?? 0) + e.imports);
  }
  return [...sums]
    .map(([key, imports]) => {
      const [from, to] = key.split("\0");
      return { from, to, imports };
    })
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

function membersByGroup(graph: ArchitectureGraph): Map<string, GraphNode[]> {
  const groups = new Map<string, GraphNode[]>();
  for (const node of graph.nodes) groups.set(node.group, [...(groups.get(node.group) ?? []), node]);
  return groups;
}

/** Packages in the order the generator laid their modules out (users on the left), four to a row. */
export function packageOverview(graph: ArchitectureGraph): ArchitectureGraph {
  const groups = membersByGroup(graph);
  const meanX = (members: readonly GraphNode[]) =>
    members.reduce((n, m) => n + m.x, 0) / Math.max(1, members.length);
  const order = [...groups.keys()].sort(
    (a, b) => meanX(groups.get(a) ?? []) - meanX(groups.get(b) ?? []) || a.localeCompare(b),
  );
  const columns = Math.min(4, Math.max(1, order.length));
  const nodes = order.map((group, i) =>
    packageNode(
      group,
      groups.get(group) ?? [],
      ORIGIN + (i % columns) * (BOX_W + GAP_X),
      ORIGIN + Math.floor(i / columns) * (BOX_H + GAP_Y),
    ),
  );
  const groupOf = new Map(graph.nodes.map((n) => [n.id, n.group]));
  const edges = bundle(
    graph.edges.map((e) => ({
      from: packageNodeId(groupOf.get(e.from) ?? ""),
      to: packageNodeId(groupOf.get(e.to) ?? ""),
      imports: e.imports,
    })),
  );
  const highlighted = [
    ...new Set(graph.highlighted.map((id) => packageNodeId(groupOf.get(id) ?? ""))),
  ].sort();
  return { ...graph, nodes, edges, highlighted };
}

export interface GroupFrame {
  group: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const FRAME_PAD = 16;
const FRAME_TITLE = 22;

/**
 * One package opened in place: the overview stays, and the package's box becomes a framed grid of its modules where
 * the box was. Packages to its right in the same row move right, and lower rows move down, so nothing overlaps.
 * Imports between two closed packages stay bundled; imports that touch the open package go to its modules.
 */
export function expandInPlace(
  graph: ArchitectureGraph,
  group: string,
): { graph: ArchitectureGraph; frame: GroupFrame | null } {
  const overview = packageOverview(graph);
  const box = overview.nodes.find((n) => n.id === packageNodeId(group));
  const members = membersByGroup(graph).get(group) ?? [];
  if (!box || members.length === 0) return { graph: overview, frame: null };
  const columns = Math.max(1, Math.ceil(Math.sqrt(members.length)));
  const rows = Math.ceil(members.length / columns);
  const stepX = BOX_W + GAP_X / 2;
  const stepY = BOX_H + GAP_Y / 2;
  const frame: GroupFrame = {
    group,
    x: box.x,
    y: box.y,
    width: columns * stepX - GAP_X / 2 + FRAME_PAD * 2,
    height: rows * stepY - GAP_Y / 2 + FRAME_PAD * 2 + FRAME_TITLE,
  };
  const growX = frame.width - BOX_W;
  const growY = frame.height - BOX_H;
  const moved = overview.nodes
    .filter((n) => n.id !== box.id)
    .map((n) => {
      if (n.y > box.y) return Object.assign({}, n, { y: n.y + growY });
      if (n.y === box.y && n.x > box.x) return Object.assign({}, n, { x: n.x + growX });
      return n;
    });
  const modules = [...members]
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((m, i) =>
      Object.assign({}, m, {
        x: frame.x + FRAME_PAD + (i % columns) * stepX,
        y: frame.y + FRAME_PAD + FRAME_TITLE + Math.floor(i / columns) * stepY,
      }),
    );
  const inside = new Set(members.map((m) => m.id));
  const groupOf = new Map(graph.nodes.map((n) => [n.id, n.group]));
  const outer = (id: string) => (inside.has(id) ? id : packageNodeId(groupOf.get(id) ?? ""));
  const edges = bundle(
    graph.edges.map((e) => ({ from: outer(e.from), to: outer(e.to), imports: e.imports })),
  );
  const highlighted = [...new Set(graph.highlighted.map(outer))].sort();
  return { graph: { ...graph, nodes: [...moved, ...modules], edges, highlighted }, frame };
}

/** Modules whose name or folder matches, best first: name starts with the query, then name contains it. */
export function searchModules(graph: ArchitectureGraph, query: string, limit = 8): GraphNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const rank = (node: GraphNode) => {
    const label = node.label.toLowerCase();
    if (label.startsWith(q)) return 0;
    return label.includes(q) ? 1 : 2;
  };
  return graph.nodes
    .filter((node) => matchesQuery(node, q))
    .sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label))
    .slice(0, limit);
}

/** One hop: only the selected module's direct neighbours count as lit. */
export function nearestOnly(selection: Selection): Selection {
  return {
    ...selection,
    usesAll: new Set(selection.usesDirect),
    usedByAll: new Set(selection.usedByDirect),
    oneHop: true,
  };
}

/** "Show what calls this": only the modules that use the selection, at every level; what it uses goes quiet. */
export function callersOnly(selection: Selection): Selection {
  return { ...selection, usesDirect: [], usesAll: new Set(), oneHop: false, callersOnly: true };
}
