import { createFinalInputCheck, waitForFinalInputHandoff } from "./final-input-check.js";
import { randomUUID } from "node:crypto";
import { deferredPromptPayload as promptPayload } from "./trusted-operation.js";
import { TRUSTED_OPERATION, FINAL_INPUT_CHECK } from "./agent-sdk-types.js";
import type { TrustedOperationHandle } from "../plugins/trusted.js";
import type { Logger } from "pino";

import type {
  AgentPermissionRequest,
  AgentPromptInput,
  AgentRunOptions,
} from "./agent-sdk-types.js";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import { heldSendsFor } from "../held-sends.js";
import { isStaleProviderSessionError } from "./stale-provider-session-error.js";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import type { ActiveTurnBehavior } from "@getpaseo/protocol/messages";

export type AgentUnarchiveController = Pick<AgentManager, "notifyAgentState" | "unarchiveSnapshot">;

// Refusal-only legacy notice checks; never wire flags or authority substitutes.
const finishDispatchChecks = new WeakMap<object, () => void>();

export type AgentRunController = Pick<
  AgentManager,
  | "withInput"
  | "trustedPlugins"
  | "getAgent"
  | "tryRunOutOfBand"
  | "hasInFlightRun"
  | "replaceAgentRun"
  | "steerOrReplaceActiveTurn"
  | "streamAgent"
> & {
  reloadAgentSession(...args: Parameters<AgentManager["reloadAgentSession"]>): Promise<unknown>;
};

export interface StartAgentRunOptions {
  replaceRunning?: boolean;
  activeTurnBehavior?: ActiveTurnBehavior;
  runOptions?: AgentRunOptions;
  /** Ask the provider to deny permissions blocking this steer. */
  clearPendingPermissions?: boolean;
  /** FULCRA(orchestration): steer into a running turn or throw SteerUnavailableError; never replace it. */
  steerOnly?: boolean;
}

/** FULCRA(orchestration): a steer-only prompt found a running turn it could not steer into. Hold it and retry. */
export class SteerUnavailableError extends Error {
  readonly code = "STEER_UNAVAILABLE";
  constructor(readonly agentId: string) {
    super(`Agent ${agentId} is busy and cannot take this message into its running turn`);
    this.name = "SteerUnavailableError";
  }
}

export type PromptDispatchDisposition = "out_of_band" | "steered" | "turn_started";

async function steerOrReplaceActiveRun(
  agentManager: AgentRunController,
  agentId: string,
  prompt: AgentPromptInput,
  options: StartAgentRunOptions | undefined,
): Promise<
  | { disposition: "steered" }
  | {
      disposition: "turn_started";
      iterator: AsyncGenerator<import("./agent-sdk-types.js").AgentStreamEvent>;
    }
  | null
> {
  if (options?.activeTurnBehavior !== "steer") {
    return null;
  }
  const steerOptions = {
    ...options.runOptions,
    ...(options.clearPendingPermissions ? { clearPendingPermissions: true } : {}),
    ...(options.steerOnly ? { steerOnly: true } : {}),
  };
  const result = await agentManager.steerOrReplaceActiveTurn(agentId, prompt, steerOptions);
  if (result.status === "steered") {
    return { disposition: "steered" };
  }
  if (result.status === "replaced") {
    return { disposition: "turn_started", iterator: result.iterator };
  }
  // A turn still in flight without a steerable foreground turn would be replaced below.
  if (
    options.steerOnly &&
    (result.status === "unavailable" || agentManager.hasInFlightRun(agentId))
  )
    throw new SteerUnavailableError(agentId);
  return null;
}

