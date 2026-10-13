import {
  LeadEventDispatcher,
  leadEventsFor,
  registerLeadEvents,
  withLeadEvent,
} from "./lead-events.js";
import { loadAgentPolicy } from "./limit-resume/policy.js";
import type { PolicyHooks } from "../../../../plugins/fulcra-agent-policy/index.host.mjs";
import type { ReportTurnEnd } from "../../../../plugins/fulcra-agent-policy/server/report-observer.mjs";
import type {
  PermissionRequest,
  LimitedChat,
} from "../../../../plugins/fulcra-agent-policy/server/report-notices.mjs";
export type {
  PermissionRequest,
  LimitedChat,
} from "../../../../plugins/fulcra-agent-policy/server/report-notices.mjs";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { writePrivateFileAtomicSync } from "./private-files.js";
import type { Logger } from "pino";
import {
  MAIN_ASSISTANT_ROLE,
  REPORTS_TO_OWNER,
  ROLE_REF_PREFIX,
  SEAT_LABEL,
} from "@getpaseo/protocol/agent-labels";
import { FINAL_INPUT_CHECK } from "./agent/agent-sdk-types.js";
import type { AgentManager, AgentManagerEvent } from "./agent/agent-manager.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import {
  FINISH_NOTIFICATION_MESSAGE_PREFIX,
  formatSystemNotificationPrompt,
  hasArmedFinishNotification,
  isSystemInjectedEnvelope,
  sendPromptToAgent,
} from "./agent/agent-prompt.js";
import {
  createFinalInputCheck,
  hasFinalInputHandoff,
  waitForFinalInputHandoff,
} from "./agent/final-input-check.js";
import type { DaemonConfigStore } from "./daemon-config-store.js";
import { heldSendsFor } from "./held-sends.js";
import {
  defaultLedgerDir,
  readOpenLedgerRows,
  rowsOwnedBy,
  type LedgerRow,
} from "./ledger-items.js";
import { lastAgentMessageAt } from "./agent-message-log.js";
import type { HostLinkNoticeKind } from "./host-link-contracts.js";
import { classifyEndingAssistantMessage, classifyFailedTurn } from "./limit-resume/detect.js";
import {
  decideSend,
  lineStoreOf,
  reportsTo,
  resolveRoleTarget,
  type LineAgent,
  type LineStore,
} from "./reporting-lines.js";

const {
  REPORT_UP_SNIPPET_CHARS,
  PERMISSION_COMMAND_CHARS,
  COALESCE_WINDOW_MS,
  COMBINED_LIST_LIMIT,
  COMBINED_SNIPPET_CHARS,
  NUDGE_LIST_LIMIT,
  UNKNOWN_RESET_MS,
  MAX_HELD_REPORTS,
  formatLimitNotice,
  permissionCommandOf,
  formatNudge,
  formatPermissionNotice,
  formatCombinedNotice,
  titleOf,
  formatReportUpNotice,
  reportUpSwitches,
  quietReportReason,
} = loadAgentPolicy("report-notices");
export {
  REPORT_UP_SNIPPET_CHARS,
  PERMISSION_COMMAND_CHARS,
  COALESCE_WINDOW_MS,
  COMBINED_LIST_LIMIT,
  COMBINED_SNIPPET_CHARS,
  NUDGE_LIST_LIMIT,
  UNKNOWN_RESET_MS,
  MAX_HELD_REPORTS,
  formatLimitNotice,
  permissionCommandOf,
  formatNudge,
  formatPermissionNotice,
  formatCombinedNotice,
  titleOf,
  formatReportUpNotice,
  reportUpSwitches,
};

// FULCRA(orchestration): native policy selects notices. The host keeps ownership checks and guarded delivery.
/** One worker's "finished a turn" line waiting to go to its lead (FU-115). */
interface PendingFinish {
  workerId: string;
  eventId?: string;
  worker: LineAgent;
  lastMessage: string | null;
}

/** The message id prefix of an idle-lead nudge; it starts with the notice prefix, so it counts as a notice too. */
export const NUDGE_MESSAGE_PREFIX = `${FINISH_NOTIFICATION_MESSAGE_PREFIX}idle-nudge:`;

export interface ReportUpDeps {
  remoteNotice?: (workerId: string, prompt: string, kind: HostLinkNoticeKind) => Promise<boolean>;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  /** "Finished a turn" notices: off unless the owner turned the fallback on. */
  isEnabled: () => boolean;
  /** The permission, limit and idle-lead notices: on unless every report-up notice is turned off. Default: on. */
  isOtherEnabled?: () => boolean;
  localServerId: string | null;
  logger: Logger;
  /** The delivery step; tests replace it. */
  deliver?: (leadId: string, prompt: string) => Promise<void>;
  /** The clock and the timer; tests replace them. */
  now?: () => number;
  setTimer?: (run: () => void, ms: number) => void;
  /** Where the limited chats and the held reports are kept, so a daemon restart does not lose them. */
  statePath?: string;
  /** The open ledger rows; tests replace it. Default: the project ledgers under FULCRA_LEDGER_DIR or ~/shared-vault. */
  readLedger?: () => readonly LedgerRow[] | Promise<readonly LedgerRow[]>;
}

