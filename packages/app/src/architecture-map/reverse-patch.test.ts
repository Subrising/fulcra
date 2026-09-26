import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gitDiff } from "./git-patch.test.helpers";
import { reverseApply } from "./reverse-patch";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", name), "utf8");
const lines = (n: number, prefix = "line") =>
  Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join("\n") + "\n";

describe("reverseApply", () => {
  it("rebuilds the base map exactly from the head map and the branch diff", () => {
    const base = fixture("change-base.ir.json");
    const head = fixture("change-head.ir.json");
    expect(reverseApply(head, gitDiff(base, head))).toEqual({ kind: "ok", text: base });
  });

  it.each([
    ["insertions only", lines(20), lines(20).replace("line 10\n", "line 10\nnew a\nnew b\n")],
    ["deletions only", lines(20), lines(20).replace("line 5\nline 6\n", "")],
    ["change at the very top", lines(20), `first\n${lines(20).slice("line 1\n".length)}`],
    ["change at the very end", lines(20), lines(20).replace("line 20\n", "last\n")],
    [
      "many separate hunks",
      lines(60),
      lines(60).replace("line 3\n", "x\n").replace("line 30\n", "y\n").replace("line 58\n", ""),
    ],
    ["no newline at the end, added", "a\nb", "a\nb\nc\n"],
    ["no newline at the end, kept", "a\nb\n", "a\nc"],
    ["emptied file", "a\nb\n", ""],
  ])("%s", (_name, before, after) => {
    // Exact up to the final newline, which the daemon's parser does not report (see the module).
    const trim = (text: string | null) => text?.replace(/\n$/, "") ?? null;
    for (const context of [3, 0]) {
      const result = reverseApply(after, gitDiff(before, after, context));
      expect(result.kind).toBe("ok");
      expect(result.kind === "ok" ? trim(result.text) : null).toBe(trim(before));
    }
  });

  it("a file new in the branch had no base; a deleted file is rebuilt from its removed lines", () => {
    expect(reverseApply("a\n", { isNew: true, isDeleted: false, hunks: [] })).toEqual({
      kind: "ok",
      text: null,
    });
    const deleted = { ...gitDiff("a\nb\n", ""), isDeleted: true };
    expect(reverseApply(null, deleted)).toEqual({ kind: "ok", text: "a\nb\n" });
  });

  it("refuses when the hunks do not match the file, instead of guessing", () => {
    const before = lines(20);
    const after = before.replace("line 10\n", "changed\n");
    const patch = gitDiff(before, after);
    expect(reverseApply(after.replace("line 9\n", "edited since\n"), patch)).toEqual({
      kind: "unavailable",
      reason: "mismatch",
    });
    const cut = {
      ...patch,
      hunks: [{ ...patch.hunks[0], lines: patch.hunks[0].lines.slice(0, 3) }],
    };
    expect(reverseApply(after, cut)).toEqual({ kind: "unavailable", reason: "mismatch" });
    expect(reverseApply(after, { ...patch, status: "too_large", hunks: [] })).toEqual({
      kind: "unavailable",
      reason: "too_large",
    });
  });
});