async function startOrReplaceRun(
  agentManager: AgentRunController,
  agentId: string,
  prompt: AgentPromptInput,
  options: StartAgentRunOptions | undefined,
): Promise<{
  iterator: AsyncGenerator<import("./agent-sdk-types.js").AgentStreamEvent>;
  replaced: boolean;
}> {
  const runOptions = options?.clearPendingPermissions
    ? { ...options.runOptions, clearPendingQuestions: true }
    : options?.runOptions;
  const replaced = Boolean(options?.replaceRunning && agentManager.hasInFlightRun(agentId));
  const iterator = replaced
    ? await agentManager.replaceAgentRun(agentId, prompt, runOptions)
    : agentManager.streamAgent(agentId, prompt, runOptions);
  return { iterator, replaced };
}

async function drainAgentRunIterator(
  iterator: AsyncGenerator<import("./agent-sdk-types.js").AgentStreamEvent>,
): Promise<void> {
  for await (const _ of iterator) {
    // Events are broadcast via AgentManager subscribers.
  }
}

export async function startAgentRun(
  agentManager: AgentRunController,
  agentId: string,
  prompt: AgentPromptInput,
  logger: Logger,
  options?: StartAgentRunOptions,
): Promise<{ disposition: PromptDispatchDisposition }> {
  const finishCheck = options && finishDispatchChecks.get(options);
  finishCheck?.();
  return agentManager.withInput(
    agentId,
    "prompt",
    options?.runOptions?.clientMessageId,
    async (handle) => {
      if (handle)
        options = {
          ...options,
          runOptions: { ...options?.runOptions, [TRUSTED_OPERATION]: handle },
        };
      if (options && finishCheck) finishDispatchChecks.set(options, finishCheck);
      finishCheck?.();
      const snapshot = agentManager.getAgent(agentId);
      logger.trace(
        {
          agentId,
          provider: snapshot?.provider,
          providerSessionId: snapshot?.persistence?.sessionId ?? undefined,
          turnId: snapshot?.activeForegroundTurnId ?? undefined,
          promptType: typeof prompt === "string" ? "string" : "structured",
          hasRunOptions: Boolean(options?.runOptions),
          replaceRunning: Boolean(options?.replaceRunning),
        },
        "agent.session.start_stream.request",
      );
      // Out-of-band commands (e.g. /goal pause) must run WITHOUT canceling an
      // in-flight turn — replaceAgentRun would interrupt the running turn. The
      // intercept lives at this layer so it covers every prompt entrypoint.
      if (agentManager.tryRunOutOfBand(agentId, prompt, options?.runOptions)) {
        return { disposition: "out_of_band" };
      }
      try {
        return await startAgentRunInner(agentManager, agentId, prompt, logger, options);
      } catch (error) {
        if (finishCheck || !isStaleProviderSessionError(error)) throw error;
        logger.info(
          { agentId, err: error },
          "Provider session went stale; reopening from persistence",
        );
        // The live session belongs to a retired plugin runtime. Reload swaps in a
        // fresh session on the current runtime while preserving history and labels.
        await agentManager.trustedPlugins.daemon(() =>
          agentManager.reloadAgentSession(
            agentId,
            undefined,
            undefined,
            options?.runOptions?.[TRUSTED_OPERATION],
          ),
        );
        return await startAgentRunInner(agentManager, agentId, prompt, logger, options);
      }
    },
    promptPayload(prompt, options?.runOptions, {
      replaceRunning: options?.replaceRunning ?? false,
      activeTurnBehavior: options?.activeTurnBehavior,
      clearPendingPermissions: options?.clearPendingPermissions ?? false,
    }),
    options?.runOptions?.[TRUSTED_OPERATION],
  );
}

