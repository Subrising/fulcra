import {
  assessStaleness,
  changedCodeFiles,
  citedSources,
  hasTestBeside,
  parentDirectory,
  type Staleness,
} from "./change-summary";
import { parseArchitectureIr, type ArchitectureMapModel } from "./ir-model";
import { compareMaps, deltaModel, type DeltaModel, type MapComparison } from "./map-diff";
import { reverseApply, type PatchFile } from "./reverse-patch";

// Everything the Change view shows, built from what the app can read: the map as it is now (the
// branch tip), the branch's diff against its base, and directory listings beside changed code.
//
// A pull request is never reconstructed this way (CONTRACTS v1.14, R-C-J7-2). Its Before/After
// are the maps at the pull request's own commits: the merge base of its base and head, and its
// head, read through the host (`checkout.file-at-commit.get`, CONTRACTS v1.16). Nothing on this
// computer that isn't committed can change them. On a host without that interface, or when the
// forge gives no commits, the comparison is reported as unavailable, never rebuilt locally.

export interface ChangedFile {
  path: string;
  oldPath?: string;
  isDeleted: boolean;
}

export interface ArchitectureChangeInput {
  mapPath: string;
  /** The map's current text, or null when the branch deleted it. */
  headText: string | null;
  /** The map's own entry in the branch diff; null when the branch did not change it. */
  mapDiff: PatchFile | null;
  changedFiles: readonly ChangedFile[];
  /** Directory -> file names, for the directories that were checked. */
  siblings: ReadonlyMap<string, readonly string[]>;
  pullRequest: { number?: number } | null;
  /** For a pull request: the map read at its merge base and head commits, or why it could not be. */
  pullRequestMaps?: PullRequestMaps | null;
}

/** The map as read at a pull request's commits. A null text means the map is not in that commit. */
export type PullRequestMaps =
  | { kind: "ok"; base: string | null; head: string | null }
  | { kind: "unavailable"; reason: "pull-request" | "too_large" | "commit-read"; detail: string[] };

/** One host answer (`checkout.file-at-commit.get`) as map text: missing means "not in that commit". */
export interface FileAtCommitAnswer {
  status: "ok" | "missing" | "too_large" | "not_a_file" | "error";
  encoding: "utf-8" | "base64" | "none";
  content?: string;
  error?: string;
}
export function mapTextAtCommit(
  answer: FileAtCommitAnswer,
):
  | { kind: "ok"; text: string | null }
  | { kind: "unavailable"; reason: "too_large" | "commit-read"; detail: string[] } {
  if (answer.status === "missing") return { kind: "ok", text: null };
  if (answer.status === "too_large")
    return { kind: "unavailable", reason: "too_large", detail: [] };
  if (answer.status !== "ok" || answer.content === undefined)
    return {
      kind: "unavailable",
      reason: "commit-read",
      detail: answer.error ? [answer.error] : [],
    };
  if (answer.encoding === "utf-8") return { kind: "ok", text: answer.content };
  if (answer.encoding === "base64") {
    const bytes = Uint8Array.from(atob(answer.content), (c) => c.charCodeAt(0));
    return { kind: "ok", text: new TextDecoder("utf-8").decode(bytes) };
  }
  return { kind: "unavailable", reason: "commit-read", detail: [] };
}

const COMMIT = /^[0-9a-f]{40}$/;

/**
 * Whether a pull request can be compared at its own commits: the host offers
 * `checkout.file-at-commit.get` (CONTRACTS v1.16) and the forge gave both commits.
 */
export function pullRequestReadable(
  hostCanRead: boolean,
  pullRequest: { baseRefOid: string | null; headRefOid: string | null } | null,
): { base: string; head: string } | null {
  if (!hostCanRead || !pullRequest) return null;
  const { baseRefOid: base, headRefOid: head } = pullRequest;
  return base && head && COMMIT.test(base) && COMMIT.test(head) ? { base, head } : null;
}

