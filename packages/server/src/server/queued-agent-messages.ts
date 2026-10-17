import { leadEventsFor, withLeadEvent } from "./lead-events.js";
import { randomUUID } from "node:crypto";
import { DIRECT_LINK_LABEL, MAIN_ASSISTANT_ROLE } from "@getpaseo/protocol/agent-labels";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Logger } from "pino";
import { SendAgentMessageRequestSchema } from "@getpaseo/protocol/messages";
import type { AgentManager } from "./agent/agent-manager.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import {
  disarmFinishNotification,
  sendPromptToAgentAndWaitForStart,
  setupFinishNotification,
  SteerUnavailableError,
} from "./agent/agent-prompt.js";
import { buildAgentPrompt } from "./agent/prompt-attachments.js";
import { FINAL_INPUT_CHECK } from "./agent/agent-sdk-types.js";
import { ensureAgentLoaded } from "./agent/agent-loading.js";
import { createFinalInputCheck } from "./agent/final-input-check.js";
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

const RequestSchema = SendAgentMessageRequestSchema.pick({
  text: true,
  images: true,
  attachments: true,
  messageId: true,
  sender: true,
}).extend({
  sender: SendAgentMessageRequestSchema.shape.sender.unwrap(),
  sessionMode: z.string().optional(),
  notifyOnFinish: z.boolean().optional(),
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
});
type Record = z.infer<typeof RecordSchema>;
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
}

function closedReceiverReason(target: { archivedAt?: unknown } | null): string {
  return target?.archivedAt
    ? "The receiver is archived. Restore it first."
    : "The receiver is closed or archived";
}

/** Plain agent input only. Plugin and owner inputs keep their separate admission paths. */
export class QueuedAgentMessages {
  private records: Record[] = [];
  private tail: Promise<unknown> = Promise.resolve();
  private initialized = false;
  private stopped = false;
  private active = false;
  private unhealthy = false;
  private readonly deliveryListeners = new Set<() => void>();
  private readonly draining = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly unsubscribe: () => void;

  constructor(private readonly deps: Deps) {
    this.unsubscribe = deps.agentManager.subscribe(
      (event) => {
        let id: string | null = null;
        if (event.type === "agent_state") id = event.agent.id;
        else if (
          event.type === "agent_stream" &&
          ["turn_completed", "turn_failed", "turn_canceled"].includes(event.event.type)
        )
          id = event.agentId;
        if (id) this.kick(id);
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
      await writeJsonQueueFile(this.deps.agentStorage.heldMessagesPath, this.records);
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
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.unhealthy = true;
        throw error;
      }
    }
    // A provider may have accepted an attempted batch before the daemon stopped. Never replay it.
    const attempted = this.records.filter((record) => record.state === "dispatching");
    for (const record of attempted) {
      record.state = "uncertain";
      record.reason =
        "Delivery is uncertain after a daemon restart. Check the receiver before sending again.";
    }
    if (attempted.length) await this.save();
    this.initialized = true;
    for (const record of attempted) this.tell(record, record.reason!);
  }

  async prepareArchiveObservation(): Promise<void> {
    await this.serial(() => this.load());
  }

  async start(): Promise<void> {
    await this.serial(() => this.load());
    this.active = true;
    for (const record of this.records) if (record.state === "queued") this.kick(record.agentId);
  }