async function startAgentRunInner(
  agentManager: AgentRunController,
  agentId: string,
  prompt: AgentPromptInput,
  logger: Logger,
  options?: StartAgentRunOptions,
): Promise<{ disposition: PromptDispatchDisposition }> {
  const finishCheck = options && finishDispatchChecks.get(options);
  finishCheck?.();
  const snapshot = agentManager.getAgent(agentId);
  const steered = await steerOrReplaceActiveRun(agentManager, agentId, prompt, options);
  if (steered?.disposition === "steered") {
    return steered;
  }
  finishCheck?.();
  const { iterator, replaced } = steered
    ? { iterator: steered.iterator, replaced: true }
    : await startOrReplaceRun(agentManager, agentId, prompt, options);
  logger.trace(
    {
      agentId,
      provider: snapshot?.provider,
      providerSessionId: snapshot?.persistence?.sessionId ?? undefined,
      shouldReplace: replaced,
    },
    "agent.session.start_stream.iterator_returned",
  );
  void (async () => {
    try {
      try {
        await drainAgentRunIterator(iterator);
      } catch (error) {
        if (!isStaleProviderSessionError(error)) throw error;
        logger.info(
          { agentId, err: error },
          "Provider session went stale; reopening from persistence",
        );
        await agentManager.trustedPlugins.daemon(() =>
          agentManager.reloadAgentSession(
            agentId,
            undefined,
            undefined,
            options?.runOptions?.[TRUSTED_OPERATION],
          ),
        );
        const retry = await startOrReplaceRun(agentManager, agentId, prompt, options);
        await drainAgentRunIterator(retry.iterator);
      }
      logger.trace(
        {
          agentId,
          provider: snapshot?.provider,
          providerSessionId: snapshot?.persistence?.sessionId ?? undefined,
        },
        "agent.session.iterator.drained",
      );
    } catch (error) {
      logger.trace(
        {
          agentId,
          provider: snapshot?.provider,
          providerSessionId: snapshot?.persistence?.sessionId ?? undefined,
          err: error,
        },
        "agent.session.iterator.error",
      );
      logger.error({ err: error, agentId }, "Agent stream failed");
    }
  })();
  return { disposition: "turn_started" };
}

/**
 * Clear the archived flag from a stored agent record.
 * Shared across Session (app/WS), MCP, and CLI so every surface that acts on
 * an archived agent unarchives it the same way.
 */
export async function unarchiveAgentState(
  _agentStorage: AgentStorage,
  agentManager: AgentUnarchiveController,
  agentId: string,
  updates?: { workspaceId?: string; labels?: Record<string, string | null> },
  operationHandle?: TrustedOperationHandle,
): Promise<boolean> {
  const unarchived = await agentManager.unarchiveSnapshot(agentId, updates, operationHandle);
  if (!unarchived) return false;
  agentManager.notifyAgentState(agentId);
  return true;
}

/**
 * Wrap a body in <paseo-system>…</paseo-system> so the receiving agent
 * recognizes the prompt as system-injected context — not a user turn.
 * Used by chat mentions, schedule fires, and notify-on-finish.
 */
export function formatSystemNotificationPrompt(reason: string): string {
  return `<paseo-system>\n${reason}\n</paseo-system>`;
}

const SYSTEM_ENVELOPE_PATTERN = /^<paseo-system>\n[\s\S]*\n<\/paseo-system>$/;

export function isSystemInjectedEnvelope(text: string): boolean {
  return SYSTEM_ENVELOPE_PATTERN.test(text);
}

export interface SendPromptToAgentParams {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  agentId: string;
  /** Prompt to dispatch to the provider (may include image blocks or wrapped text). */
  prompt: AgentPromptInput;
  messageId?: string;
  activeTurnBehavior?: ActiveTurnBehavior;
  /** With "steer": never replace a running turn; throws SteerUnavailableError instead. */
  steerOnly?: boolean;
  runOptions?: AgentRunOptions;
  /** Optional mode to set on the agent before the run starts. */
  sessionMode?: string;
  /**
   * Default true. When false, archived agents are skipped instead of being
   * unarchived. Use false for system-injected prompts (chat mentions,
   * schedule fires, notify-on-finish).
   */
  unarchive?: boolean;
  /** See {@link StartAgentRunOptions.clearPendingPermissions}. */
  clearPendingPermissions?: boolean;
  logger: Logger;
}

