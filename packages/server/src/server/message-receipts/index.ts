import {
  NativeArtifactContentDebitSchema,
  NativeArtifactContentReadInputSchema,
  NativeArtifactContentReadOutputSchema,
  type NativeArtifactContentGrant,
  type NativeArtifactContentReadInput,
  type NativeArtifactContentDebit,
} from "@getpaseo/protocol/native-artifact-content";
import { NativeArtifactStore } from "../native-artifact-store.js";
import {
  ManagedArtifactClaimSchema,
  ManagedArtifactJournalSchema,
  type ManagedArtifactClaim,
  type ManagedArtifactJournal,
} from "@getpaseo/protocol/native-evidence";
import {
  NativeEvidenceClaimSchema,
  type NativeEvidenceClaim,
  NativeEvidenceJournalSchema,
  type NativeEvidenceJournal,
} from "@getpaseo/protocol/native-evidence";
import { canonicalJson } from "@getpaseo/protocol/trusted-input";
import { reportMembers, sameNativeReportEvent } from "../report-batch.js";
import { bindReportPublication } from "../report-publication.js";
import { requireReportReader, type ReportReader } from "../report-reader.js";
import {
  ReportBatchSchema,
  validateReportBatchData,
  requireNativeReportBatch,
  mergeNativeReportBatches,
  type NativeReportBatch,
  type ReportBatchData,
} from "../report-batch.js";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { isNativeQueuedRefusal } from "../agent/native-queued-dispatch.js";
import { writeJsonFileAtomic, writeJsonFileDurable } from "../atomic-file.js";
import { SENT_NOTHING_CODES } from "../held-sends.js";

const LegacyReceiptSchema = z.object({
  fingerprint: z.string(),
  state: z.enum(["pending", "completed"]),
  agentId: z.string(),
});

const QueuedReceiptSchema = z.object({
  version: z.literal(2),
  agentId: z.string(),
  messageId: z.string(),
  fingerprint: z.string(),
  principal: z.string(),
  boot: z.string(),
  state: z.enum(["queued", "dispatching", "delivered", "refused", "cancelled", "uncertain"]),
  admittedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  providerTurnId: z.string().optional(),
  report: ReportBatchSchema.optional(),
  collectingUntil: z.number().int().nonnegative().optional(),
});
const ReceiptSchema = z.union([
  QueuedReceiptSchema,
  LegacyReceiptSchema,
  NativeEvidenceJournalSchema,
  NativeEvidenceClaimSchema,
  ManagedArtifactClaimSchema,
  ManagedArtifactJournalSchema,
  NativeArtifactContentDebitSchema,
]);
type QueuedReceipt = z.infer<typeof QueuedReceiptSchema>;
export type NativeMessageReceipt = Pick<QueuedReceipt, "state" | "messageId" | "providerTurnId"> & {
  pendingCount: number;
};
export interface NativeQueuedMessage {
  agentId: string;
  messageId: string;
  request: unknown;
  /** Host-authenticated immutable source/target/grant/cursor binding, never a caller owner bit. */
  principal: unknown;
  boot: string;
  /** Actual retained attachment resource sizes, verified by the native owner. */
  attachmentBytes: number;
  /** Synchronous fresh authorization. Called again at durable commit and final provider effect. */
  authorize: () => void;
  /** Native manager-owned effect, never wire supplied. */
  start?: (finalCheck: () => void) => Promise<string>;
  /** Host-private lifecycle observer, not a provider effect or action authorizer. */
  observe?: (receipt: NativeMessageReceipt) => void;
  /** Branded registry purpose; never a caller-selected wire flag. */
  reportBatch?: NativeReportBatch;
  /** Native collector only: metadata committed, but no immutable wake accepted yet. */
  collectingUntil?: number;
  canDispatch?: () => boolean;
  prepareDispatch?: () => Promise<void>;
}
export interface NativeReportMetadataReceipt {
  eventId: string;
  metadataCommitted: true;
  wakeState:
    | "collecting"
    | "queued"
    | "dispatching"
    | "delivered"
    | "refused"
    | "cancelled"
    | "uncertain";
  duplicate: boolean;
}
function requireContentEncoding(debit: NativeArtifactContentDebit): void {
  const input = debit.request;
  const maximumReply = {
    requestId: input.requestId,
    grantId: input.grantId,
    grantRevision: input.grantRevision,
    artifactId: input.artifactId,
    scope: input.scope,
    offset: input.offset,
    length: input.length,
    expiresAt: Number.MAX_SAFE_INTEGER,
    encoding: "base64",
    contentType: "text/plain",
    data: "A".repeat(4 * Math.ceil(input.length / 3)),
    eof: false,
  };
  // Validate actual escaped durable bytes and the complete maximum reply BEFORE any capacity/write effect.
  if (
    Buffer.byteLength(JSON.stringify(debit)) > debit.bytes ||
    Buffer.byteLength(JSON.stringify(maximumReply)) > debit.bytes
  )
    throw new Error("Content encoded reservation exceeded");
}
const MAX_TARGET_COUNT = 32;
const MAX_TARGET_BYTES = 512 * 1024;
const MAX_GLOBAL_COUNT = 256;
const MAX_GLOBAL_BYTES = 8 * 1024 * 1024;
const MAX_TERMINAL_IDS = 10000;
const MAX_TEXT_BYTES = 16 * 1024;
const MAX_LIFETIME = 6 * 60 * 60 * 1000;
export class NativeReceiptMaintenanceError extends Error {
  readonly code = "agent_receipt_maintenance_required";
  constructor() {
    super(
      "Native receipt ledger exhausted; owner maintenance required. New IDs refused; existing IDs remain fenced.",
    );
  }
}

function isQueued(receipt: z.infer<typeof ReceiptSchema>): receipt is QueuedReceipt {
  return "version" in receipt && receipt.version === 2;
}

interface SendMessageInput {
  agentId: string;
  messageId: string;
  request: unknown;
  send: () => Promise<void>;
  prepare?: () => Promise<void>;
}

/** Owns message delivery receipts; creation is owned by CreationService. */
export class MessageReceipts {
  private readonly contentDebits = new Map<string, NativeArtifactContentDebit>();
  private artifactStore?: NativeArtifactStore;
  private readonly managedClaims = new Map<string, ManagedArtifactClaim>();
  private readonly managedArtifacts = new Map<string, ManagedArtifactJournal>();
  private readonly pending = new Map<string, Promise<void>>();
  private tail: Promise<unknown> = Promise.resolve();
  private initialized = false;
  private unhealthy = false;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private watermark = 0;
  private readonly evidenceClaims = new Map<string, NativeEvidenceClaim>();
  private readonly evidence = new Map<string, NativeEvidenceJournal>();
  private readonly records = new Map<string, QueuedReceipt>();
  private readonly admissions = new Map<string, NativeQueuedMessage>();
  private diskCount = 0;
  private readonly collectionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(
    private readonly directory: string,
    private readonly now = Date.now,
    private readonly terminalIdLimit = MAX_TERMINAL_IDS,
  ) {
    if (
      !Number.isSafeInteger(terminalIdLimit) ||
      terminalIdLimit < 1 ||
      terminalIdLimit > MAX_TERMINAL_IDS
    )
      throw new Error("Invalid finite native receipt limit");
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail
      .catch(() => undefined)
      .then(() => {
        if (this.unhealthy) throw new Error("agent_receipt_durability_unavailable");
        return operation();
      });
    this.tail = result;
    return result;
  }

