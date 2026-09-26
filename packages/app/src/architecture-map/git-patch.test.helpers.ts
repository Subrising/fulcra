import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PatchFile, PatchHunk } from "./reverse-patch";

// Real `git diff` output, parsed by the same rules as the daemon's parser
// (packages/server/src/server/utils/diff-highlighter.ts parseSectionBody): "@@" starts a hunk with a
// header line, "+"/"-"/" " are add/remove/context, "\ No newline" is skipped.
export function parse(diffText: string): PatchFile {
  const hunks: PatchHunk[] = [];
  let current: PatchHunk | null = null;
  for (const line of diffText.split("\n")) {
    const header = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (header) {
      current = {
        oldStart: Number(header[1]),
        oldCount: Number(header[2] ?? "1"),
        newStart: Number(header[3]),
        newCount: Number(header[4] ?? "1"),
        lines: [{ type: "header", content: line }],
      };
      hunks.push(current);
      continue;
    }
    if (!current || line.startsWith("\\")) continue;
    if (line.startsWith("+")) current.lines.push({ type: "add", content: line.slice(1) });
    else if (line.startsWith("-")) current.lines.push({ type: "remove", content: line.slice(1) });
    else if (line.startsWith(" ")) current.lines.push({ type: "context", content: line.slice(1) });
  }
  return { isNew: false, isDeleted: false, hunks };
}

export function gitDiff(before: string, after: string, context = 3): PatchFile {
  const dir = mkdtempSync(join(tmpdir(), "git-reverse-"));
  try {
    writeFileSync(join(dir, "a"), before);
    writeFileSync(join(dir, "b"), after);
    let out = "";
    try {
      execFileSync("git", ["diff", "--no-index", `-U${context}`, "a", "b"], {
        cwd: dir,
        encoding: "utf8",
      });
    } catch (error) {
      out = String((error as { stdout?: string }).stdout ?? "");
    }
    return parse(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
