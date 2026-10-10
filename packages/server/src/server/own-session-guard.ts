import { execFileSync } from "node:child_process";

/** Set by the daemon in its own environment at boot, so every agent and terminal it starts inherits it. */
export const DAEMON_SERVER_ID_ENV = "PASEO_DAEMON_SERVER_ID";

const MAX_ANCESTRY_DEPTH = 64;

export class OwnDaemonSessionError extends Error {
  readonly code = "OWN_DAEMON_SESSION";
  constructor(
    readonly action: "stop" | "restart",
    readonly evidence: string,
  ) {
    super(
      `Refused: this command runs inside a session of the daemon it would ${action} (${evidence}). ` +
        `That would end this session and every other session on that daemon. ` +
        `Run it from a terminal outside that daemon. An operator outside every session can pass --override-session-guard.`,
    );
    this.name = "OwnDaemonSessionError";
  }
}

/** Parent process ids of `pid`, nearest first. Empty where `ps` is not available (Windows). */
export function ancestorPids(pid: number = process.pid): number[] {
  if (process.platform === "win32") return [];
  const found: number[] = [];
  let current = pid;
  for (let depth = 0; depth < MAX_ANCESTRY_DEPTH; depth++) {
    let parent: number;
    try {
      parent = Number(
        execFileSync("ps", ["-o", "ppid=", "-p", String(current)], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim(),
      );
    } catch {
      break;
    }
    if (!Number.isInteger(parent) || parent <= 1 || found.includes(parent)) break;
    found.push(parent);
    current = parent;
  }
  return found;
}

export interface OwnSessionGuardInput {
  action: "stop" | "restart";
  /** Server id of the target daemon, when it answered. */
  serverId?: string | null;
  /** Supervisor and worker pids of the target daemon on this computer. */
  daemonPids?: ReadonlyArray<number | null | undefined>;
  env?: NodeJS.ProcessEnv;
  ancestors?: () => number[];
  /** Explicit operator override (--override-session-guard): skips the check. */
  override?: boolean;
}

/** Throws when the caller runs inside a session of the target daemon: by its env marker or by process ancestry. */
export function assertNotInsideOwnDaemonSession(input: OwnSessionGuardInput): void {
  if (input.override) return;
  const env = input.env ?? process.env;
  const marker = env[DAEMON_SERVER_ID_ENV]?.trim();
  if (marker && input.serverId && marker === input.serverId)
    throw new OwnDaemonSessionError(
      input.action,
      `${DAEMON_SERVER_ID_ENV} matches server ${marker}`,
    );
  const pids = new Set(
    (input.daemonPids ?? []).filter((pid): pid is number => Number.isInteger(pid) && pid! > 1),
  );
  if (pids.size === 0) return;
  const parent = (input.ancestors ?? ancestorPids)().find((pid) => pids.has(pid));
  if (parent !== undefined)
    throw new OwnDaemonSessionError(
      input.action,
      `daemon process ${parent} is a parent of this process`,
    );
}