export interface StartCreatedAgentInitialPromptParams {
  agentManager: AgentManager;
  agentId: string;
  snapshot?: ManagedAgent;
  prompt: AgentPromptInput | null;
  runOptions?: AgentRunOptions;
  logger: Logger;
}

/**
 * Outer bound on a run reaching "started" after dispatch.
 *
 * This wraps provider startup, so it MUST stay larger than the slowest provider's own
 * startup budget — otherwise it aborts a start the provider was still allowed to be
 * working on, and the provider's budget can never apply. OpenCode is the slowest today:
 * up to 30s for the server to boot (OPENCODE_SERVER_STARTUP_TIMEOUT_MS) and then a
 * session.create on the same budget, so this is deliberately set well above 30s.
 *
 * Not derived from the provider constant on purpose: this module is provider-agnostic
 * and must not depend on a specific provider's internals.
 */
const AGENT_RUN_START_TIMEOUT_MS = 60_000;

export async function waitForAgentRunStartWithTimeout(
  agentManager: AgentManager,
  agentId: string,
  signal?: AbortSignal,
): Promise<void> {
  const provider = agentManager.getAgent(agentId)?.provider ?? "provider";
  const startAbort = new AbortController();
  const startTimeout = setTimeout(
    () =>
      startAbort.abort(
        new Error(
          `${provider} run did not start within ${AGENT_RUN_START_TIMEOUT_MS / 1000} seconds (phase: run start)`,
        ),
      ),
    AGENT_RUN_START_TIMEOUT_MS,
  );

  try {
    await agentManager.waitForAgentRunStart(agentId, {
      signal: signal ? AbortSignal.any([startAbort.signal, signal]) : startAbort.signal,
    });
  } finally {
    clearTimeout(startTimeout);
  }
}

/**
 * Full send-prompt orchestration: (optional unarchive) → load → (optional
 * mode change) → start run.
 *
 * Every surface that sends a prompt to an agent (Session/WS, MCP, CLI-through-MCP,
 * chat mentions, notify-on-finish) MUST go through this so behavior can never
 * drift between them.
 *
 * When `unarchive` is false and the agent is archived, the call is a silent
 * no-op (returns the normal turn-start disposition) — the agent is not run.
 */
export async function sendPromptToAgent(
  params: SendPromptToAgentParams,
): Promise<{ disposition: PromptDispatchDisposition }> {
  const finishCheck = finishDispatchChecks.get(params);
  finishCheck?.();
  return params.agentManager.withInput(
    params.agentId,
    "prompt",
    params.messageId ?? params.runOptions?.clientMessageId,
    async (handle) => {
      if (handle)
        params = {
          ...params,
          runOptions: { ...params.runOptions, [TRUSTED_OPERATION]: handle },
        };
      const unarchive = params.unarchive ?? true;

      const record = await params.agentStorage.get(params.agentId);
      finishCheck?.();
      if (record?.archivedAt) {
        params.agentManager.trustedPlugins.input(
          record,
          "prompt",
          params.messageId ?? params.runOptions?.clientMessageId,
          () => undefined,
          promptPayload(params.prompt, params.runOptions, {
            sessionMode: params.sessionMode,
            unarchive: params.unarchive ?? true,
            replaceRunning: true,
            activeTurnBehavior: params.activeTurnBehavior,
            clearPendingPermissions: params.clearPendingPermissions ?? false,
          }),
          handle,
        );
      }
      if (record?.archivedAt) {
        if (!unarchive) {
          return { disposition: "turn_started" };
        }
        await unarchiveAgentState(
          params.agentStorage,
          params.agentManager,
          params.agentId,
          undefined,
          handle,
        );
      }

      await ensureAgentLoaded(params.agentId, {
        agentManager: params.agentManager,
        agentStorage: params.agentStorage,
        logger: params.logger,
      });

      finishCheck?.();
      if (params.sessionMode) {
        await params.agentManager.setAgentMode(params.agentId, params.sessionMode, handle);
      }

      const runOptions = params.messageId
        ? { ...params.runOptions, clientMessageId: params.messageId }
        : params.runOptions;

      finishCheck?.();
      const startOptions: StartAgentRunOptions = {
        replaceRunning: true,
        activeTurnBehavior: params.activeTurnBehavior,
        clearPendingPermissions: params.clearPendingPermissions,
        steerOnly: params.steerOnly,
        runOptions,
      };
      if (finishCheck) finishDispatchChecks.set(startOptions, finishCheck);
      return await startAgentRun(
        params.agentManager,
        params.agentId,
        params.prompt,
        params.logger,
        startOptions,
      );
    },
    promptPayload(params.prompt, params.runOptions, {
      sessionMode: params.sessionMode,
      unarchive: params.unarchive ?? true,
      replaceRunning: true,
      activeTurnBehavior: params.activeTurnBehavior,
      clearPendingPermissions: params.clearPendingPermissions ?? false,
    }),
    params.runOptions?.[TRUSTED_OPERATION],
  );
}

