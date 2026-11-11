// FULCRA(FU-780): the PC boot task starts `paseo daemon start` before sign-in, without Command Centre: Command Centre
// needs a stored password or the hash only this app passes, and the owner chose no stored password (FU-470 option C).
// On 12 Nov 2026 the app at logon adopted that daemon, the bundled plugins did not load, and a person had to stop it.
// Now, when Command Centre is on, the app replaces such a daemon when nothing on it is busy: no running turn, no live
// terminal or workspace script, no schedule or heartbeat due within 2 minutes. While something is busy it waits
// (bounded). It never stops busy work. Any doubt keeps the earlier behaviour: adopt the daemon unchanged.

export interface BootDaemonCandidate {
  status: string;
  desktopManaged: boolean;
  listen: string | null;
  pid: number | null;
}

/** What keeps a daemon busy. Any non-zero count blocks a stop. */
export interface BootDaemonBusy {
  turns: number;
  terminals: number;
  dueSoon: number;
}

/** A probe with no credential at all. A Command Centre daemon always requires one, so an answer proves no CC. */
export type NoCredentialProbe =
  | { answered: true; busy: BootDaemonBusy }
  | { answered: false; reason: string };

export interface BootDaemonDeps {
  commandCentreEnabled: boolean;
  /** The home stores a daemon password or a shared Command Centre password file: the daemon can have CC. */
  homeHasCommandCentreAuth: () => boolean;
  /** The signal aborts at the probe timeout: the probe then ends its child processes and removes its files. */
  probeWithoutCredential: (listen: string, signal: AbortSignal) => Promise<NoCredentialProbe>;
  /** The home still records the same daemon instance as the candidate. */
  stillSameInstance: () => Promise<boolean>;
  /**
   * Checked just before a stop: the settings still allow the replacement and the app daemon credential is ready.
   * Returns the reason not to stop, or null.
   */
  preflight: () => Promise<string | null>;
  /** Stops the candidate cleanly. */
  stop: () => Promise<BootDaemonStopResult>;
  /** After a stop that did not finish: true when the daemon exits within `ms`. */
  waitForExit: (ms: number) => Promise<boolean>;
  log: (message: string, details?: Record<string, unknown>) => void;
  logError: (message: string, details?: Record<string, unknown>) => void;
  pause: (ms: number) => Promise<void>;
  now?: () => number;
}

export const BOOT_DAEMON_IDLE_WAIT = { totalMs: 2 * 60 * 60_000, stepMs: 30_000 };
export const BOOT_DAEMON_PROBE_TIMEOUT = { ms: 20_000 };
export const BOOT_DAEMON_DUE_WINDOW_MS = 2 * 60_000;
/** A sent stop can take the supervisor grace; a stop that sent nothing gets only a short check. */
export const BOOT_DAEMON_EXIT_WAIT = { stoppingMs: 60_000, notSentMs: 3_000 };

/**
 * "stopped": the home records no daemon. "stopping": the stop request went out but the exit was not confirmed in
 * time. "not_sent": nothing reached the daemon (no channel, refused RPC, EPERM).
 */
export type BootDaemonStopResult =
  | { result: "stopped" }
  | { result: "stopping" | "not_sent"; error: string };

/** "replaced": stopped and handed to the caller's start. "kept": the old daemon stays. */
export type BootDaemonWaitOutcome = "replaced" | "kept" | "ran_out" | "abandoned";

export type BootDaemonPlan =
  | { kind: "adopt"; reason: string }
  | { kind: "replace" }
  | { kind: "wait"; busy: BootDaemonBusy };

/** "stopped": the caller starts the app daemon. "busy": wait and try again. "kept": the old daemon stays. */
export type BootDaemonStopOutcome = "stopped" | "busy" | "kept";

function listItems(items: unknown, what: string): unknown[] {
  if (!Array.isArray(items)) throw new Error(`${what} list is not an array.`);
  return items;
}

/** Sessions with a live turn: running or initializing with a loaded provider process. */
export function countBusySessions(items: unknown): number {
  return listItems(items, "Agent").filter((item) => {
    if (typeof item !== "object" || item === null) return false;
    const { status, note } = item as { status?: unknown; note?: unknown };
    return (status === "running" || status === "initializing") && note !== "not loaded";
  }).length;
}

/** Every listed terminal is live; workspace scripts run in terminals too. */
export function countLiveTerminals(items: unknown): number {
  return listItems(items, "Terminal").length;
}

/** Active schedules and heartbeats whose next run is due (or overdue) within the window. */
export function countDueSoon(items: unknown, nowMs: number, windowMs = BOOT_DAEMON_DUE_WINDOW_MS) {
  return listItems(items, "Schedule").filter((item) => {
    if (typeof item !== "object" || item === null) return false;
    const { status, nextRunAt } = item as { status?: unknown; nextRunAt?: unknown };
    if (status !== "active" || typeof nextRunAt !== "string") return false;
    const next = Date.parse(nextRunAt);
    return Number.isFinite(next) && next <= nowMs + windowMs;
  }).length;
}