export type ArchitectureChange =
  | {
      kind: "ready";
      base: ArchitectureMapModel | null;
      head: ArchitectureMapModel | null;
      comparison: MapComparison;
      delta: DeltaModel;
      staleness: Staleness;
      files: { changed: number; code: number; withTests: number; checked: number };
      pullRequest: { number?: number } | null;
    }
  | {
      kind: "unavailable";
      reason:
        | "too_large"
        | "binary"
        | "mismatch"
        | "invalid"
        | "pull-request"
        | "commit-read"
        | "not-in-pull-request";
      detail: string[];
    };

const encoder = new TextEncoder();

function parse(text: string | null): ArchitectureMapModel | null | { invalid: string[] } {
  if (text === null) return null;
  const result = parseArchitectureIr(encoder.encode(text));
  if (result.kind === "ok") return result.model;
  if (result.kind === "too_large") return { invalid: ["document: larger than 1 MiB"] };
  return { invalid: result.reasons };
}

const isInvalid = (value: unknown): value is { invalid: string[] } =>
  typeof value === "object" && value !== null && "invalid" in value;

export function buildArchitectureChange(input: ArchitectureChangeInput): ArchitectureChange {
  const texts = sideTexts(input);
  if (texts.kind === "unavailable") return texts;
  const head = parse(texts.head);
  const base = parse(texts.base);
  if (isInvalid(head)) return { kind: "unavailable", reason: "invalid", detail: head.invalid };
  if (isInvalid(base)) return { kind: "unavailable", reason: "invalid", detail: base.invalid };

  const comparison = compareMaps(base, head);
  const changedPaths = input.changedFiles.flatMap((file) =>
    file.oldPath && file.oldPath !== file.path ? [file.path, file.oldPath] : [file.path],
  );
  const staleness = assessStaleness({ changedPaths, cited: citedSources(head ?? base) });
  const code = changedCodeFiles(input.changedFiles);
  const checked = code.filter((path) => input.siblings.has(parentDirectory(path)));
  const withTests = checked.filter((path) =>
    hasTestBeside(path, input.siblings.get(parentDirectory(path)) ?? []),
  ).length;
  return {
    kind: "ready",
    base,
    head,
    comparison,
    delta: deltaModel(base, head, comparison),
    staleness,
    files: {
      changed: input.changedFiles.length,
      code: code.length,
      withTests,
      checked: checked.length,
    },
    pullRequest: input.pullRequest,
  };
}

// The two sides to compare. A pull request uses only the texts read at its commits; a branch
// without one is rebuilt from its current map and its own diff.
function sideTexts(
  input: ArchitectureChangeInput,
):
  | { kind: "ok"; base: string | null; head: string | null }
  | Extract<ArchitectureChange, { kind: "unavailable" }> {
  if (input.pullRequest !== null) {
    const maps = input.pullRequestMaps ?? null;
    if (maps === null) return { kind: "unavailable", reason: "pull-request", detail: [] };
    if (maps.kind === "unavailable") return maps;
    if (maps.base === null && maps.head === null)
      return { kind: "unavailable", reason: "not-in-pull-request", detail: [] };
    return { kind: "ok", base: maps.base, head: maps.head };
  }
  const baseText = input.mapDiff
    ? reverseApply(input.headText, input.mapDiff)
    : { kind: "ok" as const, text: input.headText };
  if (baseText.kind === "unavailable")
    return { kind: "unavailable", reason: baseText.reason, detail: [] };
  return { kind: "ok", base: baseText.text, head: input.headText };
}

/** The directories whose listings answer "has a test beside it", capped so the view stays cheap. */
export const MAX_DIRECTORIES_CHECKED = 20;
export function directoriesToCheck(changed: readonly ChangedFile[]): string[] {
  return [...new Set(changedCodeFiles(changed).map(parentDirectory))]
    .sort()
    .slice(0, MAX_DIRECTORIES_CHECKED);
}