type NoticeKind = "report-up" | "idle-nudge" | "finished-turn" | "permission" | "limit";
interface HeldReport {
  prompt: string;
  kind: NoticeKind;
}

class ReportUpDisabledError extends Error {
  constructor() {
    super("Report-up was turned off");
  }
}

interface PersistedState {
  v: 1;
  limited: Record<string, LimitedChat>;
  held: Record<string, Array<string | HeldReport>>;
}

/** A chat's lead chat on this computer (fulcra.reports-to, else its parent), or the reason there is none. */
export async function leadChatOf(
  store: LineStore,
  worker: LineAgent,
  localServerId: string | null,
): Promise<{ id: string } | { skip: string }> {
  const ref = reportsTo(worker);
  if (!ref || ref === REPORTS_TO_OWNER) return { skip: "no lead chat" };
  let leadId = ref;
  if (ref.startsWith(ROLE_REF_PREFIX)) {
    const role = await resolveRoleTarget(store, ref);
    if (!role?.ok) return { skip: "role has no chat" };
    leadId = role.agentId;
  }
  const [id, server] = leadId.split("@", 2);
  if (server !== undefined && server !== localServerId) return { skip: "lead on another computer" };
  if (!id || id === worker.id) return { skip: "no lead chat" };
  return { id };
}

const NUDGE_DELIVERY_TIMEOUT_MS = 60_000;
interface PendingNudge {
  handoff?: object;
  generation: number;
  startedAt: number;
  fingerprint: string;
  abort: AbortController;
}

export class ReportUpService {
  private readonly observer: import("../../../../plugins/fulcra-agent-policy/server/report-observer.mjs").ReportUpObserver;
  private stopped = false;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly finishOwners = new Map<string, boolean>();
  private readonly store: LineStore;
  private readonly limited = new Map<string, LimitedChat>();
  private readonly held = new Map<string, HeldReport[]>();
  /** State last delivered to each lead; notice replies do not change it. */
  private readonly nudged = new Map<string, string>();
  private readonly nudging = new Map<string, PendingNudge>();
  private nudgeGeneration = 0;

  constructor(private readonly deps: ReportUpDeps) {
    this.store = lineStoreOf({ agentManager: deps.agentManager, agentStorage: deps.agentStorage });
    this.observer = new (loadAgentPolicy("report-observer").ReportUpObserver)({
      now: () => this.now(),
      noticePrefix: FINISH_NOTIFICATION_MESSAGE_PREFIX,
      isSystemInjectedEnvelope,
      onStarted: (id) => {
        this.finishOwners.delete(id);
      },
      onClosed: (id) => {
        this.finishOwners.delete(id);
        this.nudging.get(id)?.abort.abort(new Error("Idle nudge receiver closed"));
      },
      onEnded: (input) => this.onTurnEnd(input),
      onPermission: (id, request) => {
        void this.notifyPermission(id, request).catch((err: unknown) =>
          this.deps.logger.warn({ err, agentId: id }, "Permission notice failed"),
        );
      },
    });
    this.load();
  }

