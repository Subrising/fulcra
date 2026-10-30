import { readFile } from "node:fs/promises";
import { z } from "zod";
import { writeJsonQueueFile } from "../atomic-file.js";

export const PendingSessionCostSchema = z.object({
  agentId: z.string(),
  provider: z.string(),
  accountId: z.string().nullable(),
  turnId: z.string(),
  costUsd: z.number().finite().nonnegative(),
  at: z.string(),
  cursors: z.record(z.string(), z.number().finite().nonnegative()),
  revision: z.number().int().nonnegative(),
});
export type PendingSessionCost = z.infer<typeof PendingSessionCostSchema>;
const StateSchema = z.record(z.string(), PendingSessionCostSchema);

export function pendingCostKey(value: Pick<PendingSessionCost, "agentId" | "turnId">): string {
  return JSON.stringify([value.agentId, value.turnId]);
}

/** An acknowledged result remains recoverable even when the billing plugin cannot write. */
export class SessionCostOutbox {
  private state: Record<string, PendingSessionCost> | undefined;
  /** Memory holds rows the file does not. The next read writes them before it reports. */
  private unsaved = false;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly file?: string) {}
  private async load() {
    if (this.state) return;
    try {
      this.state = this.file
        ? StateSchema.parse(JSON.parse(await readFile(this.file, "utf8")))
        : {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.state = {};
    }
  }
  private run<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.catch(() => undefined).then(action);
    this.tail = result;
    return result;
  }
  private async save(state: Record<string, PendingSessionCost>) {
    if (this.file) await writeJsonQueueFile(this.file, state);
    this.unsaved = false;
  }
  put(value: PendingSessionCost) {
    return this.putMany([value]);
  }
  /** One file write for all rows. */
  putMany(values: readonly PendingSessionCost[]) {
    return this.run(async () => {
      await this.load();
      if (values.length === 0) return;
      for (const value of values) this.state![pendingCostKey(value)] = structuredClone(value);
      this.unsaved = true;
      await this.save(this.state!);
    });
  }
  /** A read writes only to retry an earlier failed write (FU-595). */
  pending() {
    return this.run(async () => {
      await this.load();
      if (this.unsaved) await this.save(this.state!);
      return structuredClone(Object.values(this.state!));
    });
  }
  has(value: Pick<PendingSessionCost, "agentId" | "turnId">) {
    return this.run(async () => {
      await this.load();
      return Object.hasOwn(this.state!, pendingCostKey(value));
    });
  }
  remove(value: PendingSessionCost) {
    return this.removeMany([value]);
  }
  /** One file write for the batch. A failed write keeps every row for the next recovery. */
  removeMany(values: readonly PendingSessionCost[]) {
    return this.run(async () => {
      await this.load();
      const next = { ...this.state };
      for (const value of values) delete next[pendingCostKey(value)];
      if (Object.keys(next).length === Object.keys(this.state!).length && !this.unsaved) return;
      await this.save(next);
      this.state = next;
    });
  }
}
