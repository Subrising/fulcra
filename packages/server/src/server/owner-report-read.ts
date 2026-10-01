import {
  NativeArtifactContentSelectionSchema,
  SetNativeArtifactContentGrantSchema,
  NativeArtifactContentReadInputSchema,
} from "@getpaseo/protocol/native-artifact-content";
import {
  ManagedArtifactReadInputSchema,
  ManagedArtifactReadOutputSchema,
} from "@getpaseo/protocol/native-evidence";
import {
  NativeEvidenceReadInputSchema,
  NativeEvidenceReadOutputSchema,
} from "@getpaseo/protocol/native-evidence";
import { boundedJson } from "./plugins/controller-frames.js";
import { z } from "zod";
import {
  NativeOwnerReportReadInputSchema,
  NativeOwnerReportReadOutputSchema,
  type NativeReportIdentity,
} from "@getpaseo/protocol/native-intercom";
import { canonicalJson } from "@getpaseo/protocol/trusted-input";
import type { ManagementAuthority } from "./plugins/management.js";
import type { NativeReportRegistry } from "./report-registry.js";
import type { MessageReceipts } from "./message-receipts/index.js";
import { createReportReader, requireReportReader } from "./report-reader.js";
import { bindReportPublication, checkReportPublication } from "./report-publication.js";

/** Host-only adapter: no credentials, caller auth strings, consume or action routes. */
export function registerOwnerReportRead(
  management: ManagementAuthority,
  registry: NativeReportRegistry,
  current: (agentId: string) => NativeReportIdentity | null,
  ledger: () => MessageReceipts | undefined,
): void {
  management.registerOwnerHandler("report-inbox-owner-read", async (command, owner) => {
    const input = NativeOwnerReportReadInputSchema.parse(command.input);
    const guard = () => {
      owner.requireOwner();
      if (canonicalJson(current(input.identity.agentId)) !== canonicalJson(input.identity))
        throw new Error("Exact report recipient identity required");
    };
    guard();
    const registration = await registry.ownerStatus(input.identity, guard);
    guard();
    if (
      !registration ||
      registration.epoch !== input.expectedEpoch ||
      !registration.scopes.some((scope) => canonicalJson(scope) === canonicalJson(input.scope))
    )
      throw new Error("Exact registered report epoch and read scope required");
    const original = registry.readerForNativeIdentity(input.identity);
    const check = () => {
      guard();
      requireReportReader(original);
    };
    const source = requireReportReader(original);
    const scopedReader = createReportReader(
      source.identity,
      source.epoch,
      [input.scope],
      check,
      (member) => {
        check();
        source.requireMember(member);
      },
    );
    const receipts = ledger();
    if (!receipts) throw new Error("Native report ledger unavailable");
    const raw = await receipts.reportInbox(scopedReader);
    check();
    checkReportPublication(raw);
    // Projection carries only requested, independently registered read scope; no global counts or credentials.
    const inbox = z
      .object({
        events: NativeOwnerReportReadOutputSchema.shape.events,
        overflow: NativeOwnerReportReadOutputSchema.shape.overflow,
      })
      .parse(raw);
    const events = inbox.events.filter(
      (event) => canonicalJson(event.scope) === canonicalJson(input.scope),
    );
    const overflow = inbox.overflow.filter(
      (event) => canonicalJson(event.scope) === canonicalJson(input.scope),
    );
    const output = NativeOwnerReportReadOutputSchema.parse({
      scope: input.scope,
      events,
      overflow,
      visibleMetadataCount: events.length + overflow.reduce((n, group) => n + group.count, 0),
      bounded: true,
    });
    check();
    const publication = boundedJson(output);
    if (!publication || typeof publication !== "object")
      throw new Error("Report projection unavailable");
    check();
    return bindReportPublication(publication, () => {
      check();
      checkReportPublication(raw);
    });
  });
}

