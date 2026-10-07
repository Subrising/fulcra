export const NOTIFICATION_DIGEST_WINDOW_MS = 30_000;
export const NOTIFICATION_DIGEST_MAX_SESSIONS = 20;

export interface DesktopNotificationPayload {
  title: string;
  body?: string;
  data?: Record<string, unknown>;
}

/** One fixed window, latest completion per session, bounded independently of event volume. */
export class NotificationDigest<T> {
  private readonly pending = new Map<string, { payload: DesktopNotificationPayload; target: T }>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deliver: (payload: DesktopNotificationPayload, target: T) => void) {}

  send(
    payload: DesktopNotificationPayload,
    target: T,
    delivery: "immediate" | "digest",
    windowMs: number = NOTIFICATION_DIGEST_WINDOW_MS,
  ): void {
    const { reason, serverId, agentId } = payload.data ?? {};
    if (
      delivery !== "digest" ||
      reason !== "finished" ||
      typeof serverId !== "string" ||
      typeof agentId !== "string"
    ) {
      // An approval or error supersedes any queued completion for that session.
      if (typeof serverId === "string" && typeof agentId === "string") {
        this.pending.delete(JSON.stringify([serverId, agentId]));
      }
      if (delivery === "immediate") this.flush();
      this.deliver(payload, target);
      return;
    }

    const key = JSON.stringify([serverId, agentId]);
    this.pending.delete(key);
    this.pending.set(key, { payload, target });
    if (this.pending.size > NOTIFICATION_DIGEST_MAX_SESSIONS) {
      const oldest = this.pending.keys().next().value;
      if (oldest !== undefined) this.pending.delete(oldest);
    }
    if (this.timer === null) {
      this.timer = setTimeout(() => this.flush(), windowMs);
      this.timer.unref?.();
    }
  }

  flush(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const entries = [...this.pending.values()];
    this.pending.clear();
    const latest = entries.at(-1);
    if (!latest) return;
    if (entries.length === 1) {
      this.deliver(latest.payload, latest.target);
      return;
    }
    // Previews are excluded: aggregate only the already sanitized session titles.
    const titles = entries.slice(-3).map(({ payload }) => payload.title);
    const body = `${entries.length} recent sessions finished: ${titles.join("; ")}`;
    this.deliver(
      {
        title: "Session digest",
        body: body.length > 220 ? `${body.slice(0, 217).trimEnd()}...` : body,
        // Existing click routing opens the newest completion.
        data: { ...latest.payload.data, digestSessionCount: entries.length },
      },
      latest.target,
    );
  }
}
