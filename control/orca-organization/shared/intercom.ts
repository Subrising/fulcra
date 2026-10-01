import {
  PromoteReportPrimeSchema,
  DemoteReportPrimeSchema,
  TransferReportProjectSchema,
  ReportHierarchyReceiptSchema,
} from "@getpaseo/protocol/native-report-hierarchy";
import {
  NativeArtifactContentGrantSchema,
  NativeArtifactContentSelectionSchema,
  SetNativeArtifactContentGrantSchema,
} from "@getpaseo/protocol/native-artifact-content";
import { SetNativeArtifactToolSchema } from "@getpaseo/protocol/native-evidence";
import { z } from "zod";
import { defineContract } from "./rpc-contract";
import {
  RegisterReportPrimeSchema,
  AdoptReportParentSchema,
  RevokeReportRegistrationSchema,
  ReportRegistrationReceiptSchema,
  SetIntercomRatesSchema,
  IntercomRateSnapshotSchema,
  IntercomStatusInputSchema,
  IntercomStatusSchema,
} from "@getpaseo/protocol/native-intercom";

export const reportPrimeRegisterRpc = defineContract({
  name: "organization.intercom.prime.register",
  input: RegisterReportPrimeSchema,
  output: ReportRegistrationReceiptSchema,
});
export const intercomRateSettingsRpc = defineContract({
  name: "organization.intercom.rates.set",
  input: SetIntercomRatesSchema,
  output: z.object({ messageId: z.string().uuid(), duplicate: z.boolean() }).strict(),
});
export const reportParentAdoptRpc = defineContract({
  name: "organization.intercom.parent.adopt",
  input: AdoptReportParentSchema,
  output: ReportRegistrationReceiptSchema,
});
export const reportRegistrationRevokeRpc = defineContract({
  name: "organization.intercom.registration.revoke",
  input: RevokeReportRegistrationSchema,
  output: ReportRegistrationReceiptSchema,
});

/** Owner-only status. No removal, compaction, recovery or ceiling changes. */
export const receiptMaintenanceRpc = defineContract({
  name: "organization.intercom.receipts.status",
  input: z.object({}).strict(),
  output: z
    .object({
      recordedIds: z.number().int().min(0),
      maxIds: z.number().int().min(1).max(10000),
      maintenanceRequired: z.boolean(),
      newIdsRefused: z.boolean(),
      automaticPruning: z.literal(false),
    })
    .strict(),
});

export const intercomRateSettingsGetRpc = defineContract({
  name: "organization.intercom.rates.get",
  input: z.object({}).strict(),
  output: IntercomRateSnapshotSchema,
});
export const intercomStatusRpc = defineContract({
  name: "organization.intercom.status",
  input: IntercomStatusInputSchema,
  output: IntercomStatusSchema,
});

export const artifactToolSetRpc = defineContract({
  name: "organization.intercom.artifacts.tool.set",
  input: SetNativeArtifactToolSchema,
  output: z
    .object({
      messageId: z.string().uuid(),
      enabled: z.boolean(),
      expiresAt: z.number().int().nonnegative().nullable(),
    })
    .strict(),
});

export const artifactContentGrantSetRpc = defineContract({
  name: "organization.intercom.artifacts.content.set",
  input: SetNativeArtifactContentGrantSchema,
  output: z.object({ grants: z.array(NativeArtifactContentGrantSchema).max(64) }).strict(),
});
export const artifactContentGrantListRpc = defineContract({
  name: "organization.intercom.artifacts.content.list",
  input: NativeArtifactContentSelectionSchema,
  output: z.object({ grants: z.array(NativeArtifactContentGrantSchema).max(64) }).strict(),
});

export const reportPrimePromoteRpc = defineContract({
  name: "organization.intercom.prime.promote",
  input: PromoteReportPrimeSchema,
  output: ReportHierarchyReceiptSchema,
});
export const reportPrimeDemoteRpc = defineContract({
  name: "organization.intercom.prime.demote",
  input: DemoteReportPrimeSchema,
  output: ReportHierarchyReceiptSchema,
});
export const reportProjectTransferRpc = defineContract({
  name: "organization.intercom.project.transfer",
  input: TransferReportProjectSchema,
  output: ReportHierarchyReceiptSchema,
});
