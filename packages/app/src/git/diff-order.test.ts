import { describe, expect, it } from "vitest";
import { orderCheckoutDiffFiles } from "./diff-order";

function createFile(path: string, additions = 0) {
  return {
    path,
    isNew: false,
    isDeleted: false,
    additions,
    deletions: 0,
    hunks: [],
  };
}

function order(paths: string[]): string[] {
  return orderCheckoutDiffFiles(paths.map((path) => createFile(path))).map((file) => file.path);
}

describe("checkout diff ordering", () => {
  it("sorts sibling files by name", () => {
    expect(order(["zeta.ts", "alpha.ts", "beta.ts"])).toEqual(["alpha.ts", "beta.ts", "zeta.ts"]);
  });

  it("puts a directory before a file that sits beside it", () => {
    expect(order(["z.ts", "a/b.ts"])).toEqual(["a/b.ts", "z.ts"]);
  });

  it("keeps loose root files below root directories", () => {
    // The reported bug: comparing whole paths byte-for-byte put ".gitlab-ci.yml"
    // first (because "." < "b"), while the tree rail listed it last.
    expect(
      order([
        ".gitlab-ci.yml",
        "process-compose.yaml",
        "bin/lib/node-stamp.sh",
        "samera-one/package.json",
      ]),
    ).toEqual([
      "bin/lib/node-stamp.sh",
      "samera-one/package.json",
      ".gitlab-ci.yml",
      "process-compose.yaml",
    ]);
  });

  it("ranks a nested directory above a shallower file with the same prefix", () => {
    // "src/a.ts" < "src/a/z.ts" as whole strings, but "a" is a directory here.
    expect(order(["src/a.ts", "src/a/z.ts"])).toEqual(["src/a/z.ts", "src/a.ts"]);
  });

  it("orders a directory ahead of a file sharing its name", () => {
    // Converting an extensionless file into a directory puts both in one diff.
    expect(order(["bin/stack", "bin/stack/run"])).toEqual(["bin/stack/run", "bin/stack"]);
  });

  it("returns lists too short to reorder untouched", () => {
    const single = [createFile("only.ts")];
    expect(orderCheckoutDiffFiles([])).toEqual([]);
    expect(orderCheckoutDiffFiles(single)).toBe(single);
  });

  it("preserves relative order for equal paths", () => {
    const ordered = orderCheckoutDiffFiles([
      createFile("same.ts", 1),
      createFile("same.ts", 2),
      createFile("same.ts", 3),
    ]);

    expect(ordered.map((file) => file.additions)).toEqual([1, 2, 3]);
  });
});

// The topology consumes actual parents, including merge and window boundaries.
import { buildCommitTopology } from "./commit-topology";
describe("commit topology", () => {
  it("joins both merge parents without inventing an edge between sibling commits", () => {
    const graph = buildCommitTopology([
      { sha: "merge", parentShas: ["left", "right"] },
      { sha: "left", parentShas: ["base"] },
      { sha: "right", parentShas: ["base"] },
      { sha: "base", parentShas: [] },
    ]);
    expect(graph.edges).toEqual([
      { from: 0, to: 1 },
      { from: 0, to: 2 },
      { from: 1, to: 3 },
      { from: 2, to: 3 },
    ]);
    expect(graph.nodes[1]?.lane).not.toBe(graph.nodes[2]?.lane);
  });
  it("marks a parent outside the visible window and leaves unrelated roots unconnected", () => {
    const graph = buildCommitTopology([
      { sha: "a", parentShas: ["missing"] },
      { sha: "root", parentShas: [] },
    ]);
    expect(graph.edges).toEqual([]);
    expect(graph.nodes[0]?.outsideParents).toEqual(["missing"]);
  });
});
