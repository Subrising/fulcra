// "Look here" flags and the "Before you approve" checklist for a pull request review. Rule-based over the lines a
// change adds or removes, plus the automated review's own findings, so they need no model call and read the same for
// every reviewer. Each rule is deliberately narrow: a flag is a place to look, not a verdict.
import type { ReviewFileFacts } from "./review-file-order";

export type ReviewFlagKind =
  | "network-no-timeout"
  | "deleted-test"
  | "credentials"
  | "writes-disk"
  | "large-function"
  | "finding";

export interface ReviewFlag {
  kind: ReviewFlagKind;
  /** Line in the new file (the old file for a removed test); null when the flag is about the whole file. */
  line: number | null;
  /** The line itself, trimmed and cut short, or the finding's message. */
  text: string;
}

interface DiffLine {
  type: "add" | "remove" | "context" | "header";
  content: string;
}
interface DiffHunk {
  oldStart: number;
  newStart: number;
  lines: readonly DiffLine[];
}
export interface ReviewDiff {
  isDeleted: boolean;
  hunks: readonly DiffHunk[];
}

export const FLAG_LABEL: Record<ReviewFlagKind, string> = {
  "network-no-timeout": "Network call without a timeout",
  "deleted-test": "Test removed",
  credentials: "Passwords, keys or permissions",
  "writes-disk": "Writes or deletes files",
  "large-function": "Large new function",
  finding: "Automated review finding",
};

