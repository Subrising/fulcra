import { checkReportPublication } from "./report-publication.js";
import { z } from "zod";
import type { JsonValue } from "@getpaseo/protocol/trusted-input";
import type { NativeReportRegistry } from "./report-registry.js";
import type { MessageReceipts } from "./message-receipts/index.js";

const request = z.discriminatedUnion("method", [
  z
    .object({
      method: z.literal("events-inbox"),
      input: z.object({ sessionId: z.string().uuid() }).strict(),
      capability: z.string().regex(/^report1\.[A-Za-z0-9_-]{43}$/),
    })
    .strict(),
  z
    .object({
      method: z.literal("events-ack"),
      input: z
        .object({
          sessionId: z.string().uuid(),
          eventId: z.string().uuid(),
          note: z.string().min(8).max(2000),
        })
        .strict(),
      capability: z.string().regex(/^report1\.[A-Za-z0-9_-]{43}$/),
    })
    .strict(),
]);

/** Native report credential routes ONLY. No management/leadership/controller dispatch fallback. */
export class NativeReportInbox {
  constructor(
    private readonly registry: NativeReportRegistry,
    private readonly receipts: MessageReceipts,
  ) {}
  async request(value: unknown): Promise<JsonValue> {
    const input = request.parse(value);
    const reader = this.registry.authenticateReportReader(input.input.sessionId, input.capability);
    // The ledger owns read/consume guards across every await. Notes are not retained as trusted facts.
    const result =
      input.method === "events-inbox"
        ? await this.receipts.reportInbox(reader)
        : await this.receipts.consumeReport(reader, input.input.eventId);
    checkReportPublication(result);
    return result as JsonValue;
  }
}