  /** Reads the kept state: limits that have not passed, and reports still held. Held reports are released after the reset. */
  private load(): void {
    const file = this.deps.statePath;
    if (!file) return;
    let state: Partial<PersistedState> = {};
    try {
      state = JSON.parse(readFileSync(file, "utf8")) as Partial<PersistedState>;
    } catch {
      return;
    }
    const now = this.now();
    for (const [id, limit] of Object.entries(state.limited ?? {})) {
      if (typeof limit?.kind === "string" && Number.isFinite(limit.until) && limit.until > now)
        this.limited.set(id, {
          kind: limit.kind,
          until: limit.until,
          notified: limit.notified === true,
        });
    }
    for (const [lead, held] of Object.entries(state.held ?? {})) {
      const reports = Array.isArray(held)
        ? held
            .flatMap((report): HeldReport[] => {
              // COMPAT(reportUpHeldKind): added in v0.2.18, remove after 2027-04-12 once old held reports expire.
              if (typeof report === "string") {
                const heading = report.replace(/^<paseo-system>\n/, "").split("\n", 1)[0] ?? "";
                const finished =
                  /^Worker .* \([^)]+\) (?:finished a turn|ended a turn with an error):/.test(
                    heading,
                  ) || /^\d+ workers finished a turn since your last update:/.test(heading);
                return [{ prompt: report, kind: finished ? "finished-turn" : "report-up" }];
              }
              if (
                report &&
                typeof report.prompt === "string" &&
                ["report-up", "idle-nudge", "finished-turn", "permission", "limit"].includes(
                  report.kind,
                )
              )
                return [report];
              return [];
            })
            .slice(-MAX_HELD_REPORTS)
        : [];
      if (!reports.length) continue;
      this.held.set(lead, reports);
      const wait = Math.max(0, (this.limited.get(lead)?.until ?? now) - now) + 5000;
      this.schedule(() => this.releaseHeld(lead), wait);
    }
  }

  private save(): void {
    const file = this.deps.statePath;
    if (!file) return;
    const state: PersistedState = {
      v: 1,
      limited: Object.fromEntries(this.limited),
      held: Object.fromEntries(this.held),
    };
    try {
      writePrivateFileAtomicSync(file, JSON.stringify(state));
    } catch (err) {
      this.deps.logger.warn({ err }, "Report-up state not saved");
    }
  }

  /** Raw events remain as a test adapter and a source of first-message provenance. */
  onEvent(event: AgentManagerEvent): void {
    if (event.type === "agent_state" && event.agent.lifecycle === "closed")
      this.observer.close(event.agent.id);
    if (event.type === "agent_stream") this.observer.onStream(event.agentId, event.event);
  }

  observeNative(hooks: PolicyHooks): () => void {
    return loadAgentPolicy("hooks").registerReportHooks(hooks, this.observer);
  }

  /** Native observations cannot replace the synchronous, private stream-stop ownership check. */
  captureFinishOwner(agentId: string): void {
    this.finishOwners.set(agentId, this.hasFinishOwner(agentId));
  }

  private hasFinishOwner(agentId: string): boolean {
    const leadHint = reportsTo(this.deps.agentManager.getAgent(agentId) ?? null);
    return Boolean(
      leadHint &&
      (hasArmedFinishNotification(this.deps.agentManager, agentId, leadHint) ||
        this.deps.agentManager.nativeReportOwnsFinish(agentId, leadHint)),
    );
  }

  stop(): void {
    this.stopped = true;
    this.observer.stop();
    for (const pending of this.nudging.values())
      pending.abort.abort(new Error("Idle nudge service stopped"));
    this.nudging.clear();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.finishOwners.clear();
  }

  private schedule(run: () => void, ms: number): void {
    if (this.stopped) return;
    if (this.deps.setTimer) {
      this.deps.setTimer(() => {
        if (!this.stopped) run();
      }, ms);
      return;
    }
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.stopped) run();
    }, ms);
    timer.unref();
    this.timers.add(timer);
  }

  private onTurnEnd(input: ReportTurnEnd): void {
    if (this.stopped) return;
    const { agentId, failed, fromNotice, startedAt, failure, lastAssistant } = input;
    if (!failed)
      void this.nudgeIdleLead(agentId).catch((err: unknown) =>
        this.deps.logger.warn({ err, agentId }, "Idle-lead nudge failed"),
      );
    const armed = this.finishOwners.get(agentId) ?? this.hasFinishOwner(agentId);
    this.finishOwners.delete(agentId);
    if (fromNotice || armed) {
      // A limit is recorded even when this turn sends no report, so the chat is not woken again while it is limited.
      void this.noteLimit(agentId, failed, failure, lastAssistant).catch((err: unknown) =>
        this.deps.logger.warn({ err, agentId }, "Limit note failed"),
      );
      this.deps.logger.info(
        { agentId, reason: fromNotice ? "turn started by a notice" : "caller already notified" },
        "Report-up skipped",
      );
      return;
    }
    void this.report(agentId, failed, failure, startedAt, lastAssistant).catch((err: unknown) =>
      this.deps.logger.warn({ err, agentId }, "Report-up failed"),
    );
  }

  /** The lead chat on this computer, or null with the reason. */
  private leadOf(worker: LineAgent): Promise<{ id: string } | { skip: string }> {
    return leadChatOf(this.store, worker, this.deps.localServerId);
  }

  private async isLeadReportingToMain(reporterId: string, target: LineAgent): Promise<boolean> {
    return (
      target.labels?.[SEAT_LABEL] === MAIN_ASSISTANT_ROLE && (await this.hasWorkers(reporterId))
    );
  }

  /** Why a finished-turn notice is not needed, or null. A failed turn is always sent. */
  private anyEnabled(): boolean {
    return !this.stopped && (this.deps.isEnabled() || this.otherEnabled());
  }

  private otherEnabled(): boolean {
    return !this.stopped && (this.deps.isOtherEnabled ? this.deps.isOtherEnabled() : true);
  }

  private async quietReason(input: {
    workerId: string;
    leadId: string;
    leadAgent: LineAgent;
    failed: boolean;
    startedAt?: number;
  }): Promise<string | null> {
    if (input.failed) return null;
    return quietReportReason({
      failed: input.failed,
      leadToMain: await this.isLeadReportingToMain(input.workerId, input.leadAgent),
      sentAt: lastAgentMessageAt(input.workerId, input.leadId),
      startedAt: input.startedAt,
    });
  }

  /** Whether any chat on this computer reports to this chat, which makes it a lead. */
  private async hasWorkers(leadId: string): Promise<boolean> {
    for (const chat of await this.store.list()) {
      if (chat.id === leadId || chat.archivedAt || !reportsTo(chat)) continue;
      const owner = await this.leadOf(chat);
      if ("id" in owner && owner.id === leadId) return true;
    }
    return false;
  }

  /** The chats on this computer that report to the lead and are idle now. */
  private async idleWorkersOf(leadId: string): Promise<LineAgent[]> {
    const workers: LineAgent[] = [];
    for (const chat of await this.store.list()) {
      if (chat.id === leadId || chat.archivedAt || !reportsTo(chat)) continue;
      const live = this.deps.agentManager.getAgent(chat.id);
      if (live?.lifecycle !== "idle" || (live.backgroundWork?.count ?? 0) > 0) continue;
      const owner = await this.leadOf(chat);
      if ("id" in owner && owner.id === leadId) workers.push(chat);
    }
    return workers;
  }

  /**
   * A lead that is idle while it owns open ledger items and has idle workers gets one message that lists them.
   * Event-driven: it runs when the lead's turn ends. Nothing is sent when there are no idle workers, no open items,
   * when the lead is at a usage limit, or when the same state was already delivered.
   */
  private async nudgeIdleLead(leadId: string): Promise<void> {
    if (!this.otherEnabled()) return;
    await new Promise((resolve) => setImmediate(resolve));
    if (this.observer.isOpen(leadId) || this.limitOf(leadId)) return;
    const lead = await this.store.get(leadId);
    const live = this.deps.agentManager.getAgent(leadId);
    if (!lead || lead.archivedAt || live?.internal) return;
    const last = await this.deps.agentManager.getLastAssistantMessage(leadId).catch(() => null);
    const stop = classifyEndingAssistantMessage(last, this.now());
    if (stop && stop.kind !== "network") return;
    const workers = await this.idleWorkersOf(leadId);
    if (!workers.length) {
      this.cancelNudge(leadId, "Idle nudge has no eligible workers");
      return;
    }
    const owned = rowsOwnedBy(
      await (this.deps.readLedger ?? (() => readOpenLedgerRows(defaultLedgerDir())))(),
      { id: leadId, title: titleOf(lead) },
    );
    if (!owned.length) {
      this.cancelNudge(leadId, "Idle nudge has no owned open items");
      return;
    }
    const fingerprint = JSON.stringify([
      workers.map((worker) => worker.id).sort(),
      owned.map((item) => item.id).sort(),
    ]);
    if (this.observer.isOpen(leadId)) return;
    const pending = this.nudging.get(leadId);
    if (pending) {
      const unchanged = pending.fingerprint === fingerprint;
      const withinDeadline = this.now() - pending.startedAt < NUDGE_DELIVERY_TIMEOUT_MS;
      if (unchanged && withinDeadline && !pending.abort.signal.aborted) return;
      if (!withinDeadline) this.expireNudge(leadId, pending);
      else pending.abort.abort(new Error("Idle nudge state changed or expired"));
    }
    if (this.nudged.get(leadId) === fingerprint) return;
    await this.deliverNudge(
      leadId,
      fingerprint,
      formatSystemNotificationPrompt(formatNudge(workers, owned)),
    );
  }

  private cancelNudge(leadId: string, reason: string): void {
    this.nudging.get(leadId)?.abort.abort(new Error(reason));
  }

  private expireNudge(leadId: string, pending: PendingNudge): void {
    if (
      this.nudging.get(leadId)?.generation === pending.generation &&
      !pending.abort.signal.aborted &&
      hasFinalInputHandoff(pending.handoff)
    ) {
      this.nudged.set(leadId, pending.fingerprint);
    }
    pending.abort.abort(new Error("Idle nudge delivery timed out"));
  }

  private async deliverNudge(leadId: string, fingerprint: string, prompt: string): Promise<void> {
    const pending: PendingNudge = {
      generation: ++this.nudgeGeneration,
      startedAt: this.now(),
      fingerprint,
      abort: new AbortController(),
    };
    this.nudging.set(leadId, pending);
    const current = () =>
      this.nudging.get(leadId)?.generation === pending.generation &&
      !pending.abort.signal.aborted &&
      this.now() - pending.startedAt < NUDGE_DELIVERY_TIMEOUT_MS;
    let cancel!: () => void;
    const canceled = new Promise<void>((_resolve, reject) => {
      cancel = () => reject(pending.abort.signal.reason);
      pending.abort.signal.addEventListener("abort", cancel, { once: true });
    });
    // Bound queueing and dispatch before either can start. Expiry never creates another nudge.
    const timer = setTimeout(() => {
      this.expireNudge(leadId, pending);
    }, NUDGE_DELIVERY_TIMEOUT_MS);
    this.timers.add(timer);
    const dispatch = async () => {
      if (!current() || !this.noticeEnabled("idle-nudge") || this.limitOf(leadId)) return;
      if (this.deps.deliver) await this.deps.deliver(leadId, prompt);
      else
        await this.send(leadId, prompt, "idle-nudge", current, (handle) => {
          pending.handoff = handle;
        });
      if (current()) this.nudged.set(leadId, fingerprint);
    };
    // Cancellation also settles the held callback, so a stalled dispatch cannot block the queue.
    const deliver = () => Promise.race([dispatch(), canceled]);
    try {
      const delivery = this.deps.deliver
        ? deliver()
        : heldSendsFor(this.deps.agentManager, this.deps.logger).holdAndWait(leadId, deliver);
      await Promise.race([delivery, canceled]);
    } finally {
      clearTimeout(timer);
      this.timers.delete(timer);
      pending.abort.signal.removeEventListener("abort", cancel);
      if (this.nudging.get(leadId)?.generation === pending.generation) this.nudging.delete(leadId);
    }
  }

  /** Tells the lead once that a chat is waiting for permission. Nothing is allowed or denied here. */
  private async notifyPermission(workerId: string, request: PermissionRequest): Promise<void> {
    if (!this.otherEnabled()) return;
    const live = this.deps.agentManager.getAgent(workerId);
    const worker = await this.store.get(workerId);
    if (!worker || worker.archivedAt || live?.internal) return;
    const prompt = formatSystemNotificationPrompt(
      formatPermissionNotice({
        worker,
        request,
        cwd: (live as { cwd?: string } | null)?.cwd ?? (worker as { cwd?: string }).cwd ?? null,
      }),
    );
    if (await this.deps.remoteNotice?.(workerId, prompt, "permission")) return;
    const lead = await this.leadOf(worker);
    if ("skip" in lead) return;
    const leadAgent = await this.store.get(lead.id);
    if (!leadAgent || leadAgent.archivedAt) return;
    const decision = await decideSend(
      this.store,
      { agentId: workerId },
      lead.id,
      this.deps.localServerId,
    );
    if (!decision?.allowed) return;
    await this.toLead(workerId, lead.id, prompt, "permission");
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Whether a chat is at a usage limit now. */
  limitOf(agentId: string): LimitedChat | null {
    const limit = this.limited.get(agentId);
    if (!limit) return null;
    if (limit.until > this.now()) return limit;
    this.limited.delete(agentId);
    this.save();
    return null;
  }

  /**
   * Reads how a turn ended. A usage limit marks the chat limited and tells its lead once; any other end clears the
   * mark. Returns true for a limit, which is never reported as a finished turn.
   */
  private async noteLimit(
    workerId: string,
    failed: boolean,
    text: string,
    observedLast?: string | null,
  ): Promise<boolean> {
    const now = this.now();
    let last: string | null = null;
    if (!failed)
      last =
        observedLast === undefined
          ? await this.deps.agentManager.getLastAssistantMessage(workerId).catch(() => null)
          : observedLast;
    const stop = failed ? classifyFailedTurn(text, now) : classifyEndingAssistantMessage(last, now);
    if (!stop || stop.kind === "network") {
      if (this.limited.delete(workerId)) {
        this.save();
        this.releaseHeld(workerId);
      }
      return false;
    }
    const previous = this.limited.get(workerId);
    const limit: LimitedChat = {
      kind: stop.limitKind ?? "usage",
      until: stop.resetAt ?? now + UNKNOWN_RESET_MS,
      notified: previous?.notified === true && previous.until > now,
    };
    this.limited.set(workerId, limit);
    if (limit.notified) {
      this.save();
      return true;
    }
    limit.notified = true;
    this.save();
    const worker = await this.store.get(workerId);
    if (!worker || worker.archivedAt) return true;
    const prompt = formatSystemNotificationPrompt(formatLimitNotice(titleOf(worker), limit));
    if (await this.deps.remoteNotice?.(workerId, prompt, "limit")) return true;
    const lead = await this.leadOf(worker);
    if ("skip" in lead) return true;
    await this.toLead(workerId, lead.id, prompt, "limit");
    return true;
  }

  /** Sends a notice to a lead, or holds it while the lead is at a limit (sent as one notice after the reset). */
  private async toLead(
    workerId: string,
    leadId: string,
    prompt: string,
    kind: NoticeKind = "report-up",
  ): Promise<void> {
    if (!this.noticeEnabled(kind)) return;
    const leadLimit = this.limitOf(leadId);
    if (leadLimit) {
      const held = this.held.get(leadId) ?? [];
      held.push({ prompt, kind });
      if (held.length > MAX_HELD_REPORTS) held.shift();
      this.held.set(leadId, held);
      this.save();
      this.deps.logger.info(
        { agentId: workerId, lead: leadId, until: leadLimit.until },
        "Report-up held: the lead is at a usage limit",
      );
      const delay = Math.max(0, leadLimit.until - this.now()) + 1000;
      this.schedule(() => this.releaseHeld(leadId), delay);
      return;
    }
    if (this.deps.deliver) {
      await this.deps.deliver(leadId, prompt);
      return;
    }
    // Held until the lead's turn ends, one queue per lead, in order (held-sends.ts).
    heldSendsFor(this.deps.agentManager, this.deps.logger).hold(leadId, async () => {
      if (!this.noticeEnabled(kind)) return;
      await this.send(leadId, prompt, kind);
      this.deps.logger.info({ agentId: workerId, lead: leadId, kind }, "Report-up delivered");
    });
  }

  /** The held reports for a lead go out as one notice, once the lead is no longer at a limit. */
  private releaseHeld(leadId: string): void {
    if (this.limitOf(leadId)) return;
    const held = this.held.get(leadId);
    if (!held?.length) return;
    this.held.delete(leadId);
    this.save();
    if (this.deps.deliver) {
      void this.deliverHeld(leadId, held).catch((err: unknown) =>
        this.deps.logger.warn({ err, leadId }, "Held reports failed"),
      );
      return;
    }
    // Keep notice kinds until the busy lead can receive the message. Reload can change them while it waits.
    try {
      heldSendsFor(this.deps.agentManager, this.deps.logger).hold(leadId, () =>
        this.deliverHeld(leadId, held),
      );
    } catch (err) {
      this.deps.logger.warn({ err, leadId }, "Held reports failed");
    }
  }

  private async deliverHeld(leadId: string, held: readonly HeldReport[]): Promise<void> {
    const enabled = held.filter((report) => this.noticeEnabled(report.kind));
    if (!enabled.length) return;
    if (this.limitOf(leadId)) {
      for (const report of enabled) await this.toLead(leadId, leadId, report.prompt, report.kind);
      return;
    }
    const body = enabled.map(({ prompt }) => prompt.trim()).join("\n\n");
    const notice = `${enabled.length} report${enabled.length === 1 ? "" : "s"} held while you were at your usage limit:\n\n${body}`;
    if (this.deps.deliver) await this.deps.deliver(leadId, notice);
    else {
      let kind: NoticeKind = "report-up";
      if (enabled.some((report) => report.kind === "finished-turn")) kind = "finished-turn";
      else if (enabled.every((report) => report.kind === enabled[0]!.kind)) kind = enabled[0]!.kind;
      try {
        await this.send(leadId, notice, kind);
      } catch (err) {
        // The final check refused input. Retry only the notices that remain enabled, with no provider input repeated.
        const remaining = enabled.filter((report) => this.noticeEnabled(report.kind));
        if (err instanceof ReportUpDisabledError && remaining.length < enabled.length) {
          await this.deliverHeld(leadId, remaining);
          return;
        }
        throw err;
      }
      this.deps.logger.info({ lead: leadId }, "Report-up delivered");
    }
  }

  private async report(
    workerId: string,
    failed: boolean,
    failure = "",
    startedAt?: number,
    observedLast?: string | null,
  ): Promise<void> {
    const skip = (reason: string) => {
      this.deps.logger.info({ agentId: workerId, reason }, "Report-up skipped");
    };
    if (!this.anyEnabled()) return skip("turned off");
    // Idle: a follow-up turn that starts at once reports when it ends.
    await new Promise((resolve) => setImmediate(resolve));
    if (this.observer.isOpen(workerId)) return skip("a new turn started");
    const live = this.deps.agentManager.getAgent(workerId);
    const worker = await this.store.get(workerId);
    if (!worker || worker.archivedAt || live?.internal) return skip("not a visible chat");
    // A usage limit is limit state, never "finished a turn" (FU-63).
    if (await this.noteLimit(workerId, failed, failure, observedLast))
      return skip("ended on a usage limit");
    // OFF BY DEFAULT: the limit notice above stays on; "finished a turn" and "ended with an error" notices need the fallback.
    if (!this.deps.isEnabled()) return skip("turned off");
    if (await this.remoteFinished(worker, failed, startedAt, observedLast)) return;
    const lead = await this.leadOf(worker);
    if ("skip" in lead) return skip(lead.skip);
    const leadAgent = await this.store.get(lead.id);
    if (!leadAgent || leadAgent.archivedAt) return skip("lead not here or archived");
    if (!(await this.reportingLineAllows(workerId, lead.id))) return;
    if (this.suppressFinished(lead.id, workerId, failed, startedAt))
      return skip("routine event recorded in the lead digest");
    const quiet = await this.quietReason({
      workerId,
      leadId: lead.id,
      leadAgent,
      failed,
      startedAt,
    });
    if (quiet) return skip(quiet);
    const lastMessage =
      observedLast === undefined
        ? await this.deps.agentManager.getLastAssistantMessage(workerId).catch(() => null)
        : observedLast;
    // A failed turn is sent at once. A finished turn is combined with the lead's other finished workers (FU-115).
    if (failed) {
      const prompt = formatSystemNotificationPrompt(
        formatReportUpNotice({ worker, failed, lastMessage }),
      );
      await this.toLead(workerId, lead.id, prompt, "finished-turn");
      return;
    }
    await this.queueFinished(lead.id, {
      workerId,
      worker,
      lastMessage,
      eventId: startedAt === undefined ? undefined : `${workerId}:${startedAt}`,
    });
  }

  private suppressFinished(
    leadId: string,
    workerId: string,
    failed: boolean,
    startedAt?: number,
  ): boolean {
    if (failed || startedAt === undefined) return false;
    const dispatcher = leadEventsFor(this.deps.agentManager);
    return (
      dispatcher?.suppress(leadId, {
        eventId: `${workerId}:${startedAt}`,
        sourceId: workerId,
        kind: "finished_turn",
        startedAt,
        reportedAt: dispatcher.reportAt(leadId, workerId),
      }) ?? false
    );
  }

  private async remoteFinished(
    worker: LineAgent,
    failed: boolean,
    startedAt?: number,
    observedLast?: string | null,
  ): Promise<boolean> {
    const line = reportsTo(worker);
    if (line !== "role:main-assistant" || !this.deps.remoteNotice) return false;
    const sentAt = lastAgentMessageAt(worker.id, line);
    if (!failed && startedAt !== undefined && sentAt !== null && sentAt >= startedAt) return true;
    const lastMessage =
      observedLast === undefined
        ? await this.deps.agentManager.getLastAssistantMessage(worker.id).catch(() => null)
        : observedLast;
    const prompt = formatSystemNotificationPrompt(
      formatReportUpNotice({ worker, failed, lastMessage }),
    );
    return this.deps.remoteNotice(worker.id, prompt, failed ? "failed" : "finished");
  }

  private async reportingLineAllows(workerId: string, leadId: string): Promise<boolean> {
    const decision = await decideSend(
      this.store,
      { agentId: workerId },
      leadId,
      this.deps.localServerId,
    );
    if (decision?.allowed) return true;
    const reason = decision?.allowed === false ? decision.reason : null;
    this.deps.logger.info(
      { agentId: workerId, lead: leadId, reason },
      "Report-up refused by the reporting line",
    );
    return false;
  }

  /**
   * FU-115: "finished a turn" notices for one lead wait here and go out as ONE message: the first at once when the lead
   * is idle and was not told in the last 5 minutes, the rest together after that window, and always after the lead's
   * running turn ends (the held-send queue). A worker that finishes twice before delivery is listed once.
   */
  private readonly pendingFinished = new Map<string, PendingFinish[]>();
  private readonly lastFinishedAt = new Map<string, number>();
  private readonly flushing = new Set<string>();

  private async queueFinished(leadId: string, item: PendingFinish): Promise<void> {
    if (this.limitOf(leadId)) {
      // A limited lead keeps its own held-report path (persisted, one notice after the reset).
      const prompt = formatSystemNotificationPrompt(
        formatReportUpNotice({ worker: item.worker, failed: false, lastMessage: item.lastMessage }),
      );
      await this.toLead(item.workerId, leadId, prompt, "finished-turn");
      return;
    }
    const list = (this.pendingFinished.get(leadId) ?? []).filter(
      (entry) => entry.workerId !== item.workerId,
    );
    list.push(item);
    this.pendingFinished.set(leadId, list);
    if (this.flushing.has(leadId)) return;
    this.flushing.add(leadId);
    const wait = Math.max(
      0,
      (this.lastFinishedAt.get(leadId) ?? 0) + COALESCE_WINDOW_MS - this.now(),
    );
    if (wait === 0) {
      await this.flushFinished(leadId);
      return;
    }
    this.deps.logger.info(
      { lead: leadId, waitMs: wait },
      "Report-up held: the lead was told lately",
    );
    this.schedule(() => {
      void this.flushFinished(leadId).catch((err: unknown) =>
        this.deps.logger.warn({ err, leadId }, "Report-up flush failed"),
      );
    }, wait);
  }

  private takePending(leadId: string): PendingFinish[] {
    const items = this.pendingFinished.get(leadId) ?? [];
    this.pendingFinished.delete(leadId);
    this.flushing.delete(leadId);
    return items;
  }

  private async flushFinished(leadId: string): Promise<void> {
    if (this.stopped || !this.deps.isEnabled()) {
      this.takePending(leadId);
      return;
    }
    if (this.deps.deliver) {
      const items = this.takePending(leadId);
      if (!items.length) return;
      await this.deliverCombined(leadId, items);
      return;
    }
    // Built when the lead's turn has ended: notices that arrive while the lead works join this one message.
    heldSendsFor(this.deps.agentManager, this.deps.logger).hold(leadId, async () => {
      const items = this.takePending(leadId);
      if (!items.length) return;
      await this.deliverCombined(leadId, items);
    });
  }

  /**
   * The combined message goes out now, unless the lead reached a usage limit after the reports were queued: then it
   * takes the limit-aware path (toLead), which keeps it in the persisted held reports until the reset (FU-63).
   */
  private async deliverCombined(leadId: string, items: readonly PendingFinish[]): Promise<void> {
    // Reload can disable finished turns after flushFinished queues delivery for a busy lead.
    if (!this.deps.isEnabled()) return;
    const prompt = formatSystemNotificationPrompt(formatCombinedNotice(items));
    if (this.limitOf(leadId)) {
      await this.toLead(items[0]!.workerId, leadId, prompt, "finished-turn");
      return;
    }
    this.lastFinishedAt.set(leadId, this.now());
    if (this.deps.deliver) await this.deps.deliver(leadId, prompt);
    else {
      await this.send(leadId, prompt, "finished-turn");
      this.deps.logger.info({ lead: leadId, workers: items.length }, "Report-up delivered");
    }
    for (const item of items)
      if (item.eventId)
        leadEventsFor(this.deps.agentManager)?.noteDelivered(leadId, {
          eventId: item.eventId,
          sourceId: item.workerId,
          kind: "finished_turn",
        });
  }

  private noticeEnabled(kind: NoticeKind): boolean {
    return (
      !this.stopped && (kind === "finished-turn" ? this.deps.isEnabled() : this.otherEnabled())
    );
  }

  private send(
    leadId: string,
    prompt: string,
    kind: NoticeKind,
    currentNudge?: () => boolean,
    captureHandoff?: (handle: object) => void,
  ): Promise<void> {
    const { agentManager, agentStorage, logger } = this.deps;
    const checkCurrent = () => {
      if (!this.noticeEnabled(kind)) throw new ReportUpDisabledError();
      if (currentNudge && !currentNudge()) throw new Error("Idle nudge generation expired");
    };
    const causes = {
      "idle-nudge": "nudge",
      permission: "permission",
      limit: "limit",
      "finished-turn": "finished_turn",
      "report-up": "queued_delivery",
    } as const;
    const cause = causes[kind];
    return withLeadEvent(cause, () =>
      agentManager.trustedPlugins.daemon(async () => {
        const finalCheck = createFinalInputCheck(checkCurrent);
        captureHandoff?.(finalCheck);
        await sendPromptToAgent({
          agentManager,
          agentStorage,
          agentId: leadId,
          prompt,
          messageId:
            kind === "idle-nudge"
              ? `${NUDGE_MESSAGE_PREFIX}${randomUUID()}`
              : `${FINISH_NOTIFICATION_MESSAGE_PREFIX}report-up:${randomUUID()}`,
          runOptions: { [FINAL_INPUT_CHECK]: finalCheck },
          activeTurnBehavior: "steer",
          steerOnly: true,
          unarchive: false,
          logger,
        });
        await waitForFinalInputHandoff(finalCheck);
      }),
    );
  }
}

