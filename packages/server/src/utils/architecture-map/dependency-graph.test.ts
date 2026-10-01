import { describe, expect, it } from "vitest";
import { graphFromMap } from "./dependency-graph.js";
import { mapForSnapshot, type Snapshot } from "./generate.js";

function snapshot(files: Record<string, string>): Snapshot {
  const entries = Object.entries(files);
  return {
    commit: "a".repeat(40),
    files: entries.map(([path, text]) => ({ path, blob: `${path}:${text}` })),
    texts: new Map(entries),
  };
}

const repo = {
  "packages/protocol/package.json": '{"name":"@shop/protocol"}',
  "packages/protocol/src/index.ts": "export const v = 1;",
  "packages/protocol/src/a.ts": "export const a = 1;",
  "packages/protocol/src/b.ts": "export const b = 1;",
  "packages/client/package.json": '{"name":"@shop/client"}',
  "packages/client/src/index.ts": 'import { v } from "@shop/protocol";\nexport const c = v;',
  "packages/client/src/socket.ts": 'import { v } from "@shop/protocol";\nexport const s = v;',
  "packages/client/src/retry.ts": "export const r = 1;",
  "packages/client/src/socket.test.ts": 'import { v } from "@shop/protocol";\nv;',
};

describe("code dependency graph", () => {
  it("keeps every import between parts with its weight, and never counts tests", () => {
    const built = mapForSnapshot(snapshot(repo));
    const graph = graphFromMap(
      built,
      built.ir.ownership.map((o) => o.folder),
    );
    expect(graph.nodes.map((n) => n.id)).toEqual(["packages.client", "packages.protocol"]);
    // Two imports from client code; the test file's import is coverage, not structure.
    expect(graph.edges).toEqual([{ from: "packages.client", to: "packages.protocol", imports: 2 }]);
    const client = graph.nodes.find((n) => n.id === "packages.client");
    expect(client).toMatchObject({
      code: 3,
      tests: 1,
      files: 5,
      kind: "frontend",
      group: "client",
    });
    expect(graph.highlighted).toEqual([]);
  });

  it("marks the parts a change edits", () => {
    const built = mapForSnapshot(snapshot(repo));
    const graph = graphFromMap(built, [], ["packages.client", "other-files"], 3);
    expect(graph.highlighted).toEqual(["packages.client"]);
    expect(graph.changedFiles).toBe(3);
  });
});
