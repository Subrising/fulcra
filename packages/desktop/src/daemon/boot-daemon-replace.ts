// FULCRA(FU-780): the PC boot task starts `paseo daemon start` before sign-in, without Command Centre: Command Centre
// needs a stored password or the hash only this app passes, and the owner chose no stored password (FU-470 option C).
// On 12 Nov 2026 the app at logon adopted that daemon, the bundled plugins did not load, and a person had to stop it.
// Now, when Command Centre is on, the app replaces such a daemon: at once when no turn runs, else after the running
// turns end (bounded wait). It never stops a running turn. Any doubt keeps the earlier behaviour: adopt unchanged.

export interface BootDaemonCandidate {
  status: string;
  desktopManaged: boolean;
  listen: string | null;
  pid: number | null;
}

/** A status probe with no credential at all. A Command Centre daemon always requires one, so an answer proves no CC. */
export type NoCredentialProbe =
  | { answered: true; busy: number }
  | { answered: false; reason: string };

export interface BootDaemonDeps {
  commandCentreEnabled: boolean;
  /** The home stores a daemon password or a shared Command Centre password file: the daemon can have CC. */
  homeHasCommandCentreAuth: () => boolean;
  probeWithoutCredential: (listen: string) => Promise<NoCredentialProbe>;
  /** The home still records the same daemon instance as the candidate. */
  stillSameInstance: () => Promise<boolean>;
  /** Stops the candidate cleanly. Resolves true only when the home records no daemon after the stop. */
  stop: () => Promise<boolean>;
  log: (message: string, details?: Record<string, unknown>) => void;
  logError: (message: string, details?: Record<string, unknown>) => void;
  pause: (ms: number) => Promise<void>;
  now?: () => number;
  wait?: { totalMs: number; stepMs: number };
}

export const BOOT_DAEMON_IDLE_WAIT = { totalMs: 2 * 60 * 60_000, stepMs: 30_000 };

export type BootDaemonPlan =
  | { kind: "adopt"; reason: string }
  | { kind: "replace" }
  | { kind: "wait"; busy: number };

/** Sessions with a live turn: running or initializing with a loaded provider process. */
export function countBusySessions(items: unknown): number {
  if (!Array.isArray(items)) throw new Error("Agent list is not an array.");
  return items.filter((item) => {
    if (typeof item !== "object" || item === null) return false;
    const { status, note } = item as { status?: unknown; note?: unknown };
    return (status === "running" || status === "initializing") && note !== "not loaded";
  }).length;
}

export async function planBootDaemon(
  current: BootDaemonCandidate,
  deps: BootDaemonDeps,
): Promise<BootDaemonPlan> {
  if (!deps.commandCentreEnabled) return { kind: "adopt", reason: "command centre is off" };
  if (current.status !== "running" || !current.listen)
    return { kind: "adopt", reason: "daemon is not running and ready" };
  if (current.desktopManaged) return { kind: "adopt", reason: "daemon was started by the app" };
  if (deps.homeHasCommandCentreAuth())
    return { kind: "adopt", reason: "home stores command centre auth" };
  const probe = await deps.probeWithoutCredential(current.listen);
  if (!probe.answered)
    return { kind: "adopt", reason: `daemon did not answer without a credential: ${probe.reason}` };
  return probe.busy === 0 ? { kind: "replace" } : { kind: "wait", busy: probe.busy };
}

/** Polls until no turn runs. False when the daemon changed, stopped answering, or the wait ran out. */
export async function waitForIdleBootDaemon(
  current: BootDaemonCandidate,
  deps: BootDaemonDeps,
): Promise<boolean> {
  const wait = deps.wait ?? BOOT_DAEMON_IDLE_WAIT;
  const now = deps.now ?? Date.now;
  const deadline = now() + wait.totalMs;
  while (now() < deadline) {
    await deps.pause(wait.stepMs);
    if (!(await deps.stillSameInstance())) {
      deps.log("boot daemon changed while waiting; not replacing it", { pid: current.pid });
      return false;
    }
    const probe = await deps.probeWithoutCredential(current.listen ?? "");
    if (!probe.answered) {
      deps.log("boot daemon stopped answering while waiting; not replacing it", {
        pid: current.pid,
        reason: probe.reason,
      });
      return false;
    }
    if (probe.busy === 0) return true;
    deps.log("boot daemon still has running turns; waiting", {
      pid: current.pid,
      busy: probe.busy,
    });
  }
  deps.log("boot daemon wait ran out; leaving it running", {
    pid: current.pid,
    waitedMs: wait.totalMs,
  });
  return false;
}

/** Stops the idle boot daemon. On failure it writes one error line and leaves the old daemon as it is. */
export async function stopBootDaemon(
  current: BootDaemonCandidate,
  deps: BootDaemonDeps,
): Promise<boolean> {
  try {
    if (!(await deps.stillSameInstance())) {
      deps.log("boot daemon changed before stop; not replacing it", { pid: current.pid });
      return false;
    }
    deps.log("stopping boot daemon without command centre", { pid: current.pid });
    if (!(await deps.stop())) throw new Error("daemon is still recorded after the stop");
    deps.log("boot daemon stopped; starting the app daemon with command centre", {
      pid: current.pid,
    });
    return true;
  } catch (error) {
    deps.logError("boot daemon replace failed; the old daemon stays", {
      pid: current.pid,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
