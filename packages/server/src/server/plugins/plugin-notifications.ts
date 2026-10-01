import { randomUUID } from "node:crypto";
import { readFileSync, renameSync } from "node:fs";
import type pino from "pino";
import { z } from "zod";
import type { PushDeliveryReport, PushPayload } from "../push/index.js";
import { writePrivateFileAtomicSync } from "../private-files.js";

// Plugin notifications (`server.notify`). Every accepted notification joins the host's in-app list;
// only `urgency: "now"` also raises a push to the connected Fulcra apps (CONTRACTS §3.4), title only.
// The host checks the manifest grant; the plugin never supplies it.
//
// One durable state file holds four independent parts:
// - the display list (latest 500), which is what the app shows;
// - the idempotency ledger (`key` → notification), kept for KEY_RETENTION_MS whatever the list holds;
// - each plugin's rate window, so a restart does not reset it;
// - the push outbox, carrying its own payload and retry state.
// A notification is acknowledged only after that state is on disk, and `pushed` becomes true only
// after the push service accepted it. Delivery is at least once, retried with backoff.

export const PLUGIN_NOTIFICATION_TITLE_MAX = 120;
const MAX_DISPLAYED = 500;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT_PER_WINDOW = 10;
// How long a key stays deduplicated. See CONTRACT-CHANGE-J5b-1 (proposed for CONTRACTS §3.4).
export const KEY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 1_800_000, 3_600_000];

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

// An app route ("/inbox/…") or a Fulcra deep link. Never a web URL: a notification must not become
// a way to send someone to an arbitrary site.
const DeepLinkSchema = z
  .string()
  .max(500)
  .refine(
    (value) => (value.startsWith("/") && !value.startsWith("//")) || value.startsWith("fulcra://"),
    "deepLink must be an app route starting with / or a fulcra:// link",
  )
  .refine((value) => !hasControlCharacter(value), "deepLink must be one line");

export const PluginNotifyInputSchema = z
  .object({
    key: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/),
    title: z
      .string()
      .trim()
      .min(1)
      .max(PLUGIN_NOTIFICATION_TITLE_MAX)
      .refine((value) => !hasControlCharacter(value), "title must be one line of text"),
    urgency: z.enum(["now", "today", "fyi"]),
    deepLink: DeepLinkSchema.optional(),
  })
  .strict();

export type PluginNotifyInput = z.infer<typeof PluginNotifyInputSchema>;

const DeliverySchema = z.enum(["not-needed", "pending", "sent", "no-devices", "failed"]);
export type PluginNotificationDelivery = z.infer<typeof DeliverySchema>;

export const PluginNotificationSchema = z
  .object({
    id: z.string().uuid(),
    pluginId: z.string(),
    key: z.string(),
    title: z.string(),
    urgency: z.enum(["now", "today", "fyi"]),
    deepLink: z.string().nullable(),
    createdAt: z.string(),
    // True only once the push service accepted the push.
    pushed: z.boolean(),
    delivery: DeliverySchema,
  })
  .strict();

export type PluginNotification = z.infer<typeof PluginNotificationSchema>;

const OutboxItemSchema = z
  .object({
    pluginId: z.string(),
    title: z.string(),
    deepLink: z.string().nullable(),
    attempts: z.number().int().min(0),
    nextAttemptAt: z.number(),
  })
  .strict();

const StateSchema = z
  .object({
    version: z.literal(1),
    entries: z.array(PluginNotificationSchema),
    keys: z.record(z.string(), z.object({ id: z.string(), at: z.number() }).strict()),
    rate: z.record(z.string(), z.array(z.number())),
    outbox: z.record(z.string(), OutboxItemSchema),
  })
  .strict();

type State = z.infer<typeof StateSchema>;

export interface PluginNotifyResult {
  id: string;
  duplicate: boolean;
}

export class PluginNotifyNotDeclaredError extends Error {
  constructor(pluginId: string) {
    super(`Plugin ${pluginId} did not declare requirements.notify in its manifest`);
    this.name = "PluginNotifyNotDeclaredError";
  }
}

