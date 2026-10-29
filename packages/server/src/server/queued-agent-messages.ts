import { hostLinksFor } from "./host-links.js";
import { watch, type FSWatcher } from "node:fs";
import { dirname, basename } from "node:path";
import { noticePaused, noticePauseVersion, NoticePausedError } from "./notice-pause.js";
import { leadEventsFor, withLeadEvent } from "./lead-events.js";
import { createHash, randomUUID } from "node:crypto";
import { DIRECT_LINK_LABEL, MAIN_ASSISTANT_ROLE } from "@getpaseo/protocol/agent-labels";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Logger } from "pino";
import { SendAgentMessageRequestSchema } from "@getpaseo/protocol/messages";
import type { AgentManager, ManagedAgent } from "./agent/agent-manager.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import {
  disarmFinishNotification,
  sendPromptToAgentAndWaitForStart,
  armPromptFinishNotification,
  SteerUnavailableError,
} from "./agent/agent-prompt.js";
import { buildAgentPrompt } from "./agent/prompt-attachments.js";
import { FINAL_INPUT_CHECK } from "./agent/agent-sdk-types.js";
import { agentLoadInProgress, ensureAgentLoaded } from "./agent/agent-loading.js";
import {
  createFinalInputCheck,
  assertFinalInputCheck,
  hasFinalInputHandoff,
  finalInputFailure,
  FinalInputHandoffTimeoutError,
} from "./agent/final-input-check.js";
import { writeJsonQueueFile } from "./atomic-file.js";
import { HeldQueueFullError, MAX_HELD_PER_TARGET } from "./held-sends.js";
import {
  checkReportingLine,
  decideSend,
  findRoleHolder,
  lineStoreOf,
  reportsTo,
  type LineAgent,
} from "./reporting-lines.js";
import { tellSenderUndelivered } from "./undelivered-notice.js";

/** How long a delivered message still counts as the same message when its sender sends it again. */
const IDENTICAL_RESEND_MS = 10 * 60_000;

const RequestSchema = SendAgentMessageRequestSchema.pick({
  text: true,
  images: true,
  attachments: true,
  messageId: true,
  sender: true,
}).extend({
  sender: SendAgentMessageRequestSchema.shape.sender,
  sessionMode: z.string().optional(),
  notifyOnFinish: z.boolean().optional(),
  hostLinkMessageId: z.string().uuid().optional(),
  pauseNotice: z.literal(true).optional(),
});
const RecordSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  sessionId: z.string().nullable(),
  localServerId: z.string().nullable(),
  request: RequestSchema,
  state: z.enum(["queued", "dispatching", "delivered", "refused", "uncertain"]),
  reason: z.string().optional(),
  resumeAt: z.number().finite().positive().optional(),
  batchId: z.string().optional(),
  /** One absent-message retry per provider instance. A repeated failure stays visible. */
  recoveryInstanceId: z.string().optional(),
  nativeReceipt: z.boolean().optional(),
  runtimeInstanceId: z.string().optional(),
  uncertaintyReported: z.boolean().optional(),
  /** When the record reached delivered or refused. Settled records leave the file a day later. */
  settledAt: z.number().finite().positive().optional(),
  /** The payload was dropped after delivery. The IDs stay so a resent message ID is still refused. */
  compact: z.literal(true).optional(),
  /** sha256 of the whole request and of its text, images and attachments, kept when the payload is dropped. */
  requestHash: z.string().optional(),
  contentHash: z.string().optional(),
});
type Record = z.infer<typeof RecordSchema>;
type InputReceipt = "present" | "absent" | "unknown";
const SETTLED_RECORD_MS = 24 * 60 * 60 * 1000;

const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const requestHashOf = (request: z.infer<typeof RequestSchema>) => sha(request);
const contentHashOf = (request: z.infer<typeof RequestSchema>) =>
  sha([request.text, request.images ?? null, request.attachments ?? null]);

/** Drop the payload of a delivered record once the identical-resend window has passed. */
export function compactDelivered(record: Record, now: number): void {
  if (record.state !== "delivered" || record.compact) return;
  if ((record.settledAt ?? now) > now - IDENTICAL_RESEND_MS) return;
  record.requestHash = requestHashOf(record.request);
  record.contentHash = contentHashOf(record.request);
  record.request = {
    text: "",
    ...(record.request.messageId ? { messageId: record.request.messageId } : {}),
    ...(record.request.sender ? { sender: record.request.sender } : {}),
  };
  record.compact = true;
}

function settled(record: Record): boolean {
  return record.state === "delivered" || record.state === "refused";
}
class QueuedLinesChangedError extends Error {
  constructor(readonly refused: Array<{ record: Record; reason: string }>) {
    super("The reporting line changed before delivery");
  }
}

interface Deps {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
  /** Restore queues only after the daemon restores the previously open sessions. */
  deferStart?: boolean;
  writeQueue?: typeof writeJsonQueueFile;
}

function closedReceiverReason(target: { archivedAt?: unknown } | null): string {
  return target?.archivedAt
    ? "The receiver is archived. Restore it first."
    : "session closed: reload it or start a new worker";
}

/** Plain agent input and paused owner notices. Plugin capabilities never enter this queue. */
export class QueuedAgentMessages {
  private records: Record[] = [];
  /** The records as last written. A save with no change skips the fsync. */
  private saved: string | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private initialized = false;
  private stopped = false;
  private active = false;
  private pauseWatcher?: FSWatcher;
  private pauseVersion?: string;
  private unhealthy = false;
  private readonly deliveryListeners = new Set<() => void>();
  private readonly draining = new Set<string>();
  private readonly pendingDrains = new Set<Promise<void>>();
  private readonly rekick = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly attempts = new Map<string, object>();
  private readonly instances = new Map<string, string>();
  private readonly closedInstances = new Set<string>();
  private readonly unsubscribe: () => void;

