/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n/i18next";
import { parseArchitectureIr, type ArchitectureMapModel } from "./ir-model";
import { ArchitectureMapView } from "./architecture-map-view";

// The shared react-native-svg stub renders nothing. Here each primitive becomes the matching
// DOM SVG element, so the assertions run against real text nodes and attributes. Only the
// props the view actually uses are forwarded; theme mappings (uniProps) are dropped.
vi.mock("react-native-svg", async () => {
  const ReactModule = await import("react");
  const forwarded = [
    "x",
    "y",
    "x1",
    "y1",
    "x2",
    "y2",
    "width",
    "height",
    "rx",
    "points",
    "opacity",
    "viewBox",
    "fontSize",
    "textAnchor",
    "strokeWidth",
    "strokeDasharray",
    "fill",
    "stroke",
    "href",
    "xlinkHref",
    "dangerouslySetInnerHTML",
  ] as const;
  const make = (tag: string) =>
    function SvgPrimitive(props: Record<string, unknown> & { children?: React.ReactNode }) {
      const attributes: Record<string, unknown> = {};
      for (const key of forwarded) {
        if (props[key] !== undefined) attributes[key] = props[key];
      }
      if (typeof props.testID === "string") attributes["data-testid"] = props.testID;
      if (typeof props.onPress === "function") attributes.onClick = props.onPress;
      return ReactModule.createElement(tag, attributes, props.children as React.ReactNode);
    };
  return {
    default: make("svg"),
    G: make("g"),
    Line: make("line"),
    Polygon: make("polygon"),
    Rect: make("rect"),
    Text: make("text"),
  };
});

let root: Root | null = null;
let container: HTMLElement | null = null;

// Parsed fixture JSON is mutated freely to build hostile documents.
type ParsedJson = ReturnType<typeof JSON.parse>;

function headModel(mutate?: (ir: ParsedJson) => void): ArchitectureMapModel {
  const ir = JSON.parse(readFileSync(join(__dirname, "fixtures", "head.ir.json"), "utf8"));
  mutate?.(ir);
  const result = parseArchitectureIr(new TextEncoder().encode(JSON.stringify(ir)));
  if (result.kind !== "ok") throw new Error(JSON.stringify(result));
  return result.model;
}

function render(model: ArchitectureMapModel): HTMLElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(<ArchitectureMapView model={model} />);
  });
  return container;
}

function all(testId: string): HTMLElement[] {
  return Array.from(
    container?.querySelectorAll(`[data-testid="${testId}"]`) ?? [],
  ) as HTMLElement[];
}

function one(testId: string): HTMLElement | null {
  return container?.querySelector(`[data-testid="${testId}"]`) ?? null;
}

