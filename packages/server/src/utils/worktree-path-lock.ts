import { AsyncLocalStorage } from "node:async_hooks";
import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";

// FU-679: worktree removal takes an exclusive hold on its path. Agent create, workspace open and
// terminal create take a shared hold on their cwd. A removal waits until no shared hold is inside
// its path, and blocks new shared holds inside its path until it ends. Shared holds do not block
// each other, so normal work is not serialized. One daemon process owns all holds on a host.
//
// A shared hold registers in the same tick with its lexical path, so callers keep their timing,
// and adds its real path when realpath resolves. A removal waits for those real paths before it
// checks the shared holds, and holds both the real path and the caller's spelling of the path.

interface Hold {
  paths: string[];
  ready: Promise<void>;
}

const sharedHolds = new Set<Hold>();
// The use holds of the current async context. Nested work on a covered path runs at once, so a
// resume inside a create cannot wait on a removal that waits on the create.
const heldInContext = new AsyncLocalStorage<Hold[]>();
const exclusiveHolds = new Set<Hold>();
let waiters: Array<() => void> = [];

function notify(): void {
  const current = waiters;
  waiters = [];
  for (const wake of current) wake();
}

function nextChange(): Promise<void> {
  return new Promise((wake) => waiters.push(wake));
}

function covers(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

function anyCovers(roots: string[], candidates: string[]): boolean {
  return roots.some((root) => candidates.some((candidate) => covers(root, candidate)));
}

function blocked(paths: string[]): boolean {
  return [...exclusiveHolds].some((hold) => anyCovers(hold.paths, paths));
}

function runHeld<T>(cwd: string, work: () => Promise<T>): Promise<T> {
  const hold: Hold = { paths: [resolve(cwd)], ready: Promise.resolve() };
  hold.ready = (async () => {
    const real = await realpath(cwd).catch(() => null);
    if (real !== null && !hold.paths.includes(real)) hold.paths.push(real);
  })();
  sharedHolds.add(hold);
  const release = () => {
    sharedHolds.delete(hold);
    notify();
  };
  let running: Promise<T>;
  try {
    running = heldInContext.run([...(heldInContext.getStore() ?? []), hold], work);
  } catch (error) {
    release();
    return Promise.reject(error);
  }
  return running.finally(release);
}

/**
 * Run work that uses cwd. It waits while a removal holds a path that contains cwd. With no
 * removal hold, the hold is taken and work starts in the same tick. While any removal hold
 * exists, the decision uses the real path of cwd, so a linked spelling cannot slip past.
 */
export function withWorktreeUse<T>(cwd: string, work: () => Promise<T>): Promise<T> {
  const lexical = resolve(cwd);
  const outer = heldInContext.getStore() ?? [];
  // Only a hold that is still active counts. A callback that runs after its outer work ended
  // (a timer, a late promise) keeps the async context but no longer holds the path.
  if (outer.some((hold) => sharedHolds.has(hold) && anyCovers(hold.paths, [lexical]))) {
    return work();
  }
  if (exclusiveHolds.size === 0) return runHeld(cwd, work);
  return (async () => {
    const real = await realpath(cwd).catch(() => lexical);
    while (blocked([lexical, real])) await nextChange();
    return runHeld(cwd, work);
  })();
}

/** True while a removal holds or waits for path. Tests use it to time a race. */
export function hasRemovalHold(path: string): boolean {
  return [...exclusiveHolds].some((hold) => hold.paths.includes(path));
}

export class WorktreeInUseError extends Error {
  constructor() {
    super("Work in the worktree did not finish in time.");
    this.name = "WorktreeInUseError";
  }
}

/**
 * Run a removal with an exclusive hold on paths (the real worktree path and the caller's
 * spelling of it). New users inside them wait. If current users do not finish within waitMs, it
 * throws WorktreeInUseError and the caller keeps the worktree. The timeout also prevents a
 * deadlock when a user of the path starts a removal of the same path.
 */
export async function withWorktreeRemovalLock<T>(
  paths: string[],
  work: () => Promise<T>,
  waitMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + waitMs;
  const overlaps = (hold: Hold) => anyCovers(hold.paths, paths) || anyCovers(paths, hold.paths);
  while ([...exclusiveHolds].some(overlaps)) {
    if (!(await waitUntil(deadline))) throw new WorktreeInUseError();
  }
  const hold: Hold = { paths, ready: Promise.resolve() };
  exclusiveHolds.add(hold);
  try {
    for (;;) {
      await Promise.all([...sharedHolds].map((shared) => shared.ready));
      if (![...sharedHolds].some((shared) => anyCovers(paths, shared.paths))) break;
      if (!(await waitUntil(deadline))) throw new WorktreeInUseError();
    }
    return await work();
  } finally {
    exclusiveHolds.delete(hold);
    notify();
  }
}

async function waitUntil(deadline: number): Promise<boolean> {
  const left = deadline - Date.now();
  if (left <= 0) return false;
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<false>((done) => {
    timer = setTimeout(() => done(false), left);
  });
  try {
    return await Promise.race([nextChange().then(() => true as const), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
