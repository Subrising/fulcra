import type { ProjectPlacementPayload } from "@getpaseo/protocol/messages";
import {
  isSessionOwnershipState,
  type SessionOwnershipRecord,
  type SessionOwnershipState,
} from "@getpaseo/protocol/session-ownership";

export type { SessionOwnershipRecord, SessionOwnershipState };

/**
 * What the app displays. `owned` carries the ownership service's state verbatim rather than
 * flattening it, so a leaderless session can say which kind of leaderless it is.
 */
export type SessionOwnership =
  | {
      kind: "owned";
      state: Exclude<SessionOwnershipState, "unknown">;
      projectId: string;
      projectName: string | null;
      taskId: string | null;
      taskTitle: string | null;
      leaderAgentId: string | null;
      leaderTitle: string | null;
      detail: string | null;
    }
  /** The ownership service has a record and cannot resolve it. Never shown as global. */
  | { kind: "unknown"; detail: string | null }
  /** No ownership service record: this session was not created into a project. */
  | { kind: "unassigned" };

export const UNASSIGNED_SESSION_OWNERSHIP: SessionOwnership = { kind: "unassigned" };

function trimmed(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

/**
 * Recorded ownership wins over the placement the daemon derives from the workspace join.
 * Re-placing a workspace changes that placement; it must not appear to move a session
 * between projects, so once a record exists the placement is context only.
 */
export function selectSessionOwnership(
  record: SessionOwnershipRecord | null | undefined,
): SessionOwnership {
  if (!record) return UNASSIGNED_SESSION_OWNERSHIP;
  const detail = trimmed(record.detail);
  // An unrecognised state reads unknown. It must never fall through to a concrete state:
  // a confident wrong answer is worse than a visible absence of one.
  if (!isSessionOwnershipState(record.state)) return { kind: "unknown", detail };
  const projectId = trimmed(record.projectId);
  switch (record.state) {
    case "unknown":
      return { kind: "unknown", detail };
    case "recorded":
    case "adopted":
    case "declared": {
      // Any state that claims ownership without a project cannot name an owner.
      if (!projectId) return { kind: "unknown", detail };
      const leaderAgentId = trimmed(record.leaderAgentId);
      return {
        kind: "owned",
        // `adopted` asserts a leader; without one the truthful state is `declared`.
        state: record.state === "adopted" && !leaderAgentId ? "declared" : record.state,
        projectId,
        projectName: trimmed(record.projectName),
        taskId: record.taskId,
        taskTitle: record.taskTitle,
        leaderAgentId,
        leaderTitle: record.leaderTitle,
        detail,
      };
    }
    default: {
      // Exhaustiveness: a new state added upstream fails the typecheck here rather than
      // silently acquiring a display.
      const exhaustive: never = record.state;
      void exhaustive;
      return { kind: "unknown", detail };
    }
  }
}

export interface SessionOwnershipLabels {
  /** Used only when the ownership service supplied no sentence of its own. */
  unknownProject: string;
  noLeaderYet: string;
  reportsTo: (leader: string) => string;
  unknownAccessibility: string;
}

/**
 * What the session row prints for its project. Only an unassigned session falls back to
 * the daemon's derived placement, which is what the app has always shown.
 */
export function selectSessionProjectLabel(input: {
  ownership: SessionOwnership;
  placement: Pick<ProjectPlacementPayload, "projectName"> | null | undefined;
  labels: SessionOwnershipLabels;
}): {
  text: string;
  source: "controller" | "derived";
  isUnknown: boolean;
  accessibilityLabel: string | undefined;
} {
  const { ownership, labels } = input;
  if (ownership.kind === "unknown") {
    // The ownership service's sentence says why; ours only says that. Prefer theirs.
    return {
      text: ownership.detail ?? labels.unknownProject,
      source: "controller",
      isUnknown: true,
      accessibilityLabel: ownership.detail ?? labels.unknownAccessibility,
    };
  }
  if (ownership.kind === "unassigned") {
    return {
      text: input.placement?.projectName ?? "",
      source: "derived",
      isUnknown: false,
      accessibilityLabel: undefined,
    };
  }
  return {
    text: ownership.projectName ?? ownership.projectId,
    source: "controller",
    isUnknown: false,
    accessibilityLabel: ownership.detail ?? undefined,
  };
}

/** Which leader a session reports to, or that it has none yet. */
export function selectSessionLeaderLabel(
  ownership: SessionOwnership,
  labels: SessionOwnershipLabels,
): string | null {
  if (ownership.kind !== "owned") return null;
  if (ownership.leaderAgentId) {
    return labels.reportsTo(ownership.leaderTitle ?? ownership.leaderAgentId);
  }
  return labels.noLeaderYet;
}
