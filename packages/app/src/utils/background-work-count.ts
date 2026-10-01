/**
 * Reads a host's count of background jobs (running builds, watchers, backgrounded shells) for one
 * workspace. The field is display-only: it may colour a row as working, and nothing may gate an action
 * on it.
 *
 * Hosts that predate the field send nothing, and a host that sends something malformed must not break
 * the sidebar, so anything other than a whole number in 1..999 reads as 0. The wire shape is
 * `backgroundWorkCount?: number` on the workspace descriptor.
 */
export const MAX_BACKGROUND_WORK_COUNT = 999;

export function readBackgroundWorkCount(source: unknown): number {
  if (typeof source !== "object" || source === null) return 0;
  const value: unknown = (source as { backgroundWorkCount?: unknown }).backgroundWorkCount;
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= MAX_BACKGROUND_WORK_COUNT
    ? value
    : 0;
}