export async function startCreatedAgentInitialPrompt(
  params: StartCreatedAgentInitialPromptParams,
): Promise<ManagedAgent> {
  const currentSnapshot = params.agentManager.getAgent(params.agentId) ?? params.snapshot ?? null;
  if (!currentSnapshot) {
    throw new Error(`Agent ${params.agentId} not found`);
  }

  if (params.prompt === null) {
    return currentSnapshot;
  }

  const dispatchResult = await startAgentRun(
    params.agentManager,
    params.agentId,
    params.prompt,
    params.logger,
    {
      runOptions: params.runOptions,
    },
  );

  if (dispatchResult.disposition === "turn_started") {
    await waitForAgentRunStartWithTimeout(params.agentManager, params.agentId);
  }

  const refreshedSnapshot = params.agentManager.getAgent(params.agentId) ?? params.snapshot ?? null;
  if (!refreshedSnapshot) {
    throw new Error(`Agent ${params.agentId} not found`);
  }
  return refreshedSnapshot;
}

export interface SetupFinishNotificationParams {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  childAgentId: string;
  callerAgentId: string;
  requireParentOwnership?: boolean;
  logger: Logger;
}

type FinishNotificationReason = "finished" | "errored" | "needs permission" | "was closed";

const FINISH_NOTIFICATION_MESSAGE_LIMIT = 4000;

interface FinishNotificationBodyInput {
  childAgentId: string;
  title: string;
  reason: FinishNotificationReason;
  lastAssistantMessage: string | null;
  permissionRequest?: AgentPermissionRequest;
}

function formatFinishNotificationBody(params: FinishNotificationBodyInput): string {
  const statusLine = `Agent ${params.childAgentId} (${params.title}) ${params.reason}.`;
  const sections = [statusLine];
  if (params.reason === "needs permission" && params.permissionRequest) {
    sections.push(
      "Respond with `respond_to_permission` using the `agentId` and `requestId` below.",
      `<permission-request>\n${JSON.stringify(
        {
          agentId: params.childAgentId,
          requestId: params.permissionRequest.id,
          request: params.permissionRequest,
        },
        null,
        2,
      )}\n</permission-request>`,
    );
  }
  let lastAssistantMessage = params.lastAssistantMessage?.trim();
  if (lastAssistantMessage) {
    if (lastAssistantMessage.length > FINISH_NOTIFICATION_MESSAGE_LIMIT) {
      const omitted = lastAssistantMessage.length - FINISH_NOTIFICATION_MESSAGE_LIMIT;
      lastAssistantMessage = `${lastAssistantMessage.slice(0, FINISH_NOTIFICATION_MESSAGE_LIMIT)}\n[truncated ${omitted} chars; use get_agent_activity for the full response]`;
    }
    sections.push(`<agent-response>\n${lastAssistantMessage}\n</agent-response>`);
  }
  return sections.join("\n\n");
}

