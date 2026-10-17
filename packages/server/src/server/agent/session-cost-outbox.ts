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

/** An acknowledged result remains recoverable even when the billing plugin cannot write. */
export class SessionCostOutbox {
  private state: Record<string, PendingSessionCost> | undefined;
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
  }
  put(value: PendingSessionCost) {
    return this.run(async () => {
      await this.load();
      const key = JSON.stringify([value.agentId, value.turnId]);
      this.state![key] = structuredClone(value);
      await this.save(this.state!);
    });
  }
  pending() {
    return this.run(async () => {
      await this.load();
      await this.save(this.state!);
      return structuredClone(Object.values(this.state!));
    });
  }
  remove(value: PendingSessionCost) {
    return this.run(async () => {
      await this.load();
      const next = { ...this.state };
      delete next[JSON.stringify([value.agentId, value.turnId])];
      await this.save(next);
      this.state = next;
    });
  }
}
