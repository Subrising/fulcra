export interface LimitStop {
  provider: "claude" | "codex" | "other";
  kind?: "network";
  /** Epoch ms of the stated reset, or null when the text did not say. */
  resetAt: number | null;
  /** Which limit the text names: "session", "weekly", another word ("Opus"), or "usage" when none is named. */
  limitKind?: string;
}
/** The kind of limit a provider's text names ("hit your session limit", "weekly limit"); null if it names none. */
export declare function parseLimitKind(text: string): string | null;
export declare function isTransientNetworkError(text: string): boolean;
export declare function classifyFailedTurn(text: string, now: number): LimitStop | null;
/** The assistant message that ended a turn, when its whole text is a provider's limit line. */
export declare function classifyEndingAssistantMessage(
  text: string | null | undefined,
  now: number,
): LimitStop | null;