  constructor(private readonly deps: Deps) {
    for (const agent of deps.agentManager.listAgents())
      if (agent.instanceId) this.instances.set(agent.id, agent.instanceId);
    this.unsubscribe = deps.agentManager.subscribe(
      (event) => {
        let id: string | null = null;
        if (event.type === "agent_state") {
          id = event.agent.id;
          const previous = this.instances.get(id);
          if (previous && previous !== event.agent.instanceId) this.closedInstances.add(previous);
          if (event.agent.instanceId) {
            this.instances.set(id, event.agent.instanceId);
            if (event.agent.lifecycle === "closed")
              this.closedInstances.add(event.agent.instanceId);
          }
        } else if (
          event.type === "agent_stream" &&
          ["turn_completed", "turn_failed", "turn_canceled"].includes(event.event.type)
        )
          id = event.agentId;
        if (id) {
          this.kick(id);
          // A prior result must settle before the next task takes its saved notice slot.
          for (const record of this.records)
            if (record.state === "queued" && record.request.sender?.agentId === id)
              this.kick(record.agentId);
        }
        // The run releases its foreground fence after publishing its terminal event.
        if (id && event.type === "agent_stream") setTimeout(() => this.kick(id), 100).unref?.();
      },
      { replayState: false },
    );
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.tail.then(run);
    this.tail = result.catch(() => undefined);
    return result;
  }

  private async save(): Promise<void> {
    try {
      const now = Date.now();
      for (const record of this.records) {
        if (settled(record)) record.settledAt ??= now;
        compactDelivered(record, now);
      }
      this.records = this.records.filter(
        (record) => !settled(record) || record.settledAt! > now - SETTLED_RECORD_MS,
      );
      const text = JSON.stringify(this.records);
      if (text !== this.saved) {
        await (this.deps.writeQueue ?? writeJsonQueueFile)(
          this.deps.agentStorage.heldMessagesPath,
          this.records,
        );
        this.saved = text;
      }
      for (const listener of this.deliveryListeners) listener();
    } catch (error) {
      this.unhealthy = true;
      for (const listener of this.deliveryListeners) listener();
      throw error;
    }
  }