export class PluginNotifyRateLimitedError extends Error {
  constructor(pluginId: string) {
    super(
      `Plugin ${pluginId} sent more than ${RATE_LIMIT_PER_WINDOW} notifications in a minute; try again later`,
    );
    this.name = "PluginNotifyRateLimitedError";
  }
}

export class PluginNotifyStorageError extends Error {
  constructor() {
    super("The notification could not be saved on the host; try again");
    this.name = "PluginNotifyStorageError";
  }
}

export interface PluginPushSender {
  // Resolves with the delivery outcome; throws when the push could not be handed over.
  send(payload: PushPayload): Promise<PushDeliveryReport>;
}

export interface PluginNotificationCenterOptions {
  push: PluginPushSender;
  serverId: string;
  logger: pino.Logger;
  filePath?: string;
  now?: () => number;
  // Tests drive delivery with `drain()`; the daemon schedules it.
  autoDrain?: boolean;
  onAdded?: (notification: PluginNotification) => void;
}

function emptyState(): State {
  return { version: 1, entries: [], keys: {}, rate: {}, outbox: {} };
}

function ledgerKey(pluginId: string, key: string): string {
  return `${pluginId}\u0000${key}`;
}

export class PluginNotificationCenter {
  private state: State;
  private readonly now: () => number;
  private draining: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly options: PluginNotificationCenterOptions) {
    this.now = options.now ?? Date.now;
    this.state = this.load();
    // Deliveries interrupted by a restart resume here.
    if (Object.keys(this.state.outbox).length > 0) this.scheduleDrain(0);
  }

  // `declared` is the host's reading of the plugin manifest (`requirements.notify === true`).
  async notify(input: {
    pluginId: string;
    declared: boolean;
    request: unknown;
  }): Promise<PluginNotifyResult> {
    if (!input.declared) throw new PluginNotifyNotDeclaredError(input.pluginId);
    const request = PluginNotifyInputSchema.parse(input.request);
    const now = this.now();
    const next = this.pruned(now);
    const existing = next.keys[ledgerKey(input.pluginId, request.key)];
    if (existing) {
      // A repeat of an event whose push finally failed gets another delivery attempt.
      const entry = next.entries.find((candidate) => candidate.id === existing.id);
      if (entry?.delivery === "failed") {
        entry.delivery = "pending";
        next.outbox[entry.id] = {
          pluginId: entry.pluginId,
          title: entry.title,
          deepLink: entry.deepLink,
          attempts: 0,
          nextAttemptAt: now,
        };
        this.commit(next);
        this.scheduleDrain(0);
      }
      return { id: existing.id, duplicate: true };
    }
    const recent = (next.rate[input.pluginId] ?? []).filter((at) => now - at < RATE_WINDOW_MS);
    if (recent.length >= RATE_LIMIT_PER_WINDOW) {
      throw new PluginNotifyRateLimitedError(input.pluginId);
    }
    next.rate[input.pluginId] = [...recent, now];

    const push = request.urgency === "now";
    const notification: PluginNotification = {
      id: randomUUID(),
      pluginId: input.pluginId,
      key: request.key,
      title: request.title,
      urgency: request.urgency,
      deepLink: request.deepLink ?? null,
      createdAt: new Date(now).toISOString(),
      pushed: false,
      delivery: push ? "pending" : "not-needed",
    };
    next.entries.push(notification);
    if (next.entries.length > MAX_DISPLAYED) {
      next.entries.splice(0, next.entries.length - MAX_DISPLAYED);
    }
    next.keys[ledgerKey(input.pluginId, request.key)] = { id: notification.id, at: now };
    if (push) {
      next.outbox[notification.id] = {
        pluginId: notification.pluginId,
        title: notification.title,
        deepLink: notification.deepLink,
        attempts: 0,
        nextAttemptAt: now,
      };
    }
    this.commit(next);
    this.options.onAdded?.(notification);
    if (push) this.scheduleDrain(0);
    return { id: notification.id, duplicate: false };
  }

  // Newest first.
  list(limit = 100): PluginNotification[] {
    return this.state.entries.slice(-Math.max(1, Math.min(limit, MAX_DISPLAYED))).toReversed();
  }

  // Attempts every due push once. Safe to call at any time; concurrent calls share one pass.
  drain(): Promise<void> {
    if (!this.draining) {
      this.draining = this.drainOnce().finally(() => {
        this.draining = null;
        this.scheduleNext();
      });
    }
    return this.draining;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async drainOnce(): Promise<void> {
    const due = Object.entries(this.state.outbox).filter(
      ([, item]) => item.nextAttemptAt <= this.now(),
    );
    for (const [id, item] of due) {
      let outcome: PluginNotificationDelivery | null = null;
      try {
        const report = await this.options.push.send({
          title: item.title,
          body: "",
          data: {
            serverId: this.options.serverId,
            kind: "plugin-notification",
            pluginId: item.pluginId,
            notificationId: id,
            ...(item.deepLink ? { deepLink: item.deepLink } : {}),
          },
        });
        if (report.devices === 0) outcome = "no-devices";
        else if (report.accepted > 0) outcome = "sent";
      } catch (error) {
        this.options.logger.warn(
          { err: error, pluginId: item.pluginId },
          "Plugin push not delivered; will retry",
        );
      }
      this.recordAttempt(id, outcome);
    }
  }

  private recordAttempt(id: string, outcome: PluginNotificationDelivery | null): void {
    const next = structuredClone(this.state);
    const item = next.outbox[id];
    if (!item) return;
    let delivery = outcome;
    if (!delivery) {
      item.attempts += 1;
      if (item.attempts > RETRY_DELAYS_MS.length) delivery = "failed";
      else item.nextAttemptAt = this.now() + RETRY_DELAYS_MS[item.attempts - 1];
    }
    if (delivery) {
      delete next.outbox[id];
      const entry = next.entries.find((candidate) => candidate.id === id);
      if (entry) {
        entry.delivery = delivery;
        entry.pushed = delivery === "sent";
      }
    }
    try {
      this.commit(next);
    } catch {
      // The outcome stays unrecorded and the push may be sent again: at least once, never lost.
      this.options.logger.warn({ notificationId: id }, "Could not save plugin push outcome");
    }
  }

  private scheduleNext(): void {
    const times = Object.values(this.state.outbox).map((item) => item.nextAttemptAt);
    if (times.length > 0) this.scheduleDrain(Math.max(0, Math.min(...times) - this.now()));
  }

  private scheduleDrain(delayMs: number): void {
    if (this.options.autoDrain === false || this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, delayMs);
    this.timer.unref?.();
  }

  // A working copy with expired ledger keys and stale rate windows dropped.
  private pruned(now: number): State {
    const next = structuredClone(this.state);
    for (const [key, value] of Object.entries(next.keys)) {
      if (now - value.at >= KEY_RETENTION_MS) delete next.keys[key];
    }
    for (const [pluginId, times] of Object.entries(next.rate)) {
      const recent = times.filter((at) => now - at < RATE_WINDOW_MS);
      if (recent.length > 0) next.rate[pluginId] = recent;
      else delete next.rate[pluginId];
    }
    return next;
  }

  // Writes first; the in-memory state changes only once the file holds it.
  private commit(next: State): void {
    if (this.options.filePath) {
      try {
        writePrivateFileAtomicSync(this.options.filePath, `${JSON.stringify(next)}\n`);
      } catch (error) {
        this.options.logger.warn({ err: error }, "Failed to save plugin notifications");
        throw new PluginNotifyStorageError();
      }
    }
    this.state = next;
  }

  private load(): State {
    const filePath = this.options.filePath;
    if (!filePath) return emptyState();
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf8");
    } catch (error) {
      // Missing is normal. Any other read failure must not stop the daemon: start empty, and every
      // notify fails with a storage error until the file can be written.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.options.logger.warn({ err: error }, "Plugin notification state could not be read");
      }
      return emptyState();
    }
    try {
      return StateSchema.parse(JSON.parse(raw));
    } catch (error) {
      // A damaged file must not stop the daemon. It is kept aside for inspection, not overwritten.
      const aside = `${filePath}.unreadable-${this.now()}`;
      renameSync(filePath, aside);
      this.options.logger.warn({ err: error, aside }, "Plugin notification state was unreadable");
      return emptyState();
    }
  }
}