  async enqueue(
    agentId: string,
    request: z.infer<typeof RequestSchema>,
    localServerId?: string,
    resumeAt?: number,
  ): Promise<void> {
    if (!this.active && !this.deps.deferStart) await this.start();
    await this.serial(async () => {
      await this.load();
      if (this.stopped) throw new Error("The message queue is closed");
      const body = RequestSchema.parse(structuredClone(request));
      if (Buffer.byteLength(JSON.stringify(body)) > 256 * 1024)
        throw new Error("Queued message exceeds 256 KiB");
      if (
        this.records.filter(
          (r) => r.agentId === agentId && ["queued", "dispatching"].includes(r.state),
        ).length >= MAX_HELD_PER_TARGET
      )
        throw new HeldQueueFullError(agentId);
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
      if (body.notifyOnFinish)
        disarmFinishNotification(this.deps.agentManager, agentId, body.sender.agentId);
    });
    this.kick(agentId);
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
        if (["refused", "uncertain"].includes(record.state))
          finish(new Error(record.reason ?? `Message delivery ${record.state}`));
      };
      this.deliveryListeners.add(check);
      signal.addEventListener("abort", aborted, { once: true });
      check();
    });
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
    for (const listener of this.deliveryListeners) listener();
    this.unsubscribe();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await this.tail;
  }

  private tell(record: Record, reason: string): void {
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
      if (record.request.notifyOnFinish)
        disarmFinishNotification(agentManager, agentId, record.request.sender.agentId);
      const sender = record.request.sender;
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
    if (!this.active || this.stopped || this.draining.has(agentId)) return;
    this.draining.add(agentId);
    void this.serial(() => this.drain(agentId))
      .catch((error) => {
        this.deps.logger.warn({ err: error, agentId }, "Queued agent delivery failed");
      })
      .finally(() => this.draining.delete(agentId));
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
    const { agentManager, agentStorage } = this.deps;
    const target = agentManager.getAgent(agentId) ?? (await agentStorage.get(agentId));
    const line = await decideSend(
      lineStoreOf(this.deps),
      record.request.sender,
      agentId,
      record.localServerId,
    );
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

  private captureLineCheck(record: Record, agentId: string): () => string | null {
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
      const remote = Boolean(
        record.request.sender.serverId && record.request.sender.serverId !== record.localServerId,
      );
      const senderAgent = remote ? null : (agents.get(record.request.sender.agentId) ?? null);
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
          sender: record.request.sender,
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
      const current = read();
      return (
        current.reason ??
        (current.snapshot !== selected.snapshot
          ? "The reporting line changed before delivery"
          : selected.reason)
      );
    };
  }

  private async drain(agentId: string): Promise<void> {
    await this.load();
    const { agentManager } = this.deps;
    if (this.stopped || (await this.refuseClosedReceiver(agentId))) return;
    if (agentManager.hasInFlightRun(agentId)) return;
    const waiting = this.records.filter((r) => r.agentId === agentId && r.state === "queued");
    if (!waiting.length) return;
    const resumeAt = Math.max(...waiting.map((r) => r.resumeAt ?? 0));
    if (resumeAt > Date.now()) {
      this.schedule(agentId, resumeAt);
      return;
    }
    // A mode change applies to a whole turn. Preserve order across incompatible mode requests.
    const firstDifferentMode = waiting.findIndex(
      (r) => r.request.sessionMode !== waiting[0]!.request.sessionMode,
    );
    const candidates = firstDifferentMode < 0 ? waiting : waiting.slice(0, firstDifferentMode);
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
    }
    await this.save();
    for (const record of candidates)
      if (record.state === "refused") this.tell(record, record.reason!);
    if (!eligible.length) {
      if (this.pending(agentId)) setTimeout(() => this.kick(agentId), 0).unref?.();
      return;
    }
    await this.dispatchBatch(agentId, eligible, batchId, lineChecks);
    await this.save();
  }

  private async dispatchBatch(
    agentId: string,
    eligible: Record[],
    batchId: string,
    lineChecks: Map<Record, () => string | null>,
  ): Promise<void> {
    const { agentManager, logger } = this.deps;
    const prompt = promptForBatch(eligible);
    try {
      await agentManager.trustedPlugins.agentInput(async () => {
        if (this.stopped || agentManager.hasInFlightRun(agentId))
          throw new SteerUnavailableError(agentId);
        await loadQueuedReceiver(this.deps, agentId, eligible[0]!.sessionId);
        const check = queuedReceiverCheck(
          agentManager,
          agentId,
          eligible[0]!.sessionId,
          () => this.stopped,
          () => {
            const refused = eligible.flatMap((record) => {
              const reason = lineChecks.get(record)!();
              return reason ? [{ record, reason }] : [];
            });
            if (refused.length) throw new QueuedLinesChangedError(refused);
          },
        );
        for (const record of eligible) {
          if (record.request.notifyOnFinish)
            setupFinishNotification({
              ...this.deps,
              childAgentId: agentId,
              callerAgentId: record.request.sender.agentId,
              forNextTurn: true,
            });
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
      for (const record of eligible) {
        record.state = "delivered";
        leadEventsFor(agentManager)?.suppress(record.request.sender.agentId, {
          eventId: record.id,
          sourceId: agentId,
          kind: "delivery_receipt",
        });
      }
    } catch (error) {
      if (await this.refuseClosedReceiver(agentId)) return;
      if (error instanceof QueuedLinesChangedError) {
        for (const { record, reason } of error.refused) {
          record.state = "refused";
          record.reason = reason;
          if (record.request.notifyOnFinish)
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
    }
  }

  private batchFailed(agentId: string, eligible: Record[], error: unknown): void {
    const { agentManager } = this.deps;
    const limit = recipientLimit(error);
    for (const record of eligible) {
      if (record.request.notifyOnFinish)
        disarmFinishNotification(agentManager, agentId, record.request.sender.agentId);
      record.state = failureState(error, limit);
      record.reason = error instanceof Error ? error.message : String(error);
      if (limit) record.resumeAt = limit.resumeAt;
    }
    if (limit) this.schedule(agentId, limit.resumeAt);
    else if (!(error instanceof SteerUnavailableError))
      for (const record of eligible) this.tell(record, record.reason!);
  }
}

function failureState(error: unknown, limit: { resumeAt: number } | null): Record["state"] {
  if (error instanceof SteerUnavailableError || limit) return "queued";
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
              `Message ${i + 1} from ${record.request.sender.agentId}${record.request.sender.serverId ? `@${record.request.sender.serverId}` : ""}:\n${record.request.text}`,
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
): object {
  const receiver = agentManager.getAgent(agentId);
  return createFinalInputCheck(
    () => {
      checkLines();
      const current = agentManager.getAgent(agentId);
      if (!current || current.archivedAt)
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
    undefined,
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
