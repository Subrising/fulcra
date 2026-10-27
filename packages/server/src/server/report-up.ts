import { IdleTurnRecovery } from "./idle-turn-recovery.js";
import { sessionCost } from "./agent/session-cost.js";
import { LedgerDirectoryWatch } from "./ledger-routing/watch.js";
import { LedgerRoutingService, parseWorkerResult } from "./ledger-routing/service.js";
import type { BoundCreateAgentCommand } from "./agent/create-agent/create.js";
import { PERMISSION_NOTICE_GRACE_MS } from "./permission-notice.js";
import {
  LeadEventDispatcher,
  leadEventsFor,
  registerLeadEvents,
  withLeadEvent,
} from "./lead-events.js";
import { registerArchiveReportCount, archiveReportStateKnown } from "./archive-observation.js";
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
import {
  finishNoticeParentId,
  storedFinishNotices,
  type AgentStorage,
  type FinishNotice,
} from "./agent/agent-storage.js";
import {
  FINISH_NOTIFICATION_MESSAGE_PREFIX,
  formatSystemNotificationPrompt,
  hasArmedFinishNotification,
  isSystemInjectedEnvelope,
  sendPromptToAgent,
  SteerUnavailableError,
} from "./agent/agent-prompt.js";
import {
  createFinalInputCheck,
  finalInputFailure,
  hasFinalInputHandoff,
  waitForFinalInputHandoff,
} from "./agent/final-input-check.js";
import { CodexAppServerRpcError } from "./agent/providers/codex/app-server-transport.js";
import type { DaemonConfigStore } from "./daemon-config-store.js";
import { heldSendsFor } from "./held-sends.js";
import { leadMoveTarget, readLeadMoves, relayLeadNotice, type LeadMove } from "./lead-moves.js";
import { isArchiveLead } from "./agent/archive-policy.js";
import { respondToAgentPermission } from "./agent/permission-response.js";
import {
  defaultLedgerDir,
  readOpenLedgerRows,
  rowsEligibleForNudge,
  isNudgeOwnerSkipped,
  type LedgerRow,
} from "./ledger-items.js";
import { finishNoticeWanted } from "./finish-notice-filter.js";
import { lastAgentMessageAt, lastAgentMessageDeliveredAt } from "./agent-message-log.js";
import type { HostLinkNoticeKind } from "./host-link-contracts.js";
import { classifyEndingAssistantMessage, classifyFailedTurn } from "./limit-resume/detect.js";
import {
  decideSend,
  findRoleHolder,
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
  formatWorkerQuestionNotice,
  formatWorkerQuestionRefusal,
  formatCombinedNotice,
  titleOf,
  formatReportUpNotice,
  formatSessionSpend,
  reportUpSwitches,
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
  worker: LineAgent & { sessionCost?: ReturnType<typeof sessionCost> };
  lastMessage: string | null;
}

/** The message id prefix of an idle-lead nudge; it starts with the notice prefix, so it counts as a notice too. */
export const NUDGE_MESSAGE_PREFIX = `${FINISH_NOTIFICATION_MESSAGE_PREFIX}idle-nudge:`;

export interface ReportUpDeps {
  routing?: LedgerRoutingService;
  isDispatchLead?: (id: string) => boolean;
  remoteNotice?: (workerId: string, prompt: string, kind: HostLinkNoticeKind) => Promise<boolean>;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  /** "Finished a turn" notices: off unless the owner turned the fallback on. */
  isEnabled: () => boolean;
  /** The permission and limit notices: on unless every report-up notice is turned off. Default: on. */
  isOtherEnabled?: () => boolean;
  /** Idle-lead nudges have their own switch. Unset means on. */
  isNudgeEnabled?: () => boolean;
  getNudgeSkipOwners?: () => readonly string[];
  getNudgeMinIntervalMinutes?: () => number;
  localServerId: string | null;
  logger: Logger;
  /** FU-444: the leads that moved (lead-moves.ts). A notice for an old lead goes to its new lead. */
  leadMoves?: () => readonly LeadMove[];
  /** Runs a relay command for a lead on another computer; tests replace it. */
  relay?: (file: string, args: string[]) => Promise<void>;
  /** The delivery step; tests replace it. */
  deliver?: (leadId: string, prompt: string, messageId?: string) => Promise<void>;
  /** The clock and the timer; tests replace them. */
  now?: () => number;
  setTimer?: (run: () => void, ms: number) => void;
  /** Where the limited chats and the held reports are kept, so a daemon restart does not lose them. */
  statePath?: string;
  /** The open ledger rows; tests replace it. Default: the project ledgers under FULCRA_LEDGER_DIR or ~/shared-vault. */
  readLedger?: () => readonly LedgerRow[] | Promise<readonly LedgerRow[]>;
  /** Production watches this directory. Tests can use an isolated ledger directory. */
  ledgerDir?: string;
}

type NoticeKind =
  | "report-up"
  | "idle-nudge"
  | "finished-turn"
  | "owned-finish"
  | "permission"
  | "owned-permission"
  | "limit";
interface HeldReport {
  prompt: string;
  kind: NoticeKind;
  permission?: { workerId: string; requestId: string };
}

class ReportUpDisabledError extends Error {
  constructor() {
    super("Report-up was turned off");
  }
}

class OwnedFinishAlreadyDelivered extends Error {}

class OwnedFinishLineChanged extends Error {
  constructor(
    readonly parentId: string | null,
    reason: string,
  ) {
    super(reason);
  }
}

interface PersistedState {
  v: 1;
  limited: Record<string, LimitedChat>;
  held: Record<string, Array<string | HeldReport>>;
  nudgeDeliveredAt?: Record<string, number>;
}

const ASYNC_QUESTION_TOOL = "request_user_input_async";

/**
 * A worker by its labels: it reports to a chat, holds no seat or lead role, and does not report to the main assistant
 * (project leads do, with fulcra.role=implementation). The caller also excludes chats that have workers.
 */
function looksLikeWorker(worker: LineAgent): boolean {
  const line = reportsTo(worker);
  return (
    Boolean(line) &&
    line !== REPORTS_TO_OWNER &&
    !line!.startsWith(`${ROLE_REF_PREFIX}${MAIN_ASSISTANT_ROLE}`) &&
    !isArchiveLead({ labels: worker.labels ?? {} })
  );
}

const LEAD_ON_ANOTHER_COMPUTER = "lead on another computer";

interface UnseenTurn {
  worker: LineAgent;
  failed: boolean;
  observedLast: string | null | undefined;
  startedAt: number | undefined;
}

/**
 * The worker sent to its lead since the turn began: a delivered local send (FU-427), or for a lead on another computer
 * the source check of an SSH relay. A failed relay is shown to the worker by the CLI itself.
 */
function sentToLeadDuring(
  worker: LineAgent,
  startedAt: number | undefined,
  localServerId: string | null,
): boolean {
  const [leadId, server] = reportsTo(worker)?.split("@", 2) ?? [];
  if (!leadId || startedAt === undefined) return false;
  const remote = server !== undefined && server !== localServerId;
  const at = remote
    ? lastAgentMessageAt(worker.id, leadId)
    : lastAgentMessageDeliveredAt(worker.id, leadId);
  return at !== null && at >= startedAt;
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
  if (server !== undefined && server !== localServerId) return { skip: LEAD_ON_ANOTHER_COMPUTER };
  if (!id || id === worker.id) return { skip: "no lead chat" };
  return { id };
}

export { PERMISSION_NOTICE_GRACE_MS } from "./permission-notice.js";
const NUDGE_DELIVERY_TIMEOUT_MS = 60_000;
/**
 * FU-424: a refused or unknown finish notice to an idle lead is tried again after 2 s, then 4 s, up to 60 s apart.
 * After the timed attempts, the lead's next idle event or the next boot tries it again from the stored notice.
 */
export const FINISH_RETRY_BASE_MS = 2_000;
export const FINISH_RETRY_MAX_MS = 60_000;
export const FINISH_RETRY_TIMED_ATTEMPTS = 8;

/** The notices that report-up stores as "sending" before the provider call, so storage holds their outcome. */
function durableFinish(notice: FinishNotice): boolean {
  return notice.owner === "report-up" || notice.reason === "stopped";
}
interface PendingNudge {
  handoff?: object;
  deliveryRecorded?: boolean;
  generation: number;
  startedAt: number;
  fingerprint: string;
  abort: AbortController;
}

interface NudgeState {
  fingerprint: string;
  workerIds: string[];
  itemIds: string[];
  itemOwners: string[];
  projects: string[];
  needsDelivery: boolean;
  deferred?: boolean;
}

export class ReportUpService {
  private readonly idleTurns: IdleTurnRecovery;
  private readonly observer: import("../../../../plugins/fulcra-agent-policy/server/report-observer.mjs").ReportUpObserver;
  private stopped = false;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly finishOwners = new Map<string, boolean>();
  private readonly processingOwned = new Set<string>();
  private readonly skippedTurnedOff = new Set<string>();
  private readonly finishRetryAttempts = new Map<string, number>();
  private readonly finishRetryTimers = new Set<string>();
  private readonly store: LineStore;
  private readonly limited = new Map<string, LimitedChat>();
  private archiveStateKnown = true;
  private readonly held = new Map<string, HeldReport[]>();
  private readonly nudgeStates = new Map<string, NudgeState>();
  private readonly nudging = new Map<string, PendingNudge>();
  private nudgeGeneration = 0;
  private ledgerRevision = 0;
  private ledgerSnapshot?: { revision: number; rows: readonly LedgerRow[] };
  private readonly nudgeStopped = new Map<string, Promise<ReadonlySet<string> | null>>();
  private ledgerWatcher?: LedgerDirectoryWatch;
  private ledgerDebounce?: ReturnType<typeof setTimeout>;
  private readonly nudgeDeliveredAt = new Map<string, number>();

