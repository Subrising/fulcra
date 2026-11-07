import type { StoredAgentRecord } from "./agent-storage.js";
import {
  PARENT_AGENT_ID_LABEL,
  REPORTS_TO_LABEL,
  SEAT_LABEL,
  MAIN_ASSISTANT_ROLE,
} from "@getpaseo/protocol/agent-labels";

/** The "fulcra.role" values a lead carries (a worker has "implementation" or none). */
export const LEAD_SESSION_ROLES: readonly string[] = [
  "planning",
  "orchestration",
  "prime",
  "lead",
  "owner",
];

export function isLeadRole(labels: Record<string, string> | null | undefined): boolean {
  return LEAD_SESSION_ROLES.includes(labels?.["fulcra.role"]?.trim() ?? "");
}

export function isArchiveLead(record: Pick<StoredAgentRecord, "labels">): boolean {
  const labels = record.labels ?? {};
  return labels[SEAT_LABEL] === MAIN_ASSISTANT_ROLE || isLeadRole(labels);
}

// Fulcra reporting lines own lifecycle. Old parent labels can point at an unrelated lead.
export function reportsToArchiveParent(
  parent: StoredAgentRecord,
  child: StoredAgentRecord,
  serverId?: string,
): boolean {
  if (parent.id === child.id) return false;
  const ref = child.labels?.[REPORTS_TO_LABEL];
  const targets = [parent.id];
  if (parent.labels?.[SEAT_LABEL]) targets.push(`role:${parent.labels[SEAT_LABEL]}`);
  return targets.some((target) => ref === target || (serverId && ref === `${target}@${serverId}`));
}

export function isArchiveChild(
  parent: StoredAgentRecord,
  child: StoredAgentRecord,
  serverId?: string,
): boolean {
  if (isArchiveLead(child)) return false;
  const fulcra = [parent, child].some(
    (record) =>
      record.labels?.["fulcra.role"] ||
      record.labels?.[REPORTS_TO_LABEL] ||
      record.labels?.[SEAT_LABEL],
  );
  return fulcra
    ? reportsToArchiveParent(parent, child, serverId)
    : child.labels?.[PARENT_AGENT_ID_LABEL] === parent.id;
}
