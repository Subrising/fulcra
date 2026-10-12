import { classifyEndingAssistantMessage, classifyFailedTurn } from "./detect.js";

export class RecipientLimitedError extends Error {
  readonly code = "RECIPIENT_LIMITED";
  constructor(readonly resumeAt: number) {
    super("Automatic input waits until the recipient's usage limit resets.");
    this.name = "RecipientLimitedError";
  }
}

/** A stop holds automatic input. A reset or a newer turn releases it; human input stays separate. */
export class AutomaticInputLimits {
  private readonly stops = new Map<string, { resumeAt: number; account: string | null }>();
  constructor(private readonly now = Date.now) {}

  observe(
    agentId: string,
    input: {
      failed?: string;
      assistant?: string | null;
      stoppedAt?: number;
      account?: string | null;
    },
  ): void {
    if (this.stops.has(agentId)) return;
    const at = input.stoppedAt ?? this.now();
    const stop =
      input.failed !== undefined
        ? classifyFailedTurn(input.failed, at)
        : classifyEndingAssistantMessage(input.assistant, at);
    if (!stop || stop.kind === "network") return;
    this.stops.set(agentId, {
      resumeAt: stop.resetAt ?? at + 15 * 60_000,
      account: input.account ?? null,
    });
  }

  clear(agentId: string): void {
    this.stops.delete(agentId);
  }

  assertAllowed(agentId: string, account: string | null = null): void {
    const stop = this.stops.get(agentId);
    if (!stop) return;
    if (stop.account && account && stop.account !== account) return;
    if (stop.resumeAt > this.now()) throw new RecipientLimitedError(stop.resumeAt);
  }
}
