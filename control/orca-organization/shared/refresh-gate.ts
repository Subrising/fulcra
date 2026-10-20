// FU-412 (owner design, 20 Oct): the progress board works only when something changed, at most once
// a window. With no change it holds no timer and does no work.

export interface RefreshGateTimers {
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
}

const realTimers: RefreshGateTimers = {
  setTimer: (run, ms) => setTimeout(run, ms),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/**
 * The first change arms one timer for `windowMs`; later changes in that window join it. When the
 * timer fires, `run` runs once for all of them.
 */
export function createRefreshGate(
  run: () => void,
  windowMs: number,
  timers: RefreshGateTimers = realTimers,
) {
  let timer: unknown;
  let armed = false;
  return {
    changed() {
      if (armed) return;
      armed = true;
      timer = timers.setTimer(() => {
        armed = false;
        timer = undefined;
        run();
      }, windowMs);
    },
    get pending() {
      return armed;
    },
    close() {
      if (armed) timers.clearTimer(timer);
      armed = false;
      timer = undefined;
    },
  };
}

/** The session facts the board shows. A change in anything else (tokens, usage, timestamps) is not a change. */
export function boardStatusKey(agent: {
  status: string;
  pendingPermissions?: readonly unknown[];
  archivedAt?: string | null;
  title?: string | null;
  workspaceId?: string | null;
  labels?: Record<string, string>;
}): string {
  return JSON.stringify([
    agent.status,
    agent.pendingPermissions?.length ?? 0,
    agent.archivedAt ?? null,
    agent.title ?? null,
    agent.workspaceId ?? null,
    agent.labels?.["project"] ?? null,
    agent.labels?.["fulcra.project"] ?? null,
  ]);
}