const NETWORK =
  /\b(fetch|axios(?:\.\w+)?|got|urlopen|http\.request|https\.request|requests\.(?:get|post|put|patch|delete))\s*\(/;
const TIMEOUT = /timeout|signal|AbortSignal|deadline/i;
// Underscores count as a boundary, so names like WEATHER_API_KEY match.
const CREDENTIALS =
  /(?:^|[^a-z0-9])(password|passwd|secret|token|api[_-]?key|credential|keychain|private[_-]?key|chmod|chown|setuid|sudo)(?![a-z0-9])/i;
const WRITES =
  /\b(writeFile(?:Sync)?|appendFile(?:Sync)?|createWriteStream|rmSync|unlinkSync|renameSync|fs\.(?:rm|unlink|rename|mkdir|writeFile|appendFile)|shutil\.rmtree|os\.remove)\s*\(/;
const TEST_CASE = /^\s*(?:it|test|describe)(?:\.\w+)?\s*\(|^\s*def test_\w+\s*\(/;
const FUNCTION_START =
  /\bfunction\s+\w+\s*\(|=>\s*\{\s*$|^\s*(?:export\s+)?(?:async\s+)?def\s+\w+\s*\(|^\s*(?:public|private|protected|static|async)?\s*\w+\s*\([^)]*\)\s*\{\s*$/;
const LARGE_FUNCTION = 60;
const PER_KIND = 3;
const COMMENT = /^\s*(?:\/\/|#|\*|\/\*)/;

const snippet = (content: string) => {
  const text = content.trim();
  return text.length > 100 ? `${text.slice(0, 99)}…` : text;
};

/** Flags for one file's diff, at most a few per kind, in line order. */
export function reviewFlags(
  diff: ReviewDiff | null,
  file: Pick<ReviewFileFacts, "kind" | "status">,
  findings: readonly { line?: number; message: string }[] = [],
): ReviewFlag[] {
  const flags: ReviewFlag[] = [];
  const add = (flag: ReviewFlag) => {
    if (flags.filter((f) => f.kind === flag.kind).length < PER_KIND) flags.push(flag);
  };
  if (file.kind === "test" && (file.status === "deleted" || diff?.isDeleted))
    add({ kind: "deleted-test", line: null, text: "This whole test file is deleted" });
  for (const hunk of diff?.hunks ?? []) {
    let oldLine = hunk.oldStart,
      newLine = hunk.newStart;
    const lines = hunk.lines.filter((l) => l.type !== "header");
    let run: { start: number; length: number; opens: boolean } | null = null;
    const closeRun = () => {
      if (run && run.opens && run.length >= LARGE_FUNCTION)
        add({
          kind: "large-function",
          line: run.start,
          text: `${run.length} new lines in one block`,
        });
      run = null;
    };
    lines.forEach((line, index) => {
      if (line.type === "add") {
        const content = line.content;
        if (!COMMENT.test(content)) {
          if (NETWORK.test(content)) {
            const nearby = lines
              .slice(index, index + 3)
              .filter((l) => l.type === "add")
              .map((l) => l.content)
              .join("\n");
            if (!TIMEOUT.test(nearby))
              add({ kind: "network-no-timeout", line: newLine, text: snippet(content) });
          }
          if (CREDENTIALS.test(content))
            add({ kind: "credentials", line: newLine, text: snippet(content) });
          if (WRITES.test(content))
            add({ kind: "writes-disk", line: newLine, text: snippet(content) });
        }
        if (!run) run = { start: newLine, length: 0, opens: false };
        run.length += 1;
        if (run.length <= 3 && FUNCTION_START.test(content)) run.opens = true;
        newLine += 1;
        return;
      }
      closeRun();
      if (line.type === "remove") {
        if (TEST_CASE.test(line.content))
          add({ kind: "deleted-test", line: oldLine, text: snippet(line.content) });
        oldLine += 1;
        return;
      }
      oldLine += 1;
      newLine += 1;
    });
    closeRun();
  }
  for (const finding of findings)
    add({ kind: "finding", line: finding.line ?? null, text: snippet(finding.message) });
  return flags.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
}

const BUILD_FILE =
  /(^|\/)(\.github\/|package\.json$|package-lock\.json$|pnpm-lock\.yaml$|yarn\.lock$|Cargo\.(toml|lock)$|go\.(mod|sum)$|requirements[^/]*\.txt$|pyproject\.toml$|Dockerfile|docker-compose[^/]*\.ya?ml$|Makefile$|\.gitlab-ci\.yml$)/;

export type CheckState = "ok" | "look" | "unknown";
export interface CheckItem {
  key: "flags" | "tests" | "build" | "parts";
  state: CheckState;
  text: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function flagsCheck(opened: number, total: number, flagged: number): CheckItem {
  if (opened === 0)
    return { key: "flags", state: "unknown", text: "Open a file to check it for places to look" };
  const of = opened < total ? ` of ${total}` : "";
  if (flagged)
    return {
      key: "flags",
      state: "look",
      text: `${plural(flagged, "place")} to look at in ${plural(opened, "opened file")}${of}`,
    };
  return {
    key: "flags",
    state: "ok",
    text: `Nothing flagged in ${plural(opened, "opened file")}${of}`,
  };
}

/**
 * The "Before you approve" list. Flags come only from the files the reviewer has opened (each file's diff is read
 * when opened), so the line says how many were checked rather than claiming the whole change is clean.
 */
export function beforeYouApprove(input: {
  files: readonly Pick<ReviewFileFacts, "path" | "kind" | "status" | "partLabel">[];
  flagsByPath: ReadonlyMap<string, readonly ReviewFlag[]>;
}): CheckItem[] {
  const { files, flagsByPath } = input;
  const opened = files.filter((f) => flagsByPath.has(f.path));
  const flagged = opened.reduce((n, f) => n + (flagsByPath.get(f.path)?.length ?? 0), 0);
  const code = files.filter((f) => f.kind === "code" && f.status !== "deleted");
  const tests = files.filter((f) => f.kind === "test" && f.status !== "deleted");
  const build = files.filter((f) => BUILD_FILE.test(f.path));
  const parts = new Set(files.filter((f) => f.kind === "code").map((f) => f.partLabel));
  const flagsItem = flagsCheck(opened.length, files.length, flagged);
  let testsItem: CheckItem;
  if (!code.length) testsItem = { key: "tests", state: "ok", text: "No code changed" };
  else if (tests.length)
    testsItem = {
      key: "tests",
      state: "ok",
      text: `Tests changed alongside the code (${plural(tests.length, "test file")})`,
    };
  else testsItem = { key: "tests", state: "look", text: "Code changed but no test file did" };
  return [
    flagsItem,
    testsItem,
    build.length
      ? {
          key: "build",
          state: "look",
          text: `Also changes build or dependency files: ${build.map((f) => f.path).join(", ")}`,
        }
      : { key: "build", state: "ok", text: "No build or dependency files changed" },
    {
      key: "parts",
      state: parts.size > 1 ? "look" : "ok",
      text: parts.size
        ? `Touches ${plural(parts.size, "part")} of the map: ${[...parts].join(", ")}`
        : "Touches no part of the map",
    },
  ];
}
