import type { NativeReportIdentity, NativeReportScope } from "@getpaseo/protocol/native-intercom";

import type { ReportMember } from "./report-batch.js";

export interface ReportReader {
  readonly kind: "native-report-reader";
}
const readers = new WeakMap<
  object,
  Readonly<{
    identity: NativeReportIdentity;
    epoch: string;
    scopes: readonly NativeReportScope[];
    requireCurrent: () => void;
    requireMember: (member: ReportMember) => void;
  }>
>();

/** Native registry only: no wire flags or controller provenance can mint this handle. */
export function createReportReader(
  identity: NativeReportIdentity,
  epoch: string,
  scopes: readonly NativeReportScope[],
  requireCurrent: () => void,
  requireMember: (member: ReportMember) => void,
): ReportReader {
  const handle = Object.freeze({ kind: "native-report-reader" as const });
  readers.set(
    handle,
    Object.freeze({
      identity: Object.freeze({ ...identity }),
      epoch,
      scopes: Object.freeze(scopes.map((scope) => Object.freeze({ ...scope }))),
      requireCurrent,
      requireMember,
    }),
  );
  return handle;
}

export function requireReportReader(handle: ReportReader) {
  const reader = readers.get(handle);
  if (!reader) throw new Error("Private native report reader required");
  reader.requireCurrent();
  return reader;
}