  private readonly deps: ReportUpDeps;

  constructor(deps: ReportUpDeps) {
    const deliver = deps.deliver;
    // FU-444: the test delivery step follows lead moves as send() does.
    this.deps = deliver
      ? {
          ...deps,
          deliver: async (leadId, prompt, messageId) => {
            const to = await this.routeMovedLead(leadId, prompt);
            if (to) await deliver(to, prompt, messageId);
          },
        }
      : deps;
    this.idleTurns = new IdleTurnRecovery({
      agentManager: deps.agentManager,
      logger: deps.logger,
      stopped: () => this.stopped,
      blocked: (id, reason) => this.blockedIdleTurn(id, reason),
    });
    this.store = lineStoreOf({ agentManager: deps.agentManager, agentStorage: deps.agentStorage });
    this.observer = new (loadAgentPolicy("report-observer").ReportUpObserver)({
      now: () => this.now(),
      noticePrefix: FINISH_NOTIFICATION_MESSAGE_PREFIX,
      isSystemInjectedEnvelope,
      onStarted: (id) => {
        this.finishOwners.delete(id);
        const worker = deps.agentManager.getAgent(id);
        if (worker) deps.routing?.begin(worker);
      },
      onClosed: (id) => {
        this.finishOwners.delete(id);
        this.nudging.get(id)?.abort.abort(new Error("Idle nudge receiver closed"));
      },
      onEnded: (input) => this.onTurnEnd(input),
      onPermission: (id, request) => {
        // Bypass and hook answers can resolve a request before a person can act on it.
        this.schedule(() => {
          void this.onPermissionRequest(id, request).catch((err: unknown) =>
            this.deps.logger.warn({ err, agentId: id }, "Permission notice failed"),
          );
        }, PERMISSION_NOTICE_GRACE_MS);
      },
    });
    this.load();
    if (deps.ledgerDir) {
      this.ledgerWatcher = new LedgerDirectoryWatch(
        deps.ledgerDir,
        () => {
          if (this.stopped) return;
          this.ledgerRevision++;
          for (const id of this.nudging.keys()) this.cancelNudge(id, "Project ledger changed");
          clearTimeout(this.ledgerDebounce);
          this.ledgerDebounce = setTimeout(() => {
            this.ledgerDebounce = undefined;
            void this.deps.routing
              ?.changed()
              .catch((err: unknown) =>
                this.deps.logger.warn({ err }, "Ledger routing event failed"),
              );
            this.checkIdleLeads();
          }, 100);
          this.ledgerDebounce.unref();
        },
        (err) =>
          this.deps.logger.warn(
            { err },
            "Ledger directory watch unavailable; turn-end checks remain active",
          ),
      );
    }
  }

  async prepareLedgerObservation(): Promise<void> {
    await this.ledgerWatcher?.ready;
    await this.ledgerWatcher?.refresh();
    await this.readLedgerSnapshot();
  }
  observesProject(project: string): boolean {
    return this.ledgerWatcher?.covers(project) === true;
  }

