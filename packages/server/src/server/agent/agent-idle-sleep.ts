import type { Logger } from "pino";

export interface IdleSleepDeps {
  logger: Logger;
  /** Minutes an idle session waits before it sleeps. 0 or less turns sleeping off. Read on every arm and fire. */
  minutes: () => number;
  /**
   * Try to put the session to sleep. Resolves "slept", or "busy" when it must stay awake for now
   * (running turn, pending permission, held message, background work, goal). "gone" ends the watch.
   */
  trySleep: (agentId: string, idleMinutes: number) => Promise<"slept" | "busy" | "gone">;
}

/**
 * Idle sleep (FU-362): a session that stays idle for N minutes releases its provider process. The session keeps
 * its record, history, labels and status; the next message starts the process again with the same provider
 * session id. This class only owns the timers. The manager owns what "idle" means.
 */
export class IdleSleep {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly idleSince = new Map<string, number>();
  private disposed = false;

  constructor(private readonly deps: IdleSleepDeps) {}

  /** Call on every state change. Repeated idle states keep the first idle time. */
  observe(agentId: string, idle: boolean): void {
    if (this.disposed) return;
    if (!idle) {
      this.forget(agentId);
      return;
    }
    if (this.timers.has(agentId)) return;
    this.idleSince.set(agentId, Date.now());
    this.arm(agentId);
  }

  forget(agentId: string): void {
    const timer = this.timers.get(agentId);
    if (timer) clearTimeout(timer);
    this.timers.delete(agentId);
    this.idleSince.delete(agentId);
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.idleSince.clear();
  }

  private arm(agentId: string): void {
    const minutes = this.deps.minutes();
    if (!(minutes > 0)) {
      // Off: keep no timer. The next state change checks the setting again.
      this.idleSince.delete(agentId);
      return;
    }
    const timer = setTimeout(() => void this.fire(agentId), minutes * 60_000);
    timer.unref?.();
    this.timers.set(agentId, timer);
  }

  private async fire(agentId: string): Promise<void> {
    this.timers.delete(agentId);
    const since = this.idleSince.get(agentId);
    if (since === undefined || this.disposed) return;
    if (!(this.deps.minutes() > 0)) {
      this.idleSince.delete(agentId);
      return;
    }
    const idleMinutes = Math.round(((Date.now() - since) / 60_000) * 10) / 10;
    let result: "slept" | "busy" | "gone";
    try {
      result = await this.deps.trySleep(agentId, idleMinutes);
    } catch (error) {
      this.deps.logger.warn({ err: error, agentId }, "agent.sleep failed");
      result = "busy";
    }
    // A state change during the await has already called observe(): do not arm twice.
    if (this.disposed || this.timers.has(agentId) || !this.idleSince.has(agentId)) return;
    if (result === "busy") this.arm(agentId);
    else this.idleSince.delete(agentId);
  }
}