  private async load(): Promise<void> {
    if (this.unhealthy) throw new Error("The message queue needs host recovery");
    if (this.initialized) return;
    try {
      const text = await readFile(this.deps.agentStorage.heldMessagesPath, "utf8");
      if (Buffer.byteLength(text) > 16 * 1024 * 1024)
        throw new Error("Message queue exceeds its size limit");
      this.records = z.array(RecordSchema).max(2000).parse(JSON.parse(text));
      this.saved = JSON.stringify(this.records);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.unhealthy = true;
        throw error;
      }
      this.saved = JSON.stringify(this.records);
    }
    // A provider may have accepted an attempted batch before the daemon stopped. Reconcile it first.
    const attempted = this.records.filter((record) => record.state === "dispatching");
    for (const record of attempted) {
      record.state = "uncertain";
      record.reason =
        "Delivery is uncertain after a daemon restart. Check the receiver before sending again.";
    }
    // Also drops settled records past their day, and stamps older ones that carry no settle time.
    await this.save();
    this.initialized = true;
  }

  async prepareArchiveObservation(): Promise<void> {
    await this.serial(() => this.load());
  }

  async start(): Promise<void> {
    await this.serial(() => this.load());
    this.active = true;
    this.pauseVersion ??= noticePauseVersion(this.deps.agentStorage.noticePausePath);
    this.pauseWatcher ??= watch(dirname(this.deps.agentStorage.noticePausePath), (_event, file) => {
      if (file && file.toString() !== basename(this.deps.agentStorage.noticePausePath)) return;
      const version = noticePauseVersion(this.deps.agentStorage.noticePausePath);
      if (!file && version === this.pauseVersion) return;
      this.pauseVersion = version;
      for (const record of this.records)
        if (["queued", "dispatching"].includes(record.state)) this.kick(record.agentId);
    });
    this.pauseWatcher.unref();
    for (const record of this.records)
      if (["queued", "dispatching", "uncertain"].includes(record.state)) this.kick(record.agentId);
  }

  private async admissionReceiver(agentId: string, expectedSessionId?: string | null) {
    const target =
      this.deps.agentManager.getAgent(agentId) ?? (await this.deps.agentStorage.get(agentId));
    if (
      !target ||
      target.archivedAt ||
      ("lifecycle" in target ? target.lifecycle : target.lastStatus) === "closed"
    )
      throw Object.assign(new Error(closedReceiverReason(target)), {
        code: "QUEUED_RECEIVER_CLOSED",
      });
    if (
      expectedSessionId !== undefined &&
      (target.persistence?.sessionId ?? null) !== expectedSessionId
    )
      throw Object.assign(new Error("The receiver session changed"), {
        code: "QUEUED_RECEIVER_CHANGED",
      });
    return target;
  }

  async enqueue(
    agentId: string,
    request: z.infer<typeof RequestSchema>,
    localServerId?: string,
    resumeAt?: number,
    expectedSessionId?: string | null,
  ): Promise<void> {
    if (!this.active && !this.deps.deferStart) await this.start();
    await this.serial(async () => {
      await this.load();
      if (this.stopped) throw new Error("The message queue is closed");
      const body = RequestSchema.parse(structuredClone(request));
      if (body.messageId) {
        const existing = this.records.find(
          (r) => r.agentId === agentId && r.request.messageId === body.messageId,
        );
        if (existing) {
          // A compact record without hashes (older file) cannot compare, so it accepts the resend.
          const same = existing.compact
            ? !existing.requestHash || existing.requestHash === requestHashOf(body)
            : JSON.stringify(existing.request) === JSON.stringify(body);
          if (!same)
            throw new Error("Message ID content changed");
          return;
        }
      }
      if (this.identicalResend(agentId, body)) {
        this.deps.logger.info(
          { agentId, sender: body.sender?.agentId },
          "Identical resend not queued: the first copy is waiting or was just delivered",
        );
        return;
      }
      if (Buffer.byteLength(JSON.stringify(body)) > 256 * 1024)
        throw new Error("Queued message exceeds 256 KiB");
      if (
        this.records.filter(
          (r) => r.agentId === agentId && ["queued", "dispatching"].includes(r.state),
        ).length >= MAX_HELD_PER_TARGET
      )
        throw new HeldQueueFullError(agentId);
      const target = await this.admissionReceiver(agentId, expectedSessionId);
      this.records = this.records
        .filter((r) => ["queued", "dispatching"].includes(r.state))
        .concat(
          this.records.filter((r) => !["queued", "dispatching"].includes(r.state)).slice(-500),
        );
      if (
        Buffer.byteLength(JSON.stringify(this.records)) + Buffer.byteLength(JSON.stringify(body)) >
        15 * 1024 * 1024
      )
        throw new Error("The message queue is full");
      if (this.records.length >= 2000) throw new Error("The message queue is full");
      this.records.push({
        id: randomUUID(),
        agentId,
        sessionId: target.persistence?.sessionId ?? null,
        localServerId: localServerId ?? null,
        request: body,
        state: "queued",
        ...(resumeAt ? { resumeAt } : {}),
      });
      await this.save();
    });
    this.kick(agentId);
  }

  /**
   * A sender whose send timed out ("Delivery is unknown") often sends the same text again with a new message ID.
   * The first copy is usually already queued, so the receiver got both. The same text from the same chat is one
   * message while the first copy waits, or for IDENTICAL_RESEND_MS after it was delivered.
   */
  private identicalResend(agentId: string, body: z.infer<typeof RequestSchema>): boolean {
    const sender = body.sender?.agentId;
    if (!sender || body.pauseNotice || body.hostLinkMessageId) return false;
    const content = contentHashOf(body);
    const since = Date.now() - IDENTICAL_RESEND_MS;
    return this.records.some(
      (r) =>
        r.agentId === agentId &&
        r.request.sender?.agentId === sender &&
        (["queued", "dispatching"].includes(r.state) ||
          (r.state === "delivered" && (r.settledAt ?? Date.now()) >= since)) &&
        (r.contentHash ?? contentHashOf(r.request)) === content,
    );
  }

  /** A queue receipt identifies the batch that accepted this message, including rebuilt batches. */
  async waitForDelivery(agentId: string, messageId: string, signal: AbortSignal): Promise<string> {
    await this.serial(() => this.load());
    signal.throwIfAborted();
    const record = this.records.find(
      (r) => r.agentId === agentId && r.request.messageId === messageId,
    );
    // Direct and held owner sends receive their identity from the submitted provider prompt instead.
    if (!record) return messageId;
    return new Promise<string>((resolve, reject) => {
      const finish = (error?: Error, batchId?: string) => {
        this.deliveryListeners.delete(check);
        signal.removeEventListener("abort", aborted);
        if (error) reject(error);
        else resolve(batchId!);
      };
      const aborted = () => finish(new DOMException("Message delivery wait aborted", "AbortError"));
      const check = () => {
        if (signal.aborted) return aborted();
        if (this.stopped || this.unhealthy)
          return finish(new Error("The message queue needs host recovery"));
        if (record.state === "delivered") return finish(undefined, record.batchId!);
        // Cold recovery runs outside the shared lock. Its saved state is not the final receipt yet.
        if (record.state === "uncertain" && this.draining.has(agentId)) return;
        if (["refused", "uncertain"].includes(record.state))
          finish(new Error(record.reason ?? `Message delivery ${record.state}`));
      };
      this.deliveryListeners.add(check);
      signal.addEventListener("abort", aborted, { once: true });
      check();
    });
  }

  async messageState(agentId: string, messageId: string): Promise<string | null> {
    try {
      await this.serial(() => this.load());
      return (
        this.records.find(
          (record) => record.agentId === agentId && record.request.messageId === messageId,
        )?.state ?? null
      );
    } catch {
      return "uncertain";
    }
  }

  archivePending(agentId: string): number | null {
    if (!this.initialized || this.unhealthy || this.stopped) return null;
    return this.records.filter(
      (record) =>
        record.agentId === agentId && ["queued", "dispatching", "uncertain"].includes(record.state),
    ).length;
  }

  pending(agentId: string): number {
    return this.records.filter((r) => r.agentId === agentId && r.state === "queued").length;
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.pauseWatcher?.close();
    for (const listener of this.deliveryListeners) listener();
    this.unsubscribe();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await Promise.all(this.pendingDrains);
    await this.tail;
  }

  private tellBatch(records: Record[], reason: string): void {
    const remote = new Map<string, Record[]>();
    for (const record of records) {
      if (!record.request.hostLinkMessageId) {
        this.tell(record, reason);
        continue;
      }
      const key = JSON.stringify([record.agentId, record.request.sender]);
      const group = remote.get(key) ?? [];
      group.push(record);
      remote.set(key, group);
    }
    for (const group of remote.values()) {
      hostLinksFor(this.deps.agentManager)?.failQueuedPrompts(
        group[0]!.agentId,
        group.map((record) => record.request.hostLinkMessageId!),
        reason,
        group.some((record) => record.state === "uncertain"),
      );
    }
  }

  private tell(record: Record, reason: string): void {
    if (record.request.hostLinkMessageId && ["refused", "uncertain"].includes(record.state))
      hostLinksFor(this.deps.agentManager)?.failQueuedPrompts(
        record.agentId,
        [record.request.hostLinkMessageId],
        reason,
        record.state === "uncertain",
      );
    if (!record.request.sender) return;
    tellSenderUndelivered({
      ...this.deps,
      sender: record.request.sender,
      targetId: record.agentId,
      localServerId: record.localServerId,
      reason,
    });
  }

  private async refuseClosedReceiver(
    agentId: string,
    selected: readonly Record[] = [],
  ): Promise<boolean> {
    const { agentManager, agentStorage } = this.deps;
    const target = agentManager.getAgent(agentId) ?? (await agentStorage.get(agentId));
    if (
      target &&
      !target.archivedAt &&
      ("lifecycle" in target ? target.lifecycle : target.lastStatus) !== "closed"
    )
      return false;
    const pending = this.records.filter(
      (record) =>
        record.agentId === agentId &&
        (["queued", "dispatching"].includes(record.state) ||
          (record.state === "refused" && selected.includes(record))),
    );
    if (!pending.length) return true;
    const reason = closedReceiverReason(target);
    const senders = new Map<string, Record[]>();
    for (const record of pending) {
      record.state = "refused";
      record.reason = reason;
      if (record.request.notifyOnFinish && record.request.sender)
        disarmFinishNotification(agentManager, agentId, record.request.sender.agentId);
      const sender = record.request.sender;
      if (!sender) continue;
      const server = sender.serverId || record.localServerId;
      const key = JSON.stringify([server, sender.agentId]);
      const group = senders.get(key) ?? [];
      group.push(record);
      senders.set(key, group);
    }
    // Save the whole refusal before any notice. Retries and restarts must not repeat the notices.
    await this.save();
    const timer = this.timers.get(agentId);
    if (timer) clearTimeout(timer);
    this.timers.delete(agentId);
    for (const group of senders.values()) {
      const record = group[0]!;
      const remoteIds = group.flatMap((item) =>
        item.request.hostLinkMessageId ? [item.request.hostLinkMessageId] : [],
      );
      if (remoteIds.length)
        hostLinksFor(agentManager)?.failQueuedPrompts(agentId, remoteIds, reason);
      if (!record.request.sender) continue;
      tellSenderUndelivered({
        ...this.deps,
        sender: record.request.sender,
        targetId: agentId,
        localServerId: record.localServerId,
        reason,
        count: group.length,
      });
    }
    return true;
  }

  private kick(agentId: string): void {
    if (!this.active || this.stopped) return;
    if (this.draining.has(agentId)) {
      this.rekick.add(agentId);
      return;
    }
    this.draining.add(agentId);
    const { agentManager, agentStorage } = this.deps;
    const waiting = this.records.filter((r) => r.agentId === agentId && r.state === "queued");
    const live = agentManager.getAgent(agentId);
    const recovery = this.records.find(
      (record) =>
        record.agentId === agentId &&
        record.state === "uncertain" &&
        (record.nativeReceipt || live),
    );
    const first = waiting[0] ?? recovery;
    const target = live ?? agentStorage.getCached(agentId);
    // Restore a cold receiver outside the shared queue lock. Admission for other chats must keep working.
    let preparation: Promise<void> | undefined;
    if (
      first &&
      (!live || agentLoadInProgress(agentId)) &&
      (recovery || waiting.every((record) => (record.resumeAt ?? 0) <= Date.now())) &&
      !noticePaused(
        agentStorage.noticePausePath,
        target,
        (id) => agentManager.getAgent(id) ?? agentStorage.getCached(id),
      )
    ) {
      const restore = () => loadQueuedReceiver(this.deps, agentId, first.sessionId);
      preparation = first.request.sender
        ? agentManager.trustedPlugins.agentInput(restore)
        : agentManager.trustedPlugins.rpc(undefined, restore);
    }
    // Warm dispatch keeps its synchronous place in the serial queue.
    const dispatch = preparation
      ? preparation
          .catch(() => undefined)
          .then(() => this.serial(() => this.drain(agentId, preparation)))
      : this.serial(() => this.drain(agentId));
    const work = dispatch
      .catch((error) => {
        this.deps.logger.warn({ err: error, agentId }, "Queued agent delivery failed");
      })
      .finally(() => {
        this.pendingDrains.delete(work);
        this.draining.delete(agentId);
        for (const listener of this.deliveryListeners) listener();
        if (this.rekick.delete(agentId)) this.kick(agentId);
      });
    this.pendingDrains.add(work);
  }

  private schedule(agentId: string, resumeAt: number): void {
    if (this.stopped) return;
    const previous = this.timers.get(agentId);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(
      () => {
        this.timers.delete(agentId);
        this.kick(agentId);
      },
      Math.min(2147483647, Math.max(1, resumeAt - Date.now())),
    );
    timer.unref?.();
    this.timers.set(agentId, timer);
  }

  private async recordRefusal(record: Record, agentId: string): Promise<string | null> {
    if (record.request.hostLinkMessageId) {
      try {
        this.checkRemotePrompt(record);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }
    const { agentManager, agentStorage } = this.deps;
    const target = agentManager.getAgent(agentId) ?? (await agentStorage.get(agentId));
    const line = record.request.sender
      ? await decideSend(
          lineStoreOf(this.deps),
          record.request.sender,
          agentId,
          record.localServerId,
        )
      : null;
    if (
      !target ||
      target.archivedAt ||
      ("lifecycle" in target ? target.lifecycle : target.lastStatus) === "closed"
    )
      return closedReceiverReason(target);
    if ((target.persistence?.sessionId ?? null) !== record.sessionId)
      return "The receiver session changed";
    if (line && !line.allowed) return line.reason;
    return null;
  }

  private async eligibleRecords(candidates: Record[], agentId: string): Promise<Record[]> {
    const eligible: Record[] = [];
    for (const record of candidates) {
      const reason = await this.recordRefusal(record, agentId);
      if (reason) {
        record.state = "refused";
        record.reason = reason;
      } else eligible.push(record);
    }
    return eligible;
  }

  private checkRemotePrompt(record: Record): void {
    if (!record.request.hostLinkMessageId) return;
    if (!record.request.sender) throw new Error("The remote prompt sender is missing.");
    const links = hostLinksFor(this.deps.agentManager);
    if (!links) throw new Error("The remote prompt return route is unavailable.");
    links.checkQueuedPrompt(
      record.agentId,
      record.request.hostLinkMessageId,
      record.request.sender,
    );
  }

  private captureLineCheck(record: Record, agentId: string): () => string | null {
    if (!record.request.sender) return () => null;
    const sender = record.request.sender;
    const { agentManager, agentStorage } = this.deps;
    const read = () => {
      const agents = new Map<string, LineAgent>(
        agentStorage
          .listCached()
          .filter((a) => !a.internal)
          .map((a) => [a.id, a]),
      );
      for (const live of agentManager.listAgents()) agents.set(live.id, live);
      const target = agents.get(agentId) ?? null;
      const remote = Boolean(sender.serverId && sender.serverId !== record.localServerId);
      const senderAgent = remote ? null : (agents.get(sender.agentId) ?? null);
      const holder = findRoleHolder([...agents.values()], MAIN_ASSISTANT_ROLE);
      const mainAssistantId = holder && "id" in holder ? holder.id : null;
      const identity = (agent: LineAgent | null) =>
        agent
          ? [
              agent.id,
              reportsTo(agent),
              agent.labels?.[DIRECT_LINK_LABEL] ?? null,
              agent.archivedAt ?? null,
            ]
          : null;
      const snapshot = JSON.stringify([
        identity(senderAgent),
        identity(target),
        holder,
        identity(mainAssistantId ? (agents.get(mainAssistantId) ?? null) : null),
      ]);
      let reason: string | null = null;
      if (!target || target.archivedAt) reason = closedReceiverReason(target);
      else if (!remote && (!senderAgent || senderAgent.archivedAt))
        reason = "The sending chat is closed or archived";
      else {
        const decision = checkReportingLine({
          sender,
          senderAgent,
          target,
          senderParent: null,
          localServerId: record.localServerId,
          mainAssistantId,
        });
        if (!decision.allowed) reason = decision.reason;
      }
      return { snapshot, reason };
    };
    const selected = read();
    return () => {
      try {
        this.checkRemotePrompt(record);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      const current = read();
      return (
        current.reason ??
        (current.snapshot !== selected.snapshot
          ? "The reporting line changed before delivery"
          : selected.reason)
      );
    };
  }

  private async holdPausedDelivery(agentId: string): Promise<boolean> {
    const target =
      this.deps.agentManager.getAgent(agentId) ?? (await this.deps.agentStorage.get(agentId));
    if (
      noticePaused(
        this.deps.agentStorage.noticePausePath,
        target,
        (id) => this.deps.agentManager.getAgent(id) ?? this.deps.agentStorage.getCached(id),
      )
    ) {
      const held = this.records.filter(
        (record) => record.agentId === agentId && record.state === "queued",
      );
      if (held.some((record) => !record.request.pauseNotice)) {
        for (const record of held) record.request.pauseNotice = true;
        await this.save();
      }
      return true;
    }
    return false;
  }

  private async drain(agentId: string, preparation?: Promise<void>): Promise<void> {
    await this.load();
    const { agentManager } = this.deps;
    await this.reconcileUncertain(agentId, preparation);
    if (this.stopped || (await this.refuseClosedReceiver(agentId))) return;
    if (agentManager.hasInFlightRun(agentId)) return;
    if (await this.holdPausedDelivery(agentId)) return;
    const waiting = this.records.filter((r) => r.agentId === agentId && r.state === "queued");
    if (!waiting.length) return;
    const resumeAt = Math.max(...waiting.map((r) => r.resumeAt ?? 0));
    if (resumeAt > Date.now()) {
      this.schedule(agentId, resumeAt);
      return;
    }
    const candidates = selectQueuedBatch(waiting);
    const eligible = await this.eligibleRecords(candidates, agentId);
    if (await this.refuseClosedReceiver(agentId, candidates)) return;
    if (this.stopped || agentManager.hasInFlightRun(agentId)) {
      await this.save();
      return;
    }
    const batchId =
      eligible.length === 1
        ? (eligible[0]!.request.messageId ?? eligible[0]!.id)
        : `queued-batch:${randomUUID()}`;
    const lineChecks = new Map(
      eligible.map((record) => [record, this.captureLineCheck(record, agentId)]),
    );
    for (const record of eligible) {
      record.state = "dispatching";
      record.batchId = batchId;
      record.nativeReceipt = Boolean(agentManager.getAgent(agentId)?.session?.getInputReceipt);
    }
    await this.save();
    for (const record of candidates)
      if (record.state === "refused") this.tell(record, record.reason!);
    if (!eligible.length) {
      if (this.pending(agentId)) setTimeout(() => this.kick(agentId), 0).unref?.();
      return;
    }
    await this.dispatchBatch(agentId, eligible, batchId, lineChecks, preparation);
    await this.save();
  }

  private async dispatchBatch(
    agentId: string,
    eligible: Record[],
    batchId: string,
    lineChecks: Map<Record, () => string | null>,
    preparation?: Promise<void>,
  ): Promise<void> {
    const { agentManager, logger } = this.deps;
    const attemptId = `${agentId}:${batchId}`;
    this.attempts.delete(attemptId);
    const prompt = promptForBatch(eligible);
    const armed = new Map<string, string | null>();
    const markDelivered = () => {
      for (const record of eligible) {
        record.state = "delivered";
        if (record.request.sender)
          leadEventsFor(agentManager)?.suppress(record.request.sender.agentId, {
            eventId: record.id,
            sourceId: agentId,
            kind: "delivery_receipt",
          });
      }
      this.attempts.delete(attemptId);
    };
    try {
      const asSource = eligible[0]!.request.sender
        ? <T>(run: () => Promise<T>) => agentManager.trustedPlugins.agentInput(run)
        : <T>(run: () => Promise<T>) => agentManager.trustedPlugins.rpc(undefined, run);
      await asSource(async () => {
        if (this.stopped || agentManager.hasInFlightRun(agentId))
          throw new SteerUnavailableError(agentId);
        if (preparation) await preparation;
        else await loadQueuedReceiver(this.deps, agentId, eligible[0]!.sessionId);
        const check = queuedReceiverCheck(
          agentManager,
          agentId,
          eligible[0]!.sessionId,
          () => this.stopped,
          () => {
            if (
              noticePaused(
                this.deps.agentStorage.noticePausePath,
                agentManager.getAgent(agentId),
                (id) => this.deps.agentManager.getAgent(id) ?? this.deps.agentStorage.getCached(id),
              )
            )
              throw new NoticePausedError();
            const refused = eligible.flatMap((record) => {
              const reason = lineChecks.get(record)!();
              return reason ? [{ record, reason }] : [];
            });
            if (refused.length) throw new QueuedLinesChangedError(refused);
          },
          eligible.some((record) => record.request.hostLinkMessageId)
            ? () => {
                for (const record of eligible) {
                  if (record.request.hostLinkMessageId && record.request.sender)
                    hostLinksFor(agentManager)!.armQueuedPrompt(
                      agentId,
                      record.request.hostLinkMessageId,
                      record.request.sender,
                    );
                }
              }
            : undefined,
        );
        const priorNotice = await this.deps.agentStorage.getFinishNotice(agentId);
        const receiver = agentManager.getAgent(agentId)!;
        for (const record of eligible) {
          record.nativeReceipt = Boolean(receiver.session?.getInputReceipt);
          record.runtimeInstanceId = receiver.instanceId ?? undefined;
        }
        await this.save();
        this.attempts.set(attemptId, check);
        for (const record of eligible) {
          if (record.request.notifyOnFinish && record.request.sender) {
            assertFinalInputCheck(check);
            const messageId = await armPromptFinishNotification({
              ...this.deps,
              childAgentId: agentId,
              callerAgentId: record.request.sender.agentId,
              forNextTurn: true,
            });
            if (!(priorNotice?.status === "armed" && priorNotice.messageId === messageId))
              armed.set(record.request.sender.agentId, messageId);
          }
        }
        await withLeadEvent("queued_delivery", () =>
          sendPromptToAgentAndWaitForStart({
            ...this.deps,
            agentId,
            prompt,
            messageId: batchId,
            queuedOnly: true,
            runOptions: { [FINAL_INPUT_CHECK]: check },
            unarchive: false,
            sessionMode: eligible[0]!.request.sessionMode,
            logger,
          }),
        );
      });
      markDelivered();
    } catch (error) {
      if (
        hasFinalInputHandoff(this.attempts.get(attemptId)) ||
        agentManager.hasSubmittedFinishMessageNow(agentId, batchId)
      ) {
        markDelivered();
        return;
      }
      if (error instanceof NoticePausedError)
        for (const [callerId, messageId] of armed) {
          disarmFinishNotification(agentManager, agentId, callerId);
          if (messageId)
            await this.deps.agentStorage.settleFinishNotice(agentId, messageId, "cancelled");
        }
      if (await this.refuseClosedReceiver(agentId)) return;
      if (error instanceof QueuedLinesChangedError) {
        for (const { record, reason } of error.refused) {
          record.state = "refused";
          record.reason = reason;
          if (record.request.notifyOnFinish && record.request.sender)
            disarmFinishNotification(agentManager, agentId, record.request.sender.agentId);
          this.tell(record, reason);
        }
        const remaining = eligible.filter((record) => record.state !== "refused");
        if (remaining.length) {
          await agentManager.waitForFailedRunSettlement(agentId);
          const rebuiltId =
            remaining.length === 1
              ? (remaining[0]!.request.messageId ?? remaining[0]!.id)
              : `queued-batch:${randomUUID()}`;
          for (const record of remaining) record.batchId = rebuiltId;
          await this.save();
          await this.dispatchBatch(agentId, remaining, rebuiltId, lineChecks);
        }
        return;
      }
      this.batchFailed(agentId, eligible, error);
      await this.reconcileUncertain(agentId, preparation);
      const uncertain = eligible.filter((record) => record.state === "uncertain");
      if (!uncertain.length) this.attempts.delete(attemptId);
      await this.tellUncertain(uncertain);
    } finally {
      if (!eligible.some((record) => record.state === "uncertain")) this.attempts.delete(attemptId);
    }
  }

  private async reconcileUncertain(agentId: string, preparation?: Promise<void>): Promise<void> {
    const uncertain = this.records.filter(
      (record) => record.agentId === agentId && record.state === "uncertain",
    );
    if (!uncertain.length) return;
    const manager = this.deps.agentManager;
    const receiver = await this.uncertainReceiver(agentId, uncertain, preparation);
    if (!receiver) return;
    let submitted: Set<string>;
    try {
      submitted = await manager.getSubmittedMessageIds(agentId);
    } catch (error) {
      this.deps.logger.warn({ err: error, agentId }, "Uncertain timeline unavailable");
      await this.tellUncertain(uncertain);
      return;
    }
    if (!this.sameReceiver(receiver)) return;
    const receipts = new Map<string, InputReceipt>();
    for (const record of uncertain) {
      if ((receiver.persistence?.sessionId ?? null) !== record.sessionId) continue;
      const outcome = await this.recoveryReceipt(record, receiver, submitted, receipts);
      if (!this.sameReceiver(receiver)) return;
      if (outcome === "absent" && manager.hasInFlightRun(agentId)) return;
      this.applyRecovery(record, receiver, outcome);
    }
    await this.save();
    await this.tellUncertain(uncertain.filter((record) => record.state === "uncertain"));
  }

  private sameReceiver(receiver: ManagedAgent): boolean {
    const current = this.deps.agentManager.getAgent(receiver.id);
    return current?.instanceId === receiver.instanceId && current?.session === receiver.session;
  }

  private async uncertainReceiver(
    agentId: string,
    uncertain: Record[],
    preparation?: Promise<void>,
  ): Promise<ManagedAgent | null> {
    try {
      if (preparation) await preparation;
      const { agentManager, agentStorage } = this.deps;
      let receiver = agentManager.getAgent(agentId);
      if (!receiver && !uncertain.some((record) => record.nativeReceipt)) {
        await this.tellUncertain(uncertain);
        return null;
      }
      const target = receiver ?? (await agentStorage.get(agentId));
      if (
        noticePaused(
          agentStorage.noticePausePath,
          target,
          (id) => agentManager.getAgent(id) ?? agentStorage.getCached(id),
        )
      )
        return null;
      if (!receiver) {
        await loadQueuedReceiver(this.deps, agentId, uncertain[0]!.sessionId);
        receiver = agentManager.getAgent(agentId);
      }
      if (receiver && !receiver.archivedAt && receiver.lifecycle !== "closed") return receiver;
    } catch (error) {
      this.deps.logger.warn({ err: error, agentId }, "Uncertain receiver unavailable");
    }
    await this.tellUncertain(uncertain);
    return null;
  }

  private async recoveryReceipt(
    record: Record,
    receiver: ManagedAgent,
    submitted: Set<string>,
    receipts: Map<string, InputReceipt>,
  ): Promise<InputReceipt> {
    const messageId = record.batchId ?? record.request.messageId ?? record.id;
    const check = this.attempts.get(`${receiver.id}:${messageId}`);
    const manager = this.deps.agentManager;
    if (
      hasFinalInputHandoff(check) ||
      manager.hasSubmittedFinishMessageNow(receiver.id, messageId) ||
      submitted.has(messageId)
    )
      return "present";
    if (
      !record.nativeReceipt ||
      manager.hasInFlightRun(receiver.id) ||
      receiver.lifecycle !== "idle"
    )
      return "unknown";
    const receipt = await this.readNativeReceipt(receiver, messageId, receipts);
    if (receipt === "absent" && !this.previousWriterStopped(record, receiver, check))
      return "unknown";
    if (receipt !== "unknown") return receipt;
    if (
      ["claude", "codex"].includes(receiver.provider) &&
      finalInputFailure(check) instanceof FinalInputHandoffTimeoutError
    )
      return "absent";
    return "unknown";
  }

  private previousWriterStopped(
    record: Record,
    receiver: ManagedAgent,
    check: object | undefined,
  ): boolean {
    if (!record.runtimeInstanceId) return false;
    if (this.closedInstances.has(record.runtimeInstanceId)) return true;
    // A retained native check proves this daemon still owns the attempt. A crash loses that proof.
    return (
      record.runtimeInstanceId === receiver.instanceId &&
      Boolean(check) &&
      ["claude", "codex"].includes(receiver.provider)
    );
  }

  private async readNativeReceipt(
    receiver: ManagedAgent,
    messageId: string,
    receipts: Map<string, InputReceipt>,
  ): Promise<InputReceipt> {
    const cached = receipts.get(messageId);
    if (cached) return cached;
    let receipt: InputReceipt = "unknown";
    try {
      receipt = (await receiver.session?.getInputReceipt?.(messageId)) ?? "unknown";
    } catch (error) {
      this.deps.logger.warn(
        { err: error, agentId: receiver.id },
        "Native input receipt unavailable",
      );
    }
    receipts.set(messageId, receipt);
    return receipt;
  }

  private applyRecovery(record: Record, receiver: ManagedAgent, outcome: InputReceipt): void {
    if (outcome === "unknown") return;
    if (outcome === "absent" && record.recoveryInstanceId === receiver.instanceId) return;
    record.state = outcome === "present" ? "delivered" : "queued";
    if (outcome === "absent") {
      record.recoveryInstanceId = receiver.instanceId ?? undefined;
      this.rekick.add(receiver.id);
    }
    record.reason = undefined;
    const messageId = record.batchId ?? record.request.messageId ?? record.id;
    this.attempts.delete(`${receiver.id}:${messageId}`);
  }

  private async tellUncertain(records: Record[]): Promise<void> {
    const unreported = records.filter((record) => !record.uncertaintyReported);
    if (!unreported.length) return;
    for (const record of unreported) record.uncertaintyReported = true;
    await this.save();
    if (unreported.length)
      this.tellBatch(
        unreported,
        unreported[0]!.reason ?? "Delivery is uncertain. Check the receiver before sending again.",
      );
  }

  private batchFailed(agentId: string, eligible: Record[], error: unknown): void {
    const { agentManager } = this.deps;
    const limit = recipientLimit(error);
    const state = failureState(error, limit);
    if (error instanceof NoticePausedError) this.rekick.add(agentId);
    for (const record of eligible) {
      if (state !== "uncertain" && record.request.notifyOnFinish && record.request.sender)
        disarmFinishNotification(agentManager, agentId, record.request.sender.agentId);
      record.state = state;
      record.reason = error instanceof Error ? error.message : String(error);
      if (limit) record.resumeAt = limit.resumeAt;
    }
    if (limit) this.schedule(agentId, limit.resumeAt);
  }
}

/** A batch keeps one sender identity and one set of relay restrictions. */
const SENDER_KEYS = [
  "agentId",
  "serverId",
  "inboundOnly",
  "outboundMainOnly",
  "outboundServerOnly",
  "outboundParent",
  "refusal",
] as const;

function selectQueuedBatch(waiting: Record[]): Record[] {
  // A mode change applies to a whole turn. Preserve order across incompatible mode requests.
  const firstDifferentMode = waiting.findIndex(
    (r) =>
      r.request.sessionMode !== waiting[0]!.request.sessionMode ||
      Boolean(r.request.sender) !== Boolean(waiting[0]!.request.sender),
  );
  const sameSender = (record: Record) =>
    SENDER_KEYS.every((key) => record.request.sender?.[key] === waiting[0]!.request.sender?.[key]);
  const ordinary = firstDifferentMode < 0 ? waiting : waiting.slice(0, firstDifferentMode);
  return waiting[0]!.request.pauseNotice
    ? waiting.filter(
        (record) =>
          record.request.pauseNotice &&
          sameSender(record) &&
          record.request.sessionMode === waiting[0]!.request.sessionMode,
      )
    : ordinary;
}

function failureState(error: unknown, limit: { resumeAt: number } | null): Record["state"] {
  if (error instanceof SteerUnavailableError || error instanceof NoticePausedError || limit)
    return "queued";
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "QUEUED_RECEIVER_CLOSED" || code === "QUEUED_RECEIVER_CHANGED") return "refused";
  return "uncertain";
}

