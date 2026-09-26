import type { ArchitectureSide } from "./ir-schema";
import type { ArchitectureMapEdge, ArchitectureMapModel, ArchitectureMapNode } from "./ir-model";

// Positions are authored in the IR, so layout is geometry only: a view box around everything
// that is drawn, side anchors for each edge and a point for each edge label.

export const VIEW_MARGIN = 40;
export const LABEL_DETAIL_THRESHOLD = 150;
export const LABEL_DETAIL_MIN_ZOOM = 0.6;
const ARROW_LENGTH = 9;
const ARROW_HALF_WIDTH = 4.5;

export interface Point {
  x: number;
  y: number;
}

export interface ViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface EdgeGeometry {
  id: string;
  start: Point;
  end: Point;
  labelAt: Point;
  arrow: [Point, Point, Point];
}

function center(node: ArchitectureMapNode): Point {
  return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
}

export function anchorPoint(node: ArchitectureMapNode, side: ArchitectureSide): Point {
  switch (side) {
    case "top":
      return { x: node.x + node.width / 2, y: node.y };
    case "bottom":
      return { x: node.x + node.width / 2, y: node.y + node.height };
    case "left":
      return { x: node.x, y: node.y + node.height / 2 };
    case "right":
      return { x: node.x + node.width, y: node.y + node.height / 2 };
  }
}

/** The side of `from` that faces `to`, by the dominant axis between their centres. */
export function facingSide(from: ArchitectureMapNode, to: ArchitectureMapNode): ArchitectureSide {
  const a = center(from);
  const b = center(to);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? "right" : "left";
  }
  return dy >= 0 ? "bottom" : "top";
}

function arrowHead(start: Point, end: Point): [Point, Point, Point] {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const baseX = end.x - ux * ARROW_LENGTH;
  const baseY = end.y - uy * ARROW_LENGTH;
  return [
    end,
    { x: baseX - uy * ARROW_HALF_WIDTH, y: baseY + ux * ARROW_HALF_WIDTH },
    { x: baseX + uy * ARROW_HALF_WIDTH, y: baseY - ux * ARROW_HALF_WIDTH },
  ];
}

export function edgeGeometry(
  edge: ArchitectureMapEdge,
  nodesById: ReadonlyMap<string, ArchitectureMapNode>,
): EdgeGeometry | null {
  const from = nodesById.get(edge.from);
  const to = nodesById.get(edge.to);
  if (!from || !to) return null;
  const start = anchorPoint(from, edge.fromSide ?? facingSide(from, to));
  const end = anchorPoint(to, edge.toSide ?? facingSide(to, from));
  return {
    id: edge.id,
    start,
    end,
    labelAt: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 + edge.labelDy },
    arrow: arrowHead(start, end),
  };
}

export function indexNodes(model: ArchitectureMapModel): Map<string, ArchitectureMapNode> {
  return new Map(model.nodes.map((node) => [node.id, node]));
}

export function computeViewBox(
  model: ArchitectureMapModel,
  edges: readonly EdgeGeometry[],
): ViewBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const include = (x: number, y: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const node of model.nodes) {
    include(node.x, node.y);
    include(node.x + node.width, node.y + node.height);
  }
  for (const edge of edges) {
    include(edge.labelAt.x, edge.labelAt.y);
  }
  return {
    x: minX - VIEW_MARGIN,
    y: minY - VIEW_MARGIN,
    width: maxX - minX + VIEW_MARGIN * 2,
    height: maxY - minY + VIEW_MARGIN * 2,
  };
}

/** Large maps hide in-canvas labels when zoomed out; the node list and detail keep full text. */
export function shouldDrawLabels(nodeCount: number, zoom: number): boolean {
  return nodeCount <= LABEL_DETAIL_THRESHOLD || zoom >= LABEL_DETAIL_MIN_ZOOM;
}

/** Ellipsise to what fits in `width` at an estimated monospace advance. */
export function fitText(text: string, width: number, fontSize: number): string {
  const maxChars = Math.max(1, Math.floor((width - 16) / (fontSize * 0.6)));
  const characters = Array.from(text);
  if (characters.length <= maxChars) return text;
  return `${characters.slice(0, Math.max(1, maxChars - 1)).join("")}…`;
}
