import { HeldQueueFullError, MAX_HELD_PER_TARGET } from "../held-sends.js";
import { SessionCostSchema, type SessionCost } from "@getpaseo/protocol/recorded-usage";
import { sessionCost, SessionCostRecordsSchema } from "./session-cost.js";
import { stripInternalPaseoMcpServer } from "./runtime-mcp-config.js";
import { promises as fs, readFileSync, type Dirent } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type { Logger } from "pino";

import { writeJsonFileAtomic, writeJsonFileDurable, writeJsonQueueFile } from "../atomic-file.js";
import { AgentFeatureSchema, AgentStatusSchema } from "../messages.js";
import { toStoredAgentRecord } from "./agent-projections.js";
import type { ManagedAgent } from "./agent-manager.js";
import type { AgentSessionConfig } from "./agent-sdk-types.js";
import { AgentOwnerSchema, daemonExecutionKey, type DaemonAgentOwner } from "./agent-owner.js";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";

/** Saved parent labels remain authoritative. Plain reporting lines support CLI-created children. */
export function finishNoticeParentId(
  labels: Record<string, string> | null | undefined,
): string | null {
  const parent = getParentAgentIdFromLabels(labels);
  if (parent) return parent;
  const line = labels?.["fulcra.parent-session"] || labels?.["fulcra.reports-to"];
  const parsed = z.string().uuid().safeParse(line);
  return parsed.success ? parsed.data : null;
}

const FinishNoticeSchema = z
  .object({
    parentId: z.string().uuid(),
    owner: z.enum(["native", "report-up"]),
    status: z.enum(["armed", "pending", "sending", "unknown", "delivered", "cancelled"]),
    retryAfterRefusal: z.boolean().optional(),
    deliveredBy: z.enum(["native", "report-up"]).optional(),
    messageId: z.string().min(1),
    turnId: z.string().min(1).optional(),
    reason: z.enum(["finished", "errored", "closed", "stopped"]).optional(),
    endedAt: z.number().int().nonnegative().optional(),
    sessionCost: SessionCostSchema.optional(),
  })
  .strict();
export type FinishNotice = z.infer<typeof FinishNoticeSchema>;

const SERIALIZABLE_CONFIG_SCHEMA = z
  .object({
    modeId: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    thinkingOptionId: z.string().nullable().optional(),
    featureValues: z.record(z.string(), z.unknown()).nullable().optional(),
    providerOptions: z.record(z.string(), z.unknown()).nullable().optional(),
    toolPolicy: z
      .object({
        preapproved: z.array(
          z.object({ kind: z.literal("mcp"), server: z.string(), tool: z.string() }).strict(),
        ),
      })
      .strict()
      .nullable()
      .optional(),
    systemPrompt: z.string().nullable().optional(),
    mcpServers: z.record(z.string(), z.any()).nullable().optional(),
    launchEnv: z.object({ CLAUDE_CONFIG_DIR: z.string().optional() }).nullable().optional(),
  })
  .nullable()
  .optional();

const PERSISTENCE_HANDLE_SCHEMA = z
  .object({
    provider: z.string(),
    sessionId: z.string(),
    nativeHandle: z.any().optional(),
    metadata: z.record(z.string(), z.any()).optional(),
  })
  .nullable()
  .optional();

// Orca R3a. A turn the daemon was running when it stopped. At boot, a stored `running`/`initializing` record on an
// agent no process has loaded is, by definition, a turn nobody is running any more: it is normalised to `idle` and
// this marker records what happened, so "idle" is not read as "the turn finished". The marker describes only the
// most recent turn: it survives snapshot flushes while `lastUserMessageAt` is unchanged and is dropped by the next
// user message.
export const StoredInterruptedTurnSchema = z.object({
  previousStatus: z.enum(["running", "initializing"]),
  detectedAt: z.string(),
  bootId: z.string().nullable(),
  lastUserMessageAt: z.string().nullable(),
});
export type StoredInterruptedTurn = z.infer<typeof StoredInterruptedTurnSchema>;

export function interruptedRecord(
  record: StoredAgentRecord,
  marker: Pick<StoredInterruptedTurn, "detectedAt" | "bootId">,
): StoredAgentRecord | null {
  if (record.archivedAt || record.internal) return null;
  if (record.lastStatus !== "running" && record.lastStatus !== "initializing") return null;
  // Only the status changes, plus the marker. updatedAt and lastUserMessageAt stay byte-identical: sidebar order
  // depends on updatedAt, and Orca's input fence compares lastUserMessageAt.
  return {
    ...record,
    lastStatus: "idle",
    interruptedTurn: {
      previousStatus: record.lastStatus,
      detectedAt: marker.detectedAt,
      bootId: marker.bootId,
      lastUserMessageAt: record.lastUserMessageAt ?? null,
    },
  };
}