function click(element: Element | null | undefined): void {
  if (!element) throw new Error("element not found");
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

const PAYLOAD = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>';

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("React", React);
  await i18n.changeLanguage("en");
  delete (window as unknown as Record<string, unknown>).__pwned;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

describe("ArchitectureMapView", () => {
  it("renders the reviewed head map: 4 nodes, 3 edges, 2 cards, title and qualifier", () => {
    render(headModel());
    expect(all("architecture-map-node")).toHaveLength(4);
    expect(all("architecture-map-edge")).toHaveLength(3);
    expect(all("architecture-map-card")).toHaveLength(2);
    expect(one("architecture-map-title")?.textContent).toBe("Radius definition: defproof-app");
    expect(one("architecture-map-subtitle")?.textContent).toMatch(/Manually mapped/);
    const svgText = Array.from(container?.querySelectorAll("text") ?? []).map((n) => n.textContent);
    expect(svgText).toContain("defproof-app");
    expect(svgText).toContain("application = reference('app').id");
    expect(container?.textContent).toContain(
      "image digest sha256:0ae87935398b92627ab73bbe2bdf43d777419076804ba1a6e346f5cb06de43ca",
    );
  });

  it("shows markup in every IR string as literal text and runs none of it", () => {
    const model = headModel((ir) => {
      ir.meta.title = PAYLOAD.slice(0, 200);
      ir.meta.subtitle = PAYLOAD;
      for (const component of ir.components) {
        component.label = PAYLOAD.slice(0, 120);
        component.sublabel = PAYLOAD;
        component.tag = PAYLOAD;
      }
      for (const connection of ir.connections) connection.label = PAYLOAD;
      ir.cards = [{ dot: "emerald", title: PAYLOAD.slice(0, 120), items: [PAYLOAD] }];
    });
    render(model);
    const html = container?.innerHTML ?? "";
    expect(container?.querySelector("script, img, a, foreignObject, iframe")).toBeNull();
    expect(html).not.toMatch(/href=/i);
    expect(one("architecture-map-subtitle")?.textContent).toBe(PAYLOAD);
    expect(container?.textContent).toContain(PAYLOAD);
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
  });

  it("puts no IR string into a colour, stroke or fill", () => {
    render(
      headModel((ir) => {
        ir.components[0].type = "red";
        ir.connections[0].variant = "url(javascript:alert(1))";
        ir.cards[0].dot = "#ff0000";
      }),
    );
    const html = container?.innerHTML ?? "";
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("#ff0000");
    expect(html).not.toMatch(/(fill|stroke)="red"/);
  });

  it("opens node detail with the full tag, dims unrelated nodes and closes on Escape", () => {
    render(headModel());
    expect(one("architecture-map-detail")).toBeNull();
    const imageRow = all("architecture-map-node-row").find((row) =>
      row.textContent?.includes("demo image"),
    );
    click(imageRow);
    expect(one("architecture-map-detail-tag")?.textContent).toBe("pinned: sha256:0ae879…43ca");
    const opacities = all("architecture-map-node").map((node) => node.getAttribute("opacity"));
    // image connects only to demo: environment and app are dimmed.
    expect(opacities).toEqual(["0.2", "0.2", "1", "1"]);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(one("architecture-map-detail")).toBeNull();
    expect(all("architecture-map-node").map((node) => node.getAttribute("opacity"))).toEqual([
      "1",
      "1",
      "1",
      "1",
    ]);
  });

  it("selects a node from the canvas as well as from the list", () => {
    render(headModel());
    click(all("architecture-map-node")[1]?.querySelector("rect"));
    expect(one("architecture-map-detail")?.textContent).toContain("defproof-app");
    click(one("architecture-map-detail-close"));
    expect(one("architecture-map-detail")).toBeNull();
  });

  it("tells the reader when hidden characters were removed", () => {
    render(headModel());
    expect(one("architecture-map-hidden-characters")).toBeNull();
    act(() => root?.unmount());
    container?.remove();
    render(
      headModel((ir) => {
        ir.components[0].label = "Env\u202Eironment";
      }),
    );
    expect(one("architecture-map-hidden-characters")?.textContent).toMatch(/Hidden/);
  });

  it("lists boundaries it cannot draw yet", () => {
    render(
      headModel((ir) => {
        ir.boundaries = [{ kind: "network", label: "cluster" }];
      }),
    );
    expect(one("architecture-map-boundary")?.textContent).toBe("cluster · network");
  });

  it("drops canvas labels for a large zoomed-out map but keeps the node list", () => {
    const components = Array.from({ length: 200 }, (_, i) => ({
      id: `n${i}`,
      type: "backend",
      label: `node-${i}`,
      pos: [(i % 20) * 250, Math.floor(i / 20) * 100],
      size: [200, 60],
    }));
    render(
      headModel((ir) => {
        ir.components = components;
        ir.connections = [];
      }),
    );
    click(one("architecture-map-zoom-out"));
    click(one("architecture-map-zoom-out"));
    click(one("architecture-map-zoom-out"));
    expect(container?.querySelectorAll("text")).toHaveLength(0);
    expect(all("architecture-map-node-row")).toHaveLength(200);
  });

  it("zooms by resizing the canvas", () => {
    render(headModel());
    const svg = container?.querySelector("svg");
    const before = Number(svg?.getAttribute("width"));
    click(one("architecture-map-zoom-in"));
    expect(Number(container?.querySelector("svg")?.getAttribute("width"))).toBeCloseTo(
      before * 1.25,
    );
    click(one("architecture-map-actual-size"));
    expect(container?.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 900 353");
  });
});
