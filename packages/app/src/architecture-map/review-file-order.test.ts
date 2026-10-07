import { describe, expect, it } from "vitest";
import {
  groupReviewFiles,
  plainFileKey,
  startHerePath,
  type ReviewFileFacts,
} from "./review-file-order";

const file = (over: Partial<ReviewFileFacts>): ReviewFileFacts => ({
  path: "src/a.ts",
  status: "modified",
  kind: "code",
  risk: "NORMAL",
  tests: 2,
  additions: 10,
  deletions: 1,
  partLabel: "App",
  ...over,
});

const paths = (groups: [string, ReviewFileFacts[]][]) =>
  groups.map(([label, group]) => [label, group.map((f) => f.path)]);

describe("review file order", () => {
  it("puts the group with the riskiest file first and orders each group riskiest first", () => {
    const files = [
      file({ path: "README.md", kind: "other", risk: "LOW", partLabel: "Docs" }),
      file({ path: "src/small.ts", additions: 2 }),
      file({ path: "src/test.test.ts", kind: "test", risk: "LOW" }),
      file({ path: "src/big.ts", additions: 80 }),
      file({ path: "server/auth.ts", risk: "HIGH", partLabel: "Server" }),
    ];
    expect(paths(groupReviewFiles(files))).toEqual([
      ["Server", ["server/auth.ts"]],
      ["App", ["src/big.ts", "src/small.ts", "src/test.test.ts"]],
      ["Docs", ["README.md"]],
    ]);
    expect(startHerePath(files)).toBe("server/auth.ts");
  });

  it("has no start-here file when every file is low risk", () => {
    expect(startHerePath([file({ risk: "LOW" }), file({ path: "b", risk: "LOW" })])).toBeNull();
  });

  it("describes each kind of change in plain words", () => {
    expect(plainFileKey(file({ status: "added", kind: "test" }))).toBe("addedTest");
    expect(plainFileKey(file({ status: "added" }))).toBe("addedCode");
    expect(plainFileKey(file({ status: "added", kind: "other" }))).toBe("addedOther");
    expect(plainFileKey(file({ status: "deleted" }))).toBe("deleted");
    expect(plainFileKey(file({ kind: "test" }))).toBe("changedTest");
    expect(plainFileKey(file({ kind: "other" }))).toBe("changedOther");
    expect(plainFileKey(file({ risk: "HIGH" }))).toBe("changedCodeUntested");
    expect(plainFileKey(file({ tests: 0 }))).toBe("changedCodeUntested");
    expect(plainFileKey(file({}))).toBe("changedCodeTested");
  });
});
