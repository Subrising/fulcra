// J0 (CC-PLAN §6, CONTRACTS §1 "Observation"): a stalled read never blanks a tab. The last good result of each
// read is kept here, in memory only, for as long as the app is open. Nothing is written to storage, so a
// restart starts empty. When a read fails or misses its deadline, the surface shows that result with one
// plain notice, and its own polling keeps retrying.
type Saved = { data: unknown; at: number };
const memory = new Map<string, Saved>();
export const MEMORY_LIMIT = 64;
const keyOf = (key: readonly unknown[]) => JSON.stringify(key);

export function remember(key: readonly unknown[], data: unknown, at: number): void {
  const k = keyOf(key);
  memory.delete(k); memory.set(k, { data, at });
  while (memory.size > MEMORY_LIMIT) memory.delete(memory.keys().next().value!);
}
export function recall<T>(key: readonly unknown[]): { data: T; at: number } | null {
  const saved = memory.get(keyOf(key));
  return saved ? { data: saved.data as T, at: saved.at } : null;
}
/** For tests and host changes: forget every remembered result. */
export function forgetAll(): void { memory.clear(); }

export function agoText(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  return `${Math.floor(min / 60)} h ago`;
}
/** A missed read deadline (the plugin's own, or the host's 30 s timeout) reads as "slow", anything else as "did not answer". */
export const isDeadline = (error: unknown) => /did not finish within|timed out/i.test(String((error as { message?: unknown } | null)?.message ?? error ?? ""));
export function stallNotice(at: number, now: number, error: unknown): string {
  return `Last updated ${agoText(now - at)} · ${isDeadline(error) ? "Fulcra is slow to answer" : "Fulcra did not answer"}; retrying`;
}

type QueryLike<T> = { data: T | undefined; isError: boolean; error: unknown; dataUpdatedAt?: number };
// J0-9: how old a result is, from the payload's own observation time where it has one, so a server that returns an
// old observation is not shown as fresh. Otherwise the time it arrived.
const observedAtOf = (data: unknown, fallback: number) => { const t = Date.parse((data as { observedAt?: unknown } | null)?.observedAt as string); return Number.isFinite(t) ? Math.min(t, fallback) : fallback; };
/**
 * The data a surface should show and the notice to show with it. A plain function, not a React hook, so it can
 * be called per query in a loop. `failure` names results that arrive as data
 * but are a failed read (for example `{ status: "error" }`), so they never replace the last good one.
 */
export function lastGood<T>(query: QueryLike<T>, key: readonly unknown[], { now = Date.now(), failure }: { now?: number; failure?: (data: T) => unknown } = {}) {
  const failed = query.data !== undefined && failure ? failure(query.data) ?? null : null;
  const good = query.data !== undefined && !query.isError && failed === null;
  if (good) remember(key, query.data, observedAtOf(query.data, query.dataUpdatedAt || now));
  if (good) return { data: query.data, notice: null, fromMemory: false };
  // Otherwise: the remembered result, or the query's own retained data if this read never succeeded here.
  const saved = recall<T>(key) ?? (failed === null && query.data !== undefined ? { data: query.data, at: observedAtOf(query.data, query.dataUpdatedAt || now) } : null);
  if (!saved) return { data: undefined, notice: null, fromMemory: false };
  const notice = query.isError || failed !== null ? stallNotice(saved.at, now, query.isError ? query.error : failed) : `Last updated ${agoText(now - saved.at)} · checking for changes`;
  return { data: saved.data, notice, fromMemory: true };
}
