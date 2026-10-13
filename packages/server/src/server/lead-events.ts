import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { writePrivateFileAtomicSync } from "./private-files.js";

export const LEAD_EVENT_KINDS = [
  "user",
  "worker_report",
  "finished_turn",
  "nudge",
  "permission",
  "limit",
  "failed_delivery",
  "queued_delivery",
  "other",
] as const;
export type LeadEventKind = (typeof LEAD_EVENT_KINDS)[number];
const kindSchema = z.enum(LEAD_EVENT_KINDS);
const idSchema = z.string().min(1).max(200);
const digestSchema = z.object({
  eventId: idSchema,
  sourceId: idSchema,
  kind: z.string().min(1).max(80),
  at: z.number().finite(),
  reason: z.enum(["duplicate", "delivery_receipt", "already_reported", "archive_done"]),
});
const sessionSchema = z.object({
  turns: z.record(kindSchema, z.number().int().nonnegative()),
  digest: z.array(digestSchema),
  seen: z.array(z.string().max(600)).max(128),
  reported: z.record(idSchema, z.number().finite()),
});
const stateSchema = z.object({ v: z.literal(1), sessions: z.record(idSchema, sessionSchema) });
export type LeadEventState = z.infer<typeof stateSchema>;
export interface DispatchEvent {
  eventId: string;
  sourceId: string;
  kind: string;
  /** Only a confirmed successful delivery can satisfy this rule. */
  reportedAt?: number;
  startedAt?: number;
  failed?: boolean;
}

const context = new AsyncLocalStorage<LeadEventKind>();
const dispatchers = new WeakMap<object, LeadEventDispatcher>();
export function withLeadEvent<T>(kind: LeadEventKind, run: () => T): T {
  return context.run(kind, run);
}
export function currentLeadEvent(
  source: string | undefined,
  nativeQueued?: unknown,
): LeadEventKind {
  // Explicit human input always wins, even inside a delayed daemon callback.
  if (source === "human") return "user";
  if (nativeQueued) return "queued_delivery";
  return context.getStore() ?? (source === "agent" ? "worker_report" : "other");
}
export function registerLeadEvents(owner: object, dispatcher: LeadEventDispatcher): () => void {
  dispatchers.set(owner, dispatcher);
  return () => {
    if (dispatchers.get(owner) === dispatcher) dispatchers.delete(owner);
  };
}
export function recordAcceptedLeadTurn(
  owner: object,
  sessionId: string,
  kind: LeadEventKind,
  internal?: boolean,
): void {
  if (!internal) dispatchers.get(owner)?.recordTurn(sessionId, kind);
}
export function noteDeliveredReport(owner: object, leadId: string, sourceId?: string): void {
  if (sourceId) dispatchers.get(owner)?.noteReport(leadId, sourceId);
}
export function leadEventsFor(owner: object): LeadEventDispatcher | undefined {
  return dispatchers.get(owner);
}
export function leadEventsPath(home: string): string {
  return path.join(home, "lead-events.json");
}
export function readLeadEvents(home: string): LeadEventState {
  try {
    return stateSchema.parse(JSON.parse(readFileSync(leadEventsPath(home), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { v: 1, sessions: {} };
    throw error;
  }
}
export function eventDispatcherEnabled(home: string): boolean {
  try {
    const config = z
      .object({
        daemon: z
          .object({ eventDispatcherEnabled: z.boolean().optional() })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .parse(JSON.parse(readFileSync(path.join(home, "config.json"), "utf8")));
    return config.daemon?.eventDispatcherEnabled !== false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    // An unreadable setting cannot authorize suppression.
    return false;
  }
}

/** Count accepted daemon turns, not prompt attempts, steers, or provider API calls. */
export class LeadEventDispatcher {
  private state: LeadEventState;
  constructor(
    private readonly deps: {
      home: string;
      enabled?: () => boolean;
      now?: () => number;
      onError: (error: unknown) => void;
    },
  ) {
    this.state = readLeadEvents(deps.home);
  }
  private session(id: string) {
    idSchema.parse(id);
    if (Object.hasOwn(this.state.sessions, id)) return this.state.sessions[id]!;
    return (this.state.sessions[id] = {
      turns: Object.fromEntries(LEAD_EVENT_KINDS.map((kind) => [kind, 0])) as Record<
        LeadEventKind,
        number
      >,
      digest: [],
      seen: [],
      reported: {},
    });
  }
  private save(): void {
    writePrivateFileAtomicSync(leadEventsPath(this.deps.home), JSON.stringify(this.state), {
      durable: process.platform !== "win32",
    });
  }
  recordTurn(sessionId: string, kind: LeadEventKind): void {
    try {
      this.session(sessionId).turns[kind] += 1;
      this.save();
    } catch (error) {
      this.deps.onError(error);
    }
  }
  noteDelivered(leadId: string, event: DispatchEvent): void {
    try {
      idSchema.parse(event.eventId);
      idSchema.parse(event.sourceId);
      const key = JSON.stringify([event.kind, event.sourceId, event.eventId]);
      const session = this.session(leadId);
      session.seen = [...session.seen.filter((id) => id !== key), key].slice(-128);
      this.save();
    } catch (error) {
      this.deps.onError(error);
    }
  }
  noteReport(leadId: string, sourceId: string): void {
    try {
      idSchema.parse(sourceId);
      this.session(leadId).reported[sourceId] = this.deps.now?.() ?? Date.now();
      this.save();
    } catch (error) {
      this.deps.onError(error);
    }
  }
  reportAt(leadId: string, sourceId: string): number | undefined {
    return Object.hasOwn(this.state.sessions, leadId)
      ? this.state.sessions[leadId]?.reported[sourceId]
      : undefined;
  }
  /** False means keep normal guarded delivery. Unknown and critical events always reach it. */
  suppress(leadId: string, event: DispatchEvent): boolean {
    if (!(this.deps.enabled?.() ?? eventDispatcherEnabled(this.deps.home))) return false;
    if (event.kind === "finished_turn") return false;
    if (event.failed || ["permission", "limit", "failed_delivery"].includes(event.kind))
      return false;
    if (!["delivery_receipt", "archive_done"].includes(event.kind)) return false;
    const previous = structuredClone(this.state);
    try {
      const session = this.session(leadId);
      idSchema.parse(event.eventId);
      idSchema.parse(event.sourceId);
      // Hash-free IDs remain separate from message text and are bound to their source and kind.
      const key = JSON.stringify([event.kind, event.sourceId, event.eventId]);
      let reason: z.infer<typeof digestSchema>["reason"] | undefined;
      if (event.kind === "delivery_receipt") reason = "delivery_receipt";
      else if (event.kind === "archive_done") reason = "archive_done";
      else if (session.seen.includes(key)) reason = "duplicate";
      if (reason)
        session.digest.push(
          digestSchema.parse({
            eventId: event.eventId,
            sourceId: event.sourceId,
            kind: event.kind,
            at: this.deps.now?.() ?? Date.now(),
            reason,
          }),
        );
      if (reason) this.save();
      return reason !== undefined;
    } catch (error) {
      // Failed persistence must never hide the event or poison duplicate detection.
      this.state = previous;
      this.deps.onError(error);
      return false;
    }
  }
}
