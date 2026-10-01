import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { z } from "zod";
import { canonicalJson } from "@getpaseo/protocol/trusted-input";
import { writeJsonFileDurable } from "./atomic-file.js";
import {
  IntercomRateSettingsSchema,
  SetIntercomRatesSchema,
} from "@getpaseo/protocol/native-intercom";
export type IntercomRateKind = keyof z.infer<typeof IntercomRateSettingsSchema>;
const defaults = { report: 12, followup: 32, channel: 8, seat: 8 };
const HOUR = 60 * 60 * 1000;
const LIMIT = 10000;
const EntrySchema = z
  .object({
    id: z.string().min(1).max(200),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    kind: z.enum(["report", "followup", "channel", "seat", "settings"]),
    subject: z.string().min(1).max(200),
    at: z.number().int().nonnegative(),
  })
  .strict();
const StateSchema = z
  .object({
    version: z.literal(1),
    watermark: z.number().int().nonnegative(),
    settings: IntercomRateSettingsSchema,
    entries: z.array(EntrySchema).max(LIMIT),
  })
  .strict();
type State = z.infer<typeof StateSchema>;

/** Private finite owner Settings and permanent operation fences. This store never issues authority. */
export class IntercomRates {
  private state: State = { version: 1, watermark: 0, settings: defaults, entries: [] };
  private loaded = false;
  private initialized = false;
  private unhealthy = false;
  private updating = false;
  private observedAt = 0;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly file: string,
    private readonly now = Date.now,
  ) {}

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail
      .catch(() => undefined)
      .then(async () => {
        if (this.unhealthy) throw new Error("Native rate durability unavailable");
        return work();
      });
    this.tail = result;
    return result;
  }

  private clock(): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < Math.max(this.state.watermark, this.observedAt))
      throw new Error("Native rate clock rollback");
    this.observedAt = now;
    return now;
  }

  private async initialize(requireCurrent: () => void): Promise<void> {
    if (this.loaded) return;
    let handle;
    try {
      handle = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
      requireCurrent();
      const stat = await handle.stat();
      requireCurrent();
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024 || stat.mode & 0o077)
        throw new Error("Native rate store invalid");
      const text = await handle.readFile("utf8");
      requireCurrent();
      const state = StateSchema.parse(JSON.parse(text));
      if (new Set(state.entries.map((entry) => entry.id)).size !== state.entries.length)
        throw new Error("Native rate operation journal invalid");
      if (state.entries.some((entry) => entry.at > state.watermark))
        throw new Error("Native rate clock journal invalid");
      this.state = state;
      this.initialized = state.entries.some((entry) => entry.kind === "settings");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        this.unhealthy = true;
        throw error;
      }
    } finally {
      await handle?.close();
    }
    requireCurrent();
    this.loaded = true;
  }

  private async commit(next: State, requireCurrent: () => void): Promise<void> {
    this.updating = true;
    try {
      await writeJsonFileDurable(this.file, next, requireCurrent);
      requireCurrent();
      this.state = next;
      this.initialized = next.entries.some((entry) => entry.kind === "settings");
    } catch (error) {
      this.unhealthy = true;
      throw error;
    } finally {
      this.updating = false;
    }
  }

  set(
    input: unknown,
    requireOwner: () => void,
  ): Promise<{ messageId: string; duplicate: boolean }> {
    const request = SetIntercomRatesSchema.parse(input);
    const fingerprint = hash(request);
    return this.serial(async () => {
      requireOwner();
      await this.initialize(requireOwner);
      requireOwner();
      const old = this.state.entries.find((entry) => entry.id === request.messageId);
      if (old) {
        if (old.kind !== "settings" || old.fingerprint !== fingerprint)
          throw new Error("Native rate settings operation conflict");
        requireOwner();
        return { messageId: request.messageId, duplicate: true };
      }
      if (this.state.entries.length >= LIMIT)
        throw new Error("Native rate owner maintenance required");
      const now = this.clock();
      await this.commit(
        {
          version: 1,
          watermark: now,
          settings: request.settings,
          entries: [
            ...this.state.entries,
            {
              id: request.messageId,
              fingerprint,
              kind: "settings",
              subject: "owner",
              at: now,
            },
          ],
        },
        requireOwner,
      );
      requireOwner();
      return { messageId: request.messageId, duplicate: false };
    });
  }

  /** Protected owner read. Missing stores are not initialized or silently written. */
  snapshot(requireOwner: () => void) {
    return this.serial(async () => {
      requireOwner();
      await this.initialize(requireOwner);
      requireOwner();
      return {
        initialized: this.initialized,
        settings: this.initialized ? structuredClone(this.state.settings) : null,
        windowMs: 3600000 as const,
      };
    });
  }

  isInitialized(): boolean {
    return this.loaded && this.initialized && !this.unhealthy && !this.updating;
  }

  /** Charge once durably before attempting effect; return a host-held fresh synchronous final guard. */
  reserve(
    id: string,
    kind: IntercomRateKind,
    subject: string,
    binding: unknown,
    requireCurrent: () => void,
  ): Promise<() => void> {
    const fingerprint = hash({ id, kind, subject, binding: structuredClone(binding) });
    return this.serial(async () => {
      requireCurrent();
      await this.initialize(requireCurrent);
      requireCurrent();
      if (!this.isInitialized()) throw new Error("Explicit owner Settings initialization required");
      const now = this.clock();
      let entry = this.state.entries.find((candidate) => candidate.id === id);
      if (entry) {
        if (entry.fingerprint !== fingerprint || entry.kind !== kind || entry.subject !== subject)
          throw new Error("Native rate operation conflict");
      } else {
        if (this.state.entries.length >= LIMIT)
          throw new Error("Native rate owner maintenance required");
        const active = this.state.entries.filter(
          (candidate) =>
            candidate.kind === kind && candidate.subject === subject && candidate.at > now - HOUR,
        );
        if (active.length >= this.state.settings[kind])
          throw new Error("Native rolling rate refused");
        entry = EntrySchema.parse({ id, fingerprint, kind, subject, at: now });
        await this.commit(
          {
            ...this.state,
            watermark: now,
            entries: [...this.state.entries, entry],
          },
          requireCurrent,
        );
      }
      const charged = entry;
      const finalCheck = () => {
        requireCurrent();
        if (this.unhealthy || this.updating) throw new Error("Native rate state unavailable");
        const current = this.clock();
        if (charged.at <= current - HOUR) throw new Error("Native rate permit expired");
        const active = this.state.entries.filter(
          (candidate) =>
            candidate.kind === kind &&
            candidate.subject === subject &&
            candidate.at > current - HOUR,
        );
        if (active.length > this.state.settings[kind] || this.state.settings[kind] === 0)
          throw new Error("Native rolling rate lowered");
      };
      finalCheck();
      return finalCheck;
    });
  }
}

function hash(input: unknown): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}
