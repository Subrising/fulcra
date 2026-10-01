import type {
  NativeEvidenceFact,
  NativeEvidenceReadInput,
  NativeEvidenceReadOutput,
} from "@getpaseo/protocol/native-evidence";

export interface NativeEvidenceRow {
  /** Opaque React key only; never a content or action grant. */
  key: string;
  kind: NativeEvidenceFact["kind"];
  title: string;
  detail: string;
}
export type NativeEvidenceProjection =
  | { kind: "unavailable" }
  | {
      kind: "ready";
      rows: NativeEvidenceRow[];
      nextExpiryAt: number | null;
      windowLabel: string;
      contentLabel: string;
    };

function describeFact(fact: NativeEvidenceFact): Pick<NativeEvidenceRow, "title" | "detail"> {
  switch (fact.kind) {
    case "produced_artifact":
      return {
        title: "Produced artifact",
        detail: "Host-materialized native generation · metadata committed",
      };
    case "file_touch":
      return {
        title: "File touch",
        detail: "Native provider acknowledgement · metadata committed",
      };
    case "command_result":
      return {
        title: "Command result",
        detail: "Native provider acknowledgement · metadata committed",
      };
  }
}

/** Presentation of an already protected client result; callers must retain live read authority. */
export function projectNativeEvidence(
  input: NativeEvidenceReadInput,
  output: NativeEvidenceReadOutput,
  nowMs: number,
): NativeEvidenceProjection {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) return { kind: "unavailable" };
  const sameScope = (scope: NativeEvidenceReadInput["scope"]) =>
    scope.projectId === input.scope.projectId && scope.taskId === input.scope.taskId;
  if (!sameScope(output.scope)) return { kind: "unavailable" };
  const invalidWindow =
    output.bounded !== true || output.contentReadAvailable !== false || output.entries.length > 24;
  if (invalidWindow) return { kind: "unavailable" };
  const seen = new Set<string>();
  const rows: NativeEvidenceRow[] = [];
  let nextExpiryAt: number | null = null;
  for (const entry of output.entries) {
    const invalidLifetime =
      !Number.isSafeInteger(entry.at) ||
      !Number.isSafeInteger(entry.expiresAt) ||
      entry.at < 0 ||
      entry.at > nowMs ||
      entry.expiresAt <= nowMs ||
      entry.expiresAt <= entry.at ||
      entry.expiresAt - entry.at > 6 * 60 * 60 * 1000;
    const invalidEntry =
      !sameScope(entry.scope) || entry.metadataCommitted !== true || seen.has(entry.id);
    if (invalidLifetime || invalidEntry) return { kind: "unavailable" };
    seen.add(entry.id);
    rows.push({ key: entry.id, kind: entry.fact.kind, ...describeFact(entry.fact) });
    nextExpiryAt =
      nextExpiryAt === null ? entry.expiresAt : Math.min(nextExpiryAt, entry.expiresAt);
  }
  return {
    kind: "ready",
    rows,
    nextExpiryAt,
    windowLabel: "Bounded metadata window · not a complete inventory",
    contentLabel: "Artifact content unavailable",
  };
}

export interface ManagedArtifactRow {
  /** Opaque React key only; never a content or action grant. */
  key: string;
  kind: "managed_artifact";
  title: string;
  detail: string;
}
export type ManagedArtifactProjection =
  | { kind: "unavailable" }
  | {
      kind: "ready";
      rows: ManagedArtifactRow[];
      nextExpiryAt: number | null;
      windowLabel: string;
      contentLabel: string;
    };

/** Separate declared-output metadata; no native-generation or content authority is inferred. */
export function projectManagedArtifacts(
  input: import("zod").z.infer<
    typeof import("@getpaseo/protocol/native-evidence").ManagedArtifactReadInputSchema
  >,
  output: import("zod").z.infer<
    typeof import("@getpaseo/protocol/native-evidence").ManagedArtifactReadOutputSchema
  >,
  nowMs: number,
): ManagedArtifactProjection {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) return { kind: "unavailable" };
  const sameScope = (scope: typeof input.scope) =>
    scope.projectId === input.scope.projectId && scope.taskId === input.scope.taskId;
  if (!sameScope(output.scope)) return { kind: "unavailable" };
  const invalidWindow =
    output.bounded !== true || output.contentReadAvailable !== false || output.entries.length > 24;
  if (invalidWindow) return { kind: "unavailable" };
  const seen = new Set<string>();
  const rows: ManagedArtifactRow[] = [];
  let nextExpiryAt: number | null = null;
  for (const entry of output.entries) {
    const invalidLifetime =
      !Number.isSafeInteger(entry.at) ||
      !Number.isSafeInteger(entry.expiresAt) ||
      entry.at < 0 ||
      entry.at > nowMs ||
      entry.expiresAt <= nowMs ||
      entry.expiresAt <= entry.at ||
      entry.expiresAt - entry.at > 6 * 60 * 60 * 1000;
    const invalidEntry =
      !sameScope(entry.scope) || entry.metadataCommitted !== true || seen.has(entry.id);
    if (invalidLifetime || invalidEntry) return { kind: "unavailable" };
    seen.add(entry.id);
    rows.push({
      key: entry.id,
      kind: "managed_artifact",
      title: "Managed artifact",
      detail: "Host-materialized declared output · metadata committed",
    });
    nextExpiryAt =
      nextExpiryAt === null ? entry.expiresAt : Math.min(nextExpiryAt, entry.expiresAt);
  }
  return {
    kind: "ready",
    rows,
    nextExpiryAt,
    windowLabel: "Bounded managed metadata window · not a complete inventory",
    contentLabel: "Artifact content unavailable",
  };
}
