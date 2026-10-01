import { describe, expect, it } from "vitest";
import type {
  NativeEvidenceEntry,
  NativeEvidenceFact,
  NativeEvidenceReadInput,
  NativeEvidenceReadOutput,
} from "@getpaseo/protocol/native-evidence";
import { projectManagedArtifacts, projectNativeEvidence } from "./native-evidence-model";

const scope = {
  projectId: "00000000-0000-4000-8000-000000000001",
  taskId: "00000000-0000-4000-8000-000000000002",
};
const input: NativeEvidenceReadInput = {
  identity: {
    agentId: "00000000-0000-4000-8000-000000000003",
    instanceId: "00000000-0000-4000-8000-000000000004",
    boot: "00000000-0000-4000-8000-000000000005",
    sessionId: "fixture-native-session",
  },
  expectedEpoch: "00000000-0000-4000-8000-000000000006",
  scope,
};
const fact: NativeEvidenceFact = {
  kind: "produced_artifact",
  basis: "host_materialized_native_generation",
  sha256: "a".repeat(64),
  size: 1,
  contentAvailable: false,
};
function entry(overrides: Partial<NativeEvidenceEntry> = {}): NativeEvidenceEntry {
  return {
    id: "00000000-0000-4000-8000-000000000007",
    operationDigest: "b".repeat(64),
    scope,
    at: 1000,
    expiresAt: 2000,
    metadataCommitted: true,
    fact,
    ...overrides,
  };
}
function output(entries: NativeEvidenceEntry[] = [entry()]): NativeEvidenceReadOutput {
  return { scope, entries, bounded: true, contentReadAvailable: false };
}
describe("protected native evidence presentation", () => {
  it("keeps all three kinds distinct and excludes private metadata from rows", () => {
    const result = projectNativeEvidence(
      input,
      output([
        entry(),
        entry({
          id: "00000000-0000-4000-8000-000000000008",
          fact: {
            kind: "file_touch",
            basis: "native_provider_ack",
            fileCount: 1,
          },
        }),
        entry({
          id: "00000000-0000-4000-8000-000000000009",
          fact: {
            kind: "command_result",
            basis: "native_provider_ack",
            exitCode: 1,
          },
        }),
      ]),
      1500,
    );
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw new Error("Expected fixture projection");
    expect(result.rows.map((row) => row.title)).toEqual([
      "Produced artifact",
      "File touch",
      "Command result",
    ]);
    expect(result.rows.map((row) => Object.keys(row))).toEqual(
      Array.from({ length: 3 }, () => ["key", "kind", "title", "detail"]),
    );
    expect(JSON.stringify(result)).not.toContain("a".repeat(64));
    expect(JSON.stringify(result)).not.toContain("b".repeat(64));
    expect(result.contentLabel).toBe("Artifact content unavailable");
    expect(result.nextExpiryAt).toBe(2000);
  });
  it("an empty bounded window never claims a complete zero inventory", () => {
    expect(projectNativeEvidence(input, output([]), 1500)).toEqual({
      kind: "ready",
      rows: [],
      nextExpiryAt: null,
      windowLabel: "Bounded metadata window · not a complete inventory",
      contentLabel: "Artifact content unavailable",
    });
  });
  it.each([
    { at: 1501 },
    { expiresAt: 1500 },
    { expiresAt: 999 },
    { expiresAt: 1000 + 6 * 60 * 60 * 1000 + 1 },
    { at: NaN },
  ])("refuses invalid or expired lifetimes %j", (overrides) => {
    expect(projectNativeEvidence(input, output([entry(overrides)]), 1500)).toEqual({
      kind: "unavailable",
    });
  });
  it("refuses response and row scope mismatch", () => {
    const foreign = { ...scope, taskId: "00000000-0000-4000-8000-000000000099" };
    expect(projectNativeEvidence(input, { ...output(), scope: foreign }, 1500)).toEqual({
      kind: "unavailable",
    });
    expect(projectNativeEvidence(input, output([entry({ scope: foreign })]), 1500)).toEqual({
      kind: "unavailable",
    });
  });
  it("refuses duplicate opaque IDs instead of hiding conflicting facts", () => {
    expect(projectNativeEvidence(input, output([entry(), entry()]), 1500)).toEqual({
      kind: "unavailable",
    });
  });
  it("refuses windows exceeding the committed bound", () => {
    expect(
      projectNativeEvidence(input, output(Array.from({ length: 25 }, () => entry())), 1500),
    ).toEqual({ kind: "unavailable" });
  });
  it("tracks the earliest expiry without sorting or expanding the bounded window", () => {
    expect(
      projectNativeEvidence(
        input,
        output([entry({ expiresAt: 3000 }), entry({ id: "00000000-0000-4000-8000-000000000008" })]),
        1500,
      ),
    ).toMatchObject({ nextExpiryAt: 2000 });
  });
  it("refuses an invalid local clock", () => {
    expect(projectNativeEvidence(input, output(), NaN)).toEqual({ kind: "unavailable" });
  });
});