  /** Reads the kept state: limits that have not passed, and reports still held. Held reports are released after the reset. */
  private load(): void {
    const file = this.deps.statePath;
    if (!file) return;
    let state: Partial<PersistedState> = {};
    try {
      state = JSON.parse(readFileSync(file, "utf8")) as Partial<PersistedState>;
    } catch (error) {
      this.archiveStateKnown = (error as NodeJS.ErrnoException).code === "ENOENT";
      return;
    }
    this.archiveStateKnown = archiveReportStateKnown(state, MAX_HELD_REPORTS);
    if (!this.archiveStateKnown) return;
    const now = this.now();
    for (const [id, at] of Object.entries(state.nudgeDeliveredAt ?? {})) {
      if (Number.isSafeInteger(at) && at >= 0) this.nudgeDeliveredAt.set(id, at);
    }
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

  pendingForArchive(agentId: string): number | null {
    if (!this.archiveStateKnown) return null;
    return (
      (this.held.get(agentId)?.length ?? 0) +
      (this.pendingFinished.get(agentId)?.length ?? 0) +
      Number(this.nudging.has(agentId))
    );
  }

  private save(): void {
    const file = this.deps.statePath;
    if (!file) return;
    const state: PersistedState = {
      v: 1,
      limited: Object.fromEntries(this.limited),
      held: Object.fromEntries(this.held),
      nudgeDeliveredAt: Object.fromEntries(this.nudgeDeliveredAt),
    };
    try {
      writePrivateFileAtomicSync(file, JSON.stringify(state));
    } catch (err) {
      this.deps.logger.warn({ err }, "Report-up state not saved");
    }
  }

  /** Raw events remain as a test adapter and a source of first-message provenance. */
  onEvent(event: AgentManagerEvent): void {
    if (
      event.type === "agent_state" &&
      (event.agent.archivedAt || event.agent.labels?.["fulcra.dispatch-state"] === "abandoned")
    )
      void this.deps.routing
        ?.wake()
        .catch((err: unknown) =>
          this.deps.logger.warn({ err }, "Ledger archive reconciliation failed"),
        );
    if (event.type === "agent_state" && event.agent.lifecycle === "closed")
      this.observer.close(event.agent.id);
    if (event.type === "agent_state" && event.agent.lifecycle === "idle") {
      this.sweepFinishNotices(event.agent.id);
      void this.deps.routing
        ?.wake()
        .catch((err: unknown) =>
          this.deps.logger.warn({ err }, "Ledger routing idle event failed"),
        );
    }
    if (event.type === "agent_stream") this.observer.onStream(event.agentId, event.event);
    if (event.type === "agent_stream" && event.event.type === "turn_canceled") {
      this.stopNudge(event.agentId);
      this.checkIdleLeads();
      void this.deliverStoppedFinish(event.agentId).catch((err: unknown) =>
        this.deps.logger.warn({ err, agentId: event.agentId }, "Stopped worker notice failed"),
      );
    }
  }

  /**
   * FU-424: the stored notices are the record of a retry, not a memory set. When a lead becomes idle, every pending or
   * unknown notice from its current children is delivered or resolved.
   */
  private sweepFinishNotices(parentId: string): void {
    if (this.stopped) return;
    void this.deps.agentStorage
      .list()
      .then((records) =>
        Promise.all(
          records.flatMap((record) => {
            // Adoption can change the parent while a notice waits; the current parent receives it.
            if (record.archivedAt || finishNoticeParentId(record.labels) !== parentId) return [];
            return storedFinishNotices(record).map((notice) =>
              this.retryStoredFinish(record.id, notice),
            );
          }),
        ),
      )
      .catch((err: unknown) =>
        this.deps.logger.warn({ err, parentId }, "Finish notice sweep failed"),
      );
  }

  private async retryStoredFinish(childId: string, notice: FinishNotice): Promise<void> {
    if (!durableFinish(notice)) return;
    if (notice.status === "unknown") await this.resolveUnknownFinish(childId, notice);
    else if (notice.status === "pending") await this.deliverOwnedFinish(childId, notice, false);
  }

  /** A busy lead gets the retry from its next idle sweep. */
  private leadBusy(parentId: string): boolean {
    const lifecycle = this.deps.agentManager.getAgent(parentId)?.lifecycle;
    return lifecycle === "running" || lifecycle === "initializing";
  }

  /**
   * FU-424: a refused notice used to wait for the lead's next idle event, but a lead whose turn ended during the send
   * is already idle and sends no new event. An idle lead now gets a timed retry with a bounded backoff.
   */
  private scheduleFinishRetry(childId: string, notice: FinishNotice): void {
    const { messageId, parentId } = notice;
    if (this.stopped || this.finishRetryTimers.has(messageId) || this.leadBusy(parentId)) return;
    const attempt = this.finishRetryAttempts.get(messageId) ?? 0;
    if (attempt >= FINISH_RETRY_TIMED_ATTEMPTS) return;
    this.finishRetryAttempts.set(messageId, attempt + 1);
    this.finishRetryTimers.add(messageId);
    this.schedule(
      () => {
        this.finishRetryTimers.delete(messageId);
        if (this.leadBusy(parentId)) return;
        void this.deps.agentStorage
          .getFinishNotice(childId, messageId)
          .then((stored) => (stored ? this.retryStoredFinish(childId, stored) : undefined))
          .catch((err: unknown) =>
            this.deps.logger.warn({ err, childId }, "Finish notice retry failed"),
          );
      },
      Math.min(FINISH_RETRY_BASE_MS * 2 ** attempt, FINISH_RETRY_MAX_MS),
    );
  }

  /**
   * FU-424: an unknown outcome is checked on the lead first. When the lead has no copy, the notice goes again with the
   * same message id, and the send's final check still refuses a copy that arrived in the meantime.
   */
  private async resolveUnknownFinish(childId: string, notice: FinishNotice): Promise<void> {
    if (this.stopped || this.processingOwned.has(notice.messageId)) return;
    const { agentManager, agentStorage } = this.deps;
    const receipt = await agentManager
      .nativeFinishReceiptStatus(notice.messageId)
      .catch(() => "missing" as const);
    if (
      receipt === "delivered" ||
      agentManager.hasSubmittedFinishMessageNow(notice.parentId, notice.messageId)
    ) {
      await agentStorage.resolveUnknownFinishNotice(childId, notice.messageId, {
        status: "delivered",
        deliveredBy: receipt === "delivered" ? "native" : "report-up",
      });
      this.finishRetryAttempts.delete(notice.messageId);
      return;
    }
    const pending = await agentStorage.resolveUnknownFinishNotice(childId, notice.messageId, {
      status: "pending",
    });
    if (pending) await this.deliverOwnedFinish(childId, pending, false);
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
    this.ledgerWatcher?.close();
    clearTimeout(this.ledgerDebounce);
    this.observer.stop();
    for (const pending of this.nudging.values())
      pending.abort.abort(new Error("Idle nudge service stopped"));
    this.nudging.clear();
    this.finishRetryAttempts.clear();
    this.finishRetryTimers.clear();
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
    const { agentId } = input;
    if (input.failed) this.stopNudge(agentId);
    else this.nudgeStopped.delete(agentId);
    this.checkIdleLeads();
    void (input.failed ? Promise.resolve(false) : this.idleTurns.handle(agentId))
      .then((handled) => handled || this.handleRoutedFinish(input))
      .then((handled) => handled || this.handleOwnedFinish(input))
      .then((handled) => {
        if (!handled) this.onUnownedTurnEnd(input);
        return undefined;
      })
      .catch((err: unknown) =>
        this.deps.logger.warn({ err, agentId }, "Owned finish notice failed"),
      );
  }

  private async blockedIdleTurn(id: string, reason: string): Promise<void> {
    const worker = await this.store.get(id);
    if (!worker || worker.archivedAt) return;
    const prompt = formatSystemNotificationPrompt(`BLOCKED: ${titleOf(worker)} (${reason})`);
    if (await this.deps.remoteNotice?.(id, prompt, "failed")) return;
    const parent = await this.leadOf(worker);
    if ("skip" in parent) {
      this.deps.logger.warn(
        { agentId: id, reason, parent: parent.skip },
        "Idle turn BLOCKED: no parent route",
      );
      return;
    }
    await this.toLead(id, parent.id, prompt, "report-up");
  }

  async routingNotice(leadId: string, line: string, messageId: string): Promise<void> {
    await heldSendsFor(this.deps.agentManager, this.deps.logger).holdAndWait(leadId, () =>
      this.send(
        leadId,
        formatSystemNotificationPrompt(line),
        "owned-finish",
        undefined,
        undefined,
        messageId,
      ),
    );
  }

  private async handleRoutedFinish(input: ReportTurnEnd): Promise<boolean> {
    const routing = this.deps.routing;
    if (!routing || input.fromNotice) return false;
    const worker = await this.store.get(input.agentId);
    if (!worker) return false;
    const text =
      input.lastAssistant === undefined
        ? await this.deps.agentManager.getLastAssistantMessage(input.agentId).catch(() => null)
        : input.lastAssistant;
    const routed = await routing.observeEnd({
      worker,
      eventId: `${input.agentId}:${input.startedAt}`,
      text,
      failed: input.failed,
      fromNotice: input.fromNotice,
    });
    if (!routed) return false;
    const notice = await this.deps.agentStorage.getFinishNotice(input.agentId);
    if (
      routed.fresh &&
      routed.result &&
      notice &&
      ["delivered", "cancelled", "unknown"].includes(notice.status)
    )
      await this.deps.agentStorage.rearmFinishNotice(input.agentId, notice.parentId);
    if (notice || this.hasFinishOwner(input.agentId)) return false;
    if (routed.fresh && routed.result) {
      const lead = await this.leadOf(worker);
      if ("id" in lead && (await this.reportingLineAllows(input.agentId, lead.id)))
        await this.toLead(
          input.agentId,
          lead.id,
          formatSystemNotificationPrompt(
            `${routed.result.line}\n${formatSessionSpend(this.workerWithSpend(worker).sessionCost)}${routed.result.state === "DONE" ? await this.transferOffer(worker.id) : ""}`,
          ),
          "owned-finish",
        );
    }
    return true;
  }

  private async transferOffer(agentId: string): Promise<string> {
    try {
      const offer = await this.deps.agentManager.archiveLedgerTransferOffer(agentId);
      return offer ? `\n${offer}` : "";
    } catch (err) {
      this.deps.logger.warn({ err, agentId }, "Cannot read ledger transfer offer");
      return "";
    }
  }

  private stopNudge(agentId: string): void {
    this.nudgeStopped.set(agentId, this.readyAtStop(agentId));
    this.cancelNudge(agentId, "Receiver turn stopped or failed");
  }

  private async readyAtStop(agentId: string): Promise<ReadonlySet<string> | null> {
    try {
      const revision = this.ledgerRevision;
      const snapshot = this.ledgerSnapshot;
      const rows =
        snapshot?.revision === revision ? snapshot.rows : await this.readLedgerSnapshot();
      if (revision !== this.ledgerRevision) return null;
      const lead = await this.store.get(agentId);
      return new Set(
        lead ? this.ownedReadyRows(lead, rows).map((row) => `${row.project}:${row.id}`) : [],
      );
    } catch (err) {
      this.deps.logger.warn({ err, agentId }, "Stopped lead READY rows could not be read");
      return null;
    }
  }

  private async readLedgerSnapshot(): Promise<readonly LedgerRow[]> {
    const revision = this.ledgerRevision;
    const rows = this.deps.readLedger
      ? await this.deps.readLedger()
      : await readOpenLedgerRows(this.deps.ledgerDir ?? defaultLedgerDir(), true);
    const snapshot = structuredClone(rows);
    if (revision === this.ledgerRevision) this.ledgerSnapshot = { revision, rows: snapshot };
    return snapshot;
  }

  private async deliverStoppedFinish(agentId: string): Promise<void> {
    const notice = await this.deps.agentStorage.getFinishNotice?.(agentId);
    if (notice?.status === "pending" && notice.reason === "stopped")
      await this.deliverOwnedFinish(agentId, notice, false);
  }

  private onUnownedTurnEnd(input: ReportTurnEnd): void {
    const { agentId, failed, fromNotice, startedAt, failure, lastAssistant } = input;
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

  private async handleOwnedFinish(input: ReportTurnEnd): Promise<boolean> {
    const storage = this.deps.agentStorage;
    if (typeof storage.getFinishNotice !== "function") return false;
    let notice = await storage.getFinishNotice(input.agentId);
    if (!notice) return false;
    this.finishOwners.delete(input.agentId);
    let recorded = false;
    if (
      notice.status === "armed" &&
      input.startedAt !== undefined &&
      !input.fromNotice &&
      !input.failed &&
      (await this.finishHeld(input.agentId, input.lastAssistant, notice.parentId))
    )
      // The notice stays armed, so the turn that ends with the result still reaches the lead.
      return true;
    if (notice.status === "armed" && input.startedAt !== undefined && !input.fromNotice) {
      notice = await storage.recordFinishNotice(
        input.agentId,
        `${input.agentId}:${input.startedAt}`,
        input.failed ? "errored" : "finished",
      );
      recorded = true;
    }
    if (recorded && notice && (await this.alreadyReportedSinceArming(input, notice))) return true;
    if (notice?.status === "pending")
      await this.deliverOwnedFinish(input.agentId, notice, false, input.lastAssistant);
    return true;
  }

  /** FU-483: true (and logged) when a finished turn has no result line for the lead. */
  private async finishHeld(
    workerId: string,
    observed: string | null | undefined,
    leadId: string | null,
  ): Promise<boolean> {
    const text =
      observed === undefined
        ? await this.deps.agentManager.getLastAssistantMessage(workerId).catch(() => null)
        : observed;
    if (finishNoticeWanted(text)) return false;
    this.deps.logger.info(
      { childId: workerId, parentId: leadId },
      "Finish notice held: no result line",
    );
    return true;
  }

  /**
   * FU-519: a worker that delivered a message to this lead since the notice was armed needs no second wake for
   * the same result. A held turn does not reset that boundary. The notice is settled as delivered so no retry sends it. Errors and turns without a send are not skipped.
   */
  private async alreadyReportedSinceArming(
    input: ReportTurnEnd,
    notice: FinishNotice,
  ): Promise<boolean> {
    if (
      notice.status !== "pending" ||
      notice.reason !== "finished" ||
      input.startedAt === undefined
    )
      return false;
    const sentAt = lastAgentMessageDeliveredAt(input.agentId, notice.parentId);
    // Older saved notices have no arming time; retain their turn-based boundary.
    if (sentAt === null || sentAt < (notice.armedAt ?? input.startedAt)) return false;
    await this.deps.agentStorage.settleFinishNotice(
      input.agentId,
      notice.messageId,
      "delivered",
      "report-up",
    );
    this.deps.logger.info(
      { childId: input.agentId, parentId: notice.parentId },
      "Finish notice skipped: already reported since arming",
    );
    return true;
  }

  /** Reconcile a saved finish after native queue recovery has settled its old boot. */
  async recoverOwnedFinishes(): Promise<void> {
    await Promise.all(
      (await this.deps.agentStorage.listLoaded()).flatMap((record) =>
        storedFinishNotices(record).map(async (notice) => {
          if (notice.status === "sending") {
            await this.deps.agentStorage.markFinishNoticeUnknown(record.id, notice.messageId);
            this.deps.logger.warn(
              { childId: record.id, messageId: notice.messageId },
              "Finish notice outcome unknown after restart",
            );
          }
          if (notice.status === "sending" || notice.status === "unknown")
            await this.retryStoredFinish(record.id, { ...notice, status: "unknown" });
          if (notice.status === "pending") await this.deliverOwnedFinish(record.id, notice, true);
        }),
      ),
    );
  }

  async onAgentClosed(childId: string): Promise<void> {
    let notice = await this.deps.agentStorage.getFinishNotice(childId);
    if (notice?.status === "armed")
      notice = await this.deps.agentStorage.recordFinishNotice(
        childId,
        `closed:${childId}`,
        "closed",
      );
    if (notice?.status === "pending" && notice.reason === "closed")
      await this.deliverOwnedFinish(childId, notice, false);
  }

  private captureOwnedFinalCheck(
    childId: string,
    notice: FinishNotice,
    expectedLine: string | null,
  ): () => void {
    return () => {
      const { agentManager, agentStorage } = this.deps;
      const child = agentManager.getAgent(childId) ?? agentStorage.getCached(childId);
      const parent =
        agentManager.getAgent(notice.parentId) ?? agentStorage.getCached(notice.parentId);
      const currentParentId = finishNoticeParentId(child?.labels);
      if (!child || child.archivedAt) throw new OwnedFinishLineChanged(null, "child unavailable");
      if (currentParentId !== notice.parentId)
        throw new OwnedFinishLineChanged(currentParentId, "parent changed");
      if (!parent || parent.archivedAt || reportsTo(child) !== expectedLine)
        throw new OwnedFinishLineChanged(currentParentId, "reporting line changed");
      if (expectedLine === `${ROLE_REF_PREFIX}${MAIN_ASSISTANT_ROLE}`) {
        const agents = new Map<string, LineAgent>(
          agentStorage.listLoadedSync().map((record) => [record.id, record]),
        );
        for (const live of agentManager.listAgents()) agents.set(live.id, live);
        const holder = findRoleHolder([...agents.values()], MAIN_ASSISTANT_ROLE);
        if (!holder || !("id" in holder) || holder.id !== notice.parentId)
          throw new OwnedFinishLineChanged(currentParentId, "reporting role changed");
      }
    };
  }

  private async recoverOwnedLineChange(
    childId: string,
    notice: FinishNotice,
    error: OwnedFinishLineChanged,
    reroutes: number,
  ): Promise<FinishNotice | null> {
    let retry: FinishNotice | null = null;
    if (error.parentId && error.parentId !== notice.parentId && reroutes < 2) {
      try {
        retry = await this.deps.agentStorage.retargetFinishNotice(
          childId,
          notice.messageId,
          error.parentId,
        );
      } catch {
        retry = null;
      }
    }
    if (!retry) await this.deps.agentStorage.dropFinishNotice(childId, notice.messageId);
    this.deps.logger.info(
      { childId, oldParent: notice.parentId, newParent: error.parentId, reason: error.message },
      retry ? "Finish notice moved to current parent" : "Finish notice dropped",
    );
    return retry;
  }

  private scheduleRetargetedFinish(
    childId: string,
    retry: FinishNotice | null,
    observedLast: string | null | undefined,
    reroutes: number,
  ): void {
    if (!retry || this.stopped) return;
    queueMicrotask(() => {
      void this.deliverOwnedFinish(childId, retry, false, observedLast, reroutes + 1).catch(
        (err: unknown) =>
          this.deps.logger.warn({ err, childId }, "Retargeted finish notice failed"),
      );
    });
  }

  private async nativeOwnedFinishDelivered(
    childId: string,
    notice: FinishNotice,
    recovery: boolean,
  ): Promise<boolean> {
    if (notice.owner !== "native" || notice.reason === "closed" || notice.reason === "stopped")
      return false;
    const outcome = recovery
      ? await this.deps.agentManager.nativeFinishReceiptStatus(notice.messageId).catch((err) => {
          this.deps.logger.warn({ err, childId }, "Native finish receipt could not be read");
          return "missing" as const;
        })
      : await this.deps.agentManager.waitForNativeFinishOutcome(childId, notice.parentId);
    if (outcome !== "delivered") return false;
    await this.deps.agentStorage.settleFinishNotice(
      childId,
      notice.messageId,
      "delivered",
      "native",
    );
    return true;
  }

  private async resolveOwnedFinishFailure(input: {
    childId: string;
    notice: FinishNotice;
    error: unknown;
    sending: boolean;
    handoff?: object;
    reroutes: number;
  }): Promise<FinishNotice | null> {
    const { childId, notice, error, sending, handoff, reroutes } = input;
    if (error instanceof OwnedFinishLineChanged) {
      if (sending) await this.deps.agentStorage.markFinishNoticeRefused(childId, notice.messageId);
      return this.recoverOwnedLineChange(childId, notice, error, reroutes);
    }
    if (!sending) {
      // A steer refusal is stored as a pending retry before it is thrown.
      if (error instanceof SteerUnavailableError) this.scheduleFinishRetry(childId, notice);
      throw error;
    }
    const refusal = finalInputFailure(handoff) ?? error;
    if (!hasFinalInputHandoff(handoff) || refusal instanceof CodexAppServerRpcError) {
      await this.deps.agentStorage.markFinishNoticeRefused(childId, notice.messageId);
      this.deps.logger.warn({ err: error, childId }, "Finish notice refused; it will retry");
    } else {
      await this.deps.agentStorage.markFinishNoticeUnknown(childId, notice.messageId);
      this.deps.logger.warn(
        { err: error, childId },
        "Finish notice outcome unknown; it will be checked",
      );
    }
    this.scheduleFinishRetry(childId, notice);
    return null;
  }

  private workerWithSpend(worker: LineAgent) {
    const record =
      this.deps.agentManager.getAgent(worker.id) ?? this.deps.agentStorage.getCached(worker.id);
    return { ...worker, sessionCost: sessionCost(record?.costRecords) };
  }

  private async ownedFinishPrompt(
    worker: LineAgent,
    notice: FinishNotice,
    observedLast?: string | null,
  ): Promise<string> {
    const reportedWorker = {
      ...this.workerWithSpend(worker),
      ...(notice.sessionCost ? { sessionCost: notice.sessionCost } : {}),
    };
    const spend = formatSessionSpend(reportedWorker.sessionCost);
    if (notice.reason === "stopped")
      return formatSystemNotificationPrompt(
        `Agent ${worker.id} (${titleOf(worker)}): worker turn stopped.\n${spend}`,
      );
    if (notice.reason === "closed")
      return formatSystemNotificationPrompt(
        `Agent ${worker.id} (${titleOf(worker)}) was closed.\n${spend}`,
      );
    const record = await this.deps.agentStorage.get(worker.id);
    let lastMessage = record?.finishNoticeResults?.[notice.messageId];
    if (lastMessage === undefined) {
      lastMessage = observedLast;
      if (lastMessage === undefined)
        lastMessage = await this.deps.agentManager
          .getLastAssistantMessage(worker.id)
          .catch(() => null);
    }
    const result =
      notice.reason === "finished" && this.deps.routing?.enabledForLead(notice.parentId)
        ? parseWorkerResult(lastMessage)
        : null;
    const offer =
      parseWorkerResult(lastMessage)?.state === "DONE" ? await this.transferOffer(worker.id) : "";
    return formatSystemNotificationPrompt(
      (result
        ? `${result.line}\n${spend}`
        : formatReportUpNotice({
            worker: reportedWorker,
            failed: notice.reason === "errored",
            lastMessage,
          })) + offer,
    );
  }

  private async deliverOwnedFinish(
    childId: string,
    notice: FinishNotice,
    recovery: boolean,
    observedLast?: string | null,
    reroutes = 0,
  ): Promise<void> {
    if (this.stopped || this.processingOwned.has(notice.messageId)) return;
    this.processingOwned.add(notice.messageId);
    let retry: FinishNotice | null = null;
    let sending = false;
    let handoff: object | undefined;
    try {
      if (await this.nativeOwnedFinishDelivered(childId, notice, recovery)) return;
      if (this.stopped) return;
      const worker = await this.deps.agentStorage.get(childId);
      const parent = await this.deps.agentStorage.get(notice.parentId);
      const currentParentId = finishNoticeParentId(worker?.labels);
      if (currentParentId !== notice.parentId)
        throw new OwnedFinishLineChanged(currentParentId, "parent changed before delivery");
      if (
        !worker ||
        !parent ||
        worker.archivedAt ||
        parent.archivedAt ||
        !(await this.reportingLineAllows(childId, notice.parentId))
      )
        throw new OwnedFinishLineChanged(currentParentId, "reporting line unavailable");
      const finalCheck = this.captureOwnedFinalCheck(childId, notice, reportsTo(worker));
      const prompt = await this.ownedFinishPrompt(worker, notice, observedLast);
      const durableDefault = notice.owner === "report-up" || notice.reason === "stopped";
      const send = async () => {
        finalCheck();
        if (durableDefault) {
          await this.deps.agentStorage.markFinishNoticeSending(childId, notice.messageId);
          sending = true;
        }
        if (this.deps.deliver) {
          await this.deps.deliver(notice.parentId, prompt, notice.messageId);
        } else {
          try {
            await this.send(
              notice.parentId,
              prompt,
              "owned-finish",
              undefined,
              (handle) => {
                handoff = handle;
              },
              notice.messageId,
              finalCheck,
              durableDefault,
            );
          } catch (error) {
            if (error instanceof SteerUnavailableError && !hasFinalInputHandoff(handoff)) {
              await this.deps.agentStorage.markFinishNoticeRefused(childId, notice.messageId);
              sending = false;
            }
            throw error;
          }
        }
      };
      try {
        if (this.deps.deliver) await send();
        else
          await heldSendsFor(this.deps.agentManager, this.deps.logger).holdAndWait(
            notice.parentId,
            send,
          );
      } catch (error) {
        if (!(error instanceof OwnedFinishAlreadyDelivered)) throw error;
      }
      await this.deps.agentStorage.settleFinishNotice(
        childId,
        notice.messageId,
        "delivered",
        "report-up",
      );
      this.finishRetryAttempts.delete(notice.messageId);
    } catch (error) {
      retry = await this.resolveOwnedFinishFailure({
        childId,
        notice,
        error,
        sending,
        handoff,
        reroutes,
      });
    } finally {
      this.processingOwned.delete(notice.messageId);
      this.scheduleRetargetedFinish(childId, retry, observedLast, reroutes);
    }
  }

  /** The lead chat on this computer, or null with the reason. */
  private leadOf(worker: LineAgent): Promise<{ id: string } | { skip: string }> {
    return leadChatOf(this.store, worker, this.deps.localServerId);
  }

  /** Why a finished-turn notice is not needed, or null. A failed turn is always sent. */
  private anyEnabled(): boolean {
    return !this.stopped && (this.deps.isEnabled() || this.otherEnabled());
  }

  private nudgeSkipOwners(): readonly string[] {
    return this.deps.getNudgeSkipOwners?.() ?? [];
  }

  private nudgeEnabled(): boolean {
    return !this.stopped && (this.deps.isNudgeEnabled ? this.deps.isNudgeEnabled() : true);
  }

  private nudgeAllowed(leadId: string): boolean {
    if (this.deps.agentManager.getAgent(leadId)?.labels?.["fulcra.nudge"] === "off") return false;
    const last = this.nudgeDeliveredAt.get(leadId);
    return (
      last === undefined ||
      this.now() - last >= (this.deps.getNudgeMinIntervalMinutes?.() ?? 60) * 60_000
    );
  }

  private otherEnabled(): boolean {
    return !this.stopped && (this.deps.isOtherEnabled ? this.deps.isOtherEnabled() : true);
  }

  private async hasWorkers(leadId: string): Promise<boolean> {
    for (const chat of await this.store.list()) {
      if (chat.id === leadId || chat.archivedAt || !reportsTo(chat)) continue;
      const owner = await this.leadOf(chat);
      if ("id" in owner && owner.id === leadId) return true;
    }
    return false;
  }

  private async leadToMainQuietReason(
    workerId: string,
    lead: LineAgent,
    failed: boolean,
  ): Promise<string | null> {
    if (failed || lead.labels?.[SEAT_LABEL] !== MAIN_ASSISTANT_ROLE) return null;
    return (await this.hasWorkers(workerId))
      ? "a lead's finished turn is not sent to the main assistant"
      : null;
  }

  /** The chats on this computer that report to the lead and are idle now. */
  private async idleWorkersOf(leadId: string): Promise<LineAgent[]> {
    const workers: LineAgent[] = [];
    for (const chat of await this.store.list()) {
      if (chat.id === leadId || chat.archivedAt || !reportsTo(chat)) continue;
      if (!this.nudgeWorkerReady(chat)) continue;
      const owner = await this.leadOf(chat);
      if ("id" in owner && owner.id === leadId) workers.push(chat);
    }
    return workers;
  }

  private nudgeWorkerReady(chat: Pick<LineAgent, "id" | "labels">): boolean {
    const live = this.deps.agentManager.getAgent(chat.id);
    if (
      !live ||
      live.lifecycle !== "idle" ||
      live.archivedAt ||
      (live.backgroundWork?.count ?? 0) > 0
    )
      return false;
    const hold = live.labels?.["fulcra.hold"] ?? chat.labels?.["fulcra.hold"];
    return hold !== "paused" && hold !== "blocked" && hold !== "done";
  }

  private nudgeSuppressed(leadId: string): boolean {
    return Boolean(
      this.deps.isDispatchLead?.(leadId) ||
      this.deps.routing?.enabledForLead(leadId) ||
      !this.nudgeEnabled(),
    );
  }

  /**
   * An idle lead with READY ledger work receives a nudge when its project has no running sessions.
   * Turn-end and ledger events check it. Nothing is sent without eligible items,
   * when the lead is at a usage limit, or when eligible work has not grown since its last observation.
   */
  private async nudgeIdleLead(
    leadId: string,
    rows: readonly LedgerRow[],
    ledgerRevision: number,
  ): Promise<void> {
    if (this.nudgeSuppressed(leadId)) {
      this.cancelNudge(leadId, "Idle nudge was turned off");
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
    if (this.observer.isOpen(leadId) || this.limitOf(leadId)) return;
    const lead = await this.store.get(leadId);
    const live = this.deps.agentManager.getAgent(leadId);
    if (!lead || lead.archivedAt || live?.internal) return;
    if (lead.labels?.["fulcra.nudge"] === "off") {
      this.cancelNudge(leadId, "Idle nudge receiver opted out");
      return;
    }
    const last = await this.deps.agentManager.getLastAssistantMessage(leadId).catch(() => null);
    const stop = classifyEndingAssistantMessage(last, this.now());
    if (stop && stop.kind !== "network") return;
    const workers = await this.idleWorkersOf(leadId);
    const owned = this.ownedReadyRows(lead, rows);
    if (!(await this.rearmStoppedNudge(leadId, owned, ledgerRevision))) return;
    if (ledgerRevision !== this.ledgerRevision) return;
    const state = this.observeNudge(leadId, workers, owned);
    const fingerprint = state.fingerprint;
    if (!owned.length) {
      state.needsDelivery = false;
      state.deferred = false;
      this.cancelNudge(leadId, "Idle nudge has no owned READY items");
      return;
    }
    if (!this.projectIdle(leadId, state.projects)) {
      this.cancelNudge(leadId, "Project work is running");
      return;
    }
    if (this.observer.isOpen(leadId)) return;
    if (!this.prepareNudgeGeneration(leadId, fingerprint)) return;
    if (!state.needsDelivery) return;
    if (!this.nudgeAllowed(leadId)) {
      state.deferred = true;
      return;
    }
    await this.deliverNudge(
      leadId,
      fingerprint,
      formatSystemNotificationPrompt(formatNudge(workers, owned)),
    );
  }

  private async rearmStoppedNudge(
    leadId: string,
    owned: readonly LedgerRow[],
    ledgerRevision: number,
  ): Promise<boolean> {
    const stopped = this.nudgeStopped.get(leadId);
    if (stopped) {
      const baseline = await stopped;
      if (this.nudgeStopped.get(leadId) !== stopped) return false;
      if (ledgerRevision !== this.ledgerRevision) return false;
      if (!baseline) {
        this.nudgeStopped.set(
          leadId,
          Promise.resolve(new Set(owned.map((row) => `${row.project}:${row.id}`))),
        );
        return false;
      }
      if (!owned.some((row) => !baseline.has(`${row.project}:${row.id}`))) return false;
      this.nudgeStopped.delete(leadId);
    }
    return true;
  }

  private ownedReadyRows(lead: LineAgent, rows: readonly LedgerRow[]): LedgerRow[] {
    return rowsEligibleForNudge({
      rows,
      chat: {
        id: lead.id,
        title: titleOf(lead),
        labels:
          isArchiveLead({ labels: lead.labels ?? {} }) ||
          lead.labels?.["fulcra.role"] === "project-lead"
            ? lead.labels
            : undefined,
      },
      skipOwners: this.nudgeSkipOwners(),
    });
  }

  /** Turn-end and ledger events share the existing per-lead fingerprint and delivery lane. */
  private checkIdleLeads(): void {
    if (!this.nudgeEnabled()) return;
    const ledgerRevision = this.ledgerRevision;
    void this.store
      .list()
      .then(async (chats) => {
        const rows = await this.readLedgerSnapshot();
        const parents = new Set(
          (
            await Promise.all(
              chats
                .filter((chat) => !chat.archivedAt && reportsTo(chat))
                .map((chat) => this.leadOf(chat)),
            )
          ).flatMap((lead) => ("id" in lead ? [lead.id] : [])),
        );
        return Promise.all(
          chats.map(async (chat) => {
            if (this.stopped || chat.archivedAt) return;
            if (
              reportsTo(chat) &&
              !isArchiveLead({ labels: chat.labels ?? {} }) &&
              chat.labels?.["fulcra.role"] !== "project-lead" &&
              !parents.has(chat.id)
            )
              return;
            await this.nudgeIdleLead(chat.id, rows, ledgerRevision);
          }),
        );
      })
      .catch((err: unknown) => this.deps.logger.warn({ err }, "Idle-lead nudge failed"));
  }

  private projectIdle(leadId: string, projects: readonly string[], admittingLead = false): boolean {
    const agents = this.deps.agentManager.listAgents();
    const lead = this.deps.agentManager.getAgent(leadId);
    if (!lead || lead.archivedAt || lead.internal) return false;
    if (lead.lifecycle !== "idle" && (!admittingLead || lead.lifecycle !== "running")) return false;
    const names = new Set(
      [...projects, lead.labels?.["fulcra.project"], lead.labels?.project].filter(Boolean),
    );
    for (const agent of agents) {
      if (admittingLead && agent.id === leadId) continue;
      if (!this.nudgeSessionBusy(agent.id)) continue;
      if (
        agent.id === leadId ||
        [agent.labels?.["fulcra.project"], agent.labels?.project].some(
          (name) => name && names.has(name),
        )
      )
        return false;
      if (this.reportsThrough(agent, leadId, agents)) return false;
    }
    return true;
  }

  private nudgeSessionBusy(id: string): boolean {
    const live = this.deps.agentManager.getAgent(id);
    return (
      live?.lifecycle === "running" ||
      this.observer.isOpen(id) ||
      this.deps.agentManager.hasInFlightRun(id) ||
      (live?.backgroundWork?.count ?? 0) > 0
    );
  }

  private reportsThrough(agent: LineAgent, leadId: string, agents: readonly LineAgent[]): boolean {
    const byId = new Map(agents.map((entry) => [entry.id, entry]));
    let current: LineAgent | undefined = agent;
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      const ref = reportsTo(current);
      if (!ref) break;
      const leadSeat = byId.get(leadId)?.labels?.[SEAT_LABEL];
      if (leadSeat && ref === `${ROLE_REF_PREFIX}${leadSeat}`) return true;
      const holder = ref.startsWith(ROLE_REF_PREFIX)
        ? findRoleHolder(agents, ref.slice(ROLE_REF_PREFIX.length))
        : null;
      const [id, server] = (holder && "id" in holder ? holder.id : ref).split("@", 2);
      if (server && server !== this.deps.localServerId) break;
      if (id === leadId) return true;
      current = id ? byId.get(id) : undefined;
    }
    return false;
  }

  private prepareNudgeGeneration(leadId: string, fingerprint: string): boolean {
    const pending = this.nudging.get(leadId);
    if (!pending) return true;
    if (hasFinalInputHandoff(pending.handoff)) this.recordPendingNudge(leadId, pending);
    const withinDeadline = this.now() - pending.startedAt < NUDGE_DELIVERY_TIMEOUT_MS;
    if (pending.fingerprint === fingerprint && withinDeadline && !pending.abort.signal.aborted)
      return false;
    if (!withinDeadline) this.expireNudge(leadId, pending);
    else pending.abort.abort(new Error("Idle nudge state changed or expired"));
    return true;
  }

  private recordPendingNudge(leadId: string, pending: PendingNudge): void {
    if (pending.deliveryRecorded) return;
    pending.deliveryRecorded = true;
    this.recordNudgeDelivery(leadId, pending.fingerprint);
  }

  private observeNudge(
    leadId: string,
    workers: readonly LineAgent[],
    items: readonly LedgerRow[],
  ): NudgeState {
    const workerIds = workers.map((worker) => worker.id).sort();
    const itemIds = items.map((item) => `${item.project}:${item.id}`).sort();
    const itemOwners = items.map((item) => item.owner);
    const fingerprint = JSON.stringify([workerIds, itemIds]);
    const previous = this.nudgeStates.get(leadId);
    const previousWorkers = new Set(previous?.workerIds ?? []);
    const previousItems = new Set(previous?.itemIds ?? []);
    const gained =
      workerIds.some((id) => !previousWorkers.has(id)) ||
      itemIds.some((id) => !previousItems.has(id));
    const retry = previous?.fingerprint === fingerprint && previous.needsDelivery;
    const state = {
      workerIds,
      itemIds,
      itemOwners,
      projects: [...new Set(items.map((item) => item.project))],
      fingerprint,
      needsDelivery: gained || retry || Boolean(previous?.deferred),
      deferred: previous?.deferred,
    };
    this.nudgeStates.set(leadId, state);
    return state;
  }

  private recordNudgeDelivery(leadId: string, fingerprint: string): void {
    const state = this.nudgeStates.get(leadId);
    if (state?.fingerprint === fingerprint) {
      state.needsDelivery = false;
      state.deferred = false;
    }
    this.nudgeDeliveredAt.set(leadId, this.now());
    this.save();
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
      this.recordPendingNudge(leadId, pending);
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
    const state = this.nudgeStates.get(leadId);
    const current = () =>
      this.nudging.get(leadId)?.generation === pending.generation &&
      this.nudgeStates.get(leadId)?.fingerprint === fingerprint &&
      !pending.abort.signal.aborted &&
      !this.nudgeStopped.has(leadId) &&
      this.nudgeAllowed(leadId) &&
      this.now() - pending.startedAt < NUDGE_DELIVERY_TIMEOUT_MS &&
      // The manager registers this nudge as running before its final provider check.
      // Idle-only admission protects the receiver; project peers must remain idle.
      this.projectIdle(leadId, state?.projects ?? [], Boolean(pending.handoff)) &&
      (state?.workerIds.every((id) => this.nudgeWorkerReady({ id })) ?? false) &&
      (state?.itemOwners.every((owner) => !isNudgeOwnerSkipped(owner, this.nudgeSkipOwners())) ??
        false);
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
      if (current()) this.recordPendingNudge(leadId, pending);
    };
    // Cancellation also settles the held callback, so a stalled dispatch cannot block the queue.
    const deliver = () => Promise.race([dispatch(), canceled]);
    try {
      const delivery = this.deps.deliver
        ? deliver()
        : heldSendsFor(this.deps.agentManager, this.deps.logger).holdAndWait(leadId, deliver);
      await Promise.race([delivery, canceled]);
    } finally {
      if (hasFinalInputHandoff(pending.handoff)) this.recordPendingNudge(leadId, pending);
      clearTimeout(timer);
      this.timers.delete(timer);
      pending.abort.signal.removeEventListener("abort", cancel);
      if (this.nudging.get(leadId)?.generation === pending.generation) this.nudging.delete(leadId);
    }
  }

  private async onPermissionRequest(workerId: string, request: PermissionRequest): Promise<void> {
    const current = () => this.permissionCurrent(workerId, request);
    if (!current() || (await this.redirectWorkerQuestion(workerId, request, current))) return;
    await this.notifyPermission(workerId, request);
  }

  /** Tells the lead once that a chat is waiting for permission. Nothing is allowed or denied here. */
  private async notifyPermission(workerId: string, request: PermissionRequest): Promise<void> {
    const current = () => this.permissionCurrent(workerId, request);
    if (!current()) return;
    const owned = await this.deps.agentStorage.getFinishNotice?.(workerId);
    if (!owned && !this.otherEnabled()) return;
    const live = this.deps.agentManager.getAgent(workerId);
    const worker = await this.store.get(workerId);
    if (!worker || worker.archivedAt || live?.internal) return;
    const prompt = formatSystemNotificationPrompt(
      formatPermissionNotice({
        worker,
        request,
        cwd: live?.cwd ?? null,
      }),
    );
    if (!current()) return;
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
    await this.toLead(
      workerId,
      lead.id,
      prompt,
      owned ? "owned-permission" : "permission",
      current,
      {
        workerId,
        requestId: request.id,
      },
    );
  }

  /**
   * FU-373: a worker's request_user_input_async stays open until a person answers, and an open question refuses every
   * new turn. No person watches a worker, so the lead gets the question text and the worker gets a dismissal that
   * tells it to continue or report DECISION/BLOCKED.
   */
  private async redirectWorkerQuestion(
    workerId: string,
    request: PermissionRequest,
    current: () => boolean,
  ): Promise<boolean> {
    if (request.name !== ASYNC_QUESTION_TOOL) return false;
    const live = this.deps.agentManager.getAgent(workerId);
    const worker = await this.store.get(workerId);
    if (!worker || worker.archivedAt || live?.internal || !looksLikeWorker(worker)) return false;
    if (await this.hasWorkers(workerId)) return false;
    if (!current()) return true;
    let copied = false;
    try {
      copied = await this.copyWorkerQuestion(worker, request, live?.cwd ?? null);
    } catch (err) {
      this.deps.logger.warn({ err, agentId: workerId }, "Worker question notice failed");
    }
    if (current())
      await respondToAgentPermission({
        agentManager: this.deps.agentManager,
        agentId: workerId,
        requestId: request.id,
        response: {
          behavior: "deny",
          message: "Dismissed: no person watches a worker chat",
          agentNotice: formatWorkerQuestionRefusal({ copied }),
        },
        logger: this.deps.logger,
      });
    return true;
  }

  /** True only when the question went to the lead's remote host or into the lead's notice queue. */
  private async copyWorkerQuestion(
    worker: LineAgent,
    request: PermissionRequest,
    cwd: string | null,
  ): Promise<boolean> {
    const prompt = formatSystemNotificationPrompt(
      formatWorkerQuestionNotice({ worker, request, cwd }),
    );
    if (await this.deps.remoteNotice?.(worker.id, prompt, "permission")) return true;
    const lead = await this.leadOf(worker);
    if ("skip" in lead) return false;
    const leadAgent = await this.store.get(lead.id);
    if (!leadAgent || leadAgent.archivedAt) return false;
    if (!(await this.reportingLineAllows(worker.id, lead.id))) return false;
    return this.toLead(worker.id, lead.id, prompt, "permission");
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
    current: () => boolean = () => true,
    permission?: HeldReport["permission"],
  ): Promise<boolean> {
    if (!this.noticeEnabled(kind) || !current()) return false;
    const leadLimit = this.limitOf(leadId);
    if (leadLimit) {
      const held = this.held.get(leadId) ?? [];
      held.push({ prompt, kind, ...(permission ? { permission } : {}) });
      if (held.length > MAX_HELD_REPORTS) held.shift();
      this.held.set(leadId, held);
      this.save();
      this.deps.logger.info(
        { agentId: workerId, lead: leadId, until: leadLimit.until },
        "Report-up held: the lead is at a usage limit",
      );
      const delay = Math.max(0, leadLimit.until - this.now()) + 1000;
      this.schedule(() => this.releaseHeld(leadId), delay);
      return true;
    }
    if (this.deps.deliver) {
      await this.deps.deliver(leadId, prompt);
      return true;
    }
    // Held until the lead's turn ends, one queue per lead, in order (held-sends.ts).
    heldSendsFor(this.deps.agentManager, this.deps.logger).hold(leadId, async () => {
      if (!this.noticeEnabled(kind) || !current()) return;
      await this.send(leadId, prompt, kind, current);
      this.deps.logger.info({ agentId: workerId, lead: leadId, kind }, "Report-up delivered");
    });
    return true;
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

  private permissionCurrent(workerId: string, request: PermissionRequest): boolean {
    return (
      this.observer.hasPermission(workerId, request) && this.permissionPending(workerId, request.id)
    );
  }

  private permissionPending(workerId: string, requestId: string): boolean {
    const worker = this.deps.agentManager.getAgent(workerId);
    if (!worker || worker.archivedAt || worker.internal) return false;
    try {
      return this.deps.agentManager
        .getPendingPermissions(workerId)
        .some((request) => request.id === requestId);
    } catch {
      return false;
    }
  }

  private heldNoticeCurrent(report: HeldReport): boolean {
    return (
      this.noticeEnabled(report.kind) &&
      (!report.permission ||
        this.permissionPending(report.permission.workerId, report.permission.requestId))
    );
  }

  private async deliverHeld(leadId: string, held: readonly HeldReport[]): Promise<void> {
    const enabled = held.filter((report) => this.heldNoticeCurrent(report));
    if (!enabled.length) return;
    if (this.limitOf(leadId)) {
      for (const report of enabled)
        await this.toLead(
          leadId,
          leadId,
          report.prompt,
          report.kind,
          () => this.heldNoticeCurrent(report),
          report.permission,
        );
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
        await this.send(leadId, notice, kind, undefined, undefined, undefined, () => {
          if (!enabled.every((report) => this.heldNoticeCurrent(report)))
            throw new ReportUpDisabledError();
        });
      } catch (err) {
        // The final check refused input. Retry only the notices that remain enabled, with no provider input repeated.
        const remaining = enabled.filter((report) => this.heldNoticeCurrent(report));
        if (err instanceof ReportUpDisabledError && remaining.length < enabled.length) {
          await this.deliverHeld(leadId, remaining);
          return;
        }
        throw err;
      }
      this.deps.logger.info({ lead: leadId }, "Report-up delivered");
    }
  }

  // "turned off" is logged once per agent, not at every turn end.
  private logSkip(workerId: string, reason: string): void {
    if (reason === "turned off") {
      if (this.skippedTurnedOff.has(workerId)) return;
      this.skippedTurnedOff.add(workerId);
    }
    this.deps.logger.info({ agentId: workerId, reason }, "Report-up skipped");
  }

  private async report(
    workerId: string,
    failed: boolean,
    failure = "",
    startedAt?: number,
    observedLast?: string | null,
  ): Promise<void> {
    const skip = (reason: string) => this.logSkip(workerId, reason);
    if (!this.anyEnabled()) return skip("turned off");
    this.skippedTurnedOff.delete(workerId);
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
    if (!this.deps.isEnabled())
      return skip(await this.unreported({ worker, failed, observedLast, startedAt }, "turned off"));
    if (await this.remoteFinished(worker, failed, observedLast)) return;
    const lead = await this.leadOf(worker);
    if ("skip" in lead)
      return skip(await this.unreported({ worker, failed, observedLast, startedAt }, lead.skip));
    const leadAgent = await this.store.get(lead.id);
    if (!leadAgent || leadAgent.archivedAt) return skip("lead not here or archived");
    if (!(await this.reportingLineAllows(workerId, lead.id))) return;
    const quiet = await this.leadToMainQuietReason(workerId, leadAgent, failed);
    if (quiet) return skip(quiet);
    const lastMessage =
      observedLast === undefined
        ? await this.deps.agentManager.getLastAssistantMessage(workerId).catch(() => null)
        : observedLast;
    // A failed turn is sent at once. A finished turn is combined with the lead's other finished workers (FU-115).
    if (failed) {
      const prompt = formatSystemNotificationPrompt(
        formatReportUpNotice({ worker: this.workerWithSpend(worker), failed, lastMessage }),
      );
      await this.toLead(workerId, lead.id, prompt, "finished-turn");
      return;
    }
    if (await this.finishHeld(workerId, lastMessage, lead.id)) return;
    await this.queueFinished(lead.id, {
      workerId,
      worker: this.workerWithSpend(worker),
      lastMessage,
      eventId: startedAt === undefined ? undefined : `${workerId}:${startedAt}`,
    });
  }

  /**
   * FU-402: a worker's DONE, BLOCKED or DECISION line, or a question, in its final text must not stay unseen. With the
   * "finished a turn" notices off and no finish notice armed, it goes once to a lead on this computer. A lead on another
   * computer cannot get it from here, so the worker is told once to send it through a route that reaches that computer.
   * Either notice starts no further notice: the answer turn was started by a notice.
   */
  private async unreported(turn: UnseenTurn, reason: string): Promise<string> {
    if (!turn.failed && (reason === "turned off" || reason === LEAD_ON_ANOTHER_COMPUTER))
      await this.relayUnseenResult(turn);
    return reason;
  }

  private async relayUnseenResult({ worker, observedLast, startedAt }: UnseenTurn): Promise<void> {
    if (!looksLikeWorker(worker) || (await this.hasWorkers(worker.id))) return;
    const lastMessage =
      observedLast === undefined
        ? await this.deps.agentManager.getLastAssistantMessage(worker.id).catch(() => null)
        : observedLast;
    if (!lastMessage || !finishNoticeWanted(lastMessage)) return;
    // The worker already messaged its lead during this turn, so its result is not unseen.
    if (sentToLeadDuring(worker, startedAt, this.deps.localServerId)) return;
    const lead = await this.leadOf(worker);
    if ("id" in lead) {
      const leadAgent = await this.store.get(lead.id);
      if (!leadAgent || leadAgent.archivedAt) return;
      if (!(await this.reportingLineAllows(worker.id, lead.id))) return;
      const prompt = formatSystemNotificationPrompt(
        formatReportUpNotice({ worker: this.workerWithSpend(worker), failed: false, lastMessage }),
      );
      await this.toLead(worker.id, lead.id, prompt, "report-up");
      return;
    }
    if (lead.skip !== LEAD_ON_ANOTHER_COMPUTER) return;
    const line = reportsTo(worker)!;
    this.deps.logger.warn(
      { agentId: worker.id, lead: line },
      "Worker result has no route to its lead on another computer",
    );
    await this.toLead(
      worker.id,
      worker.id,
      formatSystemNotificationPrompt(
        `Your lead ${line} is on another computer. Fulcra did not deliver your last message to it. ` +
          "Send your DONE, BLOCKED or DECISION line to that lead now, through a route that reaches that computer " +
          "(the notify command on Windows, or fulcra send over SSH).",
      ),
      "report-up",
    );
  }

  private async remoteFinished(
    worker: LineAgent,
    failed: boolean,
    observedLast?: string | null,
  ): Promise<boolean> {
    const line = reportsTo(worker);
    if (line !== "role:main-assistant" || !this.deps.remoteNotice) return false;
    const lastMessage =
      observedLast === undefined
        ? await this.deps.agentManager.getLastAssistantMessage(worker.id).catch(() => null)
        : observedLast;
    // FU-454: a lead on another computer that reports to the main assistant gets the same FU-439 filter.
    if (!failed && (await this.finishHeld(worker.id, lastMessage, line))) return true;
    const prompt = formatSystemNotificationPrompt(
      formatReportUpNotice({ worker: this.workerWithSpend(worker), failed, lastMessage }) +
        (!failed && parseWorkerResult(lastMessage)?.state === "DONE"
          ? await this.transferOffer(worker.id)
          : ""),
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
        formatReportUpNotice({
          worker: item.worker,
          failed: false,
          lastMessage: item.lastMessage,
        }) +
          (parseWorkerResult(item.lastMessage)?.state === "DONE"
            ? await this.transferOffer(item.workerId)
            : ""),
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
    const offers = await Promise.all(
      items
        .filter((item) => parseWorkerResult(item.lastMessage)?.state === "DONE")
        .map((item) => this.transferOffer(item.workerId)),
    );
    const prompt = formatSystemNotificationPrompt(formatCombinedNotice(items) + offers.join(""));
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
    if (this.stopped) return false;
    if (kind === "owned-finish" || kind === "owned-permission") return true;
    if (kind === "idle-nudge") return this.nudgeEnabled();
    if (kind === "finished-turn") return this.deps.isEnabled();
    return this.otherEnabled();
  }

  private watchOwnedProviderStart(parentId: string): { promise: Promise<void>; stop: () => void } {
    let stop = () => {};
    const promise = new Promise<void>((resolve, reject) => {
      stop = this.deps.agentManager.subscribe(
        (event) => {
          if (event.type !== "agent_stream" || event.agentId !== parentId) return;
          if (event.event.type === "turn_started") resolve();
          if (event.event.type === "turn_failed" || event.event.type === "turn_canceled")
            reject(new Error("Finish notice provider refused the turn"));
        },
        { agentId: parentId, replayState: false },
      );
    });
    void promise.catch(() => {});
    return { promise, stop: () => stop() };
  }

  private send(
    leadId: string,
    prompt: string,
    kind: NoticeKind,
    currentNotice?: () => boolean,
    captureHandoff?: (handle: object) => void,
    ownedMessageId?: string,
    ownedFinalCheck?: () => void,
    waitForProviderStart = false,
  ): Promise<void> {
    const dispatch = (to: string) =>
      this.dispatchTo(
        to,
        prompt,
        kind,
        currentNotice,
        captureHandoff,
        ownedMessageId,
        ownedFinalCheck,
        waitForProviderStart,
      );
    if (!this.deps.leadMoves?.().length) return dispatch(leadId);
    // A relayed notice passes the same checks first: it cannot be taken back once the other computer has it.
    return (async () => {
      if (!this.noticeEnabled(kind)) throw new ReportUpDisabledError();
      ownedFinalCheck?.();
      if (currentNotice && !currentNotice()) throw new Error("Notice is no longer current");
      const to = await this.routeMovedLead(leadId, prompt);
      if (to) await dispatch(to);
    })();
  }

  /**
   * FU-444: where a notice for `leadId` goes when that lead moved (lead-moves.ts). Returns the chat to send to here, or
   * null when the notice went to another computer through its relay command.
   */
  private async routeMovedLead(leadId: string, prompt: string): Promise<string | null> {
    const moved = this.deps.leadMoves
      ? leadMoveTarget(this.deps.leadMoves(), leadId, this.deps.localServerId)
      : null;
    if (!moved) return leadId;
    if (moved.kind === "local") {
      this.deps.logger.info(
        { lead: leadId, to: moved.id },
        "Lead moved: notice sent to the new lead",
      );
      return moved.id;
    }
    await relayLeadNotice(moved, prompt, this.deps.relay);
    this.deps.logger.info({ lead: leadId, to: moved.id }, "Lead moved: notice relayed");
    return null;
  }

  private dispatchTo(
    leadId: string,
    prompt: string,
    kind: NoticeKind,
    currentNotice?: () => boolean,
    captureHandoff?: (handle: object) => void,
    ownedMessageId?: string,
    ownedFinalCheck?: () => void,
    waitForProviderStart = false,
  ): Promise<void> {
    const { agentManager, agentStorage, logger } = this.deps;
    const checkCurrent = () => {
      if (!this.noticeEnabled(kind)) throw new ReportUpDisabledError();
      ownedFinalCheck?.();
      if (ownedMessageId && agentManager.hasSubmittedFinishMessageNow(leadId, ownedMessageId))
        throw new OwnedFinishAlreadyDelivered();
      if (currentNotice && !currentNotice()) throw new Error("Notice is no longer current");
    };
    const causes = {
      "idle-nudge": "nudge",
      permission: "permission",
      "owned-permission": "permission",
      limit: "limit",
      "finished-turn": "finished_turn",
      "owned-finish": "finished_turn",
      "report-up": "queued_delivery",
    } as const;
    const cause = causes[kind];
    const dispatch = async () => {
      const finalCheck = createFinalInputCheck(checkCurrent);
      captureHandoff?.(finalCheck);
      const result = await sendPromptToAgent({
        agentManager,
        agentStorage,
        agentId: leadId,
        prompt,
        messageId:
          ownedMessageId ??
          (kind === "idle-nudge"
            ? `${NUDGE_MESSAGE_PREFIX}${randomUUID()}`
            : `${FINISH_NOTIFICATION_MESSAGE_PREFIX}report-up:${randomUUID()}`),
        runOptions: { [FINAL_INPUT_CHECK]: finalCheck },
        ...(kind === "idle-nudge"
          ? { queuedOnly: true }
          : { activeTurnBehavior: "steer" as const, steerOnly: true }),
        unarchive: false,
        logger,
      });
      await waitForFinalInputHandoff(finalCheck);
      return result.disposition;
    };
    if (!waitForProviderStart)
      return withLeadEvent(cause, () =>
        agentManager.trustedPlugins.daemon(async () => {
          await dispatch();
        }),
      );
    return withLeadEvent(cause, async () => {
      const start = this.watchOwnedProviderStart(leadId);
      try {
        const disposition = await agentManager.trustedPlugins.daemon(dispatch);
        if (disposition === "turn_started") await start.promise;
      } finally {
        start.stop();
      }
    });
  }
}

export function startReportUp(input: {
  createAgent?: BoundCreateAgentCommand;
  ensureRoutingWorkspace?: (cwd: string) => Promise<string>;
  remoteNotice?: ReportUpDeps["remoteNotice"];
  hooks?: PolicyHooks;
  paseoHome?: string;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  daemonConfigStore: DaemonConfigStore;
  localServerId: string | null;
  logger: Logger;
}): (() => void) & { recover: () => Promise<void> } {
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
  let routing: LedgerRoutingService | undefined;
  if (input.paseoHome && input.createAgent && input.ensureRoutingWorkspace) {
    // A corrupt journal must disable automatic routing, not erase its claims.
    try {
      routing = new LedgerRoutingService({
        statePath: path.join(input.paseoHome, "ledger-routing.json"),
        ledgerDir: defaultLedgerDir(),
        hostId: input.localServerId ?? "",
        daemonHome: input.paseoHome,
        enabled: () => input.daemonConfigStore.get().ledgerDispatchEnabled === true,
        prepareLedger: () => service.prepareLedgerObservation(),
        observesProject: (project) => service.observesProject(project),
        notify: (lead, line, messageId) => service.routingNotice(lead, line, messageId),
        config: () => input.daemonConfigStore.get().projectDispatch ?? {},
        agentManager: input.agentManager,
        agentStorage: input.agentStorage,
        createAgent: input.createAgent,
        ensureWorkspace: input.ensureRoutingWorkspace,
        logger: input.logger,
      });
    } catch (err) {
      input.logger.error({ err }, "Ledger routing disabled: journal unavailable");
    }
  }
  const offRoutingConfig = input.daemonConfigStore.onChange(() => {
    void routing
      ?.changed()
      .catch((err: unknown) => input.logger.warn({ err }, "Ledger routing config event failed"));
  });
  const service: ReportUpService = new ReportUpService({
    routing,
    isDispatchLead: (id) =>
      input.daemonConfigStore.get().ledgerDispatchEnabled === true &&
      Object.values(input.daemonConfigStore.get().projectDispatch ?? {}).some(
        (config) => config.enabled && config.leadId === id,
      ),
    remoteNotice: input.remoteNotice,
    ...(input.paseoHome
      ? {
          leadMoves: () =>
            readLeadMoves(input.paseoHome!, (err) =>
              input.logger.warn({ err }, "lead-moves.json not read"),
            ),
        }
      : {}),
    ledgerDir: defaultLedgerDir(),
    agentManager: input.agentManager,
    agentStorage: input.agentStorage,
    isEnabled: () =>
      reportUpSwitches(input.daemonConfigStore.get().reportUpOnTurnEnd).finishedTurns,
    isOtherEnabled: () =>
      reportUpSwitches(input.daemonConfigStore.get().reportUpOnTurnEnd).otherNotices,
    isNudgeEnabled: () =>
      reportUpSwitches(undefined, input.daemonConfigStore.get().idleLeadNudge).idleNudges,
    getNudgeSkipOwners: () => input.daemonConfigStore.get().idleLeadNudgeSkipOwners ?? [],
    getNudgeMinIntervalMinutes: () =>
      input.daemonConfigStore.get().idleLeadNudgeMinIntervalMinutes ?? 60,
    localServerId: input.localServerId,
    logger: input.logger,
    ...(input.paseoHome ? { statePath: path.join(input.paseoHome, "report-up-limits.json") } : {}),
  });
  const offArchive = registerArchiveReportCount(input.agentManager, (id) =>
    service.pendingForArchive(id),
  );
  const offHooks = input.hooks ? service.observeNative(input.hooks) : undefined;
  const offStream = input.agentManager.subscribe(
    (event) => {
      if (event.type === "agent_state" && event.agent.lifecycle === "closed")
        void service
          .onAgentClosed(event.agent.id)
          .catch((err: unknown) =>
            input.logger.warn({ err, agentId: event.agent.id }, "Close notice failed"),
          );
      reconcileRoutingArchive(event, routing, input.logger);
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
      if (input.hooks && event.type === "agent_state" && event.agent.lifecycle === "idle") {
        service.onEvent(event);
        return;
      }
      if (
        input.hooks &&
        (event.type !== "agent_stream" || !["timeline", "turn_canceled"].includes(event.event.type))
      )
        return;
      service.onEvent(event);
    },
    { replayState: false },
  );
  const stop = () => {
    offRoutingConfig();
    void routing?.stop();
    offArchive();
    offHooks?.();
    offEvents?.();
    offStream();
    service.stop();
  };
  return Object.assign(stop, {
    recover: async () => {
      await routing?.changed();
      await service.recoverOwnedFinishes();
    },
  });
}

function reconcileRoutingArchive(
  event: AgentManagerEvent,
  routing: LedgerRoutingService | undefined,
  logger: Logger,
): void {
  if (event.type !== "agent_state") return;
  if (!event.agent.archivedAt && event.agent.labels?.["fulcra.dispatch-state"] !== "abandoned")
    return;
  void routing
    ?.wake()
    .catch((err: unknown) => logger.warn({ err }, "Ledger archive reconciliation failed"));
}