const STORED_AGENT_SCHEMA = z.object({
  costRecords: SessionCostRecordsSchema.optional(),
  id: z.string(),
  provider: z.string(),
  cwd: z.string(),
  workspaceId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastActivityAt: z.string().optional(),
  lastUserMessageAt: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  labels: z.record(z.string(), z.string()).default({}),
  lastStatus: AgentStatusSchema.default("closed"),
  lastModeId: z.string().nullable().optional(),
  config: SERIALIZABLE_CONFIG_SCHEMA,
  runtimeInfo: z
    .object({
      provider: z.string(),
      sessionId: z.string().nullable(),
      model: z.string().nullable().optional(),
      thinkingOptionId: z.string().nullable().optional(),
      modeId: z.string().nullable().optional(),
      extra: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  features: z.array(AgentFeatureSchema).optional(),
  persistence: PERSISTENCE_HANDLE_SCHEMA,
  lastError: z.string().nullable().optional(),
  requiresAttention: z.boolean().optional(),
  attentionReason: z.enum(["finished", "error", "permission"]).nullable().optional(),
  attentionTimestamp: z.string().nullable().optional(),
  internal: z.boolean().optional(),
  archivedAt: z.string().nullable().optional(),
  owner: AgentOwnerSchema.optional(),
  interruptedTurn: StoredInterruptedTurnSchema.nullable().optional(),
  finishNotice: FinishNoticeSchema.optional(),
  previousFinishNotices: z.array(FinishNoticeSchema).max(MAX_HELD_PER_TARGET).optional(),
  finishNoticeResults: z.record(z.string(), z.string().nullable()).optional(),
});

export type SerializableAgentConfig = Pick<
  AgentSessionConfig,
  | "modeId"
  | "model"
  | "thinkingOptionId"
  | "featureValues"
  | "providerOptions"
  | "toolPolicy"
  | "systemPrompt"
  | "mcpServers"
  | "launchEnv"
>;

export type StoredAgentRecord = z.infer<typeof STORED_AGENT_SCHEMA>;
export function storedFinishNotices(record: StoredAgentRecord): FinishNotice[] {
  return [
    ...(record.previousFinishNotices ?? []),
    ...(record.finishNotice ? [record.finishNotice] : []),
  ];
}

function findFinishNotice(
  record: StoredAgentRecord | null | undefined,
  messageId: string,
): FinishNotice | undefined {
  if (!record) return undefined;
  return storedFinishNotices(record).find((notice) => notice.messageId === messageId);
}

function withFinishNotice(record: StoredAgentRecord, notice: FinishNotice): StoredAgentRecord {
  if (record.finishNotice?.messageId === notice.messageId)
    return { ...record, finishNotice: notice };
  return {
    ...record,
    previousFinishNotices: (record.previousFinishNotices ?? []).map((prior) =>
      prior.messageId === notice.messageId ? notice : prior,
    ),
  };
}

export function parseStoredAgentRecord(value: unknown): StoredAgentRecord {
  return stripStoredRuntimeMcp(STORED_AGENT_SCHEMA.parse(value));
}

// Runtime connections carry per-launch credentials. Keep them out of active and archived records.
function stripStoredRuntimeMcp(record: StoredAgentRecord): StoredAgentRecord {
  const config = record.config ? stripInternalPaseoMcpServer(record.config) : record.config;
  const metadata = record.persistence?.metadata;
  const cleanMetadata = metadata ? stripInternalPaseoMcpServer(metadata) : metadata;
  if (config === record.config && cleanMetadata === metadata) return record;
  return {
    ...record,
    config,
    persistence: record.persistence
      ? { ...record.persistence, metadata: cleanMetadata }
      : record.persistence,
  };
}

/**
 * FU-462: the id of an archived record that boot may leave on disk, or null when the record must load now. A record
 * keeps loading when something at boot reads it: a finish notice to reconcile, a daemon owner (looked up by
 * execution), or no workspaceId (the legacy backfill stamps it).
 */
export function deferrableArchivedId(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== "string" || !record.archivedAt) return null;
  const prior = record.previousFinishNotices;
  if (record.finishNotice || (Array.isArray(prior) && prior.length > 0) || record.owner)
    return null;
  if (typeof record.workspaceId !== "string" || !record.workspaceId) return null;
  return record.id;
}

export class AgentStorage {
  private cache: Map<string, StoredAgentRecord> = new Map();
  private pathById: Map<string, string> = new Map();
  private pathsById: Map<string, Set<string>> = new Map();
  private pendingWrites: Map<string, Promise<void>> = new Map();
  private deleting: Set<string> = new Set();
  private daemonAgentIdsByExecution: Map<string, string> = new Map();
  private daemonExecutionKeysByAgentId: Map<string, string> = new Map();
  // FU-462: archived records stay on disk at boot. Their id and file are known here; the record is parsed and cached
  // the first time something asks for it (get, getCached, list, a write). `bootstrapRecordsLoaded` counts the records
  // parsed by the boot scan.
  private archivedOnDisk: Map<string, string> = new Map();
  /** Archived records still on disk, not yet parsed. */
  get archivedOnDiskCount(): number {
    return this.archivedOnDisk.size;
  }
  bootstrapRecordsLoaded = 0;
  bootstrapRecordsSkipped = 0;
  private loaded = false;
  private baseDir: string;
  private loadPromise: Promise<StoredAgentRecord[]> | null = null;
  private logger: Logger;

  constructor(baseDir: string, logger: Logger) {
    this.baseDir = baseDir;
    this.logger = logger.child({ module: "agent", component: "agent-storage" });
  }

  get noticePausePath(): string {
    return path.join(path.dirname(this.baseDir), "pause.json");
  }

  get heldMessagesPath(): string {
    return path.join(path.dirname(this.baseDir), "held-messages.json");
  }

  async initialize(): Promise<void> {
    await this.load();
  }

  /** Every record, archived ones included. Parses the archived records that boot skipped: use it for history. */
  async list(): Promise<StoredAgentRecord[]> {
    await this.load();
    this.materializeAllArchived();
    return Array.from(this.cache.values());
  }

  /** The records already in memory: live ones, plus archived ones that boot had to keep. Parses nothing new. */
  async listLoaded(): Promise<StoredAgentRecord[]> {
    await this.load();
    return Array.from(this.cache.values());
  }

  /** Every stored agent id, archived ones included, without parsing the archived files. */
  async knownIds(): Promise<string[]> {
    await this.load();
    return [...this.cache.keys(), ...this.archivedOnDisk.keys()];
  }

  listLoadedSync(): StoredAgentRecord[] {
    if (!this.loaded) throw new Error("Agent storage is not initialized");
    return Array.from(this.cache.values());
  }

  async get(agentId: string): Promise<StoredAgentRecord | null> {
    await this.load();
    return this.cacheGet(agentId);
  }

  /** The cached record. An archived record that boot skipped is read from disk now, once. */
  private cacheGet(agentId: string): StoredAgentRecord | null {
    const cached = this.cache.get(agentId);
    if (cached) return cached;
    const filePath = this.archivedOnDisk.get(agentId);
    if (!filePath) return null;
    this.archivedOnDisk.delete(agentId);
    const record = this.readRecordFileSync(filePath);
    if (!record) return null;
    this.cache.set(record.id, record);
    this.indexOwner(record);
    return record;
  }

  private materializeAllArchived(): void {
    for (const agentId of Array.from(this.archivedOnDisk.keys())) this.cacheGet(agentId);
  }

  async getFinishNotice(agentId: string, messageId?: string): Promise<FinishNotice | null> {
    await this.load();
    await this.pendingWrites.get(agentId);
    const record = this.cacheGet(agentId) ?? undefined;
    return (messageId ? findFinishNotice(record, messageId) : record?.finishNotice) ?? null;
  }

  async armFinishNotice(
    agent: ManagedAgent,
    parentId: string,
    owner: FinishNotice["owner"],
  ): Promise<FinishNotice> {
    await this.load();
    const notice: FinishNotice = {
      parentId: z.string().uuid().parse(parentId),
      owner,
      status: "armed",
      messageId: `paseo-notify:${randomUUID()}`,
    };
    await this.queueRecordMutation(agent.id, (existing) => {
      const record = existing ?? toStoredAgentRecord(agent);
      if (finishNoticeParentId(record.labels) !== parentId || record.finishNotice)
        throw new Error("Finish notice ownership changed");
      return { ...record, finishNotice: notice };
    });
    return notice;
  }

  async rearmFinishNotice(
    agentId: string,
    parentId: string,
    reuseArmed = false,
  ): Promise<FinishNotice | null> {
    await this.load();
    let next: FinishNotice | null = null;
    await this.queueRecordMutation(agentId, (record) => {
      if (!record) return null;
      if (finishNoticeParentId(record.labels) !== parentId) return null;
      const prior = record.finishNotice;
      if (reuseArmed && prior?.parentId === parentId && prior.status === "armed") {
        next = prior;
        return null;
      }
      if (!prior && !reuseArmed) return null;
      const retainPrior =
        prior?.owner === "report-up" && ["pending", "sending"].includes(prior.status);
      if (
        prior &&
        !retainPrior &&
        !["delivered", "cancelled", "unknown"].includes(prior.status) &&
        !(prior.status === "pending" && prior.retryAfterRefusal)
      )
        throw Object.assign(new Error("Previous finish notice is still active"), {
          code: "FINISH_NOTICE_PENDING",
        });
      const previous = (record.previousFinishNotices ?? []).filter(
        (notice) => notice.status !== "delivered" && notice.status !== "cancelled",
      );
      if (retainPrior) previous.push(prior);
      if (previous.length >= MAX_HELD_PER_TARGET) throw new HeldQueueFullError(agentId);
      next = {
        parentId: z.string().uuid().parse(parentId),
        owner: "report-up",
        status: "armed",
        messageId: `paseo-notify:${randomUUID()}`,
      };
      const retainedIds = new Set(previous.map((notice) => notice.messageId));
      const retainedResults = Object.entries(record.finishNoticeResults ?? {}).filter(([id]) =>
        retainedIds.has(id),
      );
      return {
        ...record,
        finishNotice: next,
        previousFinishNotices: previous,
        finishNoticeResults: Object.fromEntries(retainedResults),
      };
    });
    return next;
  }

  async recordFinishNotice(
    agentId: string,
    turnId: string,
    reason: "finished" | "errored" | "closed" | "stopped" | "cancelled",
    cost?: SessionCost,
    lastMessage?: string | null,
  ): Promise<FinishNotice | null> {
    await this.load();
    let result: FinishNotice | null = null;
    await this.queueRecordMutation(agentId, (record) => {
      const notice = record?.finishNotice;
      if (
        !record ||
        !notice ||
        notice.status === "cancelled" ||
        notice.status === "delivered" ||
        notice.status === "sending" ||
        notice.status === "unknown"
      )
        return null;
      if (reason === "cancelled") {
        if (notice.status !== "armed") return null;
        result = { ...notice, status: "cancelled", turnId, endedAt: Date.now() };
        return { ...record, finishNotice: result };
      }
      if (notice.status === "pending") {
        if (notice.turnId !== turnId) return null;
        result = notice;
        return null;
      }
      result = {
        ...notice,
        status: "pending",
        turnId,
        reason,
        endedAt: Date.now(),
        sessionCost: cost ?? sessionCost(record.costRecords),
      };
      const finishNoticeResults = { ...record.finishNoticeResults };
      if (lastMessage !== undefined) finishNoticeResults[notice.messageId] = lastMessage;
      return { ...record, finishNotice: result, finishNoticeResults };
    });
    return result;
  }

  async settleFinishNotice(
    agentId: string,
    messageId: string,
    status: "delivered" | "cancelled",
    deliveredBy?: "native" | "report-up",
  ) {
    await this.load();
    await this.queueRecordMutation(agentId, (record) => {
      const notice = findFinishNotice(record, messageId);
      if (!record || !notice) throw new Error("Finish notice ownership changed");
      if (notice.status === status) return null;
      if (status === "cancelled" && notice.status === "pending") return null;
      if (
        notice.status !== "armed" &&
        notice.status !== "pending" &&
        !(status === "delivered" && notice.status === "sending")
      )
        throw new Error("Finish notice already settled");
      return withFinishNotice(record, {
        ...notice,
        status,
        ...(status === "delivered" && deliveredBy ? { deliveredBy } : {}),
      });
    });
  }

  async markFinishNoticeSending(agentId: string, messageId: string): Promise<void> {
    await this.load();
    await this.queueRecordMutation(agentId, (record) => {
      const notice = findFinishNotice(record, messageId);
      if (!record || !notice || notice.status !== "pending")
        throw new Error("Finish notice changed before provider call");
      return withFinishNotice(record, { ...notice, status: "sending", retryAfterRefusal: false });
    });
  }

  async markFinishNoticeRefused(agentId: string, messageId: string): Promise<void> {
    await this.load();
    await this.queueRecordMutation(agentId, (record) => {
      const notice = findFinishNotice(record, messageId);
      if (!record || !notice || notice.status !== "sending") return null;
      return withFinishNotice(record, { ...notice, status: "pending", retryAfterRefusal: true });
    });
  }

  async markFinishNoticeUnknown(agentId: string, messageId: string): Promise<void> {
    await this.load();
    await this.queueRecordMutation(agentId, (record) => {
      const notice = findFinishNotice(record, messageId);
      if (!record || !notice || notice.status !== "sending") return null;
      return withFinishNotice(record, { ...notice, status: "unknown" });
    });
  }

  /**
   * FU-424: an unknown notice is resolved from the lead's copy. "delivered" records that the lead has it; "pending"
   * sends it again under the same message id.
   */
  async resolveUnknownFinishNotice(
    agentId: string,
    messageId: string,
    outcome: { status: "delivered"; deliveredBy: "native" | "report-up" } | { status: "pending" },
  ): Promise<FinishNotice | null> {
    await this.load();
    let next: FinishNotice | null = null;
    await this.queueRecordMutation(agentId, (record) => {
      const notice = findFinishNotice(record, messageId);
      if (!record || !notice || notice.status !== "unknown") return null;
      next =
        outcome.status === "delivered"
          ? { ...notice, status: "delivered", deliveredBy: outcome.deliveredBy }
          : { ...notice, status: "pending", retryAfterRefusal: true };
      return withFinishNotice(record, next);
    });
    return next;
  }

  async retargetFinishNotice(
    agentId: string,
    messageId: string,
    parentId: string,
  ): Promise<FinishNotice> {
    await this.load();
    let next: FinishNotice | null = null;
    await this.queueRecordMutation(agentId, (record) => {
      const notice = findFinishNotice(record, messageId);
      if (
        !record ||
        !notice ||
        notice.status !== "pending" ||
        finishNoticeParentId(record.labels) !== parentId
      )
        throw new Error("Finish notice reparent changed");
      next = { ...notice, parentId: z.string().uuid().parse(parentId) };
      return withFinishNotice(record, next);
    });
    return next!;
  }

  async dropFinishNotice(agentId: string, messageId: string): Promise<void> {
    await this.load();
    await this.queueRecordMutation(agentId, (record) => {
      const notice = findFinishNotice(record, messageId);
      if (!record || !notice) throw new Error("Finish notice owner changed");
      if (notice.status !== "pending") return null;
      return withFinishNotice(record, { ...notice, status: "cancelled" });
    });
  }

  /** Synchronous delivery fences use the initialized cache without yielding to a line change. */
  getCached(agentId: string): StoredAgentRecord | null {
    if (!this.loaded) throw new Error("Agent storage is not initialized");
    return this.cacheGet(agentId);
  }

  listCached(): StoredAgentRecord[] {
    if (!this.loaded) throw new Error("Agent storage is not initialized");
    this.materializeAllArchived();
    return Array.from(this.cache.values());
  }

  /** Sidecars survive snapshot replacement and retain the original rollback handle. */
  async writeContextRotation(
    agentId: string,
    rotationId: string,
    receipt: unknown,
    guard: () => void,
  ): Promise<void> {
    z.string().uuid().parse(agentId);
    z.string().uuid().parse(rotationId);
    await writeJsonFileDurable(
      path.join(this.baseDir, "context-rotations", agentId, `${rotationId}.json`),
      receipt,
      guard,
    );
  }

  async listByProviderSession(
    provider: string,
    providerHandleId: string,
  ): Promise<StoredAgentRecord[]> {
    await this.load();
    this.materializeAllArchived();
    return Array.from(this.cache.values()).filter(
      (record) =>
        record.persistence?.provider === provider &&
        (record.persistence.sessionId === providerHandleId ||
          record.persistence.nativeHandle === providerHandleId),
    );
  }

  async listByWorkspace(workspaceId: string): Promise<StoredAgentRecord[]> {
    await this.load();
    this.materializeAllArchived();
    return Array.from(this.cache.values()).filter((record) => record.workspaceId === workspaceId);
  }

  async findByDaemonExecution(owner: DaemonAgentOwner): Promise<StoredAgentRecord | null> {
    await this.load();
    const agentId = this.daemonAgentIdsByExecution.get(daemonExecutionKey(owner));
    return agentId ? (this.cache.get(agentId) ?? null) : null;
  }

  async upsert(record: StoredAgentRecord): Promise<void> {
    await this.load();
    // FU-468: a caller writes a copy it read earlier. A notice changed since then must not be overwritten, so
    // notice fields come only from the storage's own mutation methods.
    await this.queueRecordMutation(record.id, (existing) =>
      existing
        ? {
            ...record,
            finishNotice: existing.finishNotice,
            previousFinishNotices: existing.previousFinishNotices,
            finishNoticeResults: existing.finishNoticeResults,
          }
        : record,
    );
  }

  // A mutation may return null to leave the record exactly as it is (Orca R3: a normalisation that no longer
  // applies writes nothing).
  private queueRecordMutation(
    agentId: string,
    mutate: (existing: StoredAgentRecord | null) => StoredAgentRecord | null,
  ): Promise<void> {
    const prev = this.pendingWrites.get(agentId) ?? Promise.resolve();
    const next = prev.then(async () => {
      if (this.deleting.has(agentId)) {
        return undefined;
      }

      const existing = this.cacheGet(agentId);
      const record = mutate(existing);
      if (record === null) return undefined;
      // FU-428: a finish notice is only replaced or settled, never dropped. Name any write that drops one.
      if (existing?.finishNotice && !record.finishNotice)
        this.logger.info(
          { agentId, messageId: existing.finishNotice.messageId },
          "Finish notice removed by record write",
        );
      await this.writeRecord(record);
      return undefined;
    });

    const tracked = next.finally(() => {
      if (this.pendingWrites.get(agentId) === tracked) {
        this.pendingWrites.delete(agentId);
      }
    });

    this.pendingWrites.set(agentId, tracked);
    return tracked;
  }

  private async writeRecord(record: StoredAgentRecord): Promise<void> {
    record = stripStoredRuntimeMcp(record);
    const agentId = record.id;
    const nextPath = this.buildRecordPath(record);
    const previousPath = this.pathById.get(agentId);

    if (record.finishNotice) await writeJsonQueueFile(nextPath, record);
    else await writeJsonFileAtomic(nextPath, record);
    this.addIndexedPath(agentId, nextPath);

    if (previousPath && previousPath !== nextPath) {
      try {
        await fs.unlink(previousPath);
      } catch {
        // ignore cleanup errors
      }
      this.removeIndexedPath(agentId, previousPath);
    }

    this.cache.set(agentId, record);
    this.indexOwner(record);
    this.pathById.set(agentId, nextPath);
  }

  beginDelete(agentId: string): void {
    this.deleting.add(agentId);
  }

  /** Lifts the fence when a delete is abandoned before the record was removed. */
  cancelDelete(agentId: string): void {
    this.deleting.delete(agentId);
  }

  async remove(agentId: string): Promise<void> {
    await this.load();
    this.beginDelete(agentId);
    await (this.pendingWrites.get(agentId) ?? Promise.resolve());
    const paths = Array.from(this.pathsById.get(agentId) ?? []);
    await Promise.all(
      paths.map(async (filePath) => {
        try {
          await fs.unlink(filePath);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code && code !== "ENOENT") {
            this.logger.warn(
              { err: error, agentId, filePath },
              "Failed to remove agent record file",
            );
          }
        }
      }),
    );

    this.cache.delete(agentId);
    this.archivedOnDisk.delete(agentId);
    this.removeOwnerIndex(agentId);
    this.pathById.delete(agentId);
    this.pathsById.delete(agentId);
  }

  async applySnapshot(
    agent: ManagedAgent,
    options?: { title?: string | null; internal?: boolean },
  ): Promise<void> {
    await this.load();
    const hasTitleOverride =
      options !== undefined && Object.prototype.hasOwnProperty.call(options, "title");
    const hasInternalOverride =
      options !== undefined && Object.prototype.hasOwnProperty.call(options, "internal");
    await this.queueRecordMutation(agent.id, (existing) => {
      const record = toStoredAgentRecord(agent, {
        title: hasTitleOverride ? (options?.title ?? null) : (existing?.title ?? null),
        createdAt: existing?.createdAt,
        internal: hasInternalOverride ? options?.internal : (agent.internal ?? existing?.internal),
      });

      // Preserve soft-delete/archive status across snapshot flushes. The
      // projection runs inside the per-agent write queue so it cannot commit a
      // stale pre-archive record after the archive mutation.
      if (existing && existing.archivedAt !== undefined) {
        record.archivedAt = existing.archivedAt;
      }
      if (existing) {
        record.finishNotice = existing.finishNotice;
        record.previousFinishNotices = existing.previousFinishNotices;
        record.finishNoticeResults = existing.finishNoticeResults;
      }
      // Orca R3a: keep the interruption marker until the agent receives a new user message.
      if (
        existing?.interruptedTurn &&
        existing.interruptedTurn.lastUserMessageAt === (record.lastUserMessageAt ?? null)
      ) {
        record.interruptedTurn = existing.interruptedTurn;
      }
      return record;
    });
  }

  // Orca R3a, called once at daemon boot before any agent is loaded. Rewrites every stored non-archived,
  // non-internal `running`/`initializing` record to `idle` with an interruption marker. It loads, resumes and
  // prompts nothing. Each rewrite runs inside the per-agent write queue against the record current at that moment.
  async normalizeInterruptedTurns(
    marker: Pick<StoredInterruptedTurn, "detectedAt" | "bootId">,
    isLoaded: (agentId: string) => boolean = () => false,
  ): Promise<string[]> {
    await this.load();
    const changed: string[] = [];
    await Promise.all(
      Array.from(this.cache.values())
        .filter((record) => interruptedRecord(record, marker) !== null)
        .map((record) =>
          this.queueRecordMutation(record.id, (existing) => {
            // A live agent owns its own status; only a record no process has loaded is normalised.
            const next =
              existing && !isLoaded(record.id) ? interruptedRecord(existing, marker) : null;
            if (next) changed.push(record.id);
            return next;
          }),
        ),
    );
    return changed.sort();
  }

  // Orca R3b. The same normalisation for ONE agent, for `stop` on an agent no process has loaded. `stillUnloaded`
  // is re-checked inside the write queue, so an agent that was loaded (and may have started a real turn) in the
  // meantime is never touched.
  async normalizeInterruptedTurn(
    agentId: string,
    marker: Pick<StoredInterruptedTurn, "detectedAt" | "bootId">,
    stillUnloaded: () => boolean,
  ): Promise<StoredAgentRecord | null> {
    await this.load();
    let result: StoredAgentRecord | null = null;
    await this.queueRecordMutation(agentId, (existing) => {
      const next = existing && stillUnloaded() ? interruptedRecord(existing, marker) : null;
      result = next;
      return next;
    });
    return result;
  }

  // FULCRA(orchestration): revive on restart. A clean stop saves every open session as `closed`. At the next boot
  // the sessions that were open read `idle` again, still unloaded: clients show them open, and their next prompt or
  // held send loads them. A session loaded in the meantime owns its own status.
  async reopenAfterRestart(
    agentIds: readonly string[],
    isLoaded: (agentId: string) => boolean = () => false,
  ): Promise<string[]> {
    await this.load();
    const changed: string[] = [];
    await Promise.all(
      agentIds.map((agentId) =>
        this.queueRecordMutation(agentId, (existing) => {
          if (!existing || existing.archivedAt || existing.internal) return null;
          if (existing.lastStatus !== "closed" || isLoaded(agentId)) return null;
          changed.push(agentId);
          return { ...existing, lastStatus: "idle" };
        }),
      ),
    );
    return changed.sort();
  }

  // Daemon shutdown closes every agent, and a closed record would read as a finished turn. A turn still running at
  // that moment keeps this marker (applySnapshot preserves it until a new user message), so the next boot sees it.
  async markShutdownInterruption(agentId: string, marker: StoredInterruptedTurn): Promise<void> {
    await this.load();
    await this.queueRecordMutation(agentId, (existing) =>
      existing && !existing.archivedAt && !existing.internal
        ? { ...existing, interruptedTurn: marker }
        : null,
    );
  }

  async setTitle(agentId: string, title: string): Promise<void> {
    await this.load();
    await this.waitForPendingWrite(agentId);
    const record = await this.get(agentId);
    if (!record) {
      throw new Error(`Agent ${agentId} not found`);
    }
    await this.upsert({ ...record, title });
  }

  async flush(): Promise<void> {
    await this.load().catch(() => undefined);
    const writes = Array.from(this.pendingWrites.values());
    await Promise.allSettled(writes);
  }

  private async load(): Promise<StoredAgentRecord[]> {
    if (this.loaded) {
      return Array.from(this.cache.values());
    }

    if (!this.loadPromise) {
      this.loadPromise = this.doLoad();
    }

    return this.loadPromise;
  }

  private async doLoad(): Promise<StoredAgentRecord[]> {
    this.cache.clear();
    this.archivedOnDisk.clear();
    this.bootstrapRecordsLoaded = 0;
    this.bootstrapRecordsSkipped = 0;
    this.pathById.clear();
    this.pathsById.clear();
    this.daemonAgentIdsByExecution.clear();
    this.daemonExecutionKeysByAgentId.clear();

    try {
      const records = await this.scanDisk();
      this.loaded = true;
      return records;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.loaded = true;
        return [];
      }
      this.logger.error({ err: error }, "Failed to load agents");
      this.loaded = true;
      return [];
    }
  }

  private async scanDisk(): Promise<StoredAgentRecord[]> {
    const records: StoredAgentRecord[] = [];
    let entries: Dirent[] = [];
    try {
      entries = await fs.readdir(this.baseDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const rootRecordPaths = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.join(this.baseDir, entry.name));

    const projectDirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(this.baseDir, entry.name));

    const projectFileLists = await Promise.all(
      projectDirs.map(async (projectDir) => {
        try {
          const files = await fs.readdir(projectDir, { withFileTypes: true });
          return files
            .filter((file) => file.isFile() && file.name.endsWith(".json"))
            .map((file) => path.join(projectDir, file.name));
        } catch {
          return [];
        }
      }),
    );

    const allFilePaths = [...rootRecordPaths, ...projectFileLists.flat()];
    const loaded = await Promise.all(
      allFilePaths.map(async (filePath) => {
        const result = await this.readRecordFile(filePath, { deferArchived: true });
        return result ? { result, filePath } : null;
      }),
    );

    for (const item of loaded) {
      if (!item) continue;
      const { result, filePath } = item;
      if ("archivedId" in result) {
        // FU-462: an archived record is not parsed or cached until something asks for it.
        this.archivedOnDisk.set(result.archivedId, filePath);
        this.pathById.set(result.archivedId, filePath);
        this.addIndexedPath(result.archivedId, filePath);
        this.bootstrapRecordsSkipped += 1;
        continue;
      }
      const { record } = result;
      records.push(record);
      this.bootstrapRecordsLoaded += 1;
      this.cache.set(record.id, record);
      this.indexOwner(record);
      this.pathById.set(record.id, filePath);
      this.addIndexedPath(record.id, filePath);
    }

    return records;
  }

  private async readRecordFile(
    filePath: string,
    options: { deferArchived: true },
  ): Promise<{ record: StoredAgentRecord } | { archivedId: string } | null>;
  private async readRecordFile(filePath: string): Promise<StoredAgentRecord | null>;
  private async readRecordFile(
    filePath: string,
    options?: { deferArchived: true },
  ): Promise<StoredAgentRecord | { record: StoredAgentRecord } | { archivedId: string } | null> {
    try {
      const content = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(content);
      if (options?.deferArchived) {
        const archivedId = deferrableArchivedId(parsed);
        if (archivedId) return { archivedId };
      }
      const record = this.finishRead(filePath, parsed);
      return options ? { record: await record } : record;
    } catch (error) {
      this.logger.error({ err: error, filePath }, "Skipping invalid agent record");
      return null;
    }
  }

  private async finishRead(filePath: string, parsed: unknown): Promise<StoredAgentRecord> {
    const original = STORED_AGENT_SCHEMA.parse(parsed);
    const record = stripStoredRuntimeMcp(original);
    // Cleanup must retain durable finish notices and private file permissions.
    if (record !== original) await writeJsonQueueFile(filePath, record);
    return record;
  }

  private readRecordFileSync(filePath: string): StoredAgentRecord | null {
    try {
      const original = STORED_AGENT_SCHEMA.parse(JSON.parse(readFileSync(filePath, "utf8")));
      return stripStoredRuntimeMcp(original);
    } catch (error) {
      this.logger.error({ err: error, filePath }, "Skipping invalid agent record");
      return null;
    }
  }

  private buildRecordPath(record: StoredAgentRecord): string {
    const projectDir = projectDirNameFromCwd(record.cwd);
    return path.join(this.baseDir, projectDir, `${record.id}.json`);
  }

  private addIndexedPath(agentId: string, filePath: string): void {
    const paths = this.pathsById.get(agentId) ?? new Set<string>();
    paths.add(filePath);
    this.pathsById.set(agentId, paths);
  }

  private removeIndexedPath(agentId: string, filePath: string): void {
    const paths = this.pathsById.get(agentId);
    if (!paths) {
      return;
    }
    paths.delete(filePath);
    if (paths.size === 0) {
      this.pathsById.delete(agentId);
    }
  }

  private indexOwner(record: StoredAgentRecord): void {
    this.removeOwnerIndex(record.id);
    if (record.owner?.kind === "daemon") {
      const key = daemonExecutionKey(record.owner);
      const previousAgentId = this.daemonAgentIdsByExecution.get(key);
      if (previousAgentId && previousAgentId !== record.id) {
        this.daemonExecutionKeysByAgentId.delete(previousAgentId);
      }
      this.daemonAgentIdsByExecution.set(key, record.id);
      this.daemonExecutionKeysByAgentId.set(record.id, key);
    }
  }

  private removeOwnerIndex(agentId: string): void {
    const key = this.daemonExecutionKeysByAgentId.get(agentId);
    if (!key) return;
    if (this.daemonAgentIdsByExecution.get(key) === agentId) {
      this.daemonAgentIdsByExecution.delete(key);
    }
    this.daemonExecutionKeysByAgentId.delete(agentId);
  }

  private async waitForPendingWrite(agentId: string): Promise<void> {
    await (this.pendingWrites.get(agentId) ?? Promise.resolve()).catch(() => undefined);
  }
}

function projectDirNameFromCwd(cwd: string): string {
  // path.win32.parse handles drive letters, UNC roots, and Unix roots on all platforms
  const { root } = path.win32.parse(cwd);
  const withoutRoot = cwd.slice(root.length).replace(/[\\/]+$/, "");
  // Sanitize root: strip colons and separators, keep letters (e.g. "C:\" → "C", "\\server\share\" → "server-share")
  const sanitizedRoot = root.replace(/[:\\/]+/g, "-").replace(/^-+|-+$/g, "");
  const prefix = sanitizedRoot ? sanitizedRoot + "-" : "";
  if (!withoutRoot) {
    return sanitizedRoot || "root";
  }
  return prefix + withoutRoot.replace(/[\\/]+/g, "-");
}
