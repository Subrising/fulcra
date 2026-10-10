import type { Logger } from "pino";
import type { AgentManager, AgentManagerEvent } from "./agent/agent-manager.js";

// FULCRA(orchestration): held sends (the owner, 10 Oct: "human messages should steer"). A message from another chat or
// from the daemon never enters or cancels a running turn: it waits in one queue per target, in order, and is
// delivered when the target's turn ends. Each delivery starts a turn, so the next one waits for that turn to end.
// The queue is in memory: a daemon restart drops held messages.

export type HeldDelivery = () => Promise<void>;

const isRequeue = (error: unknown) =>
  (error as { code?: unknown } | null)?.code === "STEER_UNAVAILABLE";

/**
 * A chat's held message: the reporting line is checked again when it is delivered, because the line can change
 * while the message waits. A refusal, or a delivery that fails, tells the sender why; a held message is never
 * dropped without a word.
 */
export function deliveryWithReceipt(input: {
  recheck: () => Promise<string | null>;
  deliver: HeldDelivery;
  tellSender: (reason: string) => void;
}): HeldDelivery {
  return async () => {
    const refusal = await input.recheck();
    if (refusal) {
      input.tellSender(refusal);
      return;
    }
    try {
      await input.deliver();
    } catch (error) {
      if (isRequeue(error)) throw error;
      input.tellSender(error instanceof Error ? error.message : String(error));
    }
  };
}

interface HeldSendsDeps {
  isBusy: (agentId: string) => boolean;
  subscribe: (listener: (event: AgentManagerEvent) => void) => () => void;
  logger: Pick<Logger, "warn" | "info">;
}

export class HeldSends {
  private readonly queues = new Map<string, HeldDelivery[]>();
  private readonly draining = new Set<string>();
  private readonly unsubscribe: () => void;

  constructor(private readonly deps: HeldSendsDeps) {
    this.unsubscribe = deps.subscribe((event) => {
      const agentId = event.type === "agent_state" ? event.agent.id : null;
      const streamId =
        event.type === "agent_stream" &&
        ["turn_completed", "turn_failed", "turn_canceled"].includes(event.event.type)
          ? event.agentId
          : null;
      const id = agentId ?? streamId;
      if (!id || !this.queues.has(id)) return;
      void this.drain(id);
      // The run can leave its in-flight state just after the event; look once more.
      if (streamId) setTimeout(() => void this.drain(streamId), 100).unref?.();
    });
  }

  /** Queues a delivery for the target; it runs now when the target is idle and nothing waits before it. */
  hold(targetId: string, deliver: HeldDelivery): number {
    const queue = this.queues.get(targetId) ?? [];
    queue.push(deliver);
    this.queues.set(targetId, queue);
    const position = queue.length;
    void this.drain(targetId);
    return position;
  }

  pending(targetId: string): number {
    return this.queues.get(targetId)?.length ?? 0;
  }

  close(): void {
    this.unsubscribe();
    this.queues.clear();
  }

  private async drain(targetId: string): Promise<void> {
    if (this.draining.has(targetId)) return;
    this.draining.add(targetId);
    try {
      for (;;) {
        const queue = this.queues.get(targetId);
        if (!queue?.length) {
          this.queues.delete(targetId);
          return;
        }
        if (this.deps.isBusy(targetId)) return;
        const next = queue.shift()!;
        try {
          await next();
        } catch (error) {
          // The target became busy between the check and the send: keep the message first in line.
          if (isRequeue(error)) {
            queue.unshift(next);
            return;
          }
          this.deps.logger.warn({ err: error, agentId: targetId }, "Held send failed");
        }
      }
    } finally {
      this.draining.delete(targetId);
    }
  }
}

const perManager = new WeakMap<AgentManager, HeldSends>();

/** The daemon's one held-send queue set for this agent manager. */
export function heldSendsFor(
  agentManager: AgentManager,
  logger: Pick<Logger, "warn" | "info">,
): HeldSends {
  let held = perManager.get(agentManager);
  if (!held) {
    held = new HeldSends({
      isBusy: (agentId) => agentManager.hasInFlightRun(agentId),
      subscribe: (listener) => agentManager.subscribe(listener, { replayState: false }),
      logger,
    });
    perManager.set(agentManager, held);
  }
  return held;
}