/** Metadata only. Neither owner read nor opaque evidence IDs authorize artifact content. */
export function registerOwnerEvidenceRead(
  management: ManagementAuthority,
  registry: NativeReportRegistry,
  current: (id: string) => NativeReportIdentity | null,
  ledger: () => MessageReceipts | undefined,
): void {
  management.registerOwnerHandler("evidence-index-owner-read", async (command, owner) => {
    const input = NativeEvidenceReadInputSchema.parse(command.input);
    const guard = () => {
      owner.requireOwner();
      if (canonicalJson(current(input.identity.agentId)) !== canonicalJson(input.identity))
        throw new Error("Exact evidence recipient required");
    };
    guard();
    const registration = await registry.ownerStatus(input.identity, guard);
    guard();
    if (
      !registration ||
      registration.epoch !== input.expectedEpoch ||
      !registration.scopes.some((scope) => canonicalJson(scope) === canonicalJson(input.scope))
    )
      throw new Error("Exact registered evidence scope required");
    const reader = registry.readerForNativeIdentity(input.identity);
    const check = () => {
      guard();
      requireReportReader(reader);
    };
    const receipts = ledger();
    if (!receipts) throw new Error("Native evidence ledger unavailable");
    const member = (record: import("@getpaseo/protocol/native-evidence").NativeEvidenceJournal) => {
      check();
      registry.requireCommittedEvidence(
        record.source,
        record.sourceEpoch,
        record.recipient,
        record.recipientEpoch,
        record.entry.scope,
        record.entry.at,
      );
    };
    const records = await receipts.evidenceIndex(
      input.identity.agentId,
      input.expectedEpoch,
      input.scope,
      check,
      member,
    );
    check();
    records.forEach(member);
    const output = NativeEvidenceReadOutputSchema.parse({
      scope: input.scope,
      entries: records.map((record) => record.entry),
      bounded: true,
      contentReadAvailable: false,
    });
    const publication = boundedJson(output);
    if (!publication || typeof publication !== "object")
      throw new Error("Evidence projection unavailable");
    check();
    return bindReportPublication(publication, () => {
      check();
      records.forEach(member);
    });
  });
}

/** Metadata only. Neither owner read nor opaque evidence IDs authorize artifact content. */
export function registerOwnerManagedArtifactRead(
  management: ManagementAuthority,
  registry: NativeReportRegistry,
  current: (id: string) => NativeReportIdentity | null,
  ledger: () => MessageReceipts | undefined,
): void {
  management.registerOwnerHandler("managed-artifact-index-owner-read", async (command, owner) => {
    const input = ManagedArtifactReadInputSchema.parse(command.input);
    const guard = () => {
      owner.requireOwner();
      if (canonicalJson(current(input.identity.agentId)) !== canonicalJson(input.identity))
        throw new Error("Exact evidence recipient required");
    };
    guard();
    const registration = await registry.ownerStatus(input.identity, guard);
    guard();
    if (
      !registration ||
      registration.epoch !== input.expectedEpoch ||
      !registration.scopes.some((scope) => canonicalJson(scope) === canonicalJson(input.scope))
    )
      throw new Error("Exact registered evidence scope required");
    const reader = registry.readerForNativeIdentity(input.identity);
    const check = () => {
      guard();
      requireReportReader(reader);
    };
    const receipts = ledger();
    if (!receipts) throw new Error("Native evidence ledger unavailable");
    const member = (
      record: import("@getpaseo/protocol/native-evidence").ManagedArtifactJournal,
    ) => {
      check();
      registry.requireCommittedEvidence(
        record.source,
        record.sourceEpoch,
        record.recipient,
        record.recipientEpoch,
        record.entry.scope,
        record.entry.at,
      );
    };
    const records = await receipts.managedArtifactIndex(
      input.identity.agentId,
      input.expectedEpoch,
      input.scope,
      check,
      member,
    );
    check();
    records.forEach(member);
    const output = ManagedArtifactReadOutputSchema.parse({
      scope: input.scope,
      entries: records.map((record) => record.entry),
      bounded: true,
      contentReadAvailable: false,
    });
    const publication = boundedJson(output);
    if (!publication || typeof publication !== "object")
      throw new Error("Evidence projection unavailable");
    check();
    return bindReportPublication(publication, () => {
      check();
      records.forEach(member);
    });
  });
}

