import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArchitectureIr, type ArchitectureMapModel } from "./ir-model";
import { compareMaps, deltaModel, reach } from "./map-diff";

// The same cases as the control repo's orca-architecture-map/diff.test.mjs, on the same fixture
// pair, so the app and the agents' tooling cannot drift apart silently.

type ParsedJson = ReturnType<typeof JSON.parse>;

function load(name: "change-base" | "change-head", mutate?: (ir: ParsedJson) => void) {
  const ir = JSON.parse(readFileSync(join(__dirname, "fixtures", `${name}.ir.json`), "utf8"));
  mutate?.(ir);
  const result = parseArchitectureIr(new TextEncoder().encode(JSON.stringify(ir)));
  if (result.kind !== "ok") throw new Error(JSON.stringify(result));
  return result.model;
}

const base = load("change-base");
const head = load("change-head");
const component = (ir: ParsedJson, id: string) =>
  ir.components.find((c: { id: string }) => c.id === id);
const connection = (ir: ParsedJson, id: string) =>
  ir.connections.find((c: { id: string }) => c.id === id);

describe("compareMaps", () => {
  it("the fixture pair: added, removed, changed and unchanged parts and connections", () => {
    const r = compareMaps(base, head);
    expect(r.components.added).toEqual(["search"]);
    expect(r.components.removed).toEqual(["reports"]);
    expect(r.components.changed).toEqual([{ id: "orders", fields: ["sublabel"] }]);
    expect(r.components.unchanged).toEqual(["mail", "orders-db", "payments", "web"]);
    expect(r.connections.added).toEqual(["orders-to-search", "search-to-db"]);
    expect(r.connections.removed).toEqual(["reports-to-db"]);
    expect(r.touched).toEqual(["orders", "reports", "search"]);
    expect(r.reach).toEqual(["web"]);
    expect(r.nodeStatus.get("search")).toBe("added");
    expect(r.nodeStatus.get("reports")).toBe("removed");
    expect(r.nodeStatus.get("orders")).toBe("changed");
    expect(r.nodeStatus.get("web")).toBe("unchanged");
  });

  it("moving a box is layout, not a change", () => {
    const moved = load("change-base", (ir) => {
      component(ir, "mail").pos = [900, 400];
    });
    const r = compareMaps(base, moved);
    expect(r.components.changed).toEqual([]);
    expect(r.components.moved).toEqual(["mail"]);
    expect(r.touched).toEqual([]);
    expect(r.unchangedMap).toBe(false);
    expect(compareMaps(base, base).unchangedMap).toBe(true);
  });

  it("a part whose id changed is removed + added and flagged as a suspected rename", () => {
    const renamed = load("change-base", (ir) => {
      component(ir, "mail").id = "email-queue";
      connection(ir, "orders-to-mail").to = "email-queue";
    });
    const r = compareMaps(base, renamed);
    expect(r.components.removed).toEqual(["mail"]);
    expect(r.components.added).toEqual(["email-queue"]);
    expect(r.suspectedRenames).toEqual([{ from: "mail", to: "email-queue" }]);
    expect(r.connections.changed).toEqual([{ id: "orders-to-mail", fields: ["to"] }]);
  });

  it("connection changes touch the part that makes the connection, never the other end", () => {
    const relabelled = compareMaps(
      base,
      load("change-base", (ir) => {
        connection(ir, "orders-to-db").label = "stores and archives orders";
      }),
    );
    expect(relabelled.connections.changed).toEqual([{ id: "orders-to-db", fields: ["label"] }]);
    expect(relabelled.touched).toEqual(["orders"]);
    const newMaker = compareMaps(
      base,
      load("change-base", (ir) => {
        connection(ir, "reports-to-db").from = "orders";
      }),
    );
    expect(newMaker.touched).toEqual(["orders", "reports"]);
  });

  it("a new map and a deleted map", () => {
    expect(compareMaps(null, head).components.added).toHaveLength(head.nodes.length);
    expect(compareMaps(base, null).components.removed).toHaveLength(base.nodes.length);
  });
});

describe("reach", () => {
  it("is transitive, survives cycles and never repeats a touched part", () => {
    const edges = [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "c", to: "a" },
      { from: "x", to: "a" },
      { from: "c", to: "y" },
    ];
    expect(reach(edges, ["c"])).toEqual(["a", "b", "x"]);
    expect(reach(edges, [])).toEqual([]);
  });
});

describe("deltaModel", () => {
  it("draws the map after the change plus what it removed, each with its status", () => {
    const comparison = compareMaps(base, head);
    const delta = deltaModel(base, head, comparison);
    const status = (id: string) => delta.nodes.find((node) => node.id === id)?.status;
    expect(delta.nodes).toHaveLength(head.nodes.length + 1);
    expect(status("reports")).toBe("removed");
    expect(status("search")).toBe("added");
    const edge = (id: string) => delta.edges.find((item) => item.id === id)?.status;
    expect(edge("reports-to-db")).toBe("removed");
    expect(edge("search-to-db")).toBe("added");
  });

  it("drops a removed connection whose end is no longer drawn", () => {
    const withGhost: ArchitectureMapModel = {
      ...base,
      edges: [...base.edges, { ...base.edges[0], id: "ghost", to: "gone" }],
    };
    const delta = deltaModel(withGhost, head, compareMaps(withGhost, head));
    expect(delta.edges.find((edge) => edge.id === "ghost")).toBeUndefined();
  });
});
