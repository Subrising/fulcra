// J6. The host gives every plugin RPC 30 s (REQUEST_TIMEOUT_MS in the host's plugins/runtime.ts) and then answers
// the client with a bare "Plugin RPC timed out", which the surfaces can only show as "unavailable". A read that
// waits on a stalled controller socket (localCall's own timer is also 30 s) therefore always lost that race.
// Reads now answer within READ_DEADLINE_MS with an error that says what happened. The work itself is not
// cancelled: the single-flighted readers keep their flight, and the next refresh joins it.
// Only READS are wrapped. A mutation that is still in flight must not be reported as failed early, or the
// operator may repeat something the controller is about to do.
export const READ_DEADLINE_MS = 20000;
// L36: the tracker refresh is the one write given a deadline. Repeating it is harmless (items are reconciled per complete
// observation and refreshes are single-flight per mapping), and it must answer before the host's 30 s limit.
export const TRACKER_REFRESH_DEADLINE_MS = 25000;
export class ReadDeadlineExceeded extends Error {}
export function withDeadline<T>(work: () => T | Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ReadDeadlineExceeded(`${label} did not finish within ${Math.round(ms / 1000)} s; the controller or daemon is slow to answer. Refresh to try again.`)), ms);
    // Never the reason a process stays alive; the host keeps running anyway.
    (timer as { unref?: () => void }).unref?.();
  });
  return Promise.race([Promise.resolve().then(work), expired]).finally(() => clearTimeout(timer));
}
