import path from "node:path";
import { isCode, isTest, OTHER_PART, type MapPair } from "./generate.js";

// What a reviewer needs to know about a change beyond the picture: which files and parts it edits, what else can
// feel it, and whether tests reach it. The rules are the control repo's change-impact.mjs rules, applied to the
// head commit's import graph:
// - the blast radius is every non-test file that imports a changed file, directly or through other files;
// - a changed code file is covered when some test file reaches it, directly or through other files;
// - the nearest test is the one named after the file, then one in the same folder.
// Everything comes from the committed code at the two ends of the change; nothing is run.

export const MAX_LISTED_FILES = 300;

export type ChangedFileStatus = "added" | "modified" | "deleted";

export interface ChangedFileImpact {
  path: string;
  status: ChangedFileStatus;
  part: string;
  kind: "code" | "test" | "other";
  /** For changed code: test files that reach it (count) and the ones to open first. */
  tests: number;
  nearestTests: string[];
}

export interface PartImpact {
  id: string;
  label: string;
  added: number;
  modified: number;
  deleted: number;
}

export interface DependentPart {
  id: string;
  label: string;
  files: number;
}

export interface ChangeImpact {
  files: ChangedFileImpact[];
  filesTruncated: boolean;
  counts: {
    files: number;
    code: number;
    tests: number;
    other: number;
    added: number;
    deleted: number;
  };
  parts: PartImpact[];
  /** `direct`: files that import a changed file themselves; `files`: everything that reaches one. */
  dependents: { files: number; direct: number; parts: DependentPart[] };
  coverage: { code: number; covered: number; uncovered: string[] };
}

function reverseGraph(graph: ReadonlyMap<string, readonly string[]>): Map<string, Set<string>> {
  const reverse = new Map<string, Set<string>>();
  for (const [file, targets] of graph) {
    for (const target of targets) {
      const users = reverse.get(target) ?? new Set<string>();
      users.add(file);
      reverse.set(target, users);
    }
  }
  return reverse;
}

/** Everything that can reach `changed` through imports, `changed` itself excluded. */
export function dependentsOf(
  graph: ReadonlyMap<string, readonly string[]>,
  changed: readonly string[],
): string[] {
  const reverse = reverseGraph(graph);
  const seen = new Set<string>();
  const queue = changed.filter((f) => graph.has(f));
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) break;
    for (const user of reverse.get(next) ?? []) {
      if (!seen.has(user)) {
        seen.add(user);
        queue.push(user);
      }
    }
  }
  for (const f of changed) seen.delete(f);
  return [...seen].sort();
}

/** For each changed code file, the test files that reach it. */
export function testsReaching(
  graph: ReadonlyMap<string, readonly string[]>,
  changed: readonly string[],
): Map<string, string[]> {
  const wanted = new Set(changed);
  const reaching = new Map<string, string[]>(changed.map((f) => [f, []]));
  for (const test of [...graph.keys()].filter(isTest).sort()) {
    const seen = new Set<string>();
    const queue = [test];
    while (queue.length > 0) {
      const next = queue.shift();
      if (next === undefined) break;
      for (const out of graph.get(next) ?? []) {
        if (seen.has(out)) continue;
        seen.add(out);
        queue.push(out);
        if (wanted.has(out)) reaching.get(out)?.push(test);
      }
    }
  }
  return reaching;
}

export function nearestTests(file: string, tests: readonly string[], limit = 3): string[] {
  const stem = path.posix.basename(file).replace(/\.[^.]+$/, "");
  const dir = path.posix.dirname(file);
  const rank = (t: string) => {
    if (path.posix.basename(t).startsWith(`${stem}.`)) return 0;
    return path.posix.dirname(t) === dir ? 1 : 2;
  };
  return [...tests].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).slice(0, limit);
}

const KIND_ORDER: Record<ChangedFileImpact["kind"], number> = { code: 0, test: 1, other: 2 };

function fileKind(file: string): ChangedFileImpact["kind"] {
  if (!isCode(file)) return "other";
  return isTest(file) ? "test" : "code";
}

export function measureChangeImpact(pair: MapPair): ChangeImpact {
  const { before, after, changed } = pair;
  const labelOf = (id: string) => after.labels.get(id) ?? before.labels.get(id) ?? id;
  const status = (file: string): ChangedFileStatus => {
    if (!before.owner.has(file)) return "added";
    return after.owner.has(file) ? "modified" : "deleted";
  };
  const liveCode = changed.filter((f) => isCode(f) && !isTest(f) && after.owner.has(f));
  const reaching = testsReaching(after.graph, liveCode);

  const files: ChangedFileImpact[] = changed.map((file) => {
    const tests = reaching.get(file) ?? [];
    return {
      path: file,
      status: status(file),
      part: after.owner.get(file) ?? before.owner.get(file) ?? OTHER_PART,
      kind: fileKind(file),
      tests: tests.length,
      nearestTests: nearestTests(file, tests),
    };
  });

  const parts = new Map<string, PartImpact>();
  for (const file of files) {
    const p = parts.get(file.part) ?? {
      id: file.part,
      label: labelOf(file.part),
      added: 0,
      modified: 0,
      deleted: 0,
    };
    p[file.status] += 1;
    parts.set(file.part, p);
  }

  // Deleted code is felt by whatever imported it at the base; everything else by its users at the head.
  const deletedCode = changed.filter((f) => isCode(f) && !isTest(f) && !after.owner.has(f));
  const reached = new Set([
    ...dependentsOf(after.graph, liveCode),
    ...dependentsOf(before.graph, deletedCode),
  ]);
  const dependentFiles = [...reached].filter((f) => !isTest(f) && !changed.includes(f));
  const changedCode = new Set([...liveCode, ...deletedCode]);
  const direct = dependentFiles.filter((f) =>
    [...(after.graph.get(f) ?? []), ...(before.graph.get(f) ?? [])].some((t) => changedCode.has(t)),
  ).length;
  const byPart = new Map<string, number>();
  for (const file of dependentFiles) {
    const part = after.owner.get(file) ?? before.owner.get(file) ?? OTHER_PART;
    byPart.set(part, (byPart.get(part) ?? 0) + 1);
  }

  const codeFiles = files.filter((f) => f.kind === "code" && f.status !== "deleted");
  const uncovered = codeFiles.filter((f) => f.tests === 0).map((f) => f.path);
  const order = (a: ChangedFileImpact, b: ChangedFileImpact) =>
    KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.path.localeCompare(b.path);
  return {
    files: [...files].sort(order).slice(0, MAX_LISTED_FILES),
    filesTruncated: files.length > MAX_LISTED_FILES,
    counts: {
      files: files.length,
      code: files.filter((f) => f.kind === "code").length,
      tests: files.filter((f) => f.kind === "test").length,
      other: files.filter((f) => f.kind === "other").length,
      added: files.filter((f) => f.status === "added").length,
      deleted: files.filter((f) => f.status === "deleted").length,
    },
    parts: [...parts.values()].sort(
      (a, b) =>
        b.added + b.modified + b.deleted - (a.added + a.modified + a.deleted) ||
        a.label.localeCompare(b.label),
    ),
    dependents: {
      files: dependentFiles.length,
      direct,
      parts: [...byPart]
        .map(([id, n]) => ({ id, label: labelOf(id), files: n }))
        .sort((a, b) => b.files - a.files || a.label.localeCompare(b.label)),
    },
    coverage: {
      code: codeFiles.length,
      covered: codeFiles.length - uncovered.length,
      uncovered: uncovered.slice(0, 50),
    },
  };
}