  private recoverEvidence(file: string, receipt: z.infer<typeof ReceiptSchema>): void {
    if (!("recordType" in receipt)) return;
    if (receipt.recordType === "native_artifact_content_debit") {
      const { fingerprint, bytes, ...body } = receipt;
      if (
        file !== `${digest(["native-artifact-content", receipt.request.requestId])}.json` ||
        fingerprint !== digest(body) ||
        (bytes !== 4096 + 4 * Math.ceil(receipt.request.length / 3) &&
          bytes !== 2048 + 4 * Math.ceil(receipt.request.length / 3)) ||
        Buffer.byteLength(JSON.stringify(receipt)) > bytes
      )
        throw new Error("Native content debit corrupt");
      requireContentEncoding(receipt);
      this.contentDebits.set(file.slice(0, -5), receipt);
      this.watermark = Math.max(this.watermark, receipt.at);
      return;
    }
    if (
      receipt.recordType === "native_managed_artifact_attempt" ||
      receipt.recordType === "native_managed_artifact"
    ) {
      if (
        !validManagedArtifact(receipt) ||
        file !== `${digest(["native-managed-artifact", receipt.entry.id])}.json`
      )
        throw new Error("Managed artifact journal corrupt");
      if (receipt.recordType === "native_managed_artifact_attempt")
        this.managedClaims.set(file.slice(0, -5), receipt);
      else this.managedArtifacts.set(file.slice(0, -5), receipt);
      this.watermark = Math.max(this.watermark, receipt.entry.at);
      return;
    }
    if (!validEvidence(receipt) || file !== `${digest(["native-evidence", receipt.entry.id])}.json`)
      throw new Error("Native evidence journal corrupt");
    if (receipt.recordType === "native_evidence_attempt")
      this.evidenceClaims.set(file.slice(0, -5), receipt);
    else this.evidence.set(file.slice(0, -5), receipt);
    this.watermark = Math.max(this.watermark, receipt.entry.at);
  }

  private async initialize(requireEffect?: () => void): Promise<void> {
    if (this.initialized) return;
    let files: string[];
    try {
      files = await readdir(this.directory);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      files = [];
    }
    files = files.filter((file) => /^[a-f0-9]{64}\.json$/.test(file));
    this.diskCount = files.length;
    if (files.length > this.terminalIdLimit) throw new NativeReceiptMaintenanceError();
    for (const file of files) {
      const receipt = await readReceipt(path.join(this.directory, file));
      if (!receipt) throw new Error("agent_receipt_disappeared");
      this.diskCount += isQueued(receipt) ? this.weight(receipt) - 1 : 0;
      if (this.diskCount > this.terminalIdLimit) throw new NativeReceiptMaintenanceError();
      this.recoverEvidence(file, receipt);
      if (isQueued(receipt)) {
        this.watermark = Math.max(this.watermark, receipt.admittedAt);
        // A new native manager never reconstructs authority or replays a prior boot's prompt.
        if (receipt.state === "queued" || receipt.state === "dispatching") {
          receipt.state = receipt.state === "queued" ? "cancelled" : "uncertain";
          await writeJsonFileDurable(path.join(this.directory, file), receipt, requireEffect);
        }
        this.records.set(file.slice(0, -5), receipt);
      }
    }
    this.initialized = true;
  }