type ManagedOutput = import("zod").z.infer<
  typeof import("@getpaseo/protocol/native-evidence").ManagedArtifactReadOutputSchema
>;
type ManagedEntry = ManagedOutput["entries"][number];
function managedEntry(overrides: Partial<ManagedEntry> = {}): ManagedEntry {
  return {
    ...entry(),
    fact: {
      kind: "managed_artifact",
      basis: "host_materialized_declared_output",
      sha256: "c".repeat(64),
      size: 1,
      contentAvailable: false,
    },
    ...overrides,
  };
}
function managedOutput(entries: ManagedEntry[] = [managedEntry()]): ManagedOutput {
  return { scope, entries, bounded: true, contentReadAvailable: false };
}
describe("protected managed artifact presentation", () => {
  it("preserves the distinct declared basis without digest, content or action fields", () => {
    expect(projectManagedArtifacts(input, managedOutput(), 1500)).toEqual({
      kind: "ready",
      rows: [
        {
          key: entry().id,
          kind: "managed_artifact",
          title: "Managed artifact",
          detail: "Host-materialized declared output · metadata committed",
        },
      ],
      nextExpiryAt: 2000,
      windowLabel: "Bounded managed metadata window · not a complete inventory",
      contentLabel: "Artifact content unavailable",
    });
  });
  it("preserves an empty bounded window without complete-zero claims", () => {
    expect(projectManagedArtifacts(input, managedOutput([]), 1500)).toMatchObject({
      kind: "ready",
      rows: [],
      nextExpiryAt: null,
    });
  });
  it.each([
    { at: 1501 },
    { expiresAt: 1500 },
    { expiresAt: 999 },
    { expiresAt: 1000 + 6 * 60 * 60 * 1000 + 1 },
    { at: NaN },
  ])("refuses invalid or expired managed lifetimes %j", (overrides) => {
    expect(projectManagedArtifacts(input, managedOutput([managedEntry(overrides)]), 1500)).toEqual({
      kind: "unavailable",
    });
  });
  it("refuses mismatched response and entry scopes", () => {
    const foreign = { ...scope, taskId: "00000000-0000-4000-8000-000000000099" };
    expect(projectManagedArtifacts(input, { ...managedOutput(), scope: foreign }, 1500)).toEqual({
      kind: "unavailable",
    });
    expect(
      projectManagedArtifacts(input, managedOutput([managedEntry({ scope: foreign })]), 1500),
    ).toEqual({ kind: "unavailable" });
  });
  it("refuses duplicate IDs rather than hiding conflicting managed records", () => {
    expect(
      projectManagedArtifacts(input, managedOutput([managedEntry(), managedEntry()]), 1500),
    ).toEqual({ kind: "unavailable" });
  });
  it("refuses more than the bounded 24 entries", () => {
    expect(
      projectManagedArtifacts(
        input,
        managedOutput(Array.from({ length: 25 }, () => managedEntry())),
        1500,
      ),
    ).toEqual({ kind: "unavailable" });
  });
  it("provides earliest expiry for local purge without a read or count", () => {
    expect(
      projectManagedArtifacts(
        input,
        managedOutput([
          managedEntry({ expiresAt: 3000 }),
          managedEntry({ id: "00000000-0000-4000-8000-000000000008" }),
        ]),
        1500,
      ),
    ).toMatchObject({ nextExpiryAt: 2000 });
  });
  it("refuses invalid local clock", () => {
    expect(projectManagedArtifacts(input, managedOutput(), NaN)).toEqual({ kind: "unavailable" });
  });
});