function promptForBatch(eligible: Record[]): ReturnType<typeof buildAgentPrompt> {
  const text =
    eligible.length === 1
      ? eligible[0]!.request.text
      : eligible
          .map(
            (record, i) =>
              `Message ${i + 1} from ${record.request.sender?.agentId ?? "owner"}${record.request.sender?.serverId ? `@${record.request.sender.serverId}` : ""}:\n${record.request.text}`,
          )
          .join("\n\n");
  const prompt = buildAgentPrompt(
    text,
    eligible.flatMap((r) => r.request.images ?? []),
    eligible.flatMap((r) => r.request.attachments ?? []),
  );
  return prompt;
}

/** Refusal-only host check. Plain queue delivery cannot steer a newer turn or reopen a closed receiver. */
export async function loadQueuedReceiver(
  deps: Deps,
  agentId: string,
  sessionId: string | null,
): Promise<void> {
  await ensureAgentLoaded(agentId, {
    ...deps,
    requireRecord: (record) => {
      if (!record || record.archivedAt || record.lastStatus === "closed")
        throw Object.assign(new Error(closedReceiverReason(record)), {
          code: "QUEUED_RECEIVER_CLOSED",
        });
      if ((record.persistence?.sessionId ?? null) !== sessionId)
        throw Object.assign(new Error("The receiver session changed"), {
          code: "QUEUED_RECEIVER_CHANGED",
        });
    },
  });
}

