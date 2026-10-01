import {
  GENERATOR_RULES,
  isCode,
  isTest,
  mapForSnapshot,
  OTHER_PART,
  pairFromSnapshots,
  type BuiltMap,
} from "./generate.js";
import { hasCommit, mergeBase, readCommitSnapshot } from "./read-commit.js";
import { runGitCommand } from "../run-git-command.js";

// The whole repository as a module graph (Code Dependency Map): the same parts and rules as the generated
// architecture map, but every import between parts is kept with its weight, so the app can filter, search and
// light up a module's dependencies and dependents itself. Drawn at the default branch's head, or at a pull
// request's head with the parts it edits marked. Read from git objects only; results are cached by commit.

export const GRAPH_BUDGET = 60;

export interface GraphNode {
  id: string;
  label: string;
  folder: string;
  kind: string;
  group: string;
  files: number;
  code: number;
  tests: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  imports: number;
}

export interface DependencyGraph {
  commit: string;
  rules: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Parts the pull request edits (empty for the default branch). */
  highlighted: string[];
  changedFiles: number;
}

const TAG = /^(\d+) code · (\d+) tests$/;

/** Every import between two different parts, with how many imports it carries. Tests never count. */
export function partEdges(built: BuiltMap, partDirs: readonly string[]): GraphEdge[] {
  const byDir = new Map<string, string>(built.ir.ownership.map((o) => [o.folder, o.part]));
  const partFor = (target: string): string | undefined => {
    if (!target.endsWith("/")) return built.owner.get(target);
    let best: string | null = null;
    for (const dir of partDirs) {
      const inside = dir === "" || `${target}index.ts`.startsWith(`${dir}/`);
      if (inside && (best === null || dir.length > best.length)) best = dir;
    }
    return best === null ? undefined : byDir.get(best);
  };
  const weights = new Map<string, number>();
  for (const [file, targets] of built.graph) {
    if (isTest(file)) continue;
    const from = built.owner.get(file);
    for (const target of targets) {
      const to = partFor(target);
      if (!from || !to || from === to || from === OTHER_PART || to === OTHER_PART) continue;
      const key = `${from}\0${to}`;
      weights.set(key, (weights.get(key) ?? 0) + 1);
    }
  }
  return [...weights]
    .map(([key, imports]) => {
      const [from, to] = key.split("\0");
      return { from, to, imports };
    })
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

export function graphFromMap(
  built: BuiltMap,
  plan: readonly string[],
  highlighted: readonly string[] = [],
  changedFiles = 0,
): DependencyGraph {
  const folderOf = new Map(built.ir.ownership.map((o) => [o.part, o.folder]));
  const files = new Map<string, number>();
  for (const part of built.owner.values()) files.set(part, (files.get(part) ?? 0) + 1);
  const nodes = built.ir.components
    .filter((c) => c.id !== OTHER_PART)
    .map((c) => {
      const counts = TAG.exec(c.tag);
      return {
        id: c.id,
        label: c.label,
        folder: folderOf.get(c.id) ?? "",
        kind: c.type,
        group: c.label.split(" › ")[0],
        files: files.get(c.id) ?? 0,
        code: counts ? Number(counts[1]) : 0,
        tests: counts ? Number(counts[2]) : 0,
        x: c.pos[0],
        y: c.pos[1],
        width: c.size[0],
        height: c.size[1],
      };
    });
  return {
    commit: built.ir.generated.commit,
    rules: GENERATOR_RULES,
    nodes,
    edges: partEdges(built, plan),
    highlighted: [...highlighted].filter((id) => id !== OTHER_PART).sort(),
    changedFiles,
  };
}

const cache = new Map<string, Promise<DependencyGraph>>();
const MAX_ENTRIES = 12;
function remember(key: string, make: () => Promise<DependencyGraph>): Promise<DependencyGraph> {
  const known = cache.get(key);
  if (known) return known;
  const value = make();
  cache.set(key, value);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  value.catch(() => {
    if (cache.get(key) === value) cache.delete(key);
  });
  return value;
}

const GIT_ENV = { GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };
const SHA40 = /^[0-9a-f]{40}$/;

/** The default branch's head as this repository knows it (origin/HEAD, else HEAD); never fetches. */
export async function defaultBranchHead(
  cwd: string,
): Promise<{ commit: string; ref: string } | null> {
  const symbolic = await runGitCommand(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], {
    cwd,
    envOverlay: GIT_ENV,
    acceptExitCodes: [0, 1, 128],
  });
  const refs =
    symbolic.exitCode === 0 && symbolic.stdout.trim() ? [symbolic.stdout.trim(), "HEAD"] : ["HEAD"];
  for (const ref of refs) {
    const parsed = await runGitCommand(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      cwd,
      envOverlay: GIT_ENV,
      acceptExitCodes: [0, 1, 128],
    });
    const commit = parsed.stdout.trim();
    if (parsed.exitCode === 0 && SHA40.test(commit)) {
      return { commit, ref: ref.replace(/^refs\/remotes\/origin\//, "") };
    }
  }
  return null;
}

export async function graphAtCommit(cwd: string, commit: string): Promise<DependencyGraph> {
  return remember(`${cwd}\0${commit}\0${GENERATOR_RULES}`, async () => {
    const snapshot = await readCommitSnapshot(cwd, commit);
    const built = mapForSnapshot(snapshot, { budget: GRAPH_BUDGET });
    return graphFromMap(
      built,
      built.ir.ownership.map((o) => o.folder),
    );
  });
}

export type ChangeGraphResult =
  | { kind: "ok"; graph: DependencyGraph }
  | { kind: "missing-commits" }
  | { kind: "no-merge-base" };

/** The graph at a change's head, split where the change is, with the parts it edits highlighted. */
export async function graphForChange(input: {
  cwd: string;
  base: string;
  head: string;
}): Promise<ChangeGraphResult> {
  const { cwd, base, head } = input;
  if (!(await hasCommit(cwd, base)) || !(await hasCommit(cwd, head))) {
    return { kind: "missing-commits" };
  }
  const start = await mergeBase(cwd, base, head);
  if (!start) return { kind: "no-merge-base" };
  const graph = await remember(`${cwd}\0${start}\0${head}\0${GENERATOR_RULES}`, async () => {
    const [before, after] = await Promise.all([
      readCommitSnapshot(cwd, start),
      readCommitSnapshot(cwd, head),
    ]);
    const pair = pairFromSnapshots(before, after, { budget: GRAPH_BUDGET });
    const edited = new Set<string>();
    for (const file of pair.changed) {
      const part = pair.after.owner.get(file) ?? pair.before.owner.get(file);
      if (part && isCode(file)) edited.add(part);
    }
    return graphFromMap(pair.after, pair.plan, [...edited], pair.changed.length);
  });
  return { kind: "ok", graph };
}
