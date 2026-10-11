// FU-77: counts the synchronous disk calls on the daemon main thread. A site is a short name such as
// "journal.write". The meter is cheap: one clock read before and after the call. It logs one line a minute, and
// only for sites that took time. The controller plugin (plain .mjs, no import into the server) finds the meter on
// globalThis, so a plugin without the meter just runs its call.
export interface SyncIoSite {
  site: string;
  calls: number;
  totalMs: number;
  maxMs: number;
}

export const SYNC_IO_METER_KEY = Symbol.for("fulcra.syncIoMeter");

export interface SyncIoMeter {
  timed<T>(site: string, call: () => T): T;
  /** Returns the sites that took time since the last call, and starts a new period. */
  drain(): SyncIoSite[];
}

export function createSyncIoMeter(now: () => number = () => performance.now()): SyncIoMeter {
  let sites = new Map<string, SyncIoSite>();
  return {
    timed<T>(site: string, call: () => T): T {
      const start = now();
      try {
        return call();
      } finally {
        const ms = now() - start;
        const entry = sites.get(site) ?? { site, calls: 0, totalMs: 0, maxMs: 0 };
        entry.calls += 1;
        entry.totalMs += ms;
        entry.maxMs = Math.max(entry.maxMs, ms);
        sites.set(site, entry);
      }
    },
    drain() {
      const taken = sites;
      sites = new Map();
      return [...taken.values()]
        .filter((s) => s.totalMs >= 1)
        .map((s) => ({
          site: s.site,
          calls: s.calls,
          totalMs: Math.round(s.totalMs),
          maxMs: Math.round(s.maxMs),
        }))
        .sort((a, b) => b.totalMs - a.totalMs);
    },
  };
}

/** Installs the meter for this process and logs the busy sites once a minute. Returns the stop function. */
export function startSyncIoMeter(
  log: (sites: SyncIoSite[]) => void,
  intervalMs = 60_000,
  target: Record<symbol, unknown> = globalThis as Record<symbol, unknown>,
): () => void {
  const meter = createSyncIoMeter();
  target[SYNC_IO_METER_KEY] = meter;
  const timer = setInterval(() => {
    const sites = meter.drain();
    if (sites.length > 0) log(sites);
  }, intervalMs);
  timer.unref();
  return () => {
    clearInterval(timer);
    delete target[SYNC_IO_METER_KEY];
  };
}

/** Runs a synchronous disk call under the process meter when one is installed. */
export function timedSync<T>(site: string, call: () => T): T {
  const meter = (globalThis as Record<symbol, unknown>)[SYNC_IO_METER_KEY] as
    | SyncIoMeter
    | undefined;
  return meter ? meter.timed(site, call) : call();
}