interface NotifySafelyOptions {
  terminal?: boolean;
  permissionRequest?: AgentPermissionRequest;
}

/**
 * FIX-8 W3: the message id prefix of the daemon's finish notice to a caller. The notice is admitted with source
 * "daemon" (it has no ambient human or agent context), and a trusted plugin (Fulcra's controller) can tell it from a
 * person typing into the caller: a delegated lead keeps its delegation when a child reports back. The prefix alone
 * proves nothing; only the daemon source does.
 */
export const FINISH_NOTIFICATION_MESSAGE_PREFIX = "paseo-notify:";
// A caller waits on a child through one armed notification. Arming again, such as a
// follow-up prompt while the child still runs, replaces the earlier one so the child's
// next finish reaches the caller once.
const armedFinishNotifications = new WeakMap<AgentManager, Map<string, () => void>>();

/** FULCRA(orchestration): a caller already waits on this child's finish, so report-up stays quiet for it. */
export function hasArmedFinishNotification(
  agentManager: AgentManager,
  childAgentId: string,
  callerAgentId: string,
): boolean {
  return (
    armedFinishNotifications
      .get(agentManager)
      ?.has(JSON.stringify([childAgentId, callerAgentId])) ?? false
  );
}

export function setupFinishNotification(params: SetupFinishNotificationParams): void {
  const {
    agentManager,
    agentStorage,
    childAgentId,
    callerAgentId,
    requireParentOwnership = false,
    logger,
  } = params;
  let hasSeenRunning = false;
  let stopped = false;
  let superseded = false;
  const checkIdentity = agentManager.captureFinishNotificationCheck(childAgentId, callerAgentId);
  const checkCurrent = () => {
    if (superseded || agentManager.nativeReportOwnsFinish(childAgentId, callerAgentId))
      throw new Error("Finish notification superseded by current wake ownership");
    checkIdentity();
  };
  const notifiedPermissionRequestIds = new Set<string>();
  let unsubscribe: (() => void) | null = null;
  let notificationQueue = Promise.resolve();

  const armedByManager = armedFinishNotifications.get(agentManager) ?? new Map();
  armedFinishNotifications.set(agentManager, armedByManager);
  const armedKey = JSON.stringify([childAgentId, callerAgentId]);
  armedByManager.get(armedKey)?.();
  const cancel = () => {
    superseded = true;
    stop();
  };
  armedByManager.set(armedKey, cancel);
  if (agentManager.nativeReportOwnsFinish(childAgentId, callerAgentId)) {
    cancel();
    armedByManager.delete(armedKey);
    return;
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    unsubscribe?.();
  }

  async function notify(
    reason: FinishNotificationReason,
    permissionRequest?: AgentPermissionRequest,
  ): Promise<void> {
    checkCurrent();
    const callerRecord = await agentStorage.get(callerAgentId);
    checkCurrent();
    if (callerRecord?.archivedAt) {
      return;
    }

    const record = await agentStorage.get(childAgentId);
    checkCurrent();
    if (requireParentOwnership && getParentAgentIdFromLabels(record?.labels) !== callerAgentId) {
      return;
    }
    const title = record?.title ?? childAgentId;
    const lastAssistantMessage = await agentManager.getLastAssistantMessage(childAgentId);
    checkCurrent();
    const body = formatFinishNotificationBody({
      childAgentId,
      title,
      reason,
      lastAssistantMessage,
      permissionRequest,
    });

    const prompt = formatSystemNotificationPrompt(body);
    const messageId = `${FINISH_NOTIFICATION_MESSAGE_PREFIX}${randomUUID()}`;
    // FULCRA(orchestration): the notice steers into the caller's running turn but never replaces it: when the turn
    // cannot take a steer, it waits for the turn to end (held-sends.ts) and is then sent with the daemon source.
    const deliver = () =>
      agentManager.trustedPlugins.daemon(async () => {
        checkCurrent();
        const finalCheck = createFinalInputCheck(checkCurrent);
        const dispatch: SendPromptToAgentParams = {
          agentManager,
          agentStorage,
          agentId: callerAgentId,
          prompt,
          messageId,
          runOptions: { [FINAL_INPUT_CHECK]: finalCheck },
          activeTurnBehavior: "steer",
          steerOnly: true,
          unarchive: false,
          logger,
        };
        finishDispatchChecks.set(dispatch, checkCurrent);
        checkCurrent();
        await sendPromptToAgent(dispatch);
        await waitForFinalInputHandoff(finalCheck);
      });
    try {
      await deliver();
    } catch (error) {
      if (!(error instanceof SteerUnavailableError)) throw error;
      heldSendsFor(agentManager, logger).hold(callerAgentId, deliver);
    }
  }

  function notifySafely(reason: FinishNotificationReason, options: NotifySafelyOptions = {}): void {
    if (stopped) return;
    if (options.terminal ?? true) stop();
    notificationQueue = notificationQueue
      .then(() =>
        agentManager.trustedPlugins.daemon(() => notify(reason, options.permissionRequest)),
      )
      .catch((error) => {
        superseded = true;
        logger.error(
          { err: error, childAgentId, callerAgentId, reason },
          "Failed to notify caller agent",
        );
      })
      .finally(() => {
        if (stopped && armedByManager.get(armedKey) === cancel) armedByManager.delete(armedKey);
      });
  }

  unsubscribe = agentManager.subscribe(
    (event) => {
      if (stopped) {
        return;
      }

      if (event.type === "agent_state") {
        for (const requestId of notifiedPermissionRequestIds) {
          if (!event.agent.pendingPermissions.has(requestId)) {
            notifiedPermissionRequestIds.delete(requestId);
          }
        }
        if (event.agent.lifecycle === "running") {
          if (event.agent.pendingPermissions.size === 0) {
            hasSeenRunning = true;
          }
          return;
        }
        if (event.agent.lifecycle === "error") {
          notifySafely("errored");
          return;
        }
        if (event.agent.lifecycle === "idle" && hasSeenRunning) {
          notifySafely("finished");
          return;
        }
        if (event.agent.lifecycle === "closed") {
          notifySafely("was closed");
          return;
        }
        return;
      }

      if (event.type === "timeline_replacement") {
        return;
      }

      if (event.event.type === "permission_requested") {
        // A permission pause is an intermediate checkpoint. Forget the run
        // observed before it so an idle state during follow-up startup cannot
        // masquerade as the final completion.
        hasSeenRunning = false;
        if (!notifiedPermissionRequestIds.has(event.event.request.id)) {
          notifiedPermissionRequestIds.add(event.event.request.id);
          notifySafely("needs permission", {
            terminal: false,
            permissionRequest: event.event.request,
          });
        }
        return;
      }

      if (event.event.type === "permission_resolved") {
        notifiedPermissionRequestIds.delete(event.event.requestId);
        const childAgent = agentManager.getAgent(childAgentId);
        if (childAgent?.pendingPermissions.size === 0) {
          hasSeenRunning = childAgent.lifecycle === "running";
        }
      }
    },
    { agentId: childAgentId, replayState: false },
  );

  // Check if the child is already running (catches the case where
  // the lifecycle flipped before our subscribe call was processed).
  // Do NOT treat an immediate "idle" as "finished" — the agent may
  // not have started yet (streamAgent sets a pending run before
  // transitioning to "running").
  const childSnapshot = agentManager.getAgent(childAgentId);
  if (!childSnapshot || childSnapshot.lifecycle === "closed") {
    stop();
    return;
  }
  if (childSnapshot.lifecycle === "running") {
    hasSeenRunning = true;
  } else if (childSnapshot.lifecycle === "error") {
    notifySafely("errored");
  }
}