export function startReportUp(input: {
  remoteNotice?: ReportUpDeps["remoteNotice"];
  hooks?: PolicyHooks;
  paseoHome?: string;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  daemonConfigStore: DaemonConfigStore;
  localServerId: string | null;
  logger: Logger;
}): () => void {
  let offEvents: (() => void) | undefined;
  if (input.paseoHome) {
    try {
      offEvents = registerLeadEvents(
        input.agentManager,
        new LeadEventDispatcher({
          home: input.paseoHome,
          onError: (err) => input.logger.warn({ err }, "Lead event state not saved"),
        }),
      );
    } catch (err) {
      input.logger.warn({ err }, "Lead event state not loaded; dispatcher disabled");
    }
  }
  const service = new ReportUpService({
    remoteNotice: input.remoteNotice,
    agentManager: input.agentManager,
    agentStorage: input.agentStorage,
    isEnabled: () =>
      reportUpSwitches(input.daemonConfigStore.get().reportUpOnTurnEnd).finishedTurns,
    isOtherEnabled: () =>
      reportUpSwitches(input.daemonConfigStore.get().reportUpOnTurnEnd).otherNotices,
    localServerId: input.localServerId,
    logger: input.logger,
    ...(input.paseoHome ? { statePath: path.join(input.paseoHome, "report-up-limits.json") } : {}),
  });
  const offHooks = input.hooks ? service.observeNative(input.hooks) : undefined;
  const offStream = input.agentManager.subscribe(
    (event) => {
      if (event.type === "agent_state" && event.agent.archivedAt) {
        const dispatcher = leadEventsFor(input.agentManager);
        if (dispatcher)
          void leadChatOf(lineStoreOf(input), event.agent, input.localServerId)
            .then((lead) => {
              if ("id" in lead)
                dispatcher.suppress(lead.id, {
                  eventId: `${event.agent.id}:${event.agent.archivedAt}`,
                  sourceId: event.agent.id,
                  kind: "archive_done",
                });
              return undefined;
            })
            .catch((err) => input.logger.warn({ err }, "Archive digest failed"));
      }
      // Native hooks own lifecycle events; first-message provenance still needs the host timeline.
      if (input.hooks && event.type === "agent_stream") {
        const live = input.agentManager.getAgent(event.agentId);
        if (!live || live.internal) return;
      }
      if (
        input.hooks &&
        event.type === "agent_stream" &&
        (event.event.type === "turn_completed" || event.event.type === "turn_failed")
      )
        service.captureFinishOwner(event.agentId);
      if (input.hooks && (event.type !== "agent_stream" || event.event.type !== "timeline")) return;
      service.onEvent(event);
    },
    { replayState: false },
  );
  return () => {
    offHooks?.();
    offEvents?.();
    offStream();
    service.stop();
  };
}
