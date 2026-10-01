import { z } from "zod";
import { canonicalJson } from "@getpaseo/protocol/trusted-input";
import {
  NativeReportIdentitySchema,
  NativeReportScopeSchema,
} from "@getpaseo/protocol/native-intercom";
import { createHash } from "node:crypto";

export const ReportMemberSchema = z
  .object({
    id: z.string().uuid(),
    source: NativeReportIdentitySchema,
    scope: NativeReportScopeSchema,
    sourceEpoch: z.string().uuid(),
    retirement: z.string().uuid().optional(),
    route: z.object({ ownerEpoch: z.string().uuid() }).strict().optional(),
    origin: z
      .object({ lifecycleId: z.string().min(1).max(200) })
      .strict()
      .optional(),
    kind: z.enum(["ended", "needs-you", "blocked", "usage-limit", "handoff"]),
    at: z.number().int().nonnegative(),
  })
  .strict();
const ReportOverflowMemberSchema = z.union([
  ReportMemberSchema,
  z
    .object({
      memberIndex: z.number().int().min(0).max(7),
      id: z.string().uuid(),
      kind: ReportMemberSchema.shape.kind,
      at: z.number().int().nonnegative(),
    })
    .strict(),
]);
export const ReportBatchSchema = z
  .object({
    parent: NativeReportIdentitySchema,
    parentEpoch: z.string().uuid(),
    members: z.array(ReportMemberSchema).min(1).max(8),
    overflow: z.array(ReportOverflowMemberSchema).max(16).optional(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    consumed: z.array(z.string().uuid()).max(24),
  })
  .strict();
export type ReportMember = z.infer<typeof ReportMemberSchema>;
export type ReportBatchData = z.infer<typeof ReportBatchSchema>;
export function validateReportBatchData(data: ReportBatchData): void {
  const body = {
    parent: data.parent,
    parentEpoch: data.parentEpoch,
    members: data.members,
    ...(data.overflow ? { overflow: data.overflow } : {}),
  };
  const members = reportMembers(data);
  if (
    data.overflow?.some((item) => "memberIndex" in item && item.memberIndex >= data.members.length)
  )
    throw new Error("Native report overflow source linkage invalid");
  if (
    createHash("sha256").update(canonicalJson(body)).digest("hex") !== data.digest ||
    new Set(members.map((member) => member.id)).size !== members.length ||
    new Set(data.consumed).size !== data.consumed.length ||
    data.consumed.some((id) => !members.some((member) => member.id === id)) ||
    // The immutable envelope is 4 KiB. Consumption IDs are separately bounded
    // journal metadata covered by the same pre-reserved 8 KiB receipt allocation.
    Buffer.byteLength(canonicalJson({ ...body, digest: data.digest })) > 4096
  )
    throw new Error("Native report membership journal invalid");
}
export interface NativeReportBatch {
  readonly kind: "native-report-batch";
}
const batches = new WeakMap<
  object,
  Readonly<{ data: ReportBatchData; requireCurrent: () => void }>
>();

/** Host registry only, after verified parent derivation. No controller/action handle can substitute. */
export function createNativeReportBatch(
  data: Omit<ReportBatchData, "digest" | "consumed">,
  requireCurrent: () => void,
): NativeReportBatch {
  const snapshot = structuredClone(data);
  const digest = createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
  const parsed = ReportBatchSchema.parse({ ...snapshot, digest, consumed: [] });
  if (
    new Set(reportMembers(parsed).map((member) => member.id)).size !== reportMembers(parsed).length
  )
    throw new Error("Report member identity conflict");
  if (Buffer.byteLength(canonicalJson(parsed)) > 4096)
    throw new Error("Native report batch resource limit");
  validateReportBatchData(parsed);
  const handle = Object.freeze({ kind: "native-report-batch" as const });
  batches.set(handle, Object.freeze({ data: parsed, requireCurrent }));
  return handle;
}
export function requireNativeReportBatch(handle: NativeReportBatch) {
  const batch = batches.get(handle);
  if (!batch) throw new Error("Private native report batch required");
  batch.requireCurrent();
  // Callers receive a copy; retained membership and its fingerprint cannot mutate.
  return { data: structuredClone(batch.data), requireCurrent: batch.requireCurrent };
}

/** Merge only private registry handles while metadata is collecting, before native wake acceptance. */
export function mergeNativeReportBatches(
  earlier: NativeReportBatch,
  incoming: NativeReportBatch,
): NativeReportBatch {
  const first = requireNativeReportBatch(earlier);
  const next = requireNativeReportBatch(incoming);
  if (
    canonicalJson(first.data.parent) !== canonicalJson(next.data.parent) ||
    first.data.parentEpoch !== next.data.parentEpoch
  )
    throw new Error("Report collection recipient changed");
  return createNativeReportBatch(
    {
      parent: first.data.parent,
      parentEpoch: first.data.parentEpoch,
      members: [...reportMembers(first.data), ...reportMembers(next.data)].slice(0, 8),
      ...(reportMembers(first.data).length + reportMembers(next.data).length > 8
        ? {
            overflow: [...reportMembers(first.data), ...reportMembers(next.data)]
              .slice(8)
              .map((member) => {
                const memberIndex = [...reportMembers(first.data), ...reportMembers(next.data)]
                  .slice(0, 8)
                  .findIndex(
                    (normal) =>
                      canonicalJson({
                        source: normal.source,
                        scope: normal.scope,
                        epoch: normal.sourceEpoch,
                        retirement: normal.retirement ?? null,
                        route: normal.route ?? null,
                        origin: normal.origin ?? null,
                      }) ===
                      canonicalJson({
                        source: member.source,
                        scope: member.scope,
                        epoch: member.sourceEpoch,
                        retirement: member.retirement ?? null,
                        route: member.route ?? null,
                        origin: member.origin ?? null,
                      }),
                  );
                if (memberIndex < 0) return member;
                return { memberIndex, id: member.id, kind: member.kind, at: member.at };
              }),
          }
        : {}),
    },
    () => {
      first.requireCurrent();
      next.requireCurrent();
    },
  );
}

/** Overflow facts share the same permanent membership journal, resource ceilings and scope guards. */
export function reportMembers(data: ReportBatchData): ReportMember[] {
  return [
    ...data.members,
    ...(data.overflow ?? []).map((item) => {
      if (!("memberIndex" in item)) return item;
      const base = data.members[item.memberIndex];
      if (!base) throw new Error("Native report overflow source linkage invalid");
      return Object.assign({}, base, { id: item.id, kind: item.kind, at: item.at });
    }),
  ];
}

/** Permanent native fact identity survives report-role/owner epoch changes. Legacy first IDs remain fenced.
 * Cross-route matching is allowed only for a recipient identity proven equal by the retained ledger envelope.
 */
export function sameNativeReportEvent(
  previous: ReportMember,
  incoming: ReportMember,
  sameRecipient = false,
): boolean {
  if (previous.id === incoming.id) return true;
  if (
    !incoming.origin ||
    canonicalJson(previous.source) !== canonicalJson(incoming.source) ||
    canonicalJson(previous.scope) !== canonicalJson(incoming.scope) ||
    previous.kind !== incoming.kind ||
    (!sameRecipient && !!previous.route !== !!incoming.route)
  )
    return false;
  if (previous.origin) return previous.origin.lifecycleId === incoming.origin.lifecycleId;
  if (previous.route) return false;
  const hex = createHash("sha256")
    .update(
      canonicalJson({
        source: incoming.source,
        epoch: previous.sourceEpoch,
        kind: incoming.kind,
        lifecycleId: incoming.origin.lifecycleId,
        scope: incoming.scope,
      }),
    )
    .digest("hex");
  const legacy = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  return previous.id === legacy;
}
