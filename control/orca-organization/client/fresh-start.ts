// Fresh start, read from the controller's recovery status (organization.recovery → recovery.compactionLoops).
// A rotation is the controller's record of continuing a session in a new provider context with a handoff, whether a
// compaction loop, the context limit or the Fresh start button started it. Nothing here changes a session.

export interface FreshStart {
  id: string;
  at: number;
  state: "rotated" | "rotating" | "held" | string;
  /** The controller's handoff file was written. Its path is private to the host and not shown. */
  handoff: boolean;
  outcome: string | null;
}

interface Rotation {
  id?: unknown;
  sessionId?: unknown;
  state?: unknown;
  handoff?: unknown;
  outcome?: unknown;
  at?: unknown;
  previousSessionId?: unknown;
  sessionIdAfter?: unknown;
}

function compactionLoops(recovery: unknown): { freshStart?: unknown; rotations?: unknown } | null {
  const loops = (recovery as { compactionLoops?: unknown } | null | undefined)?.compactionLoops;
  return loops && typeof loops === "object" ? (loops as { freshStart?: unknown }) : null;
}

/** True only when the controller says it accepts a manual Fresh start. */
export function freshStartSupported(recovery: unknown): boolean {
  return compactionLoops(recovery)?.freshStart === true;
}

/** This session's fresh starts, newest first. */
export function freshStartsFor(recovery: unknown, sessionId: string): FreshStart[] {
  const rotations = compactionLoops(recovery)?.rotations;
  if (!Array.isArray(rotations)) return [];
  return (rotations as Rotation[])
    .filter(
      (r) =>
        r.sessionId === sessionId ||
        r.previousSessionId === sessionId ||
        r.sessionIdAfter === sessionId,
    )
    .filter((r) => typeof r.id === "string" && typeof r.at === "number" && Number.isFinite(r.at))
    .map((r) => ({
      id: r.id as string,
      at: r.at as number,
      state: typeof r.state === "string" ? r.state : "unknown",
      handoff: typeof r.handoff === "string" && r.handoff.length > 0,
      outcome: typeof r.outcome === "string" && r.outcome ? r.outcome : null,
    }))
    .sort((a, b) => b.at - a.at);
}

/** "Fresh start at 14:02 · handoff", or why it stopped. */
export function freshStartLine(start: FreshStart, formatTime: (at: number) => string): string {
  const when = formatTime(start.at);
  if (start.state === "rotated")
    return `Fresh start at ${when}${start.handoff ? " · handoff" : ""}`;
  if (start.state === "rotating") return `Fresh start in progress since ${when}`;
  return `Fresh start at ${when} stopped for review${start.outcome ? `: ${start.outcome}` : ""}`;
}
