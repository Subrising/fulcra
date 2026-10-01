import { z } from "zod";
import {
  NativeReportIdentitySchema,
  NativeReportScopeSchema,
  ReportRegistrationReceiptSchema,
} from "./native-intercom.js";
const projectChange = z
  .object({ projectId: z.string().uuid(), expectedOwnerEpoch: z.string().uuid().nullable() })
  .strict();
/** Explicit owner operations only. Role/report credentials cannot choose ownership or reparent. */
export const PromoteReportPrimeSchema = z
  .object({
    messageId: z.string().uuid(),
    identity: NativeReportIdentitySchema,
    expectedEpoch: z.string().uuid().nullable(),
    scopes: z.array(NativeReportScopeSchema).min(1).max(16),
    projects: z.array(projectChange).max(16),
  })
  .strict();
export const DemoteReportPrimeSchema = z
  .object({
    messageId: z.string().uuid(),
    identity: NativeReportIdentitySchema,
    expectedEpoch: z.string().uuid(),
    parent: NativeReportIdentitySchema,
    expectedParentEpoch: z.string().uuid(),
    projects: z.array(projectChange).max(16),
  })
  .strict();
export const TransferReportProjectSchema = z
  .object({
    messageId: z.string().uuid(),
    projectId: z.string().uuid(),
    from: NativeReportIdentitySchema.nullable(),
    expectedFromEpoch: z.string().uuid().nullable(),
    to: NativeReportIdentitySchema,
    expectedToEpoch: z.string().uuid(),
    expectedOwnerEpoch: z.string().uuid().nullable(),
  })
  .strict();
export const ReportHierarchyReceiptSchema = ReportRegistrationReceiptSchema.extend({
  pendingDisposition: z.literal("fenced-retained-no-retarget"),
}).strict();
