import { z } from "zod";
import { IntercomStatusSchema } from "@getpaseo/protocol/native-intercom";
import {
  reportPrimePromoteRpc,
  reportPrimeDemoteRpc,
  reportProjectTransferRpc,
} from "../../../../../control/orca-organization/shared/intercom";

export type ReportRoleSnapshot = z.infer<typeof IntercomStatusSchema>;
export type HierarchyAction = "promote" | "demote" | "transfer";

/** Status supplies exact observed epochs, never ownership/action authority. */
export function snapshotReportRole(raw: unknown, agentId: string): ReportRoleSnapshot {
  const status = IntercomStatusSchema.parse(raw);
  if (!status.identity || status.identity.agentId !== agentId || !status.registration)
    throw new Error("Current registered native session required");
  return status;
}

export function prepareHierarchyRequest(
  action: HierarchyAction,
  source: ReportRoleSnapshot,
  target: ReportRoleSnapshot | null,
  projectId: string,
  messageId: string,
) {
  const identity = source.identity;
  const registration = source.registration;
  if (!identity || !registration) throw new Error("Current registration required");
  if (action === "promote") {
    const projects = [...new Set(registration.scopes.map((scope) => scope.projectId))].map(
      (id) => ({
        projectId: id,
        expectedOwnerEpoch:
          registration.owningProjects?.find((item) => item.projectId === id)?.epoch ??
          target?.registration?.owningProjects?.find((item) => item.projectId === id)?.epoch ??
          null,
      }),
    );
    return {
      action,
      input: reportPrimePromoteRpc.input.parse({
        messageId,
        identity,
        expectedEpoch: registration.epoch,
        scopes: registration.scopes,
        projects,
      }),
    };
  }
  if (!target?.identity || !target.registration || target.identity.agentId === identity.agentId)
    throw new Error("Distinct registered recipient required");
  if (action === "demote")
    return {
      action,
      input: reportPrimeDemoteRpc.input.parse({
        messageId,
        identity,
        expectedEpoch: registration.epoch,
        parent: target.identity,
        expectedParentEpoch: target.registration.epoch,
        projects: (registration.owningProjects ?? []).map((item) => ({
          projectId: item.projectId,
          expectedOwnerEpoch: item.epoch,
        })),
      }),
    };
  const ownership = registration.owningProjects?.find((item) => item.projectId === projectId);
  if (!ownership) throw new Error("Select an observed owned project");
  return {
    action,
    input: reportProjectTransferRpc.input.parse({
      messageId,
      projectId,
      from: identity,
      expectedFromEpoch: registration.epoch,
      to: target.identity,
      expectedToEpoch: target.registration.epoch,
      expectedOwnerEpoch: ownership.epoch,
    }),
  };
}

export function unchangedReportRole(original: ReportRoleSnapshot, current: ReportRoleSnapshot) {
  if (
    JSON.stringify(original.identity) !== JSON.stringify(current.identity) ||
    JSON.stringify(original.registration) !== JSON.stringify(current.registration)
  )
    throw new Error("Observed native registration changed");
}
