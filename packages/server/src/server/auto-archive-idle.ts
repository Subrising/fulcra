import type { Logger } from "pino";
import {
  MAIN_ASSISTANT_ROLE,
  PARENT_AGENT_ID_LABEL,
  REPORTS_TO_LABEL,
  SEAT_LABEL,
} from "@getpaseo/protocol/agent-labels";

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
// Never archived: leads, owners, any session with a seat label, the main assistant, sessions that other sessions
// report to, `fulcra.hold` sessions, sessions named by an open ledger row, workers with a pending host-link notice,
// and closed sessions whose finish notice has not reached the lead.

export const DONE_IDLE_MS = 30 * 60_000;
export const DEFAULT_CLOSED_AFTER_HOURS = 24;
const CHECK_MS = 5 * 60_000;

export type AutoArchiveReason = "closed-idle" | "done-idle";

export interface AutoArchiveCandidate {
  id: string;
  reason: AutoArchiveReason;
  /** What the daemon saw; the archive checks it again inside the lifecycle lane. */
  lastUserMessageAt: string | null;
}

/** The outcome of one archive try: "skipped" means the session was busy and nothing was refused. */
export type AutoArchiveOutcome = "archived" | "skipped";

export interface AutoArchiveInput {
  records: readonly StoredAgentRecord[];
  now: number;
  closedAfterHours: number;
  /** The live lifecycle of a loaded session, or null when no process holds it. */
  lifecycleOf: (id: string) => string | null;
  /** The last assistant text of a loaded session. */
  lastMessageOf: (id: string) => string | null;
  openLedgerText: string;
  /** Ids that must stay although no label says so: workers with a pending host-link notice. */
  protectedIds?: ReadonlySet<string>;
}

/** The ids that other sessions report to (a reports-to or parent label). Stored values may end in `@serverId`. */
function reportTargets(records: readonly StoredAgentRecord[]): Set<string> {
  const targets = new Set<string>();
  for (const record of records) {
    for (const key of [REPORTS_TO_LABEL, PARENT_AGENT_ID_LABEL]) {
      const value = record.labels?.[key];
      if (value) targets.add(value.split("@")[0]!);
    }
  }
  return targets;
}

function isProtected(
  record: StoredAgentRecord,
  input: Pick<AutoArchiveInput, "openLedgerText" | "protectedIds">,
  targets: ReadonlySet<string>,
): boolean {
  const labels = record.labels ?? {};
  if (record.internal || record.archivedAt) return true;
  if (isArchiveLead(record) || labels[SEAT_LABEL] === MAIN_ASSISTANT_ROLE) return true;
  if (labels[SEAT_LABEL] || labels["fulcra.role"] === "project-lead") return true;
  if (labels["fulcra.hold"]?.trim() || targets.has(record.id)) return true;
  if (input.protectedIds?.has(record.id)) return true;
  return (
    input.openLedgerText.includes(record.id) || input.openLedgerText.includes(record.id.slice(0, 8))
  );
}

function idleSince(record: StoredAgentRecord): number {
  const stamp = Date.parse(record.lastActivityAt ?? record.updatedAt);
  return Number.isFinite(stamp) ? stamp : Number.POSITIVE_INFINITY;
}

function closedReason(record: StoredAgentRecord, input: AutoArchiveInput): boolean {
  // A finish notice that is still on its way to the lead is work in progress.
  const status = record.finishNotice?.status;
  if (status && status !== "delivered" && status !== "cancelled") return false;
  return (
    input.closedAfterHours > 0 &&
    input.now - idleSince(record) >= input.closedAfterHours * 3_600_000
  );
}

function doneReason(record: StoredAgentRecord, input: AutoArchiveInput): boolean {
  const notice = record.finishNotice;
  if (notice?.status !== "delivered") return false;
  // New work after the finish: a user message newer than the notice means the lead sent more.
  const lastUser = record.lastUserMessageAt ? Date.parse(record.lastUserMessageAt) : 0;
  if (notice.endedAt !== undefined && lastUser > notice.endedAt) return false;
  if (input.now - idleSince(record) < DONE_IDLE_MS) return false;
  return parseWorkerResult(input.lastMessageOf(record.id))?.state === "DONE";
}

/** The sessions that are due, oldest idle first. The caller archives one. */
export function pickAutoArchive(input: AutoArchiveInput): AutoArchiveCandidate[] {
  const due: Array<AutoArchiveCandidate & { since: number }> = [];
  const targets = reportTargets(input.records);
  for (const record of input.records) {
    if (isProtected(record, input, targets)) continue;
    const lifecycle = input.lifecycleOf(record.id);
    const closed = (lifecycle === null || lifecycle === "closed") && record.lastStatus === "closed";
    let reason: AutoArchiveReason | null = null;
    if (closed) reason = closedReason(record, input) ? "closed-idle" : null;
    else if (lifecycle === "idle") reason = doneReason(record, input) ? "done-idle" : null;
    if (!reason) continue;
    const lastUserMessageAt = record.lastUserMessageAt ?? null;
    due.push({ id: record.id, reason, since: idleSince(record), lastUserMessageAt });
  }
  return due
    .sort((a, b) => a.since - b.since)
    .map(({ id, reason, lastUserMessageAt }) => ({ id, reason, lastUserMessageAt }));
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
  protectedIds?: () => ReadonlySet<string>;
  closedAfterHours: () => number;
  archive: (candidate: AutoArchiveCandidate) => Promise<AutoArchiveOutcome>;
  now?: () => number;
  /** Sessions the archive guard refused, with the activity stamp they had. Kept between passes by the caller. */
  refused?: Map<string, string>;
}

/**
 * One pass: archives at most one session. A session the archive guard refuses is skipped until its record changes,
 * and the next candidate is tried in the same pass. Returns the id archived, or null.
 */
export async function runAutoArchivePass(deps: AutoArchiveIdleDeps): Promise<string | null> {
  const records = deps.loadedRecords();
  const refused = deps.refused ?? new Map<string, string>();
  const stamps = new Map(records.map((r) => [r.id, r.lastActivityAt ?? r.updatedAt]));
  const candidates = pickAutoArchive({
    records,
    now: (deps.now ?? Date.now)(),
    closedAfterHours: deps.closedAfterHours(),
    lifecycleOf: deps.lifecycleOf,
    lastMessageOf: deps.lastMessageOf,
    openLedgerText: openLedgerTextOf(await deps.readOpenLedgerRows()),
    protectedIds: deps.protectedIds?.(),
  });
  for (const candidate of candidates) {
    if (refused.get(candidate.id) === stamps.get(candidate.id)) continue;
    try {
      if ((await deps.archive(candidate)) === "skipped") continue;
      deps.logger.info(
        { agentId: candidate.id, reason: candidate.reason },
        "Auto-archived an idle session",
      );
      return candidate.id;
    } catch (error) {
      refused.set(candidate.id, stamps.get(candidate.id) ?? "");
      deps.logger.warn(
        { err: error, agentId: candidate.id },
        "Auto-archive of an idle session was refused",
      );
    }
  }
  return null;
}

export function startAutoArchiveIdle(deps: AutoArchiveIdleDeps): () => void {
  const withRefused = { ...deps, refused: deps.refused ?? new Map<string, string>() };
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void runAutoArchivePass(withRefused)
      .catch((error) => deps.logger.warn({ err: error }, "Auto-archive pass failed"))
      .finally(() => {
        running = false;
      });
  }, CHECK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
