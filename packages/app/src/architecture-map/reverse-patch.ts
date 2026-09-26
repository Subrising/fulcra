// The app reads files only from the working tree, so it rebuilds the map as it was at the branch's
// base by undoing the branch's own diff of that file: every hunk says which lines it added and which it
// removed, with their line numbers on both sides. Undoing it is exact for a line diff taken with
// whitespace changes included, except for one thing: the daemon's parser drops git's "\ No newline
// at end of file" marker, so whether the base's last line ended in a newline is taken from the head.
// A map is JSON, which parses the same either way. If the hunks do not match the file (it changed
// after the diff was taken, or the diff was cut short), the result is refused rather than guessed.

export interface PatchLine {
  type: "add" | "remove" | "context" | "header";
  content: string;
}

export interface PatchHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: PatchLine[];
}

export interface PatchFile {
  isNew: boolean;
  isDeleted: boolean;
  hunks: PatchHunk[];
  status?: "ok" | "too_large" | "binary";
}

export type BaseText =
  | { kind: "ok"; text: string | null }
  | { kind: "unavailable"; reason: "too_large" | "binary" | "mismatch" };

/**
 * The file's text before the diff. `headText` is null when the file no longer exists. A result of
 * `text: null` means the file did not exist at the base.
 */
export function reverseApply(headText: string | null, file: PatchFile): BaseText {
  if (file.status === "too_large" || file.status === "binary") {
    return { kind: "unavailable", reason: file.status };
  }
  if (file.isNew) return { kind: "ok", text: null };
  const trailingNewline = headText === null || headText.endsWith("\n");
  const lines = headText === null || headText === "" ? [] : headText.replace(/\n$/, "").split("\n");
  // Bottom-up, so each hunk's new-side line numbers still hold when it is undone.
  const hunks = [...file.hunks].sort((a, b) => b.newStart - a.newStart);
  for (const hunk of hunks) {
    const body = hunk.lines.filter((line) => line.type !== "header");
    const newSide = body.filter((line) => line.type !== "remove").map((line) => line.content);
    const oldSide = body.filter((line) => line.type !== "add").map((line) => line.content);
    if (newSide.length !== hunk.newCount || oldSide.length !== hunk.oldCount) {
      return { kind: "unavailable", reason: "mismatch" };
    }
    // A hunk with no new-side lines names the line BEFORE the gap, so it starts one line later.
    const at = hunk.newCount === 0 ? hunk.newStart : hunk.newStart - 1;
    const current = lines.slice(at, at + hunk.newCount);
    if (at < 0 || at > lines.length || current.length !== newSide.length) {
      return { kind: "unavailable", reason: "mismatch" };
    }
    if (current.some((line, index) => line !== newSide[index])) {
      return { kind: "unavailable", reason: "mismatch" };
    }
    lines.splice(at, hunk.newCount, ...oldSide);
  }
  if (lines.length === 0) return { kind: "ok", text: "" };
  return { kind: "ok", text: lines.join("\n") + (trailingNewline ? "\n" : "") };
}
