import type { ArchitectureMapEdge, ArchitectureMapModel, ArchitectureMapNode } from "./ir-model";

// Before/after comparison of two architecture maps (Fulcra CHANGES). This is the TypeScript twin of
// the control repo's orca-architecture-map/diff.mjs, which agents and the decision-packet evidence
// use; the two keep the same rules and the same test cases:
// - identity is the authored id, so a moved box is "moved" (layout) and a relabelled box is
//   "changed", never removed + added;
// - a part is touched when it was added, removed or changed, or when a connection it makes was;
// - reach is every part with a path of connections leading into a touched part.
// It compares render models, whose strings are already display-safe.

export type DiffStatus = "added" | "removed" | "changed" | "unchanged";

const NODE_FIELDS = ["type", "label", "sublabel", "tag"] as const;
const NODE_LAYOUT = ["x", "y", "width", "height"] as const;
const EDGE_FIELDS = ["from", "to", "label", "style"] as const;
const EDGE_LAYOUT = ["fromSide", "toSide", "labelDy"] as const;

export type NodeField = (typeof NODE_FIELDS)[number];
export type EdgeField = (typeof EDGE_FIELDS)[number];

export interface SetDiff<F extends string> {
  added: string[];
  removed: string[];
  changed: { id: string; fields: F[] }[];
  moved: string[];
  unchanged: string[];
}

export interface MapComparison {
  components: SetDiff<NodeField>;
  connections: SetDiff<EdgeField>;
  touched: string[];
  reach: string[];
  suspectedRenames: { from: string; to: string }[];
  /** Nothing about the system or its layout differs. */
  unchangedMap: boolean;
  nodeStatus: ReadonlyMap<string, DiffStatus>;
  edgeStatus: ReadonlyMap<string, DiffStatus>;
}

function compareSets<T extends { id: string }, F extends keyof T & string>(
  before: ReadonlyMap<string, T>,
  after: ReadonlyMap<string, T>,
  fields: readonly F[],
  layout: readonly (keyof T)[],
): SetDiff<F> {
  const result: SetDiff<F> = { added: [], removed: [], changed: [], moved: [], unchanged: [] };
  for (const id of after.keys()) if (!before.has(id)) result.added.push(id);
  for (const [id, old] of before) {
    const now = after.get(id);
    if (!now) {
      result.removed.push(id);
      continue;
    }
    const diff = fields.filter((field) => old[field] !== now[field]);
    if (diff.length > 0) result.changed.push({ id, fields: diff });
    else result.unchanged.push(id);
    if (layout.some((field) => old[field] !== now[field])) result.moved.push(id);
  }
  result.added.sort();
  result.removed.sort();
  result.changed.sort((a, b) => a.id.localeCompare(b.id));
  result.moved.sort();
  result.unchanged.sort();
  return result;
}

const byId = <T extends { id: string }>(items: readonly T[]) =>
  new Map(items.map((item) => [item.id, item]));

/** Every part with a path of connections leading into a touched part; touched parts excluded. */
export function reach(
  edges: readonly { from: string; to: string }[],
  touched: readonly string[],
): string[] {
  const into = new Map<string, Set<string>>();
  for (const { from, to } of edges) {
    const users = into.get(to) ?? new Set<string>();
    users.add(from);
    into.set(to, users);
  }
  const seen = new Set(touched);
  const queue = [...touched];
  const found: string[] = [];
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) break;
    for (const user of into.get(next) ?? []) {
      if (seen.has(user)) continue;
      seen.add(user);
      found.push(user);
      queue.push(user);
    }
  }
  return found.sort();
}

function suspectedRenames(
  components: SetDiff<NodeField>,
  before: ReadonlyMap<string, ArchitectureMapNode>,
  after: ReadonlyMap<string, ArchitectureMapNode>,
): { from: string; to: string }[] {
  const key = (node: ArchitectureMapNode | undefined) =>
    `${node?.type ?? ""}\u0000${(node?.label ?? "").trim().toLowerCase()}`;
  const added = new Map<string, string[]>();
  for (const id of components.added) {
    const k = key(after.get(id));
    added.set(k, [...(added.get(k) ?? []), id]);
  }
  const pairs: { from: string; to: string }[] = [];
  for (const id of components.removed) {
    const match = added.get(key(before.get(id)));
    const to = match?.shift();
    if (to !== undefined) pairs.push({ from: id, to });
  }
  return pairs;
}

