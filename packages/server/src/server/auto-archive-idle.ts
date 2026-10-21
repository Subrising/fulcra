import type { Logger } from "pino";
import { SEAT_LABEL, MAIN_ASSISTANT_ROLE } from "@getpaseo/protocol/agent-labels";

import { isArchiveLead } from "./agent/archive-policy.js";
import type { StoredAgentRecord } from "./agent/agent-storage.js";
import type { LedgerRow } from "./ledger-items.js";
import { parseWorkerResult } from "./ledger-routing/service.js";

// FU-462: idle sessions that nobody needs are archived by the daemon, one at a time.
//
// - A closed session (no live process) that is not a lead, owner or main assistant, has no hold label and no open
//   ledger row, is archived after `autoArchiveClosedAfterHours` of no activity (default 24, 0 turns it off).
// - A worker whose last turn ended with a DONE line, and whose lead received the finish notice, is archived after
//   DONE_IDLE_MS of idle time. New work for the worker (a newer user message or a new notice) resets this.
// Leads, the main assistant, sessions with `fulcra.hold` and sessions named by an open ledger row are never archived.

export const DONE_IDLE_MS = 30 * 60_000;
export const DEFAULT_CLOSED_AFTER_HOURS = 24;
const CHECK_MS = 5 * 60_000;

export type AutoArchiveReason = "closed-idle" | "done-idle";

export interface AutoArchiveCandidate {
  id: string;
  reason: AutoArchiveReason;
}

export interface AutoArchiveInput {
  records: readonly StoredAgentRecord[];
  now: number;
  closedAfterHours: number;
  /** The live lifecycle of a loaded session, or null when no process holds it. */
  lifecycleOf: (id: string) => string | null;
  /** The last assistant text of a loaded session. */
  lastMessageOf: (id: string) => string | null;
  openLedgerText: string;
}

function isProtected(record: StoredAgentRecord, openLedgerText: string): boolean {
  const labels = record.labels ?? {};
  if (record.internal || record.archivedAt) return true;
  if (isArchiveLead(record) || labels[SEAT_LABEL] === MAIN_ASSISTANT_ROLE) return true;
  if (labels["fulcra.role"] === "project-lead" || labels["fulcra.hold"]?.trim()) return true;
  return openLedgerText.includes(record.id) || openLedgerText.includes(record.id.slice(0, 8));
}

function idleSince(record: StoredAgentRecord): number {
  const stamp = Date.parse(record.lastActivityAt ?? record.updatedAt);
  return Number.isFinite(stamp) ? stamp : Number.POSITIVE_INFINITY;
}

/** The sessions that are due, oldest idle first. The caller archives one. */
export function pickAutoArchive(input: AutoArchiveInput): AutoArchiveCandidate[] {
  const due: Array<AutoArchiveCandidate & { since: number }> = [];
  for (const record of input.records) {
    if (isProtected(record, input.openLedgerText)) continue;
    const since = idleSince(record);
    const lifecycle = input.lifecycleOf(record.id);
    const closed = (lifecycle === null || lifecycle === "closed") && record.lastStatus === "closed";
    if (closed) {
      if (input.closedAfterHours > 0 && input.now - since >= input.closedAfterHours * 3_600_000)
        due.push({ id: record.id, reason: "closed-idle", since });
      continue;
    }
    const notice = record.finishNotice;
    if (lifecycle !== "idle" || notice?.status !== "delivered") continue;
    // New work after the finish: a user message newer than the notice means the lead sent more.
    const lastUser = record.lastUserMessageAt ? Date.parse(record.lastUserMessageAt) : 0;
    if (notice.endedAt !== undefined && lastUser > notice.endedAt) continue;
    if (input.now - since < DONE_IDLE_MS) continue;
    if (parseWorkerResult(input.lastMessageOf(record.id))?.state !== "DONE") continue;
    due.push({ id: record.id, reason: "done-idle", since });
  }
  return due.sort((a, b) => a.since - b.since).map(({ id, reason }) => ({ id, reason }));
}

export function openLedgerTextOf(rows: readonly LedgerRow[]): string {
  return rows.map((row) => `${row.owner} ${row.status}`).join("\n");
}

export interface AutoArchiveIdleDeps {
  logger: Logger;
  loadedRecords: () => readonly StoredAgentRecord[];
  lifecycleOf: (id: string) => string | null;
  lastMessageOf: (id: string) => string | null;
  readOpenLedgerRows: () => Promise<LedgerRow[]>;
  closedAfterHours: () => number;
  archive: (id: string) => Promise<unknown>;
  now?: () => number;
}

/** One pass: archives at most one session. Returns the id archived, or null. */
export async function runAutoArchivePass(deps: AutoArchiveIdleDeps): Promise<string | null> {
  const hours = deps.closedAfterHours();
  const records = deps.loadedRecords();
  const [candidate] = pickAutoArchive({
    records,
    now: (deps.now ?? Date.now)(),
    closedAfterHours: hours,
    lifecycleOf: deps.lifecycleOf,
    lastMessageOf: deps.lastMessageOf,
    openLedgerText: openLedgerTextOf(await deps.readOpenLedgerRows()),
  });
  if (!candidate) return null;
  try {
    await deps.archive(candidate.id);
    deps.logger.info(
      { agentId: candidate.id, reason: candidate.reason },
      "Auto-archived an idle session",
    );
    return candidate.id;
  } catch (error) {
    deps.logger.warn(
      { err: error, agentId: candidate.id },
      "Auto-archive of an idle session failed",
    );
    return null;
  }
}

export function startAutoArchiveIdle(deps: AutoArchiveIdleDeps): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void runAutoArchivePass(deps)
      .catch((error) => deps.logger.warn({ err: error }, "Auto-archive pass failed"))
      .finally(() => {
        running = false;
      });
  }, CHECK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