export function isBusy(busy: BootDaemonBusy): boolean {
  return busy.turns + busy.terminals + busy.dueSoon > 0;
}

async function probe(listen: string, deps: BootDaemonDeps): Promise<NoCredentialProbe> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<NoCredentialProbe>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({
        answered: false,
        reason: `probe timed out after ${BOOT_DAEMON_PROBE_TIMEOUT.ms} ms`,
      });
    }, BOOT_DAEMON_PROBE_TIMEOUT.ms);
  });
  try {
    return await Promise.race([
      deps
        .probeWithoutCredential(listen, controller.signal)
        .catch((error: unknown) => ({ answered: false as const, reason: String(error) })),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
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
  const result = await probe(current.listen, deps);
  if (!result.answered)
    return {
      kind: "adopt",
      reason: `daemon did not answer without a credential: ${result.reason}`,
    };
  return isBusy(result.busy) ? { kind: "wait", busy: result.busy } : { kind: "replace" };
}

/**
 * Stops the idle boot daemon. Just before the stop it checks the instance, the settings and the credential, and
 * probes again. A stop that does not finish is awaited until the daemon exits; only then the outcome is "kept".
 */
export async function stopBootDaemon(
  current: BootDaemonCandidate,
  deps: BootDaemonDeps,
): Promise<BootDaemonStopOutcome> {
  const details = { pid: current.pid };
  try {
    if (!(await deps.stillSameInstance())) {
      deps.log("boot daemon changed before stop; not replacing it", details);
      return "kept";
    }
    const refusal = await deps.preflight();
    if (refusal) {
      deps.log("not replacing boot daemon", { ...details, reason: refusal });
      return "kept";
    }
    const last = await probe(current.listen ?? "", deps);
    if (!last.answered) {
      deps.log("boot daemon did not answer before stop; not replacing it", {
        ...details,
        reason: last.reason,
      });
      return "kept";
    }
    if (isBusy(last.busy)) {
      deps.log("boot daemon became busy before stop; waiting", { ...details, ...last.busy });
      return "busy";
    }
  } catch (error) {
    deps.logError("boot daemon replace check failed; the old daemon stays", {
      ...details,
      error: error instanceof Error ? error.message : String(error),
    });
    return "kept";
  }
  deps.log("stopping boot daemon without command centre", details);
  let stopped: BootDaemonStopResult;
  try {
    stopped = await deps.stop();
  } catch (error) {
    stopped = { result: "not_sent", error: error instanceof Error ? error.message : String(error) };
  }
  if (stopped.result === "stopped") {
    deps.log("boot daemon stopped; starting the app daemon with command centre", details);
    return "stopped";
  }
  const waitMs =
    stopped.result === "stopping"
      ? BOOT_DAEMON_EXIT_WAIT.stoppingMs
      : BOOT_DAEMON_EXIT_WAIT.notSentMs;
  deps.log(
    stopped.result === "stopping"
      ? "boot daemon stop was sent but not confirmed; waiting for it to exit"
      : "boot daemon stop request did not reach the daemon; checking once that it still runs",
    { ...details, error: stopped.error, waitMs },
  );
  if (await deps.waitForExit(waitMs)) {
    deps.log("boot daemon exited; starting the app daemon with command centre", details);
    return "stopped";
  }
  deps.logError("boot daemon did not stop; it stays running and the app adopts it", {
    ...details,
    error: stopped.error,
  });
  return "kept";
}

/**
 * Polls until nothing is busy, outside any lock. Then `finish` runs the last checks, the stop and the start (the
 * caller runs it under its start lock). When `finish` finds new busy work, the wait goes on.
 */
export async function replaceBootDaemonWhenIdle(
  current: BootDaemonCandidate,
  deps: BootDaemonDeps,
  finish: () => Promise<BootDaemonStopOutcome>,
): Promise<BootDaemonWaitOutcome> {
  const wait = BOOT_DAEMON_IDLE_WAIT;
  const now = deps.now ?? Date.now;
  const deadline = now() + wait.totalMs;
  while (now() < deadline) {
    await deps.pause(wait.stepMs);
    if (!(await deps.stillSameInstance())) {
      deps.log("boot daemon changed while waiting; not replacing it", { pid: current.pid });
      return "abandoned";
    }
    const result = await probe(current.listen ?? "", deps);
    if (!result.answered) {
      deps.log("boot daemon stopped answering while waiting; not replacing it", {
        pid: current.pid,
        reason: result.reason,
      });
      return "abandoned";
    }
    if (isBusy(result.busy)) {
      deps.log("boot daemon is still busy; waiting", { pid: current.pid, ...result.busy });
      continue;
    }
    const outcome = await finish();
    if (outcome === "stopped") return "replaced";
    if (outcome === "kept") return "kept";
  }
  deps.log("boot daemon wait ran out because it stayed busy; leaving it running", {
    pid: current.pid,
    waitedMs: wait.totalMs,
  });
  return "ran_out";
}