/** Independent enumerated content authority; no metadata/status/action credential can mint it. */
export function registerOwnerArtifactContent(
  management: ManagementAuthority,
  registry: NativeReportRegistry,
  current: (id: string) => NativeReportIdentity | null,
  ledger: () => MessageReceipts | undefined,
): void {
  const selection = async (
    raw: unknown,
    owner: Parameters<import("./plugins/management.js").OwnerManagementHandler>[1],
  ) => {
    const input = NativeArtifactContentSelectionSchema.parse(raw);
    const guard = () => {
      owner.requireOwner();
      if (canonicalJson(current(input.identity.agentId)) !== canonicalJson(input.identity))
        throw new Error("Exact content recipient required");
    };
    const status = await registry.ownerStatus(input.identity, guard);
    guard();
    if (
      !status ||
      status.epoch !== input.expectedEpoch ||
      !status.scopes.some((scope) => canonicalJson(scope) === canonicalJson(input.scope))
    )
      throw new Error("Exact registered content scope required");
    const reader = registry.readerForNativeIdentity(input.identity);
    const check = () => {
      guard();
      requireReportReader(reader);
    };
    const member = (
      record: import("@getpaseo/protocol/native-evidence").ManagedArtifactJournal,
    ) => {
      check();
      registry.requireCommittedEvidence(
        record.source,
        record.sourceEpoch,
        record.recipient,
        record.recipientEpoch,
        record.entry.scope,
        record.entry.at,
      );
    };
    const receipts = ledger();
    if (!receipts) throw new Error("Content ledger unavailable");
    return { input, check, member, receipts };
  };
  management.registerOwnerHandler("artifact-content-owner-list", async (command, owner) => {
    const original = await selection(command.input, owner);
    const output = await registry.artifactContentGrants(original.input, original.check);
    original.check();
    const publication = boundedJson(output);
    if (!publication || typeof publication !== "object")
      throw new Error("Content projection refused");
    return bindReportPublication(publication, original.check);
  });
  management.registerOwnerHandler("artifact-content-owner-set", async (command, owner) => {
    const input = SetNativeArtifactContentGrantSchema.parse(command.input);
    const original = await selection(
      { identity: input.identity, expectedEpoch: input.expectedEpoch, scope: input.scope },
      owner,
    );
    const records = input.enabled
      ? (
          await original.receipts.managedArtifactIndex(
            input.identity.agentId,
            input.expectedEpoch,
            input.scope,
            original.check,
            original.member,
          )
        ).filter((record) => input.artifactIds.includes(record.entry.id))
      : [];
    original.check();
    records.forEach(original.member);
    const output = await registry.setArtifactContentGrant(input, owner, records);
    original.check();
    const publication = boundedJson(output);
    if (!publication || typeof publication !== "object")
      throw new Error("Content projection refused");
    return bindReportPublication(publication, original.check);
  });
  management.registerOwnerHandler("artifact-content-owner-read", async (command, owner) => {
    const input = NativeArtifactContentReadInputSchema.parse(structuredClone(command.input));
    const original = await selection(
      { identity: input.identity, expectedEpoch: input.expectedEpoch, scope: input.scope },
      owner,
    );
    const captured = registry.captureArtifactContentGrant(input);
    const check = () => {
      original.check();
      captured.check();
    };
    check();
    const output = await original.receipts.readManagedArtifactContent(
      input,
      captured.grant,
      check,
      original.member,
    );
    check();
    checkReportPublication(output);
    const publication = boundedJson(output);
    if (!publication || typeof publication !== "object")
      throw new Error("Content projection refused");
    return bindReportPublication(publication, () => {
      check();
      checkReportPublication(output);
    });
  });
}
