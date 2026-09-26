import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArchitectureIr, type ArchitectureMapNode } from "./ir-model";
import {
  anchorPoint,
  computeViewBox,
  edgeGeometry,
  facingSide,
  fitText,
  indexNodes,
  shouldDrawLabels,
  VIEW_MARGIN,
} from "./layout";

function headModel() {
  const result = parseArchitectureIr(readFileSync(join(__dirname, "fixtures", "head.ir.json")));
  if (result.kind !== "ok") throw new Error("fixture must parse");
  return result.model;
}

function node(id: string, x: number, y: number): ArchitectureMapNode {
  return {
    id,
    type: "backend",
    tone: "service",
    label: id,
    sublabel: null,
    tag: null,
    x,
    y,
    width: 100,
    height: 40,
  };
}

describe("architecture map layout", () => {
  it("puts every node and edge label inside the view box with a margin", () => {
    const model = headModel();
    const nodesById = indexNodes(model);
    const edges = model.edges.flatMap((edge) => edgeGeometry(edge, nodesById) ?? []);
    const box = computeViewBox(model, edges);
    for (const entry of model.nodes) {
      expect(entry.x).toBeGreaterThanOrEqual(box.x + VIEW_MARGIN);
      expect(entry.y).toBeGreaterThanOrEqual(box.y + VIEW_MARGIN);
      expect(entry.x + entry.width).toBeLessThanOrEqual(box.x + box.width - VIEW_MARGIN);
      expect(entry.y + entry.height).toBeLessThanOrEqual(box.y + box.height - VIEW_MARGIN);
    }
    for (const edge of edges) {
      expect(edge.labelAt.y).toBeLessThanOrEqual(box.y + box.height - VIEW_MARGIN);
    }
  });

  it("anchors an edge on its authored sides", () => {
    const model = headModel();
    const nodesById = indexNodes(model);
    const edge = model.edges.find((entry) => entry.id === "application-to-environment");
    const geometry = edge ? edgeGeometry(edge, nodesById) : null;
    // app is at (40,210) 210x62, environment at (40,40) 210x62: top of app to bottom of environment.
    expect(geometry?.start).toEqual({ x: 145, y: 210 });
    expect(geometry?.end).toEqual({ x: 145, y: 102 });
  });

  it("chooses facing sides when none are authored", () => {
    const left = node("a", 0, 0);
    const right = node("b", 300, 10);
    const below = node("c", 0, 300);
    expect(facingSide(left, right)).toBe("right");
    expect(facingSide(right, left)).toBe("left");
    expect(facingSide(left, below)).toBe("bottom");
    expect(facingSide(below, left)).toBe("top");
  });

  it("offsets the edge label by labelDy", () => {
    const model = headModel();
    const nodesById = indexNodes(model);
    const edge = model.edges.find((entry) => entry.id === "container-to-image");
    const geometry = edge ? edgeGeometry(edge, nodesById) : null;
    // demo right (530,241) to image left (600,241): midpoint y 241 + 72.
    expect(geometry?.labelAt).toEqual({ x: 565, y: 313 });
  });

  it("ends the arrow head at the target anchor", () => {
    const a = node("a", 0, 0);
    const b = node("b", 300, 0);
    const geometry = edgeGeometry(
      {
        id: "e",
        from: "a",
        to: "b",
        label: null,
        style: "solid",
        fromSide: null,
        toSide: null,
        labelDy: 0,
      },
      new Map([
        ["a", a],
        ["b", b],
      ]),
    );
    expect(geometry?.arrow[0]).toEqual(anchorPoint(b, "left"));
    expect(geometry?.arrow[1].x).toBeLessThan(300);
  });

  it("returns no geometry for an edge whose endpoint is missing", () => {
    expect(
      edgeGeometry(
        {
          id: "e",
          from: "a",
          to: "z",
          label: null,
          style: "solid",
          fromSide: null,
          toSide: null,
          labelDy: 0,
        },
        new Map([["a", node("a", 0, 0)]]),
      ),
    ).toBeNull();
  });

  it("hides canvas labels only for large maps that are zoomed out", () => {
    expect(shouldDrawLabels(150, 0.1)).toBe(true);
    expect(shouldDrawLabels(151, 0.59)).toBe(false);
    expect(shouldDrawLabels(151, 0.6)).toBe(true);
  });

  it("ellipsises text that does not fit and keeps text that does", () => {
    expect(fitText("demo", 210, 13)).toBe("demo");
    const fitted = fitText("x".repeat(100), 100, 10);
    expect(fitted.endsWith("…")).toBe(true);
    expect(Array.from(fitted).length).toBe(14);
  });
});
