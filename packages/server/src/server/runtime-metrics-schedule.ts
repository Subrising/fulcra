/** Metrics are logged every 60 s, or every 30 s only while the daemon is busy. */
export const WS_RUNTIME_METRICS_IDLE_FLUSH_MS = 60_000;
export const WS_RUNTIME_METRICS_BUSY_FLUSH_MS = 30_000;

export function nextRuntimeMetricsDelayMs(busy: boolean): number {
  return busy ? WS_RUNTIME_METRICS_BUSY_FLUSH_MS : WS_RUNTIME_METRICS_IDLE_FLUSH_MS;
}

/** Busy means a git command is running or waiting, or the last window counted any traffic. */
export function isRuntimeMetricsWindowBusy(input: {
  counters: Record<string, unknown>;
  gitActive: number;
  gitPending: number;
}): boolean {
  if (input.gitActive > 0 || input.gitPending > 0) return true;
  return Object.values(input.counters).some((value) => typeof value === "number" && value > 0);
}
