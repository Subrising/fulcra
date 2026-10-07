// Where to look first in a pull request review, and what each file change is, in plain words. Built only from the
// fields the host already returns for each file (status, kind, risk, test reach, size), so it needs no model call.

export interface ReviewFileFacts {
  path: string;
  status: "added" | "modified" | "deleted";
  kind: "code" | "test" | "other";
  risk: "LOW" | "NORMAL" | "HIGH";
  tests: number;
  additions: number;
  deletions: number;
  partLabel: string;
}

const RISK_RANK: Record<ReviewFileFacts["risk"], number> = { HIGH: 0, NORMAL: 1, LOW: 2 };
const KIND_RANK: Record<ReviewFileFacts["kind"], number> = { code: 0, test: 1, other: 2 };

/** Riskiest first, then code before tests before the rest, then the bigger change, then by path. */
export function compareReviewFiles(a: ReviewFileFacts, b: ReviewFileFacts): number {
  return (
    RISK_RANK[a.risk] - RISK_RANK[b.risk] ||
    KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
    b.additions + b.deletions - (a.additions + a.deletions) ||
    a.path.localeCompare(b.path)
  );
}

/** Groups by part, each ordered riskiest first; the group holding the riskiest file comes first. */
export function groupReviewFiles<T extends ReviewFileFacts>(files: readonly T[]): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const file of [...files].sort(compareReviewFiles))
    groups.set(file.partLabel, [...(groups.get(file.partLabel) ?? []), file]);
  return [...groups];
}

/** The file to open first, or null when nothing in the change carries risk. */
export function startHerePath(files: readonly ReviewFileFacts[]): string | null {
  const first = [...files].sort(compareReviewFiles)[0];
  return first && first.risk !== "LOW" ? first.path : null;
}

/** The i18n key (under `panels.architectureMap.review.plain`) for the file's one-line description. */
export function plainFileKey(file: ReviewFileFacts): string {
  if (file.status === "deleted") return "deleted";
  if (file.status === "added") {
    if (file.kind === "test") return "addedTest";
    return file.kind === "code" ? "addedCode" : "addedOther";
  }
  if (file.kind === "test") return "changedTest";
  if (file.kind === "other") return "changedOther";
  return file.risk === "HIGH" || file.tests === 0 ? "changedCodeUntested" : "changedCodeTested";
}