const EMPTY: Pick<ArchitectureMapModel, "nodes" | "edges"> = { nodes: [], edges: [] };

/** Compare two maps; either may be null (a map new in the change, or deleted by it). */
export function compareMaps(
  base: Pick<ArchitectureMapModel, "nodes" | "edges"> | null,
  head: Pick<ArchitectureMapModel, "nodes" | "edges"> | null,
): MapComparison {
  const b = base ?? EMPTY;
  const h = head ?? EMPTY;
  const bn = byId<ArchitectureMapNode>(b.nodes);
  const hn = byId<ArchitectureMapNode>(h.nodes);
  const be = byId<ArchitectureMapEdge>(b.edges);
  const he = byId<ArchitectureMapEdge>(h.edges);
  const components = compareSets(bn, hn, NODE_FIELDS, NODE_LAYOUT);
  const connections = compareSets(be, he, EDGE_FIELDS, EDGE_LAYOUT);

  const touched = new Set<string>([
    ...components.added,
    ...components.removed,
    ...components.changed.map((c) => c.id),
  ]);
  for (const id of [
    ...connections.added,
    ...connections.removed,
    ...connections.changed.map((c) => c.id),
  ]) {
    for (const edge of [be.get(id), he.get(id)]) {
      if (edge && (bn.has(edge.from) || hn.has(edge.from))) touched.add(edge.from);
    }
  }
  const touchedParts = [...touched].sort();
  const edges = [...be.values(), ...he.values()];

  const status = <F extends string>(diff: SetDiff<F>) => {
    const out = new Map<string, DiffStatus>();
    for (const id of diff.added) out.set(id, "added");
    for (const id of diff.removed) out.set(id, "removed");
    for (const { id } of diff.changed) out.set(id, "changed");
    for (const id of diff.unchanged) out.set(id, "unchanged");
    return out;
  };

  return {
    components,
    connections,
    touched: touchedParts,
    reach: reach(edges, touchedParts),
    suspectedRenames: suspectedRenames(components, bn, hn),
    unchangedMap:
      touchedParts.length === 0 && components.moved.length === 0 && connections.moved.length === 0,
    nodeStatus: status(components),
    edgeStatus: status(connections),
  };
}

export function withStatus<T extends object>(
  item: T,
  status: DiffStatus,
): T & { status: DiffStatus } {
  return { ...item, status };
}

export interface DeltaModel {
  nodes: (ArchitectureMapNode & { status: DiffStatus })[];
  edges: (ArchitectureMapEdge & { status: DiffStatus })[];
}

/**
 * One picture of the change: the map after it, plus what it removed drawn where it used to be.
 * Removed connections are kept only when both ends are still drawn.
 */
export function deltaModel(
  base: Pick<ArchitectureMapModel, "nodes" | "edges"> | null,
  head: Pick<ArchitectureMapModel, "nodes" | "edges"> | null,
  comparison: MapComparison,
): DeltaModel {
  const b = base ?? EMPTY;
  const h = head ?? EMPTY;
  const removedNodes = new Set(comparison.components.removed);
  const nodes = [
    ...h.nodes.map((node) => withStatus(node, comparison.nodeStatus.get(node.id) ?? "unchanged")),
    ...b.nodes
      .filter((node) => removedNodes.has(node.id))
      .map((node) => withStatus(node, "removed")),
  ];
  const drawn = new Set(nodes.map((node) => node.id));
  const removedEdges = new Set(comparison.connections.removed);
  const edges = [
    ...h.edges.map((edge) => withStatus(edge, comparison.edgeStatus.get(edge.id) ?? "unchanged")),
    ...b.edges
      .filter((edge) => removedEdges.has(edge.id) && drawn.has(edge.from) && drawn.has(edge.to))
      .map((edge) => withStatus(edge, "removed")),
  ];
  return { nodes, edges };
}