  private clock(): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < this.watermark)
      throw new Error("agent_queue_clock_rollback");
    this.watermark = now;
    return now;
  }

  private weight(receipt: QueuedReceipt): number {
    return 1 + (receipt.report ? reportMembers(receipt.report).length : 0);
  }

  private reserved(): QueuedReceipt[] {
    return [...this.records.values()].filter(
      (r) =>
        r.state === "queued" ||
        r.state === "dispatching" ||
        (r.report &&
          r.report.consumed.length < reportMembers(r.report).length &&
          r.expiresAt > this.now()),
    );
  }

  private active(): QueuedReceipt[] {
    return [...this.records.values()].filter(
      (r) => r.state === "queued" || r.state === "dispatching",
    );
  }

  private view(receipt: QueuedReceipt): NativeMessageReceipt {
    return {
      state: receipt.state,
      messageId: receipt.messageId,
      ...(receipt.providerTurnId ? { providerTurnId: receipt.providerTurnId } : {}),
      pendingCount: this.active().filter((r) => r.agentId === receipt.agentId && !r.collectingUntil)
        .length,
    };
  }

  private async commit(
    key: string,
    receipt: QueuedReceipt,
    requireEffect?: () => void,
  ): Promise<void> {
    try {
      if (receipt.report && Buffer.byteLength(JSON.stringify(receipt)) > receipt.bytes)
        throw new Error("Native report consumption reservation exceeded");
      await writeJsonFileDurable(path.join(this.directory, `${key}.json`), receipt, requireEffect);
      requireEffect?.(); // After every durability await, immediately before memory publication.
    } catch (error) {
      this.unhealthy = true;
      throw error;
    }
    this.records.set(key, receipt);
    this.admissions.get(key)?.observe?.(this.view(receipt));
    if (receipt.state !== "queued" && receipt.state !== "dispatching") this.admissions.delete(key);
    this.armExpiry();
  }

  private armExpiry(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    const pending = [...this.records.values()].filter((r) => r.state === "queued");
    if (!pending.length) return;
    const next = Math.min(...pending.map((r) => r.expiresAt));
    this.expiryTimer = setTimeout(
      () => {
        this.expiryTimer = undefined;
        void this.serial(async () => {
          let now: number;
          try {
            now = this.clock();
          } catch {
            await this.cancelPending();
            return;
          }
          await this.expire(now);
        }).catch(() => {
          this.unhealthy = true;
        });
      },
      Math.max(1, next - this.now()),
    );
    this.expiryTimer.unref();
  }

  private async cancelPending(agentId?: string): Promise<void> {
    for (const [key, receipt] of this.records) {
      if (receipt.state === "queued" && (!agentId || receipt.agentId === agentId))
        await this.commit(key, { ...receipt, state: "cancelled" });
    }
  }

  hasPendingForAgent(agentId: string): boolean {
    return this.active().some((receipt) => receipt.agentId === agentId);
  }

  /** Native lifecycle owner only; no public read/cancel authority is inferred from this method. */
  closeAgent(agentId: string): Promise<void> {
    return this.serial(() => this.cancelPending(agentId));
  }

  /** Native owner adapter only. Never expose global counts through a report/action credential. */
  maintenance(requireOwner: () => void): Promise<{
    recordedIds: number;
    maxIds: number;
    maintenanceRequired: boolean;
    newIdsRefused: boolean;
    automaticPruning: false;
  }> {
    return this.serial(async () => {
      requireOwner();
      try {
        await this.initialize(requireOwner);
      } catch (error) {
        if (!(error instanceof NativeReceiptMaintenanceError)) throw error;
      }
      requireOwner();
      const exhausted = this.diskCount >= this.terminalIdLimit;
      return {
        recordedIds: this.diskCount,
        maxIds: this.terminalIdLimit,
        maintenanceRequired: exhausted,
        newIdsRefused: exhausted,
        automaticPruning: false,
      };
    });
  }

  private assertNewReportMembers(report: ReportBatchData | undefined): void {
    if (!report) return;
    const incoming = new Set(reportMembers(report).map((member) => member.id));
    for (const existing of this.records.values()) {
      if (
        existing.report &&
        reportMembers(existing.report).some((member) => incoming.has(member.id))
      )
        throw new Error("Native report member already committed");
    }
  }

  private assertReservation(
    agentId: string,
    bytes: number,
    weight: number,
    members: number,
    replacing?: QueuedReceipt,
  ): void {
    this.assertEvidenceCapacity(agentId, bytes, weight, replacing);
    if (this.diskCount + weight - (replacing ? this.weight(replacing) : 0) > this.terminalIdLimit)
      throw new NativeReceiptMaintenanceError();
    const active = this.reserved().filter((receipt) => receipt !== replacing),
      target = active.filter((receipt) => receipt.agentId === agentId);
    if (
      active.reduce((n, receipt) => n + this.weight(receipt), weight) > MAX_GLOBAL_COUNT ||
      target.reduce((n, receipt) => n + this.weight(receipt), weight) > MAX_TARGET_COUNT ||
      (members > 0 &&
        target.reduce(
          (n, receipt) => n + (receipt.report ? reportMembers(receipt.report).length : 0),
          members,
        ) > 24) ||
      bytes > MAX_TARGET_BYTES ||
      target.reduce((n, receipt) => n + receipt.bytes, bytes) > MAX_TARGET_BYTES ||
      active.reduce((n, receipt) => n + receipt.bytes, bytes) > MAX_GLOBAL_BYTES
    )
      throw new Error("agent_queue_resource_limit");
  }

  /** Native admission only; no provider invocation or controller retry occurs here. */
  enqueue(original: NativeQueuedMessage): Promise<NativeMessageReceipt> {
    // Caller/UI ownership can change while the serialized admission awaits. Snapshot body/binding now.
    const authorize = original.authorize;
    const reportBatch = original.reportBatch;
    const input: NativeQueuedMessage = {
      ...original,
      request: structuredClone(original.request),
      principal: structuredClone(original.principal),
      authorize: () => {
        authorize();
        if (reportBatch) requireNativeReportBatch(reportBatch);
      },
    };
    return this.serial(() => this.admit(input));
  }

  /** Metadata and the future wake reservation share one recoverable receipt file and serial fence. */
  collectReport(
    batch: NativeReportBatch,
    makeInput: (batch: NativeReportBatch, messageId: string) => NativeQueuedMessage,
    onReady: (agentId: string) => void,
  ): Promise<NativeReportMetadataReceipt> {
    const incoming = requireNativeReportBatch(batch);
    if (incoming.data.members.length !== 1) throw new Error("One host report event required");
    const member = incoming.data.members[0]!;
    return this.serial(async () => {
      await this.initialize(incoming.requireCurrent);
      incoming.requireCurrent();
      const now = this.clock();
      await this.expire(now);
      incoming.requireCurrent();
      const previous = [...this.records.values()].find(
        (receipt) =>
          receipt.report &&
          reportMembers(receipt.report).some((entry) =>
            sameNativeReportEvent(
              entry,
              member,
              digest(receipt.report!.parent) === digest(incoming.data.parent),
            ),
          ),
      );
      if (previous) {
        const retained = previous.report!;
        const oldMember = reportMembers(retained).find((entry) =>
          sameNativeReportEvent(
            entry,
            member,
            digest(retained.parent) === digest(incoming.data.parent),
          ),
        )!;
        if (
          digest(oldMember) !== digest(member) ||
          digest(retained.parent) !== digest(incoming.data.parent) ||
          retained.parentEpoch !== incoming.data.parentEpoch
        )
          throw new Error("Native report event identity conflict");
        incoming.requireCurrent();
        return this.reportMetadataReceipt(previous, member.id, true);
      }
      // A legitimate new host event may outlive an earlier source registration (e.g. its final retirement).
      // Cancel stale collecting envelopes as host facts; never merge their revoked authority into the new batch.
      for (const [oldKey, oldReceipt] of this.records) {
        if (
          oldReceipt.state !== "queued" ||
          !oldReceipt.collectingUntil ||
          oldReceipt.agentId !== incoming.data.parent.agentId
        )
          continue;
        try {
          this.admissions.get(oldKey)?.authorize();
        } catch {
          await this.commit(oldKey, { ...oldReceipt, state: "cancelled" });
        }
      }
      const entry = [...this.records].find(
        ([, receipt]) =>
          receipt.state === "queued" &&
          (receipt.collectingUntil ?? 0) > now &&
          receipt.report &&
          reportMembers(receipt.report).length < 24 &&
          receipt.report.parentEpoch === incoming.data.parentEpoch &&
          digest(receipt.report.parent) === digest(incoming.data.parent),
      );
      if (entry) {
        const [key, receipt] = entry;
        const oldInput = this.admissions.get(key);
        if (!oldInput?.reportBatch) throw new Error("Native report collection authority absent");
        const merged = mergeNativeReportBatches(oldInput.reportBatch, batch);
        const input = this.reportCollectionInput(merged, receipt.messageId, makeInput);
        if (input.agentId !== receipt.agentId || input.boot !== receipt.boot)
          throw new Error("Native report collection identity changed");
        const report = reportDataFor(input)!;
        report.consumed = [...receipt.report!.consumed];
        const next = {
          ...receipt,
          report,
          principal: digest(input.principal),
          fingerprint: digest({
            request: input.request,
            principal: input.principal,
            attachmentBytes: input.attachmentBytes,
            delivery: "boundary-v1",
            report,
          }),
        };
        if (
          Buffer.byteLength(JSON.stringify(next)) +
            Buffer.byteLength(JSON.stringify(input.request)) >
          next.bytes
        )
          throw new Error("Native report collection reservation exceeded");
        this.assertReservation(
          input.agentId,
          next.bytes,
          this.weight(next),
          reportMembers(report).length,
          receipt,
        );
        await this.commit(key, next, input.authorize);
        this.diskCount++;
        input.authorize();
        this.admissions.set(key, { ...input, collectingUntil: receipt.collectingUntil });
        this.armCollection(key, onReady);
        return this.reportMetadataReceipt(next, member.id, false);
      }
      const input = this.reportCollectionInput(batch, `paseo-notify:${randomUUID()}`, makeInput);
      input.collectingUntil = now + 2000;
      await this.admit(input);
      const key = digest(["send", input.agentId, input.messageId]);
      input.authorize();
      this.armCollection(key, onReady);
      return this.reportMetadataReceipt(this.records.get(key)!, member.id, false);
    });
  }

  private reportCollectionInput(
    batch: NativeReportBatch,
    messageId: string,
    makeInput: (batch: NativeReportBatch, messageId: string) => NativeQueuedMessage,
  ): NativeQueuedMessage {
    const original = makeInput(batch, messageId);
    if (
      original.messageId !== messageId ||
      original.reportBatch !== batch ||
      original.attachmentBytes !== 0
    )
      throw new Error("Invalid host report collection input");
    const authorize = original.authorize;
    return {
      ...original,
      request: structuredClone(original.request),
      principal: structuredClone(original.principal),
      authorize: () => {
        authorize();
        requireNativeReportBatch(batch);
      },
    };
  }

  private reportMetadataReceipt(
    receipt: QueuedReceipt,
    eventId: string,
    duplicate: boolean,
  ): NativeReportMetadataReceipt {
    return {
      eventId,
      metadataCommitted: true,
      wakeState:
        receipt.state === "queued" && receipt.collectingUntil ? "collecting" : receipt.state,
      duplicate,
    };
  }

  private armCollection(key: string, onReady: (agentId: string) => void): void {
    const receipt = this.records.get(key);
    if (!receipt?.collectingUntil || receipt.state !== "queued") return;
    const oldTimer = this.collectionTimers.get(key);
    if (oldTimer) clearTimeout(oldTimer);
    const delay = Math.max(0, receipt.collectingUntil - this.now());
    const timer = setTimeout(() => {
      this.collectionTimers.delete(key);
      void this.serial(async () => {
        const current = this.records.get(key);
        if (!current?.collectingUntil || current.state !== "queued") return;
        const input = this.admissions.get(key);
        try {
          if (!input) throw new Error("Native report collection authority absent");
          input.authorize();
          if (!input.canDispatch?.()) throw new Error("Native report wake unsupported");
          await input.prepareDispatch?.();
          input.authorize();
        } catch {
          await this.commit(key, { ...current, state: "refused" });
          return;
        }
        const sealed = { ...current };
        delete sealed.collectingUntil;
        await this.commit(key, sealed, input.authorize);
        input.authorize();
        onReady(sealed.agentId);
      }).catch(() => {
        this.unhealthy = true;
      });
    }, delay);
    timer.unref();
    this.collectionTimers.set(key, timer);
  }

  prepareEvidence(input: NativeEvidenceClaim, authorize: () => void): Promise<boolean> {
    const snapshot = NativeEvidenceClaimSchema.parse(structuredClone(input));
    authorize();
    return this.serial(async () => {
      await this.initialize(authorize);
      authorize();
      const key = digest(["native-evidence", snapshot.entry.id]);
      const old = await readReceipt(path.join(this.directory, `${key}.json`));
      authorize();
      if (old) {
        if (
          !("recordType" in old) ||
          (old.recordType !== "native_evidence" && old.recordType !== "native_evidence_attempt") ||
          old.completionBodyDigest !== snapshot.completionBodyDigest ||
          canonicalJson(evidenceContext(old)) !== canonicalJson(evidenceContext(snapshot))
        )
          throw new Error("Native evidence ID body conflict");
        return false; // Any prior preparation, including a crash, permanently prevents re-materialization.
      }
      if (!validEvidence(snapshot) || snapshot.entry.expiresAt <= this.clock())
        throw new Error("Native evidence claim refused");
      this.assertEvidenceCapacity(snapshot.recipient.agentId, snapshot.bytes);
      try {
        await writeJsonFileDurable(path.join(this.directory, `${key}.json`), snapshot, authorize);
        authorize();
      } catch (error) {
        this.unhealthy = true;
        throw error;
      }
      this.evidenceClaims.set(key, snapshot);
      this.diskCount++;
      return true;
    });
  }

  appendEvidence(input: NativeEvidenceJournal, authorize: () => void): Promise<void> {
    const snapshot = NativeEvidenceJournalSchema.parse(structuredClone(input));
    authorize();
    return this.serial(async () => {
      await this.initialize(authorize);
      authorize();
      const key = digest(["native-evidence", snapshot.entry.id]);
      const old = await readReceipt(path.join(this.directory, `${key}.json`));
      authorize();
      if (
        !old ||
        !("recordType" in old) ||
        (old.recordType !== "native_evidence" && old.recordType !== "native_evidence_attempt")
      )
        throw new Error("Durable native evidence claim required");
      if (old.recordType === "native_evidence") {
        if (canonicalJson(old) !== canonicalJson(snapshot))
          throw new Error("Native evidence ID body conflict");
        return;
      }
      if (
        old.completionBodyDigest !== snapshot.completionBodyDigest ||
        canonicalJson(evidenceContext(old)) !== canonicalJson(evidenceContext(snapshot))
      )
        throw new Error("Native evidence claim body conflict");
      if (
        !validEvidence(snapshot) ||
        snapshot.bytes > old.bytes ||
        snapshot.entry.expiresAt <= this.clock()
      )
        throw new Error("Native evidence resource refusal");
      try {
        await writeJsonFileDurable(path.join(this.directory, `${key}.json`), snapshot, authorize);
        authorize();
      } catch (error) {
        this.unhealthy = true;
        throw error;
      }
      this.evidenceClaims.delete(key);
      this.evidence.set(key, snapshot);
    });
  }

  produceDeclaredArtifact(
    input: ManagedArtifactClaim,
    bytes: Uint8Array,
    authorize: () => void,
  ): Promise<ManagedArtifactJournal> {
    const snapshot = ManagedArtifactClaimSchema.parse(structuredClone(input)),
      body = Buffer.from(bytes);
    if (
      body.length !== snapshot.artifactReservation.size ||
      createHash("sha256").update(body).digest("hex") !== snapshot.artifactReservation.sha256
    )
      throw new Error("Native declared bytes conflict");
    authorize();
    return this.serial(async () => {
      await this.initialize(authorize);
      authorize();
      const key = digest(["native-managed-artifact", snapshot.entry.id]),
        file = path.join(this.directory, `${key}.json`);
      const previous = await readReceipt(file);
      authorize();
      if (previous)
        throw new Error("Managed artifact ID already attempted; no rematerialization or replay");
      if (!validManagedArtifact(snapshot) || snapshot.entry.expiresAt <= this.clock())
        throw new Error("Managed artifact attempt refused");
      this.assertEvidenceCapacity(
        snapshot.recipient.agentId,
        snapshot.bytes + snapshot.artifactReservation.size,
      );
      try {
        await writeJsonFileDurable(file, snapshot, authorize);
        authorize();
        this.managedClaims.set(key, snapshot);
        this.diskCount++;
        this.artifactStore ??= new NativeArtifactStore(path.join(this.directory, "artifacts"));
        this.artifactStore.validateReservations(
          [...this.managedClaims.values(), ...this.managedArtifacts.values()].map((item) =>
            item.recordType === "native_managed_artifact"
              ? {
                  id: item.entry.id,
                  size: item.artifactReservation.size,
                  reference: item.artifactReference,
                }
              : { id: item.entry.id, size: item.artifactReservation.size },
          ),
          authorize,
        );
        const artifactReference = this.artifactStore.write(snapshot.entry.id, body, authorize);
        const { fingerprint: _fingerprint, ...captured } = snapshot;
        const recordBody = {
          ...captured,
          recordType: "native_managed_artifact" as const,
          artifactReference,
          entry: {
            ...snapshot.entry,
            fact: {
              kind: "managed_artifact" as const,
              basis: "host_materialized_declared_output" as const,
              size: artifactReference.size,
              sha256: artifactReference.sha256,
              contentAvailable: false as const,
            },
            metadataCommitted: true as const,
          },
        };
        const { bytes: _bytes, ...immutable } = recordBody;
        const record = ManagedArtifactJournalSchema.parse({
          ...recordBody,
          fingerprint: digest(immutable),
        });
        if (!validManagedArtifact(record)) throw new Error("Managed artifact outcome refused");
        await writeJsonFileDurable(file, record, authorize);
        authorize();
        this.managedClaims.delete(key);
        this.managedArtifacts.set(key, record);
        return record;
      } catch (error) {
        this.unhealthy = true;
        throw error;
      }
    });
  }

  readManagedArtifactContent(
    raw: NativeArtifactContentReadInput,
    rawGrant: NativeArtifactContentGrant,
    authorize: () => void,
    member: (record: ManagedArtifactJournal) => void,
  ) {
    const input = NativeArtifactContentReadInputSchema.parse(structuredClone(raw)),
      grant = structuredClone(rawGrant);
    authorize();
    return this.serial(async () => {
      await this.initialize(authorize);
      authorize();
      if (
        grant.grantId !== input.grantId ||
        grant.revision !== input.grantRevision ||
        canonicalJson(grant.identity) !== canonicalJson(input.identity) ||
        grant.expectedEpoch !== input.expectedEpoch ||
        canonicalJson(grant.scope) !== canonicalJson(input.scope) ||
        !grant.artifactIds.includes(input.artifactId) ||
        this.clock() >= grant.expiresAt
      )
        throw new Error("Current enumerated content grant required");
      const record = this.managedArtifacts.get(
        digest(["native-managed-artifact", input.artifactId]),
      );
      if (
        !record ||
        record.recipient.agentId !== input.identity.agentId ||
        record.recipientEpoch !== input.expectedEpoch ||
        canonicalJson(record.entry.scope) !== canonicalJson(input.scope) ||
        record.entry.expiresAt <= this.clock() ||
        !Number.isSafeInteger(input.offset + input.length) ||
        input.offset + input.length > record.artifactReference.size
      )
        throw new Error("Committed contained content range required");
      const check = () => {
        authorize();
        member(record);
        if (record.entry.expiresAt <= this.clock() || grant.expiresAt <= this.clock())
          throw new Error("Committed content or grant expired");
      };
      check();
      const key = digest(["native-artifact-content", input.requestId]);
      if (await readReceipt(path.join(this.directory, `${key}.json`)))
        throw new Error("Content read ID already attempted; no replay");
      check();
      const used = [...this.contentDebits.values()]
        .filter((debit) => debit.request.grantId === grant.grantId)
        .reduce((total, debit) => total + debit.request.length, 0);
      if (used + input.length > grant.byteBudget)
        throw new Error("Aggregate content grant byte budget exhausted");
      const body = {
        version: 5 as const,
        recordType: "native_artifact_content_debit" as const,
        request: input,
        byteBudget: grant.byteBudget,
        artifactDigest: digest(record.artifactReference),
        at: this.clock(),
      };
      const debit = NativeArtifactContentDebitSchema.parse({
        ...body,
        bytes: 4096 + 4 * Math.ceil(input.length / 3),
        fingerprint: digest(body),
      });
      requireContentEncoding(debit);
      this.assertEvidenceCapacity(input.identity.agentId, debit.bytes);
      try {
        await writeJsonFileDurable(path.join(this.directory, `${key}.json`), debit, check);
        check();
        this.contentDebits.set(key, debit);
        this.diskCount++;
        this.artifactStore ??= new NativeArtifactStore(path.join(this.directory, "artifacts"));
        const bytes = this.artifactStore
          .read(input.artifactId, record.artifactReference, check)
          .subarray(input.offset, input.offset + input.length);
        check();
        const output = NativeArtifactContentReadOutputSchema.parse({
          requestId: input.requestId,
          grantId: grant.grantId,
          grantRevision: grant.revision,
          artifactId: input.artifactId,
          scope: input.scope,
          offset: input.offset,
          length: bytes.length,
          expiresAt: Math.min(grant.expiresAt, record.entry.expiresAt),
          encoding: "base64",
          contentType: "text/plain",
          data: bytes.toString("base64"),
          eof: input.offset + bytes.length === record.artifactReference.size,
        });
        return bindReportPublication(output, check);
      } catch (error) {
        this.unhealthy = true;
        throw error;
      }
    });
  }

  managedArtifactIndex(
    recipient: string,
    epoch: string,
    scope: unknown,
    authorize: () => void,
    member: (record: ManagedArtifactJournal) => void,
  ): Promise<ManagedArtifactJournal[]> {
    return this.serial(async () => {
      await this.initialize(authorize);
      authorize();
      const result = [...this.managedArtifacts.values()]
        .filter(
          (r) =>
            r.recipient.agentId === recipient &&
            r.recipientEpoch === epoch &&
            canonicalJson(r.entry.scope) === canonicalJson(scope) &&
            r.entry.expiresAt > this.clock(),
        )
        .filter((r) => {
          try {
            member(r);
            return true;
          } catch {
            return false;
          }
        })
        .sort((a, b) => a.entry.at - b.entry.at)
        .slice(0, 24);
      authorize();
      return structuredClone(result);
    });
  }

  private assertEvidenceCapacity(
    agentId: string,
    bytes: number,
    weight = 1,
    replacing?: QueuedReceipt,
  ): void {
    if (this.diskCount + weight - (replacing ? this.weight(replacing) : 0) > this.terminalIdLimit)
      throw new NativeReceiptMaintenanceError();
    const live = [...this.evidence.values(), ...this.evidenceClaims.values()].filter(
      (item) => item.entry.expiresAt > this.now(),
    );
    // Stored artifact bytes remain reserved after metadata expiry, including failed attempts/restart.
    const managed = [...this.managedClaims.values(), ...this.managedArtifacts.values()];
    const debits = [...this.contentDebits.values()];
    const targetDebits = debits.filter((item) => item.request.identity.agentId === agentId);
    const managedTarget = managed.filter((item) => item.recipient.agentId === agentId);
    const storedBytes = (items: typeof managed) =>
      items.reduce((total, item) => total + item.bytes + item.artifactReservation.size, 0);
    const queue = this.reserved().filter((receipt) => receipt !== replacing);
    const target = live.filter((item) => item.recipient.agentId === agentId);
    const queued = queue.filter((item) => item.agentId === agentId);
    if (
      debits.length +
        managed.length +
        live.length +
        queue.reduce((n, r) => n + this.weight(r), 0) +
        weight >
        MAX_GLOBAL_COUNT ||
      targetDebits.length +
        managedTarget.length +
        target.length +
        queued.reduce((n, r) => n + this.weight(r), 0) +
        weight >
        MAX_TARGET_COUNT ||
      debits.reduce((n, item) => n + item.bytes, 0) +
        storedBytes(managed) +
        live.reduce((n, r) => n + r.bytes, 0) +
        queue.reduce((n, r) => n + r.bytes, 0) +
        bytes >
        MAX_GLOBAL_BYTES ||
      targetDebits.reduce((n, item) => n + item.bytes, 0) +
        storedBytes(managedTarget) +
        target.reduce((n, r) => n + r.bytes, 0) +
        queued.reduce((n, r) => n + r.bytes, 0) +
        bytes >
        MAX_TARGET_BYTES
    )
      throw new Error("Native evidence shared resource refusal");
  }

  evidenceIndex(
    recipient: string,
    epoch: string,
    scope: unknown,
    authorize: () => void,
    member: (entry: NativeEvidenceJournal) => void,
  ): Promise<NativeEvidenceJournal[]> {
    return this.serial(async () => {
      await this.initialize(authorize);
      authorize();
      const result = [...this.evidence.values()]
        .filter(
          (record) =>
            record.recipient.agentId === recipient &&
            record.recipientEpoch === epoch &&
            canonicalJson(record.entry.scope) === canonicalJson(scope) &&
            record.entry.expiresAt > this.clock(),
        )
        .filter((record) => {
          try {
            member(record);
            return true;
          } catch {
            return false;
          }
        })
        .sort((a, b) => a.entry.at - b.entry.at)
        .slice(0, 24);
      authorize();
      result.forEach(member);
      return structuredClone(result);
    });
  }

  private async admit(input: NativeQueuedMessage): Promise<NativeMessageReceipt> {
    await this.initialize();
    input.authorize();
    const key = digest(["send", input.agentId, input.messageId]);
    const report = reportDataFor(input);
    const principal = digest(input.principal);
    const fingerprint = digest({
      request: input.request,
      principal: input.principal,
      attachmentBytes: input.attachmentBytes,
      delivery: "boundary-v1",
      ...(report ? { report } : {}),
    });
    const old = await readReceipt(path.join(this.directory, `${key}.json`));
    input.authorize(); // Principal protection includes duplicate reads after disk I/O.
    if (old) {
      // Legacy ack/outcome must never become proof of native queued/delivered acceptance.
      if (!isQueued(old) || old.principal !== principal)
        throw new Error("agent_receipt_unavailable");
      if (old.fingerprint !== fingerprint) throw new Error("agent_request_key_conflict");
      return this.view(old);
    }
    const now = this.clock();
    await this.expire(now);
    const textBytes = Buffer.byteLength(JSON.stringify(input.request));
    if (
      textBytes > MAX_TEXT_BYTES ||
      !Number.isSafeInteger(input.attachmentBytes) ||
      input.attachmentBytes < 0
    )
      throw new Error("agent_queue_resource_limit");
    const bytes =
      textBytes + input.attachmentBytes + (report ? Buffer.byteLength(JSON.stringify(report)) : 0);
    const weight = 1 + (report ? reportMembers(report).length : 0);
    this.assertNewReportMembers(report);
    this.assertEvidenceCapacity(input.agentId, bytes, weight);
    this.assertReservation(input.agentId, bytes, weight, report ? reportMembers(report).length : 0);
    const receipt: QueuedReceipt = {
      version: 2,
      agentId: input.agentId,
      messageId: input.messageId,
      fingerprint,
      principal,
      boot: input.boot,
      state: "queued",
      admittedAt: now,
      expiresAt: now + MAX_LIFETIME,
      bytes,
      ...(report ? { report } : {}),
      ...(input.collectingUntil ? { collectingUntil: input.collectingUntil } : {}),
    };
    if (report) {
      // Count the actual durable envelope/member/linkage encoding as well as the retained prompt.
      for (let n = 0; n < 3; n++)
        receipt.bytes = textBytes + Buffer.byteLength(JSON.stringify(receipt));
      // Reserve bounded outcome and consumption journal growth at admission,
      // for immediate batches as well as delayed collectors.
      receipt.bytes = Math.max(receipt.bytes, 8192);
      this.assertEvidenceCapacity(input.agentId, receipt.bytes, weight);
      this.assertReservation(input.agentId, receipt.bytes, weight, reportMembers(report).length);
    }
    input.authorize();
    await this.commit(key, receipt, input.authorize);
    this.diskCount += weight;
    // Durability may await; recheck before returning ownership of a UI draft.
    try {
      input.authorize();
    } catch (error) {
      await this.commit(key, { ...receipt, state: "cancelled" });
      throw error;
    }
    this.admissions.set(key, {
      ...input,
      request: structuredClone(input.request),
      principal: structuredClone(input.principal),
    });
    return this.view(receipt);
  }

  receipt(
    agentId: string,
    messageId: string,
    principal: unknown,
    authorize: () => void,
  ): Promise<NativeMessageReceipt> {
    return this.serial(async () => {
      await this.initialize();
      authorize();
      const receipt = this.records.get(digest(["send", agentId, messageId]));
      if (!receipt || receipt.principal !== digest(principal))
        throw new Error("agent_receipt_unavailable");
      await this.expire(this.clock());
      authorize();
      return this.view(this.records.get(digest(["send", agentId, messageId]))!);
    });
  }

  cancel(
    agentId: string,
    messageId: string,
    principal: unknown,
    authorize: () => void,
  ): Promise<NativeMessageReceipt> {
    return this.serial(async () => {
      await this.initialize();
      authorize();
      const key = digest(["send", agentId, messageId]);
      const receipt = this.records.get(key);
      if (!receipt || receipt.principal !== digest(principal))
        throw new Error("agent_receipt_unavailable");
      if (receipt.state === "queued") {
        authorize();
        await this.commit(key, { ...receipt, state: "cancelled" }, authorize);
      }
      authorize();
      return this.view(this.records.get(key)!);
    });
  }

  private async expire(now: number): Promise<void> {
    for (const [key, receipt] of this.records) {
      if (receipt.state === "queued" && receipt.expiresAt <= now)
        await this.commit(key, { ...receipt, state: "cancelled" });
    }
  }

  /** Called by AgentManager's sole foreground fence. Never retries an attempted ticket. */
  async dispatchNext(
    agentId: string,
    ready: () => boolean,
    dispatch: (input: NativeQueuedMessage, finalCheck: () => void) => Promise<string>,
  ): Promise<NativeMessageReceipt | null> {
    const attempt = await this.serial(async () => {
      await this.initialize();
      await this.expire(this.clock());
      if (!ready()) return null;
      const entry = [...this.records].find(
        ([, r]) => r.agentId === agentId && r.state === "queued" && !r.collectingUntil,
      );
      if (!entry || this.active().some((r) => r.agentId === agentId && r.state === "dispatching"))
        return null;
      const [key, receipt] = entry;
      const input = this.admissions.get(key);
      if (!input) {
        await this.commit(key, { ...receipt, state: "cancelled" });
        return { result: this.view(this.records.get(key)!) };
      }
      try {
        input.authorize();
        await input.prepareDispatch?.();
        input.authorize();
        if (!ready()) return null;
        if (input.canDispatch && !input.canDispatch())
          throw new Error("Native queued provider unavailable");
      } catch {
        await this.commit(key, { ...receipt, state: "refused" });
        return { result: this.view(this.records.get(key)!) };
      }
      await this.commit(key, { ...receipt, state: "dispatching" }, input.authorize);
      return { key, receipt, input };
    });
    if (!attempt) return null;
    if ("result" in attempt) return attempt.result ?? null;
    const { key, receipt, input } = attempt;
    const finalCheck = () => {
      if (
        this.unhealthy ||
        this.records.get(key)?.state !== "dispatching" ||
        this.clock() >= receipt.expiresAt
      )
        throw new Error("agent_queue_boundary_changed");
      input.authorize();
      if (input.reportBatch) requireNativeReportBatch(input.reportBatch);
    };
    let state: QueuedReceipt = { ...receipt, state: "uncertain" };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      finalCheck();
      // The native provider seam MUST call finalCheck synchronously immediately before effect.
      const providerTurnId = await Promise.race([
        dispatch(input, finalCheck),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("agent_queue_acceptance_unknown")), 30000);
          timer.unref();
        }),
      ]);
      if (providerTurnId) state = { ...receipt, state: "delivered", providerTurnId };
    } catch (error) {
      if (isNativeQueuedRefusal(error)) state = { ...receipt, state: "refused" };
      // Otherwise an effect may have happened. No automatic replay.
    } finally {
      if (timer) clearTimeout(timer);
    }
    return this.serial(async () => {
      // Consumption may commit while an attempted provider acknowledgement is pending.
      const current = this.records.get(key);
      if (current?.report) state = { ...state, report: current.report };
      await this.commit(key, state);
      return this.view(state);
    });
  }

  /** Report metadata is not delegated/leadership inbox data, nor evidence of human receipt. */
  reportInbox(handle: ReportReader): Promise<unknown> {
    return this.serial(async () => {
      const reader = requireReportReader(handle);
      const scopes = new Set(reader.scopes.map((scope) => digest(scope)));
      await this.initialize(() => {
        requireReportReader(handle);
      });
      requireReportReader(handle);
      await this.expire(this.clock());
      requireReportReader(handle);
      const batches = [...this.records.values()].filter(
        (r) =>
          r.report &&
          r.report.parent.agentId === reader.identity.agentId &&
          r.report.parentEpoch === reader.epoch &&
          r.expiresAt > this.now(),
      );
      const publishedMembers: import("../report-batch.js").ReportMember[] = [];
      const events = batches
        .flatMap((receipt) =>
          receipt
            .report!.members.filter((member) => {
              if (!scopes.has(digest(member.scope))) return false;
              try {
                reader.requireMember(member);
                publishedMembers.push(member);
                return true;
              } catch {
                return false;
              }
            })
            .map((member) =>
              Object.assign(
                {
                  eventId: member.id,
                  kind: member.kind,
                  scope: member.scope,
                  at: member.at,
                  metadataCommitted: true,
                  wakeState:
                    receipt.state === "queued" && receipt.collectingUntil
                      ? "collecting"
                      : receipt.state,
                  providerAccepted: receipt.state === "delivered",
                  consumed: receipt.report!.consumed.includes(member.id),
                },
                member.route ? { routing: "owning-prime-rollup" } : {},
              ),
            ),
        )
        .sort((a, b) => Number(a.consumed) - Number(b.consumed) || a.at - b.at)
        .slice(0, 24);
      const overflow = batches
        .flatMap((receipt) => {
          const grouped = new Map<
            string,
            {
              scope: import("@getpaseo/protocol/native-intercom").NativeReportScope;
              eventIds: string[];
              counts: Partial<Record<import("../report-batch.js").ReportMember["kind"], number>>;
            }
          >();
          for (const member of reportMembers(receipt.report!).slice(
            receipt.report!.members.length,
          )) {
            if (!scopes.has(digest(member.scope)) || receipt.report!.consumed.includes(member.id))
              continue;
            try {
              reader.requireMember(member);
            } catch {
              continue;
            }
            publishedMembers.push(member);
            const key = digest(member.scope);
            const group = grouped.get(key) ?? { scope: member.scope, eventIds: [], counts: {} };
            group.eventIds.push(member.id);
            group.counts[member.kind] = (group.counts[member.kind] ?? 0) + 1;
            grouped.set(key, group);
          }
          return [...grouped.values()].map((group) => ({
            scope: group.scope,
            eventIds: group.eventIds,
            counts: group.counts,
            count: group.eventIds.length,
            metadataCommitted: true,
            wakeState: receipt.collectingUntil ? "collecting" : receipt.state,
            providerAccepted: receipt.state === "delivered",
          }));
        })
        .slice(0, 24);
      requireReportReader(handle);
      return bindReportPublication(
        {
          events,
          overflow,
          overflowCount: overflow.reduce((total, group) => total + group.count, 0),
          metadataCount: events.length + overflow.reduce((total, group) => total + group.count, 0),
          wakePendingCount: batches.filter(
            (r) => (r.state === "queued" && !r.collectingUntil) || r.state === "dispatching",
          ).length,
        },
        () => {
          const current = requireReportReader(handle);
          publishedMembers.forEach((member) => current.requireMember(member));
        },
      );
    });
  }

  consumeReport(
    handle: ReportReader,
    eventId: string,
  ): Promise<{ eventId: string; consumed: true }> {
    return this.serial(async () => {
      const reader = requireReportReader(handle);
      const scopes = new Set(reader.scopes.map((scope) => digest(scope)));
      await this.initialize(() => {
        requireReportReader(handle);
      });
      requireReportReader(handle);
      const entry = [...this.records].find(
        ([, r]) =>
          r.report?.parent.agentId === reader.identity.agentId &&
          r.report.parentEpoch === reader.epoch &&
          r.expiresAt > this.now() &&
          reportMembers(r.report).some(
            (member) => member.id === eventId && scopes.has(digest(member.scope)),
          ),
      );
      if (!entry) throw new Error("Scoped native report unavailable");
      const [key, receipt] = entry;
      const report = receipt.report!;
      const member = reportMembers(report).find((item) => item.id === eventId)!;
      const guard = () => {
        requireReportReader(handle).requireMember(member);
      };
      guard();
      if (!report.consumed.includes(eventId)) {
        await this.commit(
          key,
          { ...receipt, report: { ...report, consumed: [...report.consumed, eventId] } },
          guard,
        );
      }
      guard();
      return bindReportPublication({ eventId, consumed: true as const }, guard);
    });
  }

  send(input: SendMessageInput): Promise<void> {
    // Preserve the existing on-disk identity and shape across daemon upgrades.
    const key = digest(["send", input.agentId, input.messageId]);
    const previous = this.pending.get(key);
    const result = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() =>
      this.sendOnce(key, input),
    );
    this.pending.set(key, result);
    void result
      .finally(() => {
        if (this.pending.get(key) === result) this.pending.delete(key);
      })
      .catch(() => undefined);
    return result;
  }

  private async sendOnce(key: string, input: SendMessageInput): Promise<void> {
    const file = path.join(this.directory, `${key}.json`);
    const fingerprint = digest(input.request);
    const shouldSend = await this.serial(async () => {
      await this.initialize();
      const existing = await readReceipt(file);
      if (existing) {
        if (isQueued(existing) || "recordType" in existing || existing.fingerprint !== fingerprint)
          throw new Error("agent_request_key_conflict");
        if (existing.state === "completed") return false;
        throw new Error("agent_request_outcome_unknown");
      }
      if (this.diskCount >= this.terminalIdLimit) throw new NativeReceiptMaintenanceError();
      await input.prepare?.();
      await writeJsonFileAtomic(file, { fingerprint, agentId: input.agentId, state: "pending" });
      this.diskCount++;
      return true;
    });
    if (!shouldSend) return;
    try {
      await input.send();
    } catch (error) {
      // A refusal that is known to have sent nothing (the target's held queue is full, or a plugin message the busy
      // chat cannot take as a steer) leaves no "pending" receipt:
      // a retry with the same message ID is then tried again, not refused as "outcome unknown". Any other failure
      // keeps its pending receipt, because a send that threw part-way may have been delivered.
      const code = (error as { code?: unknown } | null)?.code;
      if (typeof code === "string" && SENT_NOTHING_CODES.has(code)) {
        await this.serial(async () => {
          await rm(file, { force: true });
          this.diskCount = Math.max(0, this.diskCount - 1);
        });
      }
      throw error;
    }
    await this.serial(() =>
      writeJsonFileAtomic(file, { fingerprint, agentId: input.agentId, state: "completed" }),
    );
  }
}

