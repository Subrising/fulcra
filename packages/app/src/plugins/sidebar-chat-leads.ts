import type { Seat } from "../../../../control/orca-organization/shared/roles";
import { chatStatusWord } from "@getpaseo/protocol/chat-status";

interface ChatRecord {
  status?: string;
  archivedAt?: unknown;
}

interface Projects {
  available: boolean;
  projects: readonly { id: string; name: string; status: string; archivedAt?: unknown }[];
}

/** Labels and saved lead names cannot establish a current project seat. */
export function liveProjectSeats(
  seats: readonly Seat[],
  projects: Projects | undefined,
  agents: ReadonlyMap<string, ChatRecord> | undefined,
): Seat[] {
  if (!projects?.available || !agents) return [];
  const active = new Set(
    projects.projects
      .filter((project) => project.status !== "archived" && !project.archivedAt)
      .map((project) => project.id),
  );
  return seats.filter((seat) => {
    if (
      seat.role !== "project-orchestrator" ||
      seat.state !== "assigned" ||
      !seat.projectId ||
      !active.has(seat.projectId) ||
      !seat.sessionId ||
      !seat.sessionPresent ||
      !seat.sessionTaskMatches ||
      seat.sessionGenerationChanged
    )
      return false;
    const agent = agents.get(seat.sessionId);
    return Boolean(
      agent &&
      !agent.archivedAt &&
      ["idle", "running", "error", "initializing"].includes(agent.status ?? ""),
    );
  });
}

export function chatStatusLabel(status: string | undefined): string | null {
  return chatStatusWord(status);
}