export function queuedReceiverCheck(
  agentManager: AgentManager,
  agentId: string,
  sessionId: string | null,
  stopped = () => false,
  checkLines = () => {},
  beforeHandoff?: () => void,
): object {
  const receiver = agentManager.getAgent(agentId);
  return createFinalInputCheck(
    () => {
      checkLines();
      const current = agentManager.getAgent(agentId);
      if (!current || current.archivedAt || current.lifecycle === "closed")
        throw Object.assign(new Error(closedReceiverReason(current)), {
          code: "QUEUED_RECEIVER_CLOSED",
        });
      if (
        current.instanceId !== receiver?.instanceId ||
        current.session !== receiver?.session ||
        (current.persistence?.sessionId ?? null) !== sessionId
      )
        throw Object.assign(new Error("The receiver session changed"), {
          code: "QUEUED_RECEIVER_CHANGED",
        });
      if (stopped() || current.activeForegroundTurnId || current.pendingReplacement)
        throw new SteerUnavailableError(agentId);
    },
    beforeHandoff,
    !["claude", "codex"].includes(receiver?.provider ?? ""),
  );
}

export function recipientLimit(error: unknown): { resumeAt: number } | null {
  if (
    !error ||
    typeof error !== "object" ||
    !("code" in error) ||
    error.code !== "RECIPIENT_LIMITED"
  )
    return null;
  if (
    !("resumeAt" in error) ||
    typeof error.resumeAt !== "number" ||
    !Number.isFinite(error.resumeAt) ||
    error.resumeAt <= 0
  )
    return null;
  return { resumeAt: error.resumeAt };
}

const queues = new WeakMap<AgentManager, QueuedAgentMessages>();
export function queuedAgentMessagesFor(deps: Deps): QueuedAgentMessages {
  let queue = queues.get(deps.agentManager);
  if (!queue) {
    queue = new QueuedAgentMessages(deps);
    queues.set(deps.agentManager, queue);
  }
  return queue;
}