async function readReceipt(file: string): Promise<z.infer<typeof ReceiptSchema> | null> {
  try {
    const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await fd.stat();
      if (!stat.isFile() || stat.size > 16384) throw new Error("agent_receipt_invalid_file");
      const receipt = ReceiptSchema.parse(JSON.parse(await fd.readFile("utf8")));
      if (isQueued(receipt) && receipt.report) validateReportBatchData(receipt.report);
      return receipt;
    } finally {
      await fd.close();
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function reportDataFor(input: NativeQueuedMessage): ReportBatchData | undefined {
  if (!input.reportBatch) return undefined;
  const data = requireNativeReportBatch(input.reportBatch).data;
  if (data.parent.agentId !== input.agentId || data.parent.boot !== input.boot)
    throw new Error("Native report target identity conflict");
  return data;
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(value, (_key, candidate: unknown) => {
        if (candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)) {
          return Object.fromEntries(
            Object.entries(candidate).sort(([a], [b]) => a.localeCompare(b)),
          );
        }
        return candidate;
      }),
    )
    .digest("hex");
}

function validEvidence(record: NativeEvidenceJournal | NativeEvidenceClaim): boolean {
  const { fingerprint, bytes, ...body } = record;
  return (
    fingerprint === digest(body) &&
    Buffer.byteLength(JSON.stringify(record)) <= bytes &&
    record.entry.expiresAt > record.entry.at &&
    record.entry.expiresAt - record.entry.at <= MAX_LIFETIME
  );
}

function evidenceContext(record: NativeEvidenceJournal | NativeEvidenceClaim) {
  const {
    recordType: _recordType,
    fingerprint: _fingerprint,
    bytes: _bytes,
    entry,
    ...context
  } = record;
  const {
    fact: _fact,
    metadataCommitted: _metadataCommitted,
    ...operation
  } = entry as NativeEvidenceJournal["entry"];
  return { ...context, entry: operation };
}

function validManagedArtifact(record: ManagedArtifactClaim | ManagedArtifactJournal): boolean {
  const { fingerprint, bytes, ...body } = record;
  if (
    fingerprint !== digest(body) ||
    Buffer.byteLength(JSON.stringify(record)) > bytes ||
    record.entry.expiresAt <= record.entry.at ||
    record.entry.expiresAt - record.entry.at > MAX_LIFETIME
  )
    return false;
  if (record.recordType === "native_managed_artifact")
    return (
      record.artifactReference.size === record.artifactReservation.size &&
      record.artifactReference.sha256 === record.artifactReservation.sha256 &&
      record.entry.fact.size === record.artifactReservation.size &&
      record.entry.fact.sha256 === record.artifactReservation.sha256
    );
  return true;
}
