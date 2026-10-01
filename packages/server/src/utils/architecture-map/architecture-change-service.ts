import { measureChangeImpact, type ChangeImpact } from "./blast-radius.js";
import { GENERATOR_RULES, pairFromSnapshots } from "./generate.js";
import { hasCommit, mergeBase, readCommitSnapshot } from "./read-commit.js";

// Generated Before/After maps for a change, and its blast radius, cached by the commits they were drawn from.
// A change is identified by (repository, merge base, head): the same pull request at the same commits is
// generated once, and a new push (a new head) is a new entry. `prewarm` is how a tracked pull request is mapped
// before anyone opens it: the pull request status path calls it whenever it learns a pull request's commits.

export interface GeneratedChange {
  base: string;
  head: string;
  rules: number;
  generatedAt: string;
  before: string;
  after: string;
  impact: ChangeImpact;
  elapsedMs: number;
}

export type ArchitectureChangeResult =
  | { kind: "ok"; change: GeneratedChange }
  | { kind: "missing-commits"; missing: string[] }
  | { kind: "no-merge-base" };

const MAX_ENTRIES = 24;
const cache = new Map<string, Promise<GeneratedChange>>();

function remember(key: string, value: Promise<GeneratedChange>): Promise<GeneratedChange> {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  // A failed generation is not cached, so the next request tries again.
  value.catch(() => {
    if (cache.get(key) === value) cache.delete(key);
  });
  return value;
}

async function generate(input: {
  cwd: string;
  base: string;
  head: string;
  title: string;
}): Promise<GeneratedChange> {
  const started = Date.now();
  const [before, after] = await Promise.all([
    readCommitSnapshot(input.cwd, input.base),
    readCommitSnapshot(input.cwd, input.head),
  ]);
  const pair = pairFromSnapshots(before, after, { title: input.title });
  return {
    base: input.base,
    head: input.head,
    rules: GENERATOR_RULES,
    generatedAt: new Date().toISOString(),
    before: JSON.stringify(pair.before.ir),
    after: JSON.stringify(pair.after.ir),
    impact: measureChangeImpact(pair),
    elapsedMs: Date.now() - started,
  };
}

/**
 * The generated change between the merge base of `base` and `head`, and `head`. Commits must already be in the
 * repository; this never fetches.
 */
export async function getArchitectureChange(input: {
  cwd: string;
  base: string;
  head: string;
  title: string;
}): Promise<ArchitectureChangeResult> {
  const missing: string[] = [];
  for (const sha of [input.base, input.head]) {
    if (!(await hasCommit(input.cwd, sha))) missing.push(sha);
  }
  if (missing.length > 0) return { kind: "missing-commits", missing };
  const start = await mergeBase(input.cwd, input.base, input.head);
  if (!start) return { kind: "no-merge-base" };
  const key = `${input.cwd}\0${start}\0${input.head}\0${GENERATOR_RULES}`;
  const known = cache.get(key);
  const change = await (known ??
    remember(key, generate({ cwd: input.cwd, base: start, head: input.head, title: input.title })));
  return { kind: "ok", change };
}

/** Map a tracked change in the background when its commits become known. Errors are dropped. */
export function prewarmArchitectureChange(input: {
  cwd: string;
  base: string | null | undefined;
  head: string | null | undefined;
  title: string;
}): void {
  const { base, head } = input;
  if (!base || !head) return;
  void getArchitectureChange({ cwd: input.cwd, base, head, title: input.title }).catch(() => {});
}

export function clearArchitectureChangeCache(): void {
  cache.clear();
}
