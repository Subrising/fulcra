import { PermissionAttentionError } from "./permission-attention-error.js";
import { fingerprintLimitResumeBinding } from "../limit-resume/binding.js";
import { registerOwnerArtifactContent } from "../owner-report-read.js";
import {
  NativeArtifactProduceInputSchema,
  NativeArtifactProduceOutputSchema,
  ManagedArtifactClaimSchema,
} from "@getpaseo/protocol/native-evidence";
import {
  createNativeArtifactInvocation,
  consumeNativeArtifactInvocation,
  type NativeArtifactInvocation,
} from "../native-artifact-origin.js";
import { bindReportPublication } from "../report-publication.js";
import {
  registerNativeEvidenceSink,
  nativeEvidenceDigest,
  type NativeCompletion,
} from "../native-evidence-origin.js";
import {
  NativeEvidenceFactSchema,
  NativeEvidenceJournalSchema,
  NativeEvidenceClaimSchema,
} from "@getpaseo/protocol/native-evidence";
import {
  registerOwnerReportRead,
  registerOwnerEvidenceRead,
  registerOwnerManagedArtifactRead,
} from "../owner-report-read.js";
import { assertFinalInputCheck, failFinalInputHandoff } from "./final-input-check.js";
import { checkReportPublication } from "../report-publication.js";
import {
  createNativeReportOrigin,
  forkNativeReportOrigin,
  rememberNativeReportPublication,
  requireNativeReportOrigin,
  enrollNativeReportCreation,
  type NativeReportOrigin,
  type NativeReportCreation,
} from "../report-origin.js";
import { NativeReportInbox } from "../report-inbox.js";
import { IntercomRates } from "../intercom-rates.js";
import { requireNativeReportBatch, type NativeReportBatch } from "../report-batch.js";
import {
  registerNativeReceiptMaintenance,
  registerNativeReportRegistry,
  registerNativeIntercomRates,
} from "../plugins/native-intercom-owner.js";
import { NativeReportRegistry } from "../report-registry.js";
import {
  IntercomStatusInputSchema,
  IntercomStatusSchema,
  type NativeReportIdentity,
} from "@getpaseo/protocol/native-intercom";
import { sessionQuotaUsage } from "./session-quota-usage.js";
import {
  snapshotParentAdoption,
  validateParentAdoption,
  type ParentAdoptionInput,
} from "./parent-adoption.js";
import { nativeDispatch } from "../plugins/admission-outcome.js";
import type {
  AccountCredential,
  LiveAccountSession,
} from "../../services/quota-fetcher/account-usage-types.js";
import { AdmissionDeniedError } from "../plugins/trusted.js";
import { normalizeTrustedPermissionResponse } from "@getpaseo/protocol/trusted-input";
import type { TrustedOperationHandle } from "../plugins/trusted.js";
import {
  deferredPromptPayload as promptPayload,
  deferredCommandPayload as commandPayload,
  snapshotRunOptions,
} from "./trusted-operation.js";
import type { TrustedPayloadV11 } from "@getpaseo/protocol/trusted-input";
import type { MessageReceipts, NativeMessageReceipt } from "../message-receipts/index.js";
import {
  createNativeQueuedDispatch,
  nativeQueuedAcceptance,
  supportsNativeQueuedProvider,
  validateNativeQueuedDispatch,
  nativeQueuedFailure,
} from "./native-queued-dispatch.js";
import { TRUSTED_OPERATION, NATIVE_QUEUED_FINAL, FINAL_INPUT_CHECK } from "./agent-sdk-types.js";
import type { AgentBackgroundWork } from "@getpaseo/protocol/agent-background-work";
import {
  BackgroundWorkSampler,
  type BackgroundWorkSamplerOptions,
} from "./background-work/sampler.js";
import { TrustedPlugins } from "../plugins/trusted.js";
import type { InputSequence, TrustedInputKind } from "@getpaseo/plugin/server";
import { projectTimelineRows } from "./timeline-projection.js";
import type { PluginLifecycle } from "../plugins/lifecycle/index.js";
import { describeHookAgent, publishAgentStream } from "../plugins/lifecycle/index.js";
import type { PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { createHash, createHmac, randomUUID } from "node:crypto";
import {
  AgentMcpRefreshInputSchema,
  AgentQuotaSnapshotSchema,
  type AgentMcpRefreshInput,
  type AgentMcpRefreshResult,
  type AgentMcpRefreshState,
} from "@getpaseo/protocol/messages";
import { basename, resolve } from "node:path";
import { stat } from "node:fs/promises";
import {
  AGENT_LIFECYCLE_STATUSES,
  type AgentLifecycleStatus,
} from "@getpaseo/protocol/agent-lifecycle";
import {
  getParentAgentIdFromLabels,
  hasOpenAgentTab,
  isDelegatedAgent,
  isOpenAgentTabLabel,
  PARENT_AGENT_ID_LABEL,
} from "@getpaseo/protocol/agent-labels";
import type { Logger } from "pino";
import { childModeClass, type ChildModeClass } from "./create-agent-mode.js";
import type { ProviderOptions, ToolPolicy } from "@getpaseo/protocol/agent-types";
import type { ProviderPaseoToolsPolicy } from "@getpaseo/protocol/provider-config";
import { z } from "zod";
import type { TerminalManager } from "../../terminal/terminal-manager.js";

import {
  CODEX_TURN_ADMISSION,
  getAgentStreamEventTurnId,
  type AgentCapabilityFlags,
  type AgentClient,
  type AgentCreateSessionOptions,
  type AgentResumePurpose,
  type AgentResumeSessionOptions,
  type AgentFeature,
  type AgentLaunchContext,
  type AgentSlashCommand,
  type AgentMode,
  type AgentPermissionRequest,
  type AgentPermissionResponse,
  type AgentPermissionResult,
  type AgentPersistenceHandle,
  type AgentProviderNotice,
  type AgentPromptInput,
  type AgentProvider,
  type AgentRunOptions,
  type AgentSteerOptions,
  type AgentRunResult,
  type AgentSession,
  type AgentSessionConfig,
  type SteerResult,
  type AgentStreamEvent,
  type AgentTimelineItem,
  type AgentUsage,
  type AgentRuntimeInfo,
  type AgentQuotaSnapshot,
  type ImportedTimelineEntry,
  type ImportableProviderSession,
  type ListImportableSessionsOptions,
  normalizeAgentModelDefinition,
} from "./agent-sdk-types.js";
import { buildArchivedAgentRecord, type ArchivedStoredAgentRecord } from "./agent-archive.js";
import type { StoredAgentRecord, AgentStorage } from "./agent-storage.js";
import type { AgentOwner } from "./agent-owner.js";
import {
  InMemoryAgentTimelineStore,
  type SeedAgentTimelineOptions,
} from "./agent-timeline-store.js";
import type {
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
  AgentTimelineIndexSnapshot,
  AgentTimelinePlacement,
  AgentTimelineRow,
  AgentTimelineStore,
} from "./agent-timeline-store-types.js";
import { TimelineIndexBuilder, findTimelineTurn } from "./timeline-turn-index.js";
import {
  AGENT_STREAM_COALESCE_DEFAULT_WINDOW_MS,
  AgentStreamCoalescer,
} from "./agent-stream-coalescer.js";
import { limitAgentTimelineItemContent } from "./agent-timeline-content.js";
import {
  AgentRunState,
  type ForegroundTurnWaiter,
  type PendingForegroundRun,
} from "./agent-run-state.js";
import { invokeRewindCapability, type RewindMode } from "./rewind/rewind.js";
import { FINISH_NOTIFICATION_MESSAGE_PREFIX, isSystemInjectedEnvelope } from "./agent-prompt.js";
import { isStaleProviderSessionError } from "./stale-provider-session-error.js";
import { stripInternalPaseoMcpServer, withRuntimePaseoMcpServer } from "./runtime-mcp-config.js";
import { resolveCreateAgentTitles } from "./create-agent-title.js";
import type { PaseoToolCatalogFactory } from "./tools/types.js";
import { isPaseoToolPolicyEnabled } from "./paseo-tool-policy.js";
import {
  ProviderSubagentStore,
  type ProviderSubagentDescriptor,
  type ProviderSubagentStoreEvent,
} from "./provider-subagents/store.js";
import { withTimeout } from "../../utils/promise-timeout.js";
import { extractAttention } from "../persistence-hooks.js";

const RELOAD_SESSION_CLOSE_TIMEOUT_MS = 3_000;
const INTERRUPT_SESSION_TIMEOUT_MS = 2_000;
const IMPORTABLE_SESSION_LIST_TIMEOUT_MS = 90_000;
const STORED_AGENT_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: false,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: true,
  supportsRewindConversation: false,
  supportsRewindFiles: false,
  supportsRewindBoth: false,
};

type TimeoutResult = "completed" | "timed_out";

function submittedPromptText(prompt: AgentPromptInput): string {
  if (typeof prompt === "string") {
    return prompt;
  }
  return prompt
    .flatMap((block) => (block.type === "text" && !("mimeType" in block) ? [block.text] : []))
    .join("\n")
    .trim();
}

export class AgentManagerShuttingDownError extends Error {
  constructor() {
    super("Agent manager is shutting down");
    this.name = "AgentManagerShuttingDownError";
  }
}

class QuietMcpRefreshRefusal extends Error {
  constructor(readonly reason: "busy" | "stale") {
    super(reason);
    this.name = "QuietMcpRefreshRefusal";
  }
}

export class AgentRunCancellationError extends Error {
  constructor(agentId: string, action: "reload" | "replace" | "rewind" | "stop") {
    super(
      `Cannot ${action} agent ${agentId} because its active run cancellation was not acknowledged`,
    );
    this.name = "AgentRunCancellationError";
  }
}

export type AgentRunCancellationResult =
  | { status: "not_running" }
  | { status: "settled" }
  | { status: "refused" };

/** A session that will run in a directory needs that directory to be there. */
async function assertUsableWorkingDirectory(cwd: string): Promise<void> {
  try {
    const stats = await stat(cwd);
    if (!stats.isDirectory()) {
      throw new Error(`Working directory is not a directory: ${cwd}`);
    }
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      throw new Error(`Working directory does not exist: ${cwd}`, { cause: error });
    }
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`Failed to access working directory: ${cwd}`, { cause: error });
  }
}

interface PreparedSessionConfig {
  storedConfig: AgentSessionConfig;
  launchConfig: AgentSessionConfig;
  paseoToolPolicy: ProviderPaseoToolsPolicy | undefined;
}

// An absent mode. Deliberately NOT "default": for Claude that is a real, user-choosable mode (Always Ask).
function isUnsetModeId(modeId: string | null | undefined): boolean {
  return modeId === undefined || modeId === null || modeId.trim().length === 0;
}

function isUnsetThinkingOptionId(thinkingOptionId: string | null | undefined): boolean {
  return (
    thinkingOptionId === undefined ||
    thinkingOptionId === null ||
    thinkingOptionId.trim().length === 0
  );
}

interface NormalizeConfigOptions {
  resolveDefaultModel?: boolean;
  /**
   * Fill a missing mode from the provider default. OFF unless asked, unlike resolveDefaultModel: only the
   * create path sets it. Resume, reload and import must keep a stored record's mode exactly as it is --
   * filling there would silently move sessions nobody chose a mode for into a more permissive one.
   */
  resolveDefaultMode?: boolean;
  /** Fill a missing thinking option from the model's default. OFF unless asked, for the same reason. */
  resolveDefaultThinking?: boolean;
  env?: Record<string, string>;
  /** Defaults to interactive. A history load reads persisted state and runs nothing. */
  purpose?: AgentResumePurpose;
}

interface TimeoutOptions {
  operation: Promise<void>;
  timeoutMs: number;
  onLateError?: (error: unknown) => void;
}

function formatProviderList(providers: readonly string[]): string {
  return providers.length > 0 ? providers.join(", ") : "none";
}

function buildStoredAgentConfig(record: StoredAgentRecord): AgentSessionConfig {
  const config: AgentSessionConfig = {
    provider: record.provider,
    cwd: record.cwd,
  };
  if (!record.config) {
    return config;
  }
  if (record.config.modeId != null) config.modeId = record.config.modeId;
  if (record.config.model != null) config.model = record.config.model;
  if (record.config.thinkingOptionId != null) {
    config.thinkingOptionId = record.config.thinkingOptionId;
  }
  if (record.config.featureValues != null) {
    config.featureValues = record.config.featureValues;
  }
  if (record.config.providerOptions != null) {
    config.providerOptions = record.config.providerOptions;
  }
  if (record.config.toolPolicy != null) config.toolPolicy = record.config.toolPolicy;
  if (record.config.systemPrompt != null) {
    config.systemPrompt = record.config.systemPrompt;
  }
  if (record.config.mcpServers != null) config.mcpServers = record.config.mcpServers;
  return stripInternalPaseoMcpServer(config);
}

export { AGENT_LIFECYCLE_STATUSES, type AgentLifecycleStatus };
export type {
  AgentTimelineCursor,
  AgentTimelineFetchDirection,
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
  AgentTimelineRow,
  AgentTimelineWindow,
} from "./agent-timeline-store-types.js";

export type AgentManagerEvent =
  | { type: "agent_state"; agent: ManagedAgent }
  | { type: "provider_subagent"; event: ProviderSubagentStoreEvent }
  | { type: "timeline_replacement"; agentId: string; epoch: string }
  | {
      type: "agent_stream";
      agentId: string;
      event: AgentStreamEvent;
      seq?: number;
      epoch?: string;
      timestamp?: string;
    };

export type AgentSubscriber = (event: AgentManagerEvent) => void;

export interface SubscribeOptions {
  agentId?: string;
  replayState?: boolean;
}

interface HydrateTimelineOptions {
  force?: boolean;
  broadcast?: boolean | (() => boolean);
  broadcastTimeline?: boolean;
}

export type ImportablePersistedAgentQueryOptions = ListImportableSessionsOptions & {
  /**
   * When set, only providers in this set are scanned, in addition to the
   * built-in importable allowlist + enabled + non-derived rules.
   */
  providerFilter?: Set<string>;
};

export interface ManagedImportableProviderSession extends ImportableProviderSession {
  provider: AgentProvider;
}

export interface ImportableSessionProviderError {
  provider: AgentProvider;
  message: string;
}

export interface ManagedImportableSessionsResult {
  sessions: ManagedImportableProviderSession[];
  providerErrors: ImportableSessionProviderError[];
}

export type AgentAttentionCallback = (params: {
  agentId: string;
  provider: AgentProvider;
  reason: "finished" | "error" | "permission";
}) => void;

export type AgentArchivedCallback = (agentId: string) => Promise<void> | void;

export interface ProviderAvailability {
  provider: AgentProvider;
  available: boolean;
  error: string | null;
}

interface AgentManagerRescueTimeouts {
  reloadSessionCloseMs?: number;
  interruptSessionMs?: number;
}

interface ProviderEnabledFlag {
  enabled: boolean;
  derivedFromProviderId?: string | null;
  validateOptions?: (options: ProviderOptions | undefined) => ProviderOptions | undefined;
  applyOptions?: (
    config: AgentSessionConfig,
    options: ProviderOptions | undefined,
  ) => AgentSessionConfig;
  applyToolPolicy?: (
    config: AgentSessionConfig,
    toolPolicy: ToolPolicy | undefined,
  ) => AgentSessionConfig;
}
type ProviderEnabledMap = Partial<Record<AgentProvider, ProviderEnabledFlag>>;
type ProviderClientMap = Partial<Record<AgentProvider, AgentClient>>;

export interface CreateAgentOptions {
  reportCreation?: NativeReportCreation;
  labels?: Record<string, string>;
  initialPrompt?: string;
  env?: Record<string, string>;
  persistSession?: boolean;
  initialTitle?: string | null;
  // undefined is an explicit decision: the agent never appears in the sidebar.
  workspaceId: string | undefined;
  owner?: AgentOwner;
  /**
   * Starting an EXISTING stored record (one with no provider handle yet) sets this true. Its config is kept
   * exactly as stored -- including a missing mode -- because filling it would silently move a session nobody
   * chose a mode for into a more permissive one. Every genuinely new session leaves it unset.
   */
  fromStoredRecord?: boolean;
}

export interface AgentManagerOptions {
  /** Host-private registration journal, derived from the existing private home. Not a shared config key. */
  reportRegistryFile?: string;
  reportGrantDirectory?: string;
  trustedPlugins?: TrustedPlugins;
  pluginLifecycle?: PluginLifecycle;
  /** Trusted synchronous host ownership/grant fence. Never supplied by an RPC caller. */
  mcpRefreshAdmission?: (agent: ManagedAgent) => { revision: string; allowed: boolean };
  clients?: ProviderClientMap;
  providerDefinitions?: ProviderEnabledMap;
  idFactory?: () => string;
  registry?: AgentStorage;
  onAgentAttention?: AgentAttentionCallback;
  onWorkspaceStateMayHaveChanged?: (params: { cwd: string }) => void;
  durableTimelineStore?: AgentTimelineStore;
  /** What deleting an agent does to its timeline history. Defaults to keeping it. */
  timelineRetention?: "keep" | "purge";
  terminalManager?: TerminalManager | null;
  mcpBaseUrl?: string;
  mcpAuthToken?: string;
  paseoToolsEnabled?: boolean;
  paseoToolCatalogFactory?: PaseoToolCatalogFactory;
  resolvePaseoToolPolicy?: (provider: AgentProvider) => ProviderPaseoToolsPolicy | undefined;
  appendSystemPrompt?: string;
  agentStreamCoalesceWindowMs?: number;
  rescueTimeouts?: AgentManagerRescueTimeouts;
  beforeSteerUnavailableFallback?: (input: {
    agentId: string;
    expectedTurnId: string;
  }) => Promise<void>;
  logger: Logger;
}

export type ActiveTurnSteerDispatchResult =
  | { status: "inactive" | "steered" }
  | { status: "replaced"; iterator: AsyncGenerator<AgentStreamEvent> };

function stripSteerOptions(options?: AgentSteerOptions): AgentRunOptions | undefined {
  if (!options) return undefined;
  const { clearPendingPermissions: _, ...runOptions } = options;
  return runOptions;
}

export interface WaitForAgentOptions {
  signal?: AbortSignal;
  waitForActive?: boolean;
}

export interface WaitForAgentResult {
  status: AgentLifecycleStatus;
  permission: AgentPermissionRequest | null;
  lastMessage: string | null;
}

export interface WaitForAgentStartOptions {
  signal?: AbortSignal;
}

export type AttentionState =
  | { requiresAttention: false }
  | {
      requiresAttention: true;
      attentionReason: "finished" | "error" | "permission";
      attentionTimestamp: Date;
    };

function resolveInitialAttention(input: AttentionState | undefined): AttentionState {
  if (input == null || !input.requiresAttention) {
    return { requiresAttention: false };
  }
  return {
    requiresAttention: true,
    attentionReason: input.attentionReason,
    attentionTimestamp: new Date(input.attentionTimestamp),
  };
}

interface StreamEventFlags {
  shouldDispatchEvent: boolean;
  shouldNotifyWaiters: boolean;
}

type ActiveTurnTerminalDisposition = "closed_current" | "stale" | "untracked";

interface HandleStreamEventOptions {
  fromHistory?: boolean;
}

interface ManagedAgentBase {
  archivedAt: string | null;
  instanceId?: string;
  inputSequence?: InputSequence;
  id: string;
  provider: AgentProvider;
  cwd: string;
  /**
   * Workspace this agent belongs to, stamped at creation. Independent of cwd:
   * cwd answers "where does it run", workspaceId answers "which workspace owns it".
   * Null/undefined for legacy agents created before ownership stamping.
   */
  workspaceId?: string;
  owner?: AgentOwner;
  capabilities: AgentCapabilityFlags;
  config: AgentSessionConfig;
  runtimeInfo?: AgentRuntimeInfo;
  createdAt: Date;
  updatedAt: Date;
  availableModes: AgentMode[];
  features?: AgentFeature[];
  currentModeId: string | null;
  pendingPermissions: Map<string, AgentPermissionRequest>;
  bufferedPermissionResolutions: Map<
    string,
    Extract<AgentStreamEvent, { type: "permission_resolved" }>
  >;
  inFlightPermissionResponses: Set<string>;
  pendingReplacement: boolean;
  persistence: AgentPersistenceHandle | null;
  historyPrimed: boolean;
  lastUserMessageAt: Date | null;
  activeTurnId: string | null;
  activeTurnStartedAt: Date | null;
  lastUsage?: AgentUsage;
  lastError?: string;
  /**
   * Display only (MULTIHOST-DESIGN §6): background jobs the session left running. Live, never
   * persisted, and never read by lifecycle, turns, waiters, admission or any policy.
   */
  backgroundWork?: AgentBackgroundWork | null;
  attention: AttentionState;
  foregroundTurnWaiters: Set<ForegroundTurnWaiter>;
  finalizedForegroundTurnIds: Set<string>;
  unsubscribeSession: (() => void) | null;
  /**
   * Internal agents are hidden from listings and don't trigger notifications.
   */
  internal?: boolean;
  /**
   * User-defined labels for categorizing agents (e.g., { surface: "workspace" }).
   */
  labels: Record<string, string>;
}

type ManagedAgentWithSession = ManagedAgentBase & {
  session: AgentSession;
};

type ManagedAgentInitializing = ManagedAgentWithSession & {
  lifecycle: "initializing";
  activeForegroundTurnId: null;
};

type ManagedAgentIdle = ManagedAgentWithSession & {
  lifecycle: "idle";
  activeForegroundTurnId: null;
};

type ManagedAgentRunning = ManagedAgentWithSession & {
  lifecycle: "running";
  activeForegroundTurnId: string | null;
};

type ManagedAgentError = ManagedAgentWithSession & {
  lifecycle: "error";
  activeForegroundTurnId: null;
  lastError: string;
};

type ManagedAgentClosed = ManagedAgentBase & {
  lifecycle: "closed";
  session: null;
  activeForegroundTurnId: null;
};

export type ManagedAgent =
  | ManagedAgentInitializing
  | ManagedAgentIdle
  | ManagedAgentRunning
  | ManagedAgentError
  | ManagedAgentClosed;

export interface AgentMetricsSnapshot {
  total: number;
  subscriptionCount: number;
  byLifecycle: Record<string, number>;
  withActiveForegroundTurn: number;
  timelineStats: {
    totalItems: number;
    maxItemsPerAgent: number;
  };
}

type ActiveManagedAgent =
  | ManagedAgentInitializing
  | ManagedAgentIdle
  | ManagedAgentRunning
  | ManagedAgentError;

type LiveManagedAgent = ActiveManagedAgent;
type AgentLabelPatch = Record<string, string | null>;

function attachManagedTurnIdentity(
  agent: ActiveManagedAgent,
  event: AgentStreamEvent,
  fromHistory: boolean,
): { event: AgentStreamEvent; turnId: string | undefined } {
  const existingTurnId = getAgentStreamEventTurnId(event);
  if (fromHistory || existingTurnId !== undefined) {
    return { event, turnId: existingTurnId };
  }
  switch (event.type) {
    case "turn_started": {
      const turnId =
        agent.activeForegroundTurnId ?? agent.activeTurnId ?? `autonomous-${randomUUID()}`;
      return { event: { ...event, turnId }, turnId };
    }
    case "turn_completed":
    case "turn_failed":
    case "turn_canceled": {
      const turnId = agent.activeForegroundTurnId ?? agent.activeTurnId ?? undefined;
      return turnId ? { event: { ...event, turnId }, turnId } : { event, turnId };
    }
    case "timeline": {
      // Live provider items belong to the foreground turn that owns their dispatch.
      // Provider history deliberately keeps absent IDs because it has no daemon turn identity.
      const turnId = agent.activeForegroundTurnId ?? agent.activeTurnId ?? undefined;
      return turnId ? { event: { ...event, turnId }, turnId } : { event, turnId };
    }
    default:
      return { event, turnId: undefined };
  }
}

function limitAgentStreamEventContent(event: AgentStreamEvent): AgentStreamEvent {
  return event.type === "timeline"
    ? { ...event, item: limitAgentTimelineItemContent(event.item) }
    : event;
}

interface WriteLabelsResult {
  record: StoredAgentRecord | null;
  live: boolean;
}

interface AgentMetadataPatch {
  title?: string;
  labels?: AgentLabelPatch;
}

const SYSTEM_ERROR_PREFIX = "[System Error]";

function attachPersistenceCwd(
  handle: AgentPersistenceHandle | null,
  cwd: string,
): AgentPersistenceHandle | null {
  if (!handle) {
    return null;
  }
  return {
    ...handle,
    metadata: {
      ...handle.metadata,
      cwd,
    },
  };
}

interface SubscriptionRecord {
  callback: AgentSubscriber;
  agentId: string | null;
}

interface SteerEventBarrier {
  events: AgentStreamEvent[];
}

const BUSY_STATUSES: Set<AgentLifecycleStatus> = new Set(["initializing", "running"]);
const AgentIdSchema = z.guid();

function isAgentBusy(status: AgentLifecycleStatus): boolean {
  return BUSY_STATUSES.has(status);
}

function isTurnTerminalEvent(event: AgentStreamEvent): boolean {
  return (
    event.type === "turn_completed" ||
    event.type === "turn_failed" ||
    event.type === "turn_canceled"
  );
}

function abortMessage(reason: unknown, fallbackMessage: string): string {
  if (typeof reason === "string") return reason;
  if (reason instanceof Error) return reason.message;
  return fallbackMessage;
}

function createAbortError(signal: AbortSignal | undefined, fallbackMessage: string): Error {
  const message = abortMessage(signal?.reason, fallbackMessage);
  return Object.assign(new Error(message), { name: "AbortError" });
}

function validateAgentId(agentId: string, source: string): string {
  const result = AgentIdSchema.safeParse(agentId);
  if (!result.success) {
    throw new Error(`${source}: agentId must be a UUID`);
  }
  return result.data;
}

function applyLabelPatch(
  labels: Record<string, string>,
  patch: AgentLabelPatch,
): Record<string, string> {
  const nextLabels = { ...labels };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete nextLabels[key];
    } else {
      nextLabels[key] = value;
    }
  }
  return nextLabels;
}

function buildExplicitTimelineSeedForRegister(
  now: Date,
  options:
    | {
        timeline?: AgentTimelineItem[];
        timelineRows?: AgentTimelineRow[];
        timelineNextSeq?: number;
        createdAt?: Date;
        updatedAt?: Date;
      }
    | undefined,
): SeedAgentTimelineOptions | null {
  const hasTimeline = Boolean(options?.timeline?.length);
  const hasTimelineRows = Boolean(options?.timelineRows?.length);
  const hasTimelineNextSeq = options?.timelineNextSeq !== undefined;
  if (!hasTimeline && !hasTimelineRows && !hasTimelineNextSeq) {
    return null;
  }
  return {
    items: options?.timeline,
    rows: options?.timelineRows,
    nextSeq: options?.timelineNextSeq,
    timestamp: (options?.updatedAt ?? options?.createdAt ?? now).toISOString(),
  };
}

function buildImportedTimelineRows(entries: readonly ImportedTimelineEntry[]): AgentTimelineRow[] {
  const rows: AgentTimelineRow[] = [];
  for (const entry of entries) {
    if (entry.item.type === "user_message" && isSystemInjectedEnvelope(entry.item.text)) {
      continue;
    }
    rows.push({
      seq: rows.length + 1,
      timestamp: entry.timestamp ?? new Date().toISOString(),
      item: limitAgentTimelineItemContent(entry.item),
    });
  }
  return rows;
}

function resolveImportedAgentTitle(
  config: AgentSessionConfig,
  timelineRows: readonly AgentTimelineRow[],
): string | null {
  const initialPrompt = getFirstUserMessageTextFromRows(timelineRows);
  if (!initialPrompt) {
    return null;
  }
  const { explicitTitle, provisionalTitle } = resolveCreateAgentTitles({
    configTitle: config.title,
    initialPrompt,
  });
  return explicitTitle ?? provisionalTitle ?? null;
}

function getFirstUserMessageTextFromRows(rows: readonly AgentTimelineRow[]): string | null {
  for (const row of rows) {
    const item = row.item;
    if (item.type !== "user_message") {
      continue;
    }
    const text = item.text.trim();
    if (text) {
      return text;
    }
  }
  return null;
}

function shouldDetachFromArchivedParent(
  parent: StoredAgentRecord,
  child: StoredAgentRecord,
): boolean {
  const isCrossWorkspace =
    parent.workspaceId !== undefined &&
    child.workspaceId !== undefined &&
    parent.workspaceId !== child.workspaceId;
  return isCrossWorkspace || hasOpenAgentTab(child.labels);
}

function detachedAgentLabelPatch(labels: Record<string, string>): AgentLabelPatch {
  const patch: AgentLabelPatch = { [PARENT_AGENT_ID_LABEL]: null };
  for (const label of Object.keys(labels)) {
    if (isOpenAgentTabLabel(label)) {
      patch[label] = null;
    }
  }
  return patch;
}

/**
 * The configuration a quiet MCP refresh would apply, or null when the changes name a key outside
 * this API's authority (daemon-injected tools and prototype keys).
 */
function mcpRefreshConfig(
  config: AgentSessionConfig,
  changes: AgentMcpRefreshInput["changes"],
  toolPolicy: AgentMcpRefreshInput["toolPolicy"],
): AgentSessionConfig | null {
  if (
    Object.keys(changes).some((key) =>
      ["paseo", "__proto__", "constructor", "prototype"].includes(key),
    )
  ) {
    return null;
  }
  const mcpServers = { ...config.mcpServers };
  for (const [name, value] of Object.entries(changes)) {
    if (value === null) delete mcpServers[name];
    else mcpServers[name] = value;
  }
  // Omitted preserves the saved policy; null clears it. Adopting a capability on a
  // retained session needs both halves — the server entry and the preapproval —
  // applied together, or the resumed session sees a policy it cannot honour.
  const nextConfig: AgentSessionConfig = { ...config, mcpServers };
  if (toolPolicy === null) delete nextConfig.toolPolicy;
  else if (toolPolicy !== undefined) nextConfig.toolPolicy = toolPolicy;
  return nextConfig;
}

function resolveTrustedPlugins(plugins: TrustedPlugins | undefined): TrustedPlugins {
  return plugins ?? new TrustedPlugins();
}

interface CascadeArchiveAdmission {
  parentId: string;
  detach: boolean;
  handle?: TrustedOperationHandle;
}
type CascadeArchivePlan = Map<string, CascadeArchiveAdmission>;

export class AgentManager {
  readonly trustedPlugins: TrustedPlugins;
  private readonly reportRegistry?: NativeReportRegistry;
  private readonly reportLaunches = new Map<
    string,
    { origin: NativeReportOrigin; identity: NativeReportIdentity | null; witness: string }
  >();

  private prepareNativeReportLaunch(agentId: string) {
    if (!this.reportRegistry) return undefined;
    if (!this.reportLaunches.has(agentId) && this.reportLaunches.size >= 256)
      throw new Error("Native report launch resource limit");
    const launch: {
      origin: NativeReportOrigin;
      identity: NativeReportIdentity | null;
      witness: string;
    } = {
      origin: createNativeReportOrigin(() => {
        const current = this.currentReportIdentity(agentId);
        if (
          this.reportLaunches.get(agentId) !== launch ||
          !launch.identity ||
          JSON.stringify(current) !== JSON.stringify(launch.identity)
        )
          throw new Error("Native report launch replaced or unavailable");
        return launch.identity;
      }),
      identity: null,
      witness: randomUUID(),
    };
    this.reportLaunches.set(agentId, launch);
    return launch;
  }

  /** HTTP authentication must already have passed; this extra witness binds the particular native launch only. */
  nativeReportMcpOrigin(agentId: string | undefined, witness: string | undefined) {
    if (!witness) return undefined;
    const launch = agentId ? this.reportLaunches.get(agentId) : undefined;
    if (!launch || launch.witness !== witness) throw new Error("Native MCP launch witness refused");
    requireNativeReportOrigin(launch.origin);
    return forkNativeReportOrigin(launch.origin);
  }

  captureManagedArtifactInvocation(
    origin: NativeReportOrigin,
    raw: unknown,
    signal?: AbortSignal,
  ): NativeArtifactInvocation {
    const input = NativeArtifactProduceInputSchema.parse(structuredClone(raw));
    const source = requireNativeReportOrigin(origin);
    const agent = this.requireSessionAgent(source.agentId),
      provider = agent.session;
    const turn = agent.activeForegroundTurnId;
    const registry = this.reportRegistry;
    if (!turn || !registry || !this.nativeReceipts)
      throw new Error("Active registered native artifact invocation required");
    const relation = registry.requireParent(source, input.scope);
    const permit = registry.captureArtifactTool(source, input.scope);
    const sequence = this.trustedPlugins.requireSequence(source.agentId);
    const guard = () => {
      signal?.throwIfAborted();
      permit();
      const current = this.trustedPlugins.requireSequence(source.agentId);
      if (
        !this.acceptingAgentRegistrations ||
        this.agents.get(source.agentId) !== agent ||
        agent.session !== provider ||
        agent.activeForegroundTurnId !== turn ||
        agent.archivedAt ||
        current.boot !== sequence.boot ||
        current.humanAt !== sequence.humanAt ||
        nativeEvidenceDigest(requireNativeReportOrigin(origin)) !== nativeEvidenceDigest(source) ||
        nativeEvidenceDigest(this.currentReportIdentity(source.agentId)) !==
          nativeEvidenceDigest(source) ||
        nativeEvidenceDigest(registry.requireParent(source, input.scope)) !==
          nativeEvidenceDigest(relation)
      )
        throw new Error("Original artifact invocation changed");
    };
    guard();
    const bytes = Buffer.from(input.text, "utf8");
    if (bytes.length < 1 || bytes.length > 128 * 1024)
      throw new Error("Managed output byte limit exceeded");
    const operationDigest = nativeEvidenceDigest({
      purpose: "declared-output",
      agentId: source.agentId,
      native: source.sessionId,
      turn,
      operationId: input.operationId,
    });
    const id = `${operationDigest.slice(0, 8)}-${operationDigest.slice(8, 12)}-4${operationDigest.slice(13, 16)}-8${operationDigest.slice(17, 20)}-${operationDigest.slice(20, 32)}`;
    const at = Date.now();
    const body = {
      version: 4 as const,
      recordType: "native_managed_artifact_attempt" as const,
      source,
      sourceEpoch: relation.sourceEpoch,
      recipient: relation.parent,
      recipientEpoch: relation.parentEpoch,
      completionBodyDigest: nativeEvidenceDigest(input),
      artifactReservation: {
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
      entry: { id, operationDigest, scope: input.scope, at, expiresAt: at + 6 * 60 * 60 * 1000 },
    };
    const claim = ManagedArtifactClaimSchema.parse({
      ...body,
      bytes: 4096,
      fingerprint: nativeEvidenceDigest(body),
    });
    return createNativeArtifactInvocation({
      input,
      claim,
      requireCurrent: guard,
      origin,
      identity: source,
    });
  }

  async produceManagedArtifact(handle: NativeArtifactInvocation) {
    const captured = consumeNativeArtifactInvocation(handle);
    if (!this.nativeReceipts) throw new Error("Native artifact ledger unavailable");
    const record = await this.nativeReceipts.produceDeclaredArtifact(
      captured.claim,
      Buffer.from(captured.input.text, "utf8"),
      captured.requireCurrent,
    );
    captured.requireCurrent();
    const result = bindReportPublication(
      NativeArtifactProduceOutputSchema.parse({
        id: record.entry.id,
        scope: record.entry.scope,
        metadataCommitted: true,
        basis: "host_materialized_declared_output",
        contentReadAvailable: false,
      }),
      captured.requireCurrent,
    );
    rememberNativeReportPublication(captured.origin, result);
    return result;
  }

  captureNativeReportCreation(origin: NativeReportOrigin): NativeReportCreation {
    if (!this.reportRegistry) throw new Error("Native report registration unavailable");
    const parent = requireNativeReportOrigin(origin);
    return this.reportRegistry.captureCreation(parent, () => {
      if (JSON.stringify(requireNativeReportOrigin(origin)) !== JSON.stringify(parent))
        throw new Error("Native report creator changed");
    });
  }

  private intercomRates?: IntercomRates;
  private readonly nativeReportTurns = new Set<string>();
  private readonly nativeQuotaLimitEpisodes = new WeakMap<ActiveManagedAgent, string>();

  private createReportRegistry(
    file: string | undefined,
    grantDirectory: string | undefined,
  ): NativeReportRegistry | undefined {
    if (!file) return undefined;
    const rates = new IntercomRates(`${file}.rates.json`);
    registerNativeIntercomRates(this.trustedPlugins.management, rates);
    this.intercomRates = rates;
    const registry = new NativeReportRegistry(
      file,
      (agentId) => this.currentReportIdentity(agentId),
      10000,
      grantDirectory,
    );
    registerNativeReportRegistry(this.trustedPlugins.management, registry);
    registerOwnerReportRead(
      this.trustedPlugins.management,
      registry,
      (id) => this.currentReportIdentity(id),
      () => this.nativeReceipts,
    );
    registerOwnerEvidenceRead(
      this.trustedPlugins.management,
      registry,
      (id) => this.currentReportIdentity(id),
      () => this.nativeReceipts,
    );
    registerOwnerArtifactContent(
      this.trustedPlugins.management,
      registry,
      (id) => this.currentReportIdentity(id),
      () => this.nativeReceipts,
    );
    registerOwnerManagedArtifactRead(
      this.trustedPlugins.management,
      registry,
      (id) => this.currentReportIdentity(id),
      () => this.nativeReceipts,
    );
    this.trustedPlugins.management.registerOwnerHandler(
      "intercom-status",
      async (command, owner) => {
        const { agentId } = IntercomStatusInputSchema.parse(command.input);
        owner.requireOwner();
        const identity = this.currentReportIdentity(agentId);
        const guard = () => {
          owner.requireOwner();
          if (JSON.stringify(this.currentReportIdentity(agentId)) !== JSON.stringify(identity))
            throw new Error("Native intercom status identity changed");
        };
        const snapshot = await rates.snapshot(guard);
        guard();
        const registration = identity ? await registry.ownerStatus(identity, guard) : null;
        guard();
        const agent = this.agents.get(agentId);
        return IntercomStatusSchema.parse({
          version: 1,
          identity,
          registration,
          settingsInitialized: snapshot.initialized,
          queueAvailable:
            !!identity &&
            snapshot.initialized &&
            !!agent?.session &&
            supportsNativeQueuedProvider(agent.session),
          reportLinked:
            !!identity &&
            !!registration?.parent &&
            registry.ownsFinish(identity, registration.parent.agentId),
          supportedProviders: ["codex"],
        });
      },
    );
    this.trustedPlugins.management.registerHandoffObserver((sourceId, operationId) => {
      const source = this.currentReportIdentity(sourceId);
      if (!source || !this.nativeReceipts) return undefined;
      try {
        const batches = registry.captureLifecycleReports(
          source,
          "handoff",
          operationId,
          Date.now(),
        );
        return () => {
          if (JSON.stringify(this.currentReportIdentity(sourceId)) !== JSON.stringify(source))
            return;
          for (const batch of batches)
            void this.collectNativeReport(batch).catch(() => {
              this.logger.warn({ kind: "handoff" }, "Native handoff metadata admission refused");
            });
        };
      } catch {
        return undefined;
      }
    });
    return registry;
  }

  /** Host-private identity fence. No caller labels, credentials, mode or human cursor affect reports. */
  private currentReportIdentity(agentId: string): NativeReportIdentity | null {
    const agent = this.agents.get(agentId);
    if (
      !this.acceptingAgentRegistrations ||
      !agent?.session ||
      !agent.instanceId ||
      agent.archivedAt ||
      agent.lifecycle === "initializing" ||
      agent.pendingReplacement ||
      this.inFlightAgentCloses.has(agentId) ||
      this.lifecycleMutationTails.has(agentId) ||
      this.mcpRefreshes.has(agentId)
    )
      return null;
    try {
      // Provider id is synchronous and current; persisted/runtime projections may lag a replacement.
      // All three handles must agree. Never transfer a registered old identity to a new native id.
      const nativeId = agent.session.id;
      const handle = agent.session.describePersistence();
      if (
        !nativeId ||
        handle?.provider !== agent.provider ||
        handle.sessionId !== nativeId ||
        agent.persistence?.sessionId !== nativeId ||
        agent.runtimeInfo?.sessionId !== nativeId
      )
        return null;
      const sequence = this.trustedPlugins.requireSequence(agentId);
      return {
        agentId,
        instanceId: agent.instanceId,
        sessionId: nativeId,
        boot: sequence.boot,
      };
    } catch {
      return null;
    }
  }
  private captureReportRelaunch(agentId: string) {
    const source = this.currentReportIdentity(agentId);
    const original = this.agents.get(agentId);
    if (!source || !original?.session || !this.reportRegistry) return undefined;
    const admission = this.readMcpRefreshAdmission(original);
    if (!admission.allowed || ["unmanaged", "unavailable"].includes(admission.revision))
      return undefined;
    let commit: ReturnType<NativeReportRegistry["captureRelaunch"]>;
    try {
      commit = this.reportRegistry.captureRelaunch(source, admission.revision);
    } catch {
      return undefined;
    } // Unknown legacy registrations cannot be adopted by refresh.
    const sequence = this.trustedPlugins.requireSequence(agentId);
    const cursor = { boot: sequence.boot, humanAt: sequence.humanAt };
    const requireAdmission = (agent: ActiveManagedAgent) => {
      const current = this.trustedPlugins.requireSequence(agentId);
      const fresh = this.readMcpRefreshAdmission(agent);
      if (
        current.boot !== cursor.boot ||
        current.humanAt !== cursor.humanAt ||
        !fresh.allowed ||
        fresh.revision !== admission.revision
      )
        throw new Error("Exact native relaunch intent changed");
    };
    return {
      beforeClose: () => {
        if (
          this.agents.get(agentId) !== original ||
          original.session.id !== source.sessionId ||
          original.session.describePersistence()?.sessionId !== source.sessionId ||
          original.persistence?.sessionId !== source.sessionId ||
          original.runtimeInfo?.sessionId !== source.sessionId
        )
          throw new Error("Captured native relaunch source changed");
        requireAdmission(original);
      },
      finish: async () => {
        await this.lifecycleMutationTails.get(agentId);
        const next = this.requireSessionAgent(agentId);
        const identity = this.currentReportIdentity(agentId);
        if (!identity) throw new Error("Native relaunch identity unavailable");
        const guard = () => {
          const fresh = this.currentReportIdentity(agentId);
          if (
            this.agents.get(agentId) !== next ||
            JSON.stringify(fresh) !== JSON.stringify(identity)
          )
            throw new Error("Native relaunch replacement changed");
          requireAdmission(next);
        };
        guard();
        await commit(identity, guard);
        guard();
        const launch = this.reportLaunches.get(agentId);
        if (launch) launch.identity = identity;
      },
    };
  }

  private nativeReceipts?: MessageReceipts;
  private readonly drainingMessages = new Set<string>();

  /** Attach the existing websocket ledger once; there is no second queue owner. */
  setNativeMessageReceipts(receipts: MessageReceipts): void {
    if (this.nativeReceipts && this.nativeReceipts !== receipts)
      throw new Error("Native receipt owner changed");
    if (!this.nativeReceipts)
      registerNativeReceiptMaintenance(this.trustedPlugins.management, receipts);
    this.nativeReceipts = receipts;
  }

  /** Native catalog read/consume domain only. The launch witness is not an action credential. */
  async nativeReportInbox(origin: NativeReportOrigin, eventId?: string) {
    if (!this.reportRegistry || !this.nativeReceipts)
      throw new Error("Native report inbox unavailable");
    const identity = requireNativeReportOrigin(origin);
    const reader = this.reportRegistry.readerForNativeIdentity(identity);
    const result =
      eventId === undefined
        ? await this.nativeReceipts.reportInbox(reader)
        : await this.nativeReceipts.consumeReport(reader, eventId);
    requireNativeReportOrigin(origin);
    checkReportPublication(result);
    rememberNativeReportPublication(origin, result);
    return result;
  }

  /** Owned controller pipe only; reports never enter management or action dispatch. */
  reportInboxRequest(input: unknown) {
    if (!this.reportRegistry || !this.nativeReceipts || !this.acceptingAgentRegistrations)
      throw new Error("Native report inbox unavailable");
    return new NativeReportInbox(this.reportRegistry, this.nativeReceipts).request(input);
  }

  /** Registry-branded host events only. Action provenance cannot mint this report purpose. */
  private collectNativeReport(batch: NativeReportBatch) {
    const receipts = this.nativeReceipts;
    const rates = this.intercomRates;
    if (!receipts || !rates) throw new Error("Native report delivery unavailable");
    return receipts.collectReport(
      batch,
      (currentBatch, messageId) => {
        const snapshot = requireNativeReportBatch(currentBatch).data;
        const target = this.requireSessionAgent(snapshot.parent.agentId);
        const provider = target.session;
        const notice = "Native report metadata is available in supervisor_inbox.";
        let rateCheck: (() => void) | undefined;
        const authorize = () => {
          requireNativeReportBatch(currentBatch);
          const identity = this.currentReportIdentity(snapshot.parent.agentId);
          if (
            !identity ||
            this.agents.get(snapshot.parent.agentId) !== target ||
            target.session !== provider ||
            identity.instanceId !== snapshot.parent.instanceId ||
            identity.sessionId !== snapshot.parent.sessionId ||
            identity.boot !== snapshot.parent.boot
          )
            throw new Error("Native report recipient identity changed");
          rateCheck?.();
        };
        const principal = {
          parent: snapshot.parent,
          parentEpoch: snapshot.parentEpoch,
          digest: snapshot.digest,
        };
        return {
          agentId: snapshot.parent.agentId,
          messageId,
          request: notice,
          principal,
          boot: snapshot.parent.boot,
          attachmentBytes: 0,
          reportBatch: currentBatch,
          authorize,
          canDispatch: () => {
            authorize();
            return supportsNativeQueuedProvider(provider);
          },
          prepareDispatch: async () => {
            rateCheck = await rates.reserve(
              messageId,
              "report",
              snapshot.parent.agentId,
              principal,
              () => {
                requireNativeReportBatch(currentBatch);
                const identity = this.currentReportIdentity(snapshot.parent.agentId);
                if (
                  !identity ||
                  identity.sessionId !== snapshot.parent.sessionId ||
                  identity.instanceId !== snapshot.parent.instanceId ||
                  identity.boot !== snapshot.parent.boot ||
                  this.agents.get(snapshot.parent.agentId) !== target ||
                  target.session !== provider
                )
                  throw new Error("Native report rate identity changed");
              },
            );
            authorize();
          },
          start: async (finalCheck: () => void) =>
            this.trustedPlugins.daemon(async () => {
              authorize();
              const capability = createNativeQueuedDispatch(() => {
                if (target.pendingPermissions.size > 0 || !supportsNativeQueuedProvider(provider))
                  throw new Error("Native report dispatch boundary changed");
                authorize();
                finalCheck();
              });
              const iterator = this.streamAgent(snapshot.parent.agentId, notice, {
                clientMessageId: `${FINISH_NOTIFICATION_MESSAGE_PREFIX}${messageId}`,
                [NATIVE_QUEUED_FINAL]: capability,
              });
              this.nativeReportTurns.add(snapshot.parent.agentId);
              try {
                await iterator.next();
              } catch (error) {
                this.nativeReportTurns.delete(snapshot.parent.agentId);
                const accepted = nativeQueuedAcceptance(capability);
                if (accepted) return accepted;
                throw error;
              }
              const accepted = nativeQueuedAcceptance(capability);
              void (async () => {
                for await (const event of iterator) void event;
              })()
                .catch(() => {})
                .finally(() => {
                  this.nativeReportTurns.delete(snapshot.parent.agentId);
                });
              if (!accepted) throw new Error("Native report provider acceptance unavailable");
              return accepted;
            }),
        };
      },
      (agentId) => this.scheduleNativeMessages(agentId),
    );
  }

  /** Native verified links alone suppress legacy transcript-bearing finish delivery. */
  nativeReportOwnsFinish(childId: string, parentId: string): boolean {
    const source = this.currentReportIdentity(childId);
    return !!source && this.reportRegistry?.ownsFinish(source, parentId) === true;
  }

  /** A refusal-only guard for legacy notice admission; it creates no authority or report handle. */
  captureFinishNotificationCheck(childId: string, parentId: string): () => void {
    const child = this.agents.get(childId),
      parent = this.agents.get(parentId);
    const childSession = child?.session,
      parentSession = parent?.session;
    const childInstance = child?.instanceId,
      parentInstance = parent?.instanceId;
    const childNative = childSession?.id,
      parentNative = parentSession?.id;
    return () => {
      if (
        !child ||
        !parent ||
        !childSession ||
        !parentSession ||
        !childNative ||
        !parentNative ||
        this.agents.get(childId) !== child ||
        this.agents.get(parentId) !== parent ||
        child.session !== childSession ||
        parent.session !== parentSession ||
        child.instanceId !== childInstance ||
        parent.instanceId !== parentInstance ||
        childSession.id !== childNative ||
        parentSession.id !== parentNative ||
        child.pendingReplacement ||
        parent.pendingReplacement ||
        this.inFlightAgentCloses.has(parentId) ||
        this.mcpRefreshes.has(parentId) ||
        this.lifecycleMutationTails.has(parentId)
      )
        throw new Error("Finish notification native identity changed");
    };
  }

  private reportObservedQuotaLimit(
    agent: ActiveManagedAgent,
    quota: AgentQuotaSnapshot,
    operationId: string,
  ): void {
    const parsed = AgentQuotaSnapshotSchema.safeParse(quota);
    if (!parsed.success) return;
    quota = parsed.data;
    const source = this.currentReportIdentity(agent.id);
    const at = Date.parse(quota.observedAt),
      now = Date.now();
    if (
      !source ||
      quota.provider !== "codex" ||
      quota.sessionId !== source.sessionId ||
      !Number.isFinite(at) ||
      at > now ||
      now - at > 30000 ||
      this.nativeReportTurns.has(agent.id)
    )
      return;
    const denied =
      quota.ordinaryUsageAllowed === false ||
      quota.limits.some(
        (limit) =>
          limit.model === quota.model &&
          limit.model !== null &&
          (limit.spendControlReached === true || !!limit.rateLimitReachedType),
      );
    if (!denied) {
      this.nativeQuotaLimitEpisodes.delete(agent);
      return;
    }
    if (!this.reportRegistry || !this.nativeReceipts) return;
    try {
      const batches = this.reportRegistry.captureLifecycleReports(
        source,
        "usage-limit",
        operationId,
        now,
      );
      const key = JSON.stringify({
        source,
        model: quota.model,
        tier: quota.serviceTier,
        account: quota.accountScope,
        epochs: batches.map((batch) => {
          const data = requireNativeReportBatch(batch).data;
          return [data.parentEpoch, data.members[0]?.sourceEpoch];
        }),
      });
      if (this.nativeQuotaLimitEpisodes.get(agent) === key) return;
      this.nativeQuotaLimitEpisodes.set(agent, key);
      for (const batch of batches)
        void this.collectNativeReport(batch).catch(() => {
          this.logger.warn({ kind: "usage-limit" }, "Native quota metadata admission refused");
        });
    } catch {
      /* Unknown/stale registrations confer no report authority. */
    }
  }

  private reportObservedLifecycle(
    agent: ActiveManagedAgent,
    kind: "ended" | "needs-you" | "blocked" | "usage-limit",
    lifecycleId: string | undefined,
    isForegroundEvent: boolean,
  ): void {
    if (
      !this.reportRegistry ||
      !this.nativeReceipts ||
      !lifecycleId ||
      !isForegroundEvent ||
      this.nativeReportTurns.has(agent.id)
    )
      return;
    const source = this.currentReportIdentity(agent.id);
    if (!source || this.agents.get(agent.id) !== agent) return;
    try {
      const batches = this.reportRegistry.captureLifecycleReports(
        source,
        kind,
        lifecycleId,
        Date.now(),
      );
      for (const batch of batches)
        void this.collectNativeReport(batch).catch(() => {
          // Refusal never promotes a wake to delivery or exposes provider/body/account details.
          this.logger.warn({ kind }, "Native report metadata admission refused");
        });
    } catch {
      // Unknown/legacy/root sessions do not infer report rights from labels or ownership.
    }
  }

  private readonly nativeReceiptPublication = new WeakMap<NativeMessageReceipt, () => void>();

  /** Host-only protected publication: a wire object cannot supply an admission witness. */
  assertNativeQueuedReceiptCurrent(receipt: NativeMessageReceipt): void {
    const requireCurrent = this.nativeReceiptPublication.get(receipt);
    if (!requireCurrent) throw new Error("Native queued receipt publication unavailable");
    requireCurrent();
  }

  async queueNativePrompt(
    agentId: string,
    prompt: AgentPromptInput,
    messageId: string,
    payload: TrustedPayloadV11,
    requireSource?: () => void,
  ): Promise<NativeMessageReceipt> {
    const checkSource = () => {
      const result: unknown = requireSource?.();
      if (result && typeof result === "object" && "then" in result) {
        void Promise.resolve(result).catch(() => {});
        throw new Error("Native queue source check must be synchronous");
      }
    };
    checkSource();
    payload = structuredClone(payload);
    const receipts = this.nativeReceipts;
    if (!receipts || !this.acceptingAgentRegistrations)
      throw new Error("Native boundary queue unavailable");
    // Retained content is native normalized text only until resource ownership for attachments is proven.
    if (typeof prompt !== "string") throw new Error("Native queued attachments unavailable");
    const agent = this.requireSessionAgent(agentId);
    const provider = agent.session;
    // Production adapters register only after their concrete submission/acknowledgement seam is proved.
    if (!supportsNativeQueuedProvider(provider))
      throw new Error("Native queued provider unavailable");
    if (prompt.trimStart().startsWith("/")) throw new Error("Native queued commands unavailable");
    const identity = this.currentReportIdentity(agentId);
    if (!identity) throw new Error("Native queued current identity unavailable");
    const instanceId = agent.instanceId;
    const nativeSessionId = identity.sessionId;
    let handle: TrustedOperationHandle | undefined;
    this.withInput(
      agentId,
      "prompt",
      messageId,
      (captured) => {
        handle = captured;
      },
      payload,
      undefined,
      "enqueue",
    );
    if (!handle) throw new Error("Native queue operation unavailable");
    const sequence = this.trustedPlugins.requireSequence(agentId);
    const original = handle;
    if (requireSource && !original.operation.pluginId)
      throw new Error("Native queue requires authenticated delegated input provenance");
    const options = { clientMessageId: messageId, [TRUSTED_OPERATION]: original };
    let ratePermit: (() => void) | undefined;
    const authorizeIdentity = () => {
      checkSource();
      const current = this.trustedPlugins.requireSequence(agentId);
      if (
        !this.acceptingAgentRegistrations ||
        this.agents.get(agentId) !== agent ||
        agent.instanceId !== instanceId ||
        agent.session !== provider ||
        !supportsNativeQueuedProvider(provider) ||
        this.currentReportIdentity(agentId)?.sessionId !== nativeSessionId ||
        agent.archivedAt ||
        current.boot !== sequence.boot ||
        current.humanAt !== sequence.humanAt
      )
        throw new Error("Native queued identity revoked");
      this.withInput(agentId, "prompt", messageId, () => {}, payload, original, "enqueue");
    };
    const authorize = () => (ratePermit ? ratePermit() : authorizeIdentity());
    if (requireSource) {
      if (!this.intercomRates) throw new Error("Native queue owner Settings unavailable");
      ratePermit = await this.intercomRates.reserve(
        `native-message:${createHash("sha256").update(messageId).digest("hex")}`,
        "channel",
        agentId,
        { agentId, messageId, payload },
        authorizeIdentity,
      );
      authorize();
    }
    const receipt = await receipts.enqueue({
      agentId,
      messageId,
      request: payload,
      principal: {
        agentId,
        messageId,
        payloadDigest: original.operation.payloadDigest,
        pluginId: original.operation.pluginId,
        attemptId: original.operation.attemptId,
        instanceId,
        nativeSessionId,
        sequence,
      },
      boot: sequence.boot,
      attachmentBytes: 0,
      observe: (outcome) => {
        try {
          this.trustedPlugins.nativeQueuedReceipt(agent, original, outcome);
        } catch {
          this.logger.error(
            { agentId },
            "Native receipt observation refused; ledger fact retained",
          );
        }
      },
      authorize,
      start: async (finalCheck) => {
        const capability = createNativeQueuedDispatch(() => {
          if (agent.pendingPermissions.size > 0)
            throw new Error("Native queued permission boundary changed");
          finalCheck();
        });
        const iterator = this.streamAgent(agentId, prompt, {
          ...options,
          [NATIVE_QUEUED_FINAL]: capability,
        });
        try {
          await iterator.next();
        } catch (error) {
          const accepted = nativeQueuedAcceptance(capability);
          if (accepted) return accepted; // A later close cannot undo an already observed native fact.
          throw error;
        }
        const accepted = nativeQueuedAcceptance(capability);
        void (async () => {
          for await (const event of iterator) {
            void event; // Manager already broadcasts each event.
          }
        })().catch(() => {});
        if (!accepted) throw new Error("Native provider acceptance unavailable");
        return accepted;
      },
    });
    authorize();
    this.nativeReceiptPublication.set(receipt, authorize);
    this.scheduleNativeMessages(agentId);
    return receipt;
  }

  private scheduleNativeMessages(agentId: string): void {
    if (
      !this.nativeReceipts ||
      this.drainingMessages.has(agentId) ||
      !this.acceptingAgentRegistrations
    )
      return;
    const agent = this.agents.get(agentId);
    if (
      !agent ||
      agent.activeForegroundTurnId ||
      this.runs.hasRun(agentId) ||
      agent.pendingPermissions.size > 0
    )
      return;
    this.drainingMessages.add(agentId);
    let more = false;
    void this.runForegroundMutation(agentId, async () => {
      const result = await this.nativeReceipts!.dispatchNext(
        agentId,
        () =>
          this.agents.get(agentId) === agent &&
          !agent.activeForegroundTurnId &&
          !this.runs.hasRun(agentId) &&
          agent.pendingPermissions.size === 0,
        async (ticket, finalCheck) => {
          if (!ticket.start) throw new Error("Native queued operation unavailable");
          return ticket.start(finalCheck);
        },
      );
      more = Boolean(result?.pendingCount);
    })
      .catch((error) =>
        this.logger.error({ err: error, agentId }, "Native message boundary refused"),
      )
      .finally(() => {
        this.drainingMessages.delete(agentId);
        if (more) this.scheduleNativeMessages(agentId);
      });
  }

  withInput<T>(
    agentId: string,
    kind: TrustedInputKind,
    messageId: string | undefined,
    operation: (handle?: TrustedOperationHandle) => T,
    payload?: TrustedPayloadV11 | (() => TrustedPayloadV11),
    handle?: TrustedOperationHandle,
    phase?: "enqueue",
  ): T {
    const agent = this.getAgent(agentId) ?? { id: agentId };
    return this.trustedPlugins.input(
      agent,
      kind,
      messageId,
      () => operation(this.trustedPlugins.captureOperation()),
      payload,
      handle,
      phase,
    );
  }

  private async withStoredInput<T>(
    agentId: string,
    kind: TrustedInputKind,
    messageId: string | undefined,
    operation: (handle?: TrustedOperationHandle) => T,
    payload?: TrustedPayloadV11 | (() => TrustedPayloadV11),
    handle?: TrustedOperationHandle,
  ): Promise<Awaited<T>> {
    const agent = this.getAgent(agentId) ?? (await this.registry?.get(agentId)) ?? { id: agentId };
    return await this.trustedPlugins.input(
      agent,
      kind,
      messageId,
      () => operation(this.trustedPlugins.captureOperation()),
      payload,
      handle,
    );
  }

  private readonly pluginLifecycle: PluginLifecycle | undefined;
  private readonly clients = new Map<AgentProvider, AgentClient>();
  private readonly providerEnabled = new Map<AgentProvider, boolean>();
  private readonly providerDefinitions = new Map<AgentProvider, ProviderEnabledFlag>();
  private readonly agents = new Map<string, LiveManagedAgent>();
  // FIX-8 W3: permission requests a trusted plugin answered before they were surfaced, per agent.
  private readonly automaticPermissions = new Map<
    string,
    Map<string, { current: () => boolean; completed: boolean }>
  >();
  private readonly automaticResolutionOrigins = new WeakMap<
    object,
    { current: () => boolean; completed: boolean }
  >();
  private readonly timelineStore = new InMemoryAgentTimelineStore();
  private readonly providerSubagents = new ProviderSubagentStore();
  private readonly agentsAwaitingInitialSnapshotPersist = new Set<string>();
  private readonly sessionEventTails = new Map<string, Promise<void>>();
  private readonly steerEventBarriers = new Map<string, SteerEventBarrier>();
  private readonly foregroundMutationTails = new Map<string, Promise<void>>();
  private readonly runs = new AgentRunState();
  private backgroundWorkSampler: BackgroundWorkSampler | null = null;
  private readonly subscribers = new Set<SubscriptionRecord>();
  private readonly idFactory: () => string;
  private readonly registry?: AgentStorage;
  private readonly durableTimelineStore?: AgentTimelineStore;
  private readonly timelineRetention: "keep" | "purge" | undefined;
  private readonly previousStatuses = new Map<string, AgentLifecycleStatus>();
  private readonly backgroundTasks = new Set<Promise<void>>();
  private readonly agentRegistrationTasks = new Set<Promise<void>>();
  private readonly inFlightAgentCloses = new Map<string, Promise<void>>();
  private readonly reloadedSessionCloses = new WeakMap<AgentSession, Promise<void>>();
  private readonly mcpRefreshes = new Set<string>();
  private readonly failedMcpRefreshCloses = new WeakSet<AgentSession>();
  private readonly mcpRevisionKey = randomUUID();
  private readonly mcpRuntimeRevisions = new WeakMap<AgentSession, string>();
  private readonly lifecycleMutationTails = new Map<string, Promise<void>>();
  private readonly agentStreamCoalescer: AgentStreamCoalescer;
  private readonly timelineWrites = new Map<string, Promise<void>>();
  private readonly timelineFailures = new Map<string, unknown>();
  private readonly coalescedTimelineWrites = new Map<string, Promise<void>>();
  private mcpBaseUrl: string | null;
  private readonly mcpAuthToken: string | null;
  private paseoToolsEnabled = true;
  private paseoToolCatalogFactory: PaseoToolCatalogFactory | null = null;
  private readonly paseoToolPolicies = new Map<string, ProviderPaseoToolsPolicy | undefined>();
  private readonly resolvePaseoToolPolicy: (
    provider: AgentProvider,
  ) => ProviderPaseoToolsPolicy | undefined;
  private appendSystemPrompt: string;
  private onAgentAttention?: AgentAttentionCallback;
  private onAgentArchived?: AgentArchivedCallback;
  private onWorkspaceStateMayHaveChanged?: (params: { cwd: string }) => void;
  private logger: Logger;
  private readonly rescueTimeouts: Required<AgentManagerRescueTimeouts>;
  private readonly beforeSteerUnavailableFallback?: AgentManagerOptions["beforeSteerUnavailableFallback"];
  private readonly mcpRefreshAdmission?: AgentManagerOptions["mcpRefreshAdmission"];
  private acceptingAgentRegistrations = true;

  constructor(options: AgentManagerOptions) {
    this.trustedPlugins = resolveTrustedPlugins(options.trustedPlugins);
    this.trustedPlugins.setNativeIdentityReader((id) => {
      const identity = this.currentReportIdentity(id);
      return identity
        ? { instanceId: identity.instanceId, nativeSessionId: identity.sessionId }
        : null;
    });
    this.reportRegistry = this.createReportRegistry(
      options.reportRegistryFile,
      options.reportGrantDirectory,
    );
    this.pluginLifecycle = options.pluginLifecycle;
    this.mcpRefreshAdmission = options.mcpRefreshAdmission;
    this.idFactory = options?.idFactory ?? (() => randomUUID());
    this.registry = options?.registry;
    this.durableTimelineStore = options?.durableTimelineStore;
    this.timelineRetention = options.timelineRetention;
    this.onAgentAttention = options?.onAgentAttention;
    this.onWorkspaceStateMayHaveChanged = options?.onWorkspaceStateMayHaveChanged;
    this.mcpBaseUrl = options?.mcpBaseUrl ?? null;
    this.mcpAuthToken = options?.mcpAuthToken ?? null;
    this.configurePaseoTools(options);
    this.resolvePaseoToolPolicy = options.resolvePaseoToolPolicy ?? (() => undefined);
    this.appendSystemPrompt = options.appendSystemPrompt ?? "";
    this.logger = options.logger.child({ module: "agent", component: "agent-manager" });
    this.rescueTimeouts = {
      reloadSessionCloseMs:
        options.rescueTimeouts?.reloadSessionCloseMs ?? RELOAD_SESSION_CLOSE_TIMEOUT_MS,
      interruptSessionMs:
        options.rescueTimeouts?.interruptSessionMs ?? INTERRUPT_SESSION_TIMEOUT_MS,
    };
    this.beforeSteerUnavailableFallback = options.beforeSteerUnavailableFallback;
    this.agentStreamCoalescer = new AgentStreamCoalescer({
      windowMs: options.agentStreamCoalesceWindowMs ?? AGENT_STREAM_COALESCE_DEFAULT_WINDOW_MS,
      timers: { setTimeout, clearTimeout },
      onFlush: ({ agentId, item, provider, turnId }) => {
        const task = this.recordAndDispatchTimelineItem(agentId, item, provider, turnId)
          .then((event) => {
            this.notifyForegroundTurnWaiters(agentId, event);
            return undefined;
          })
          .catch((error) => {
            this.timelineFailures.set(agentId, error);
            this.logger.error({ err: error, agentId }, "Failed to commit coalesced timeline");
          });
        this.coalescedTimelineWrites.set(agentId, task);
        void task.then(() => {
          if (this.coalescedTimelineWrites.get(agentId) === task)
            this.coalescedTimelineWrites.delete(agentId);
          return undefined;
        });
        this.trackBackgroundTask(task);
      },
    });
    this.updateProviderRegistry({
      providerDefinitions: options.providerDefinitions ?? {},
      clients: options.clients ?? {},
    });
  }

  private configurePaseoTools(options: AgentManagerOptions): void {
    this.paseoToolsEnabled = options.paseoToolsEnabled ?? true;
    this.paseoToolCatalogFactory = options.paseoToolCatalogFactory ?? null;
  }

  registerClient(provider: AgentProvider, client: AgentClient): void {
    this.clients.set(provider, client);
  }

  updateProviderRegistry(input: {
    providerDefinitions: ProviderEnabledMap;
    clients: ProviderClientMap;
    retiredProviders?: readonly AgentProvider[];
  }): void {
    this.providerEnabled.clear();
    this.providerDefinitions.clear();
    for (const [provider, definition] of Object.entries(input.providerDefinitions)) {
      if (definition) {
        this.providerEnabled.set(provider, definition.enabled);
        this.providerDefinitions.set(provider, definition);
      }
    }

    this.clients.clear();
    for (const [provider, client] of Object.entries(input.clients)) {
      if (client) {
        this.clients.set(provider, client);
      }
    }

    for (const provider of input.retiredProviders ?? []) {
      for (const agent of this.agents.values()) {
        if (agent.provider !== provider) continue;
        void this.trustedPlugins
          .daemon(() => this.closeAgent(agent.id))
          .catch((error) => {
            this.logger.warn(
              { err: error, agentId: agent.id, provider },
              "Failed to close agent after provider retirement",
            );
          });
      }
    }
  }

  getRegisteredProviderIds(): AgentProvider[] {
    return Array.from(this.clients.keys());
  }

  setAgentAttentionCallback(callback: AgentAttentionCallback): void {
    this.onAgentAttention = callback;
  }

  setAgentArchivedCallback(callback: AgentArchivedCallback): void {
    this.onAgentArchived = callback;
  }

  setMcpBaseUrl(url: string | null): void {
    this.mcpBaseUrl = url;
  }

  prepareForShutdown(): void {
    this.acceptingAgentRegistrations = false;
  }

  setPaseoToolsEnabled(enabled: boolean): void {
    this.paseoToolsEnabled = enabled;
  }

  setPaseoToolCatalogFactory(factory: PaseoToolCatalogFactory | null): void {
    this.paseoToolCatalogFactory = factory;
  }

  getPaseoToolPolicy(agentId: string): ProviderPaseoToolsPolicy | undefined {
    return this.paseoToolPolicies.get(agentId);
  }

  /**
   * Capability token the daemon's own MCP clients must present to the Agent MCP
   * endpoint when a daemon password is configured. Read by the per-client
   * session to authenticate its own MCP connection. Stays in the daemon — never
   * sent to remote clients.
   */
  getMcpAuthToken(): string | null {
    return this.mcpAuthToken;
  }

  setAppendSystemPrompt(prompt: string | null | undefined): void {
    this.appendSystemPrompt = prompt ?? "";
  }

  public getMetricsSnapshot(): AgentMetricsSnapshot {
    const byLifecycle: Record<string, number> = {};
    let withActiveForegroundTurn = 0;
    let totalItems = 0;
    let maxItemsPerAgent = 0;

    for (const agent of this.agents.values()) {
      byLifecycle[agent.lifecycle] = (byLifecycle[agent.lifecycle] ?? 0) + 1;

      if (agent.activeForegroundTurnId !== null) {
        withActiveForegroundTurn++;
      }

      if (!this.timelineStore.has(agent.id)) {
        continue;
      }

      const len = this.timelineStore.getItems(agent.id).length;
      totalItems += len;
      if (len > maxItemsPerAgent) {
        maxItemsPerAgent = len;
      }
    }

    return {
      total: this.agents.size,
      subscriptionCount: this.subscribers.size,
      byLifecycle,
      withActiveForegroundTurn,
      timelineStats: {
        totalItems,
        maxItemsPerAgent,
      },
    };
  }

  private touchUpdatedAt(agent: ManagedAgent): Date {
    const nowMs = Date.now();
    const previousMs = agent.updatedAt.getTime();
    const nextMs = nowMs > previousMs ? nowMs : previousMs + 1;
    const next = new Date(nextMs);
    agent.updatedAt = next;
    return next;
  }

  private nextStoredUpdatedAt(record: StoredAgentRecord): string {
    const previousMs = Date.parse(record.updatedAt);
    const nowMs = Date.now();
    const nextMs = nowMs > previousMs ? nowMs : previousMs + 1;
    return new Date(nextMs).toISOString();
  }

  hasInFlightRun(agentId: string): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return false;
    }

    return (
      agent.lifecycle === "running" ||
      Boolean(agent.activeForegroundTurnId) ||
      this.runs.hasRun(agentId)
    );
  }

  /** A failed startup emits its terminal event before its pending foreground run settles. */
  async waitForFailedRunSettlement(agentId: string): Promise<void> {
    const pending = this.runs.getPendingRun(agentId);
    if (pending?.start.status === "failed") await pending.settledPromise;
  }

  subscribe(callback: AgentSubscriber, options?: SubscribeOptions): () => void {
    const targetAgentId =
      options?.agentId == null ? null : validateAgentId(options.agentId, "subscribe");
    const record: SubscriptionRecord = {
      callback,
      agentId: targetAgentId,
    };
    this.subscribers.add(record);

    if (options?.replayState !== false) {
      if (record.agentId) {
        const agent = this.agents.get(record.agentId);
        if (agent) {
          callback({
            type: "agent_state",
            agent: { ...agent },
          });
        }
      } else {
        // For global subscribers, skip internal agents during replay
        for (const agent of this.agents.values()) {
          if (agent.internal) {
            continue;
          }
          callback({
            type: "agent_state",
            agent: { ...agent },
          });
        }
      }
    }

    return () => {
      this.subscribers.delete(record);
    };
  }

  subscriptionCount(): number {
    return this.subscribers.size;
  }

  listAgents(): ManagedAgent[] {
    return Array.from(this.agents.values())
      .filter((agent) => !agent.internal)
      .map((agent) => Object.assign({}, agent));
  }

  async listImportableSessions(
    options?: ImportablePersistedAgentQueryOptions,
  ): Promise<ManagedImportableSessionsResult> {
    const providerEntries = Array.from(this.clients.entries()).filter(
      ([provider, client]) =>
        client.capabilities.supportsSessionListing &&
        !!client.listImportableSessions &&
        this.isProviderImportable(provider, options?.providerFilter),
    );
    const providerResults = await Promise.all(
      providerEntries.map(async ([provider, client]) => {
        try {
          const sessions = await withTimeout(
            client.listImportableSessions!({
              limit: options?.limit,
              query: options?.query,
              scanLimit: options?.scanLimit,
              cwd: options?.cwd,
            }),
            IMPORTABLE_SESSION_LIST_TIMEOUT_MS,
            `Timed out listing importable sessions for provider '${provider}' after ${IMPORTABLE_SESSION_LIST_TIMEOUT_MS}ms`,
          );
          return {
            sessions: sessions
              .filter((session) => matchesImportableSessionQuery(session, options?.query))
              .map((session) => Object.assign(session, { provider })),
            error: null,
          };
        } catch (error) {
          this.logger.warn(
            { err: error, provider },
            "Failed to list importable sessions for provider",
          );
          return {
            sessions: [],
            error: {
              provider,
              message: error instanceof Error ? error.message : String(error),
            },
          };
        }
      }),
    );
    const sessions = providerResults.flatMap((result) => result.sessions);

    const limit = options?.limit ?? 20;
    return {
      sessions: sessions
        .sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime())
        .slice(0, limit),
      providerErrors: providerResults.flatMap((result) => (result.error ? [result.error] : [])),
    };
  }

  private isProviderImportable(
    provider: AgentProvider,
    providerFilter: Set<string> | undefined,
  ): boolean {
    if (this.providerEnabled.get(provider) === false) {
      return false;
    }
    if (providerFilter && !providerFilter.has(provider)) {
      return false;
    }
    return true;
  }

  async listProviderAvailability(): Promise<ProviderAvailability[]> {
    return Promise.all(
      Array.from(this.clients.keys()).map((provider) => this.getProviderAvailability(provider)),
    );
  }

  async getProviderAvailability(provider: AgentProvider): Promise<ProviderAvailability> {
    const client = this.clients.get(provider);
    if (!client) {
      return {
        provider,
        available: false,
        error: `No client registered for provider '${provider}'`,
      };
    }

    try {
      const available = await client.isAvailable();
      return {
        provider,
        available,
        error: null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn({ err: error, provider }, "Failed to check provider availability");
      return {
        provider,
        available: false,
        error: message,
      };
    }
  }

  async listDraftCommands(config: AgentSessionConfig): Promise<AgentSlashCommand[]> {
    const normalizedConfig = await this.normalizeConfig(config, { resolveDefaultModel: false });
    const client = this.requireClient(normalizedConfig.provider);
    if (!normalizedConfig.model) {
      return [];
    }
    const available = await client.isAvailable();
    if (!available) {
      throw new Error(
        `Provider '${normalizedConfig.provider}' is not available. Please ensure the CLI is installed.`,
      );
    }

    if (client.listCommands) {
      return await client.listCommands(normalizedConfig);
    }

    const session = await nativeDispatch(() => client.createSession(normalizedConfig));
    try {
      if (!session.listCommands) {
        throw new Error(
          `Provider '${normalizedConfig.provider}' does not support listing commands`,
        );
      }
      return await session.listCommands();
    } finally {
      try {
        await nativeDispatch(() => session.close());
      } catch (error) {
        this.logger.warn(
          { err: error, provider: normalizedConfig.provider },
          "Failed to close draft command listing session",
        );
      }
    }
  }

  async listDraftFeatures(config: AgentSessionConfig): Promise<AgentFeature[]> {
    const normalizedConfig = await this.normalizeConfig(config, { resolveDefaultModel: false });
    const client = this.requireClient(normalizedConfig.provider);
    if (!normalizedConfig.model && !client.listFeatures) {
      return [];
    }
    const available = await client.isAvailable();
    if (!available) {
      throw new Error(
        `Provider '${normalizedConfig.provider}' is not available. Please ensure the CLI is installed.`,
      );
    }

    if (client.listFeatures) {
      return await client.listFeatures(normalizedConfig);
    }

    const session = await nativeDispatch(() => client.createSession(normalizedConfig));
    try {
      return session.features ?? [];
    } finally {
      try {
        await nativeDispatch(() => session.close());
      } catch (error) {
        this.logger.warn(
          { err: error, provider: normalizedConfig.provider },
          "Failed to close draft feature listing session",
        );
      }
    }
  }

  getAgent(id: string): ManagedAgent | null {
    const agent = this.agents.get(id);
    return agent ? { ...agent } : null;
  }

  /** The account credential a pooled session was launched with (for its usage), or null. Never sent to a client. */
  getAgentUsageCredential(id: string): {
    provider: string;
    credential: AccountCredential;
    label: string | null;
    accountId?: string | null;
    isCurrent: () => boolean;
  } | null {
    let agent: LiveManagedAgent;
    try {
      agent = this.requirePublicAgent(id);
    } catch {
      return null;
    }
    const credential = agent.session?.usageCredential?.() ?? null;
    if (!credential) return null;
    const { observation: _observation, ...launch } = credential;
    const session = agent.session;
    return {
      provider: agent.provider,
      ...launch,
      isCurrent: () => {
        const current = this.agents.get(id);
        return (
          !!current &&
          !current.internal &&
          current.session === session &&
          !current.pendingReplacement
        );
      },
    };
  }

  /** update-7c: every running session on a pooled account, with the last reading its own traffic produced. */
  listPooledUsageSessions(): LiveAccountSession[] {
    const sessions: LiveAccountSession[] = [];
    for (const agent of this.agents.values()) {
      if (
        agent.internal ||
        agent.archivedAt ||
        agent.pendingReplacement ||
        (agent.lifecycle !== "idle" && agent.lifecycle !== "running") ||
        !agent.instanceId ||
        !agent.session
      )
        continue;
      const credential = agent.session.usageCredential?.() ?? null;
      if (!credential || (agent.provider !== "claude" && agent.provider !== "codex")) continue;
      sessions.push({
        agentId: agent.id,
        runtimeInstanceId: agent.instanceId,
        account: {
          id: credential.accountId ?? null,
          provider: agent.provider,
          name: credential.label ?? "Pooled account",
          credential: credential.credential,
        },
        observation: credential.observation ?? null,
      });
    }
    return sessions;
  }

  async getAgentSessionUsage(id: string) {
    const agent = this.requirePublicAgent(id);
    const session = agent.session;
    if (agent.provider !== "codex") return null;
    const label = session?.usageSourceLabel?.();
    if (!session || !label) return null;
    return sessionQuotaUsage(
      label,
      () => this.getAgentQuota(id),
      () => {
        const current = this.agents.get(id);
        return (
          !!current &&
          !current.internal &&
          current.session === session &&
          !current.pendingReplacement
        );
      },
    );
  }

  async getAgentQuota(id: string): Promise<AgentQuotaSnapshot> {
    const agent = this.requirePublicAgent(id);
    const session = agent.session;
    if (!session?.getQuota || agent.pendingReplacement) {
      throw new Error("Agent quota is unavailable for this session");
    }
    const quota = await session.getQuota();
    const current = this.agents.get(agent.id);
    if (
      !current ||
      current.internal ||
      current.session !== session ||
      current.pendingReplacement ||
      quota.sessionId !== session.id
    ) {
      throw new Error("Agent session changed during quota read");
    }
    this.reportObservedQuotaLimit(current, quota, `quota:${quota.observedAt}`);
    return quota;
  }

  async waitForAgentClose(agentId: string): Promise<void> {
    // Loading during reload must wait for the replacement, not resume another writer.
    await this.lifecycleMutationTails.get(agentId);
    await this.inFlightAgentCloses?.get(agentId)?.catch(() => undefined);
  }

  getTimeline(id: string): AgentTimelineItem[] {
    this.requireAgent(id);
    return this.timelineStore.getItems(id);
  }

  async getTimelineRows(id: string): Promise<AgentTimelineRow[]> {
    this.requireAgent(id);
    if (this.durableTimelineStore) {
      return projectTimelineRows({
        rows: await this.durableTimelineStore.getCommittedRows(id),
        mode: "projected",
      }).map((entry) => Object.assign({ seq: entry.seqEnd }, entry));
    }
    return this.timelineStore.getRows(id);
  }

  fetchTimeline(id: string, options?: AgentTimelineFetchOptions): AgentTimelineFetchResult {
    this.requireAgent(id);
    return this.timelineStore.fetch(id, options);
  }

  listProviderSubagents(parentAgentId: string): ProviderSubagentDescriptor[] {
    this.requirePublicAgent(parentAgentId);
    return this.providerSubagents.list(parentAgentId);
  }

  listProviderSubagentActivity(): ProviderSubagentDescriptor[] {
    const publicParentIds = new Set(
      Array.from(this.agents.values())
        .filter((agent) => !agent.internal)
        .map((agent) => agent.id),
    );
    return this.providerSubagents
      .listAll()
      .filter((subagent) => publicParentIds.has(subagent.parentAgentId));
  }

  getProviderSubagent(
    parentAgentId: string,
    subagentId: string,
  ): ProviderSubagentDescriptor | null {
    this.requirePublicAgent(parentAgentId);
    return this.providerSubagents.get(parentAgentId, subagentId);
  }

  fetchProviderSubagentTimeline(
    parentAgentId: string,
    subagentId: string,
    options?: AgentTimelineFetchOptions,
  ): AgentTimelineFetchResult {
    this.requirePublicAgent(parentAgentId);
    return this.providerSubagents.fetchTimeline(parentAgentId, subagentId, options);
  }

  createAgent(
    config: AgentSessionConfig,
    agentId: string | undefined,
    options: CreateAgentOptions,
  ): Promise<ManagedAgent> {
    return this.trackAgentRegistrationOperation(this.createAgentInternal(config, agentId, options));
  }

  private async createAgentInternal(
    config: AgentSessionConfig,
    agentId: string | undefined,
    options: CreateAgentOptions,
  ): Promise<ManagedAgent> {
    this.assertAcceptingAgentRegistrations();
    const resolvedAgentId = validateAgentId(agentId ?? this.idFactory(), "createAgent");
    if (this.pluginLifecycle && !config.internal) {
      // Update-7 W3 (R1 P-3 seam): a create with a caller shows the hook the caller's provider, mode and mode class,
      // so a host policy for children can be applied there. Context only: a hook's changes to it are not applied.
      const caller = this.describeCreateCaller(options.labels?.[PARENT_AGENT_ID_LABEL]);
      const request = await this.pluginLifecycle.before("agent.create", {
        config,
        env: options.env,
        labels: options.labels ?? {},
        ...(caller ? { caller } : {}),
      });
      config = { ...request.config, internal: config.internal };
      options = { ...options, env: request.env };
    }
    // Update-7 W3 (R1 P-1): an internal helper agent (branch names, commit and PR text -- fed untrusted repository
    // text) skips plugin hooks, so it never gets a host's owner default; with no mode of its own it runs in its
    // provider's conservative internal mode, explicitly, never in the daemon's general default.
    if (config.internal && isUnsetModeId(config.modeId)) {
      const internalModeId = this.clients.get(config.provider)?.internalModeId;
      if (internalModeId) config = { ...config, modeId: internalModeId };
    }
    await this.deleteAgentState(resolvedAgentId);
    const { storedConfig, launchConfig, paseoToolPolicy } = await this.prepareSessionConfig(
      config,
      resolvedAgentId,
      {
        env: options?.env,
        resolveDefaultMode: !options.fromStoredRecord,
        resolveDefaultThinking: !options.fromStoredRecord,
      },
    );
    this.requireEnabledProvider(storedConfig.provider);
    const client = await this.requireAvailableClient({
      provider: storedConfig.provider,
    });
    this.paseoToolPolicies.set(resolvedAgentId, paseoToolPolicy);
    const launchContext = await this.buildLaunchContext(
      resolvedAgentId,
      client,
      storedConfig.cwd,
      paseoToolPolicy,
      options?.env,
      { reason: "create", purpose: "interactive", workspaceId: options.workspaceId ?? null },
    );
    const providerLaunchConfig = this.resolveProviderLaunchConfig(launchConfig, launchContext);
    const createOptions = this.buildCreateSessionOptions(options);
    const session = await nativeDispatch(() =>
      client.createSession(providerLaunchConfig, launchContext, createOptions),
    );
    await this.requireExternalMcpSupport(session, storedConfig);
    const agent = await this.registerSession(session, storedConfig, resolvedAgentId, {
      labels: options.labels,
      initialTitle: options.initialTitle,
      workspaceId: options.workspaceId,
      owner: options.owner,
      historyPrimed: true,
    });
    if (options.reportCreation) {
      try {
        const child = this.currentReportIdentity(agent.id);
        if (!child) throw new Error("Native report child identity unavailable");
        await enrollNativeReportCreation(options.reportCreation, child);
      } catch (error) {
        // An unacknowledged creation must not leave an active unlinked child. Close
        // only the captured launch; never retarget cleanup to a replacement.
        await this.runLifecycleMutation(agent.id, () =>
          this.closeAgentRuntime(agent.id, () => {
            const current = this.agents.get(agent.id);
            if (
              current?.session !== session ||
              current.instanceId !== agent.instanceId ||
              session.id !== agent.persistence?.sessionId ||
              session.describePersistence()?.sessionId !== agent.persistence?.sessionId
            )
              throw new Error("Unlinked native child replacement prevents cleanup", {
                cause: error,
              });
          }),
        );
        throw new Error("Native report child enrollment refused", { cause: error });
      }
    }
    if (!agent.internal) {
      this.pluginLifecycle?.emit("agent.created", {
        agent: describeHookAgent({ ...agent, title: agent.config.title }),
      });
    }
    return agent;
  }

  private buildCreateSessionOptions(options?: {
    persistSession?: boolean;
  }): AgentCreateSessionOptions | undefined {
    return options?.persistSession === undefined
      ? undefined
      : { persistSession: options.persistSession };
  }

  // Reconstruct an agent from provider persistence. Callers should explicitly
  // hydrate timeline history after resume.
  resumeAgentFromPersistence(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    agentId?: string,
    options?: {
      createdAt?: Date;
      updatedAt?: Date;
      lastUserMessageAt?: Date | null;
      labels?: Record<string, string>;
      workspaceId?: string;
      owner?: AgentOwner;
      attention?: AttentionState;
    },
    resumeOptions?: AgentResumeSessionOptions,
  ): Promise<ManagedAgent> {
    const resolvedAgentId = validateAgentId(
      agentId ?? this.idFactory(),
      "resumeAgentFromPersistence",
    );
    return this.trackAgentRegistrationOperation(
      this.runLifecycleMutation(resolvedAgentId, () =>
        this.resumeAgentFromPersistenceInternal(
          handle,
          overrides,
          resolvedAgentId,
          options,
          resumeOptions,
        ),
      ),
    );
  }

  private async resumeAgentFromPersistenceInternal(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    agentId?: string,
    options?: {
      createdAt?: Date;
      updatedAt?: Date;
      lastUserMessageAt?: Date | null;
      labels?: Record<string, string>;
      workspaceId?: string;
      owner?: AgentOwner;
      attention?: AttentionState;
    },
    resumeOptions?: AgentResumeSessionOptions,
  ): Promise<ManagedAgent> {
    this.assertAcceptingAgentRegistrations();
    const resolvedAgentId = validateAgentId(
      agentId ?? this.idFactory(),
      "resumeAgentFromPersistence",
    );
    const metadata = (handle.metadata ?? {}) as Partial<AgentSessionConfig>;
    const mergedConfig = {
      ...metadata,
      ...overrides,
      provider: handle.provider,
    } as AgentSessionConfig;
    // Decide residency from durable state inside the lifecycle lane. A loader may
    // have read the record before a queued archive or restore completed. Residency is
    // settled before the config is prepared, because a history load reads an archived
    // agent whose working directory may be gone.
    const record = this.registry ? await this.registry.get(resolvedAgentId) : null;
    const currentResumeOptions = record
      ? { purpose: record.archivedAt ? ("history" as const) : ("interactive" as const) }
      : resumeOptions;
    const purpose = currentResumeOptions?.purpose ?? "interactive";

    const { storedConfig, launchConfig, paseoToolPolicy } = await this.prepareSessionConfig(
      mergedConfig,
      resolvedAgentId,
      { purpose },
    );
    const client = this.requireClient(handle.provider);
    const available = await client.isAvailable();
    if (!available) {
      throw new Error(
        `Provider '${handle.provider}' is not available. Please ensure the CLI is installed.`,
      );
    }
    this.paseoToolPolicies.set(resolvedAgentId, paseoToolPolicy);
    const launchContext = await this.buildLaunchContext(
      resolvedAgentId,
      client,
      storedConfig.cwd,
      paseoToolPolicy,
      undefined,
      {
        reason: "resume",
        purpose,
        workspaceId: options?.workspaceId ?? null,
      },
    );
    const providerLaunchConfig = this.resolveProviderLaunchConfig(launchConfig, launchContext);
    const session = await nativeDispatch(() =>
      client.resumeSession(handle, providerLaunchConfig, launchContext, currentResumeOptions),
    );
    await this.requireExternalMcpSupport(session, storedConfig);
    return this.registerSession(session, storedConfig, resolvedAgentId, {
      ...options,
      persistence: handle,
      restoring: true,
    });
  }

  importProviderSession(input: {
    provider: AgentProvider;
    providerHandleId: string;
    cwd: string;
    workspaceId: string;
    labels?: Record<string, string>;
  }): Promise<ManagedAgent> {
    return this.trackAgentRegistrationOperation(this.importProviderSessionInternal(input));
  }

  private async importProviderSessionInternal(input: {
    provider: AgentProvider;
    providerHandleId: string;
    cwd: string;
    workspaceId: string;
    labels?: Record<string, string>;
  }): Promise<ManagedAgent> {
    this.assertAcceptingAgentRegistrations();
    const resolvedAgentId = validateAgentId(this.idFactory(), "importProviderSession");
    this.requireEnabledProvider(input.provider);

    const client = await this.requireAvailableClient({ provider: input.provider });
    if (!client.importSession) {
      throw new Error(`Provider '${input.provider}' does not support importing sessions`);
    }

    const { storedConfig, launchConfig, paseoToolPolicy } = await this.prepareSessionConfig(
      {
        provider: input.provider,
        cwd: input.cwd,
      },
      resolvedAgentId,
    );
    this.paseoToolPolicies.set(resolvedAgentId, paseoToolPolicy);
    const launchContext = await this.buildLaunchContext(
      resolvedAgentId,
      client,
      storedConfig.cwd,
      paseoToolPolicy,
      undefined,
      { reason: "import", purpose: "interactive", workspaceId: input.workspaceId },
    );
    const providerLaunchConfig = this.resolveProviderLaunchConfig(launchConfig, launchContext);
    const imported = await client.importSession(
      {
        providerHandleId: input.providerHandleId,
        cwd: input.cwd,
      },
      { config: providerLaunchConfig, storedConfig, launchContext },
    );
    let handedToRegistration = false;
    try {
      const importedConfig = await this.normalizeConfig(
        stripInternalPaseoMcpServer(imported.config),
      );
      const timelineRows = buildImportedTimelineRows(imported.timeline);
      const initialTitle = resolveImportedAgentTitle(importedConfig, timelineRows);

      handedToRegistration = true;
      const agent = await this.registerSession(imported.session, importedConfig, resolvedAgentId, {
        labels: input.labels,
        workspaceId: input.workspaceId,
        timelineRows,
        timelineNextSeq: timelineRows.length + 1,
        persistence: imported.persistence,
        historyPrimed: true,
        initialTitle,
        publishWhenReady: true,
      });
      for (const event of imported.providerSubagentEvents ?? []) {
        const update = this.providerSubagents.apply(agent.id, event.provider, event.event);
        this.dispatch({ type: "provider_subagent", event: update });
      }
      return agent;
    } finally {
      if (!handedToRegistration) {
        await this.closeUnregisteredSession(imported.session);
      }
    }
  }

  /** Inspect without loading, unarchiving, or exposing MCP credentials. */
  getAgentMcpRefreshState(agentId: string): Promise<AgentMcpRefreshState | null> {
    return this.runLifecycleMutation(agentId, () => this.readAgentMcpRefreshState(agentId));
  }

  private mcpConfigRevision(value: unknown): string {
    return createHmac("sha256", this.mcpRevisionKey).update(JSON.stringify(value)).digest("hex");
  }

  private supportsQuietMcpRefresh(agent: ActiveManagedAgent): boolean {
    return Boolean(
      agent.persistence?.sessionId &&
      agent.persistence.provider === agent.provider &&
      ["claude", "codex"].includes(agent.provider) &&
      !this.failedMcpRefreshCloses.has(agent.session) &&
      agent.session.capabilities.supportsMcpServers &&
      agent.session.capabilities.supportsSessionPersistence,
    );
  }

  private async readAgentMcpRefreshState(agentId: string): Promise<AgentMcpRefreshState | null> {
    const live = this.agents.get(agentId);
    if (live) {
      if (live.internal) return null;
      return this.liveMcpRefreshState(live, this.readMcpRefreshAdmission(live));
    }
    const record = await this.registry?.get(agentId);
    if (!record || record.internal) return null;
    return {
      provider: record.provider,
      sessionId: record.persistence?.sessionId ?? null,
      configRevision: this.mcpConfigRevision(record),
      lifecycle: "closed",
      supported: false,
      mcpServerNames: Object.keys(record.config?.mcpServers ?? {}).sort(),
    };
  }

  private readMcpRefreshAdmission(agent: ActiveManagedAgent): {
    revision: string;
    allowed: boolean;
  } {
    if (!this.mcpRefreshAdmission) return { revision: "unmanaged", allowed: true };
    try {
      const value = this.mcpRefreshAdmission(agent);
      if (
        typeof value?.revision === "string" &&
        value.revision.length > 0 &&
        typeof value.allowed === "boolean"
      ) {
        return { revision: value.revision, allowed: value.allowed };
      }
    } catch {
      // Missing/unreadable authority and accidental async hooks fail closed without leaking diagnostics.
    }
    return { revision: "unavailable", allowed: false };
  }

  private liveMcpRefreshState(
    live: ActiveManagedAgent,
    admission: { revision: string; allowed: boolean },
  ): AgentMcpRefreshState {
    const runtimeRevision = this.mcpRuntimeRevisions.get(live.session) ?? randomUUID();
    this.mcpRuntimeRevisions.set(live.session, runtimeRevision);
    return {
      provider: live.provider,
      sessionId: live.persistence?.sessionId ?? null,
      configRevision: this.mcpConfigRevision({
        config: live.config,
        persistence: live.persistence,
        owner: live.owner,
        runtimeRevision,
        admission,
      }),
      lifecycle: live.lifecycle,
      supported: this.supportsQuietMcpRefresh(live),
      mcpServerNames: Object.keys(live.config.mcpServers ?? {}).sort(),
    };
  }

  private mcpRefreshFailureReason(
    agentId: string,
    original: AgentSession,
    closeStarted: boolean,
  ): AgentMcpRefreshResult["reason"] {
    if (!closeStarted) return "prepare_failed";
    if (this.agents.get(agentId)?.session === original) return "close_failed";
    return "resume_failed";
  }

  /** Patch an already owned, quiet runtime; never import or replay a provider session. */
  refreshAgentMcp(input: AgentMcpRefreshInput): Promise<AgentMcpRefreshResult> {
    // Copy and validate before queuing so a caller cannot mutate the admitted request.
    const request = AgentMcpRefreshInputSchema.parse(input);
    const reportRelaunch = this.captureReportRelaunch(request.agentId);
    return this.trackAgentRegistrationOperation(
      this.runLifecycleMutation(request.agentId, async (): Promise<AgentMcpRefreshResult> => {
        const { agentId, expected, changes } = request;
        let state = await this.readAgentMcpRefreshState(agentId);
        const refused = (reason: AgentMcpRefreshResult["reason"]): AgentMcpRefreshResult => ({
          outcome: "refused",
          reason,
          state,
        });
        const existing = this.agents.get(agentId);
        if (!existing?.session) return refused("not_resident");
        if (!state?.supported) return refused("unsupported");
        const stale = () =>
          !state ||
          state.provider !== expected.provider ||
          state.sessionId !== expected.sessionId ||
          state.configRevision !== expected.configRevision;
        if (stale()) return refused("stale");
        // Update-7 (and H7's provider recovery): a RECONNECT may restart a session whose provider turn failed (lifecycle
        // "error": a usage limit, a lost login), which is exactly what it is for -- the runtime is replaced and the
        // same session resumed with its history. Never one whose previous runtime could not be closed (explicit close
        // recovery), and nothing else changes: every other busy condition still refuses.
        const restartable = () =>
          request.reconnect === true &&
          existing.lifecycle === "error" &&
          !this.failedMcpRefreshCloses.has(existing.session);
        const busy = () =>
          (existing.lifecycle !== "idle" && !restartable()) ||
          this.hasInFlightRun(agentId) ||
          existing.activeTurnId !== null ||
          existing.pendingReplacement ||
          existing.pendingPermissions.size > 0 ||
          existing.inFlightPermissionResponses.size > 0 ||
          this.foregroundMutationTails.has(agentId) ||
          this.providerSubagents.list(agentId).some((child) => child.status === "running");
        if (busy()) return refused("busy");
        const nextConfig = mcpRefreshConfig(existing.config, changes, request.toolPolicy);
        if (!nextConfig) return refused("invalid_changes");
        const { mcpServers } = nextConfig;
        try {
          this.validateToolPolicyServers(nextConfig);
        } catch {
          return refused("invalid_changes");
        }
        if (
          !request.reconnect &&
          JSON.stringify(mcpServers) === JSON.stringify(existing.config.mcpServers ?? {}) &&
          JSON.stringify(nextConfig.toolPolicy ?? null) ===
            JSON.stringify(existing.config.toolPolicy ?? null)
        ) {
          return { outcome: "unchanged", reason: null, state };
        }
        let closeStarted = false;
        this.mcpRefreshes.add(agentId);
        try {
          await this.reloadQuietMcpSession(existing, nextConfig, async () => {
            // Launch hooks may await. Return a synchronous commit fence after draining their events.
            await this.drainSessionEvents(agentId);
            return () => {
              const admission = this.readMcpRefreshAdmission(existing);
              state = this.liveMcpRefreshState(existing, admission);
              if (!admission.allowed || stale()) throw new QuietMcpRefreshRefusal("stale");
              if (busy()) throw new QuietMcpRefreshRefusal("busy");
              reportRelaunch?.beforeClose();
              closeStarted = true;
            };
          });
          return {
            outcome: "refreshed",
            reason: null,
            state: await this.readAgentMcpRefreshState(agentId),
          };
        } catch (error) {
          if (error instanceof QuietMcpRefreshRefusal) return refused(error.reason);
          // Do not return provider exception text: it can include MCP environment/header secrets.
          return {
            outcome: "failed",
            reason: this.mcpRefreshFailureReason(agentId, existing.session, closeStarted),
            state: await this.readAgentMcpRefreshState(agentId),
          };
        } finally {
          this.mcpRefreshes.delete(agentId);
        }
      }).then(async (result) => {
        if (result.outcome === "refreshed" && reportRelaunch) await reportRelaunch.finish();
        return result;
      }),
    );
  }

  private retainFailedMcpRuntime(existing: ActiveManagedAgent, session: AgentSession): void {
    const retained: ActiveManagedAgent = {
      ...existing,
      session,
      lifecycle: "error",
      activeForegroundTurnId: null,
      lastError: "MCP refresh failed; explicit close recovery required",
    };
    this.failedMcpRefreshCloses.add(session);
    this.agents.set(existing.id, retained);
    this.emitState(retained);
  }

  private async closeFailedMcpReplacement(
    existing: ActiveManagedAgent,
    session: AgentSession,
  ): Promise<void> {
    try {
      await this.closeReloadedSession(session, existing.id);
    } catch {
      // Cleanup must retain an unacknowledged writer, including a mismatched native identity.
      this.retainFailedMcpRuntime(existing, session);
    }
  }

  private async reloadQuietMcpSession(
    existing: ActiveManagedAgent,
    storedConfig: AgentSessionConfig,
    beforeClose: () => Promise<() => void>,
  ): Promise<void> {
    this.assertAcceptingAgentRegistrations();
    const agentId = existing.id;
    const handle = existing.persistence!; // Admission requires a persisted native session.
    const client = this.requireClient(existing.provider);
    // Preserve the captured tool policy and saved config; do not re-resolve provider defaults.
    const paseoToolPolicy = this.paseoToolPolicies.get(agentId);
    const reportLaunch = this.prepareNativeReportLaunch(agentId);
    const launchConfig = this.applyDaemonAppendSystemPrompt(
      withRuntimePaseoMcpServer({
        config: storedConfig,
        agentId,
        mcpAuthToken: this.mcpAuthToken,
        nativeReportWitness: reportLaunch?.witness,
        mcpBaseUrl:
          this.paseoToolsEnabled && isPaseoToolPolicyEnabled(paseoToolPolicy)
            ? this.mcpBaseUrl
            : null,
      }),
    );
    const context = await this.buildLaunchContext(
      agentId,
      client,
      storedConfig.cwd,
      paseoToolPolicy,
      undefined,
      { reason: "refresh", purpose: "interactive", workspaceId: existing.workspaceId },
    );
    const providerConfig = this.resolveProviderLaunchConfig(launchConfig, context);
    const commitClose = await beforeClose();
    let closed: ManagedAgentClosed | undefined;
    let session: AgentSession | undefined;
    let registered = false;
    // No await between host authority validation and the old provider's close invocation.
    // Refusal remains outside cleanup: the original runtime has not been touched.
    commitClose();
    try {
      await this.closeReloadedSession(existing.session, agentId);
      await this.drainSessionEvents(agentId);
      closed = await this.prepareAgentForClosure(existing, "MCP configuration refreshed");
      await this.persistSnapshot(closed);
      this.assertAcceptingAgentRegistrations();
      session = await nativeDispatch(() => client.resumeSession(handle, providerConfig, context));
      await this.requireExternalMcpSupport(session, storedConfig);
      const resumed = session.describePersistence();
      if (
        session.provider !== existing.provider ||
        resumed?.provider !== handle.provider ||
        resumed?.sessionId !== handle.sessionId
      ) {
        throw new Error("Provider resumed a different session during MCP refresh");
      }
      await this.registerSession(session, storedConfig, agentId, {
        labels: existing.labels,
        workspaceId: existing.workspaceId,
        owner: existing.owner,
        createdAt: existing.createdAt,
        updatedAt: existing.updatedAt,
        lastUserMessageAt: existing.lastUserMessageAt,
        historyPrimed: existing.historyPrimed,
        lastUsage: existing.lastUsage,
        lastError: existing.lastError,
        attention: existing.attention,
        deferFailureCleanup: true,
      });
      registered = true;
    } catch (error) {
      const replacement = this.agents.get(agentId);
      if (session && replacement?.session === session) {
        registered = true; // A partial registration still owns the writer.
        this.retainFailedMcpRuntime(replacement, session);
      } else if (closed) {
        this.emitClosedAgent(closed, { persist: false });
      } else {
        this.retainFailedMcpRuntime(existing, existing.session);
      }
      throw error;
    } finally {
      if (session && !registered) await this.closeFailedMcpReplacement(existing, session);
    }
  }

  // Hot-reload an active agent session with config overrides. By default the
  // in-memory timeline is preserved (used for voice-mode toggles and similar
  // config swaps). When `rehydrateFromDisk` is set, a complete provider replay
  // replaces the timeline and mints a new epoch. A failed replay keeps the old rows.
  // This is what the
  // user-facing "Reload agent" action wants when the on-disk session was
  // mutated outside Paseo.
  reloadAgentSession(
    agentId: string,
    overrides?: Partial<AgentSessionConfig>,
    options?: { rehydrateFromDisk?: boolean },
    handle?: TrustedOperationHandle,
  ): Promise<ManagedAgent> {
    const reportRelaunch = this.captureReportRelaunch(agentId);
    return this.trackAgentRegistrationOperation(
      this.runLifecycleMutation(agentId, () =>
        this.withStoredInput(
          agentId,
          "configure",
          undefined,
          (operationHandle) =>
            this.reloadAgentSessionInternal(
              agentId,
              overrides,
              options,
              operationHandle,
              reportRelaunch?.beforeClose,
            ),
          commandPayload("reload", { overrides, options }),
          handle,
        ),
      ).then(async (result) => {
        if (reportRelaunch) await reportRelaunch.finish();
        return result;
      }),
    );
  }

  private invokeReportRelaunchGuard(guard?: () => void): void {
    guard?.();
  }

  private async reloadAgentSessionInternal(
    agentId: string,
    overrides?: Partial<AgentSessionConfig>,
    options?: { rehydrateFromDisk?: boolean },
    operationHandle?: TrustedOperationHandle,
    reportRelaunchBeforeClose?: () => void,
  ): Promise<ManagedAgent> {
    this.assertAcceptingAgentRegistrations();
    let existing = this.requireSessionAgent(agentId);
    if (this.hasInFlightRun(agentId)) {
      await this.cancelAgentRunBefore(agentId, "reload", operationHandle);
      existing = this.requireSessionAgent(agentId);
    }
    const rehydrateFromDisk = options?.rehydrateFromDisk ?? false;
    const preservedHistoryPrimed = existing.historyPrimed;
    const preservedLastUsage = existing.lastUsage;
    const preservedLastError = existing.lastError;
    const preservedAttention = existing.attention;
    const handle = existing.persistence;
    const provider = handle?.provider ?? existing.provider;
    const client = this.requireClient(provider);
    const refreshConfig = {
      ...existing.config,
      ...overrides,
      provider,
    } as AgentSessionConfig;
    const { storedConfig, launchConfig, paseoToolPolicy } = await this.prepareSessionConfig(
      refreshConfig,
      agentId,
    );
    const hadPreviousPaseoToolPolicy = this.paseoToolPolicies.has(agentId);
    const previousPaseoToolPolicy = this.paseoToolPolicies.get(agentId);
    const launchContext = await this.buildLaunchContext(
      agentId,
      client,
      storedConfig.cwd,
      paseoToolPolicy,
      undefined,
      { reason: "refresh", purpose: "interactive", workspaceId: existing.workspaceId },
    );
    const providerLaunchConfig = this.resolveProviderLaunchConfig(launchConfig, launchContext);
    if (
      Object.keys(storedConfig.mcpServers ?? {}).length > 0 &&
      existing.session.capabilities.supportsMcpServers !== true
    ) {
      throw new Error(`Provider '${provider}' does not support MCP servers`);
    }

    let session: AgentSession | undefined;
    let closedExisting: ManagedAgentClosed | undefined;
    let handedToRegistration = false;
    try {
      // A persisted thread can have only one writer, even when its turn is idle.
      this.invokeReportRelaunchGuard(reportRelaunchBeforeClose);
      await this.closeReloadedSession(existing.session, agentId);
      await this.drainSessionEvents(agentId);
      if (rehydrateFromDisk) {
        for (const event of this.providerSubagents.deleteParent(agentId)) {
          this.dispatch({ type: "provider_subagent", event });
        }
      } else {
        this.cancelRunningProviderSubagents(agentId);
      }
      closedExisting = await this.prepareAgentForClosure(existing, "agent reloaded");
      await this.persistSnapshot(closedExisting);
      this.assertAcceptingAgentRegistrations();

      this.paseoToolPolicies.set(agentId, paseoToolPolicy);
      session = handle
        ? await nativeDispatch(() =>
            client.resumeSession(handle, providerLaunchConfig, launchContext),
          )
        : await nativeDispatch(() => client.createSession(providerLaunchConfig, launchContext));
      await this.requireExternalMcpSupport(session, storedConfig);
      this.assertAcceptingAgentRegistrations();

      // Preserve existing labels and timeline during reload.
      handedToRegistration = true;
      return this.registerSession(session, storedConfig, agentId, {
        labels: existing.labels,
        workspaceId: existing.workspaceId,
        owner: existing.owner,
        createdAt: existing.createdAt,
        updatedAt: existing.updatedAt,
        lastUserMessageAt: existing.lastUserMessageAt,
        historyPrimed: rehydrateFromDisk ? false : preservedHistoryPrimed,
        lastUsage: preservedLastUsage,
        lastError: preservedLastError,
        attention: preservedAttention,
        restoring: true,
      });
    } catch (error) {
      if (closedExisting) {
        this.emitClosedAgent(closedExisting, { persist: false });
      } else if (this.agents.get(agentId) === existing) {
        existing.lifecycle = "error";
        existing.lastError = error instanceof Error ? error.message : String(error);
        this.emitState(existing);
      }
      throw error;
    } finally {
      if (!handedToRegistration) {
        if (hadPreviousPaseoToolPolicy) {
          this.paseoToolPolicies.set(agentId, previousPaseoToolPolicy);
        } else {
          this.paseoToolPolicies.delete(agentId);
        }
        if (session) {
          await this.closeUnregisteredSession(session);
        }
      }
    }
  }

  private async closeReloadedSession(session: AgentSession, agentId: string): Promise<void> {
    let operation = this.reloadedSessionCloses.get(session);
    if (!operation) {
      operation = nativeDispatch(() => session.close());
      this.reloadedSessionCloses.set(session, operation);
      // Keep pending closes across request timeouts; a retry must await the same release.
      void operation.catch(() => this.reloadedSessionCloses.delete(session));
    }
    const result = await this.waitWithTimeout({
      operation,
      timeoutMs: this.rescueTimeouts.reloadSessionCloseMs,
      onLateError: (error) => {
        this.logger.warn(
          { err: error, agentId },
          "Previous session close failed after refresh timeout",
        );
      },
    });
    if (result === "timed_out") {
      throw new Error("Timed out closing previous session during refresh");
    }
  }

  private async waitWithTimeout(options: TimeoutOptions): Promise<TimeoutResult> {
    let didTimeOut = false;
    let timer: NodeJS.Timeout | null = null;
    const operation = options.operation
      .then((): TimeoutResult => "completed")
      .catch((error) => {
        if (didTimeOut) {
          options.onLateError?.(error);
          return "timed_out" as const;
        }
        throw error;
      });

    try {
      return await Promise.race([
        operation,
        new Promise<TimeoutResult>((resolvePromise) => {
          timer = setTimeout(() => {
            didTimeOut = true;
            resolvePromise("timed_out");
          }, options.timeoutMs);
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  closeAgent(agentId: string, handle?: TrustedOperationHandle): Promise<void> {
    const source = this.currentReportIdentity(agentId);
    const sourceSession = this.agents.get(agentId)?.session;
    let retirement: ReturnType<NativeReportRegistry["captureRetirement"]> | undefined;
    try {
      if (source && this.reportRegistry) retirement = this.reportRegistry.captureRetirement(source);
    } catch {
      /* Unknown/legacy sessions do not acquire a report link on close. */
    }
    return this.withInput(
      agentId,
      "close",
      undefined,
      (operationHandle) => {
        const existing = this.inFlightAgentCloses.get(agentId);
        if (existing) {
          return existing;
        }

        const close = this.runLifecycleMutation(agentId, async () => {
          // A preceding reload or archive may already have closed the durable agent.
          this.withInput(
            agentId,
            "close",
            undefined,
            () => undefined,
            commandPayload("close"),
            operationHandle,
          );
          await this.nativeReceipts?.closeAgent(agentId);
          if (this.agents.has(agentId))
            await this.closeAgentRuntime(
              agentId,
              retirement && source && sourceSession
                ? () => {
                    const current = this.agents.get(agentId);
                    if (
                      current?.session !== sourceSession ||
                      current.instanceId !== source.instanceId ||
                      sourceSession.id !== source.sessionId ||
                      sourceSession.describePersistence()?.sessionId !== source.sessionId ||
                      current.persistence?.sessionId !== source.sessionId ||
                      current.runtimeInfo?.sessionId !== source.sessionId
                    )
                      throw new Error("Retiring native identity changed before close");
                  }
                : undefined,
            );
          if (retirement && source && sourceSession) {
            try {
              const batches = await retirement(() => {
                if (!this.acceptingAgentRegistrations || this.agents.has(agentId))
                  throw new Error("Retired native identity replaced or unavailable");
              });
              for (const batch of batches) await this.collectNativeReport(batch);
            } catch {
              this.logger.warn("Native final report unavailable after close");
            }
          }
        });
        this.inFlightAgentCloses.set(agentId, close);
        const clearClose = () => {
          if (this.inFlightAgentCloses.get(agentId) === close) {
            this.inFlightAgentCloses.delete(agentId);
          }
        };
        void close.then(clearClose, clearClose);
        return close;
      },
      commandPayload("close"),
      handle,
    );
  }

  private async closeAgentRuntime(
    agentId: string,
    requireRetiringIdentity?: () => void,
  ): Promise<void> {
    const agent = this.requireAgent(agentId);
    this.logger.trace(
      {
        agentId,
        provider: agent.provider,
        sessionId: agent.persistence?.sessionId ?? undefined,
        turnId: agent.activeForegroundTurnId ?? undefined,
        lifecycle: agent.lifecycle,
        activeForegroundTurnId: agent.activeForegroundTurnId,
        pendingPermissions: agent.pendingPermissions.size,
      },
      "agent.manager.close.start",
    );
    await this.drainSessionEvents(agentId);
    // Retain ownership until shutdown succeeds. A failed close may still own a
    // native writer, so publishing a resumable closed snapshot would orphan it.
    this.invokeReportRelaunchGuard(requireRetiringIdentity);
    await nativeDispatch(() => agent.session.close());
    this.cancelRunningProviderSubagents(agentId);
    const closedAgent = await this.prepareAgentForClosure(agent, "agent closed");

    let persistError: unknown;
    try {
      await this.persistSnapshot(closedAgent);
    } catch (error) {
      persistError = error;
    }
    this.emitClosedAgent(closedAgent, { persist: false });
    this.logger.trace(
      {
        agentId,
        provider: closedAgent.provider,
        sessionId: closedAgent.persistence?.sessionId ?? undefined,
      },
      "agent.manager.close.complete",
    );

    if (persistError !== undefined) {
      throw persistError;
    }
  }

  private cancelRunningProviderSubagents(parentAgentId: string): void {
    for (const subagent of this.providerSubagents.list(parentAgentId)) {
      if (subagent.status !== "running") {
        continue;
      }
      const event = this.providerSubagents.apply(parentAgentId, subagent.provider, {
        type: "upsert",
        id: subagent.id,
        status: "canceled",
      });
      this.dispatch({ type: "provider_subagent", event });
    }
  }

  async archiveAgent(
    agentId: string,
    handle?: TrustedOperationHandle,
  ): Promise<{ archivedAt: string }> {
    return this.withInput(
      agentId,
      "archive",
      undefined,
      async (operationHandle) => {
        return this.runLifecycleMutation(agentId, () =>
          this.withInput(
            agentId,
            "archive",
            undefined,
            () => this.archiveAgentUnlocked(agentId),
            commandPayload("archive"),
            operationHandle,
          ),
        );
      },
      commandPayload("archive"),
      handle,
    );
  }

  private async archiveAgentUnlocked(
    agentId: string,
    requestedArchivedAt?: string,
    admittedPlan?: CascadeArchivePlan,
  ): Promise<{ archivedAt: string }> {
    const agent = this.requireAgent(agentId);
    if (!this.registry) {
      throw new Error("Agent storage is not configured");
    }

    const cascadePlan = admittedPlan ?? (await this.admitArchiveDescendants(agentId));
    await this.registry.applySnapshot(agent, {
      internal: agent.internal,
    });
    const stored = await this.registry.get(agentId);
    if (!stored) {
      throw new Error(`Agent ${agentId} not found in storage after snapshot`);
    }

    const { archivedAt } = await this.markRecordArchived(stored, requestedArchivedAt);
    agent.updatedAt = new Date(archivedAt);
    await this.closeAgentRuntime(agentId);
    await this.syncNativeArchiveState(stored.provider, stored.persistence, "archive");
    this.discardRetainedAgentState(agentId);

    await this.cascadeArchiveChildren(agentId, cascadePlan);

    return { archivedAt };
  }

  /** Preflight before command cancellation or any workspace sibling effect.
   * Execution still rechecks the graph; this grants no reusable archive authority.
   */
  async preflightArchiveDescendants(agentId: string): Promise<void> {
    await this.admitArchiveDescendants(agentId);
  }

  /** Freeze and admit the entire cascade before any parent storage/provider effect. */
  private async admitArchiveDescendants(parentAgentId: string): Promise<CascadeArchivePlan> {
    const registry = this.requireRegistry();
    const records = await registry.list();
    const plan: CascadeArchivePlan = new Map();
    const visited = new Set([parentAgentId]);
    const visit = async (parentId: string): Promise<void> => {
      const parent = await registry.get(parentId);
      if (!parent) throw new Error(`Archive parent ${parentId} not found`);
      for (const child of records) {
        if (
          child.archivedAt ||
          child.labels?.[PARENT_AGENT_ID_LABEL] !== parentId ||
          visited.has(child.id)
        )
          continue;
        visited.add(child.id);
        const admitted = await this.runLifecycleMutation(child.id, async () => {
          const fresh = await this.requireRegistry().get(child.id);
          if (!fresh || fresh.archivedAt || fresh.labels?.[PARENT_AGENT_ID_LABEL] !== parentId)
            return null;
          const detach = shouldDetachFromArchivedParent(parent, fresh);
          const handle = await this.trustedPlugins.followup(() =>
            this.withStoredInput(
              child.id,
              detach ? "configure" : "archive",
              undefined,
              (operation) => operation,
              commandPayload(detach ? "detach" : "archive"),
            ),
          );
          return { parentId, detach, handle };
        });
        if (!admitted) continue;
        plan.set(child.id, admitted);
        if (!admitted.detach) await visit(child.id);
      }
    };
    await visit(parentAgentId);
    return plan;
  }

  // Execute only the admitted graph. New/reparented descendants never inherit a parent's grant.
  private async cascadeArchiveChildren(
    parentAgentId: string,
    plan: CascadeArchivePlan,
  ): Promise<void> {
    const registry = this.requireRegistry();
    const parent = await registry.get(parentAgentId);
    if (!parent) throw new Error(`Archived parent ${parentAgentId} not found in storage`);
    // V1 has no payload-bound plan: preserve its dynamic child/open-tab reconciliation.
    if (!this.trustedPlugins.hasV11Authority()) {
      for (const child of await registry.list()) {
        if (!child.archivedAt && child.labels?.[PARENT_AGENT_ID_LABEL] === parentAgentId)
          plan.set(child.id, {
            parentId: parentAgentId,
            detach: shouldDetachFromArchivedParent(parent, child),
          });
      }
    }
    for (const [childId, admitted] of plan) {
      if (admitted.parentId !== parentAgentId) continue;
      await this.runLifecycleMutation(childId, async () => {
        const child = await registry.get(childId);
        if (!child || child.archivedAt || child.labels?.[PARENT_AGENT_ID_LABEL] !== parentAgentId)
          return;
        const detach = shouldDetachFromArchivedParent(parent, child);
        if (detach !== admitted.detach && this.trustedPlugins.hasV11Authority())
          throw new AdmissionDeniedError("Archive descendant relationship changed");
        if (!admitted.handle) admitted.detach = detach;
        const execute = () =>
          this.withStoredInput(
            childId,
            admitted.detach ? "configure" : "archive",
            undefined,
            async () => {
              if (admitted.detach) await this.detachAgentUnlocked(childId);
              else if (this.agents.has(childId))
                await this.archiveAgentUnlocked(childId, undefined, plan);
              else
                await this.archiveSnapshotUnlocked(
                  childId,
                  new Date().toISOString(),
                  admitted.handle,
                  plan,
                );
            },
            commandPayload(admitted.detach ? "detach" : "archive"),
            admitted.handle,
          );
        await (admitted.handle ? execute() : this.trustedPlugins.daemon(execute));
      });
    }
  }

  private async markRecordArchived(
    record: StoredAgentRecord,
    archivedAt = new Date().toISOString(),
  ): Promise<ArchivedStoredAgentRecord> {
    const archivedRecord = await this.persistArchivedRecord(record, {
      archivedAt,
      updatedAt: archivedAt,
    });

    if (this.agents.has(record.id)) {
      this.notifyAgentState(record.id);
    } else if (!archivedRecord.internal) {
      this.dispatchStoredAgentState(archivedRecord);
    }

    await this.fireAgentArchived(record.id);

    return archivedRecord;
  }

  private async persistArchivedRecord(
    record: StoredAgentRecord,
    options: { archivedAt: string; updatedAt?: string },
  ): Promise<ArchivedStoredAgentRecord> {
    const archivedRecord = buildArchivedAgentRecord(record, options);
    await this.requireRegistry().upsert(archivedRecord);
    if (!record.archivedAt && !record.internal) {
      this.pluginLifecycle?.emit("agent.archived", {
        agent: describeHookAgent(archivedRecord),
        archivedAt: archivedRecord.archivedAt,
      });
    }
    return archivedRecord;
  }

  private async fireAgentArchived(agentId: string): Promise<void> {
    const callback = this.onAgentArchived;
    if (!callback) {
      return;
    }
    try {
      await callback(agentId);
    } catch (error) {
      this.logger.warn({ err: error, agentId }, "onAgentArchived callback failed");
    }
  }

  private dispatchStoredAgentState(record: StoredAgentRecord): void {
    const updatedAt = new Date(record.updatedAt);
    const attention = extractAttention(record);
    this.dispatch({
      type: "agent_state",
      agent: {
        id: record.id,
        archivedAt: record.archivedAt ?? null,
        provider: record.provider,
        cwd: record.cwd,
        workspaceId: record.workspaceId,
        owner: record.owner,
        session: null,
        capabilities: STORED_AGENT_CAPABILITIES,
        config: buildStoredAgentConfig(record),
        runtimeInfo: undefined,
        lifecycle: "closed",
        createdAt: new Date(record.createdAt),
        updatedAt,
        availableModes: [],
        features: record.features,
        currentModeId: record.lastModeId ?? null,
        pendingPermissions: new Map(),
        bufferedPermissionResolutions: new Map(),
        inFlightPermissionResponses: new Set(),
        pendingReplacement: false,
        activeForegroundTurnId: null,
        activeTurnId: null,
        activeTurnStartedAt: null,
        foregroundTurnWaiters: new Set(),
        finalizedForegroundTurnIds: new Set(),
        unsubscribeSession: null,
        persistence: record.persistence ?? null,
        historyPrimed: true,
        lastUserMessageAt: record.lastUserMessageAt ? new Date(record.lastUserMessageAt) : null,
        lastUsage: undefined,
        lastError: record.lastError ?? undefined,
        attention,
        internal: record.internal,
        labels: record.labels,
      },
    });
  }

  setAgentMode(
    agentId: string,
    modeId: string,
    operationHandle?: TrustedOperationHandle,
  ): Promise<AgentProviderNotice | null> {
    return this.runLifecycleMutation(agentId, () =>
      this.withStoredInput(
        agentId,
        "configure",
        undefined,
        () => this.setAgentModeUnlocked(agentId, modeId),
        commandPayload("set-mode", { modeId }),
        operationHandle,
      ),
    );
  }

  private async setAgentModeUnlocked(
    agentId: string,
    modeId: string,
  ): Promise<AgentProviderNotice | null> {
    const agent = this.requireSessionAgent(agentId);
    const notice = (await nativeDispatch(() => agent.session.setMode(modeId))) ?? null;
    await this.drainSessionEvents(agentId);
    const currentMode = (await agent.session.getCurrentMode()) ?? modeId;
    agent.config.modeId = currentMode ?? undefined;
    agent.currentModeId = currentMode;
    // Update runtimeInfo to reflect the new mode
    if (agent.runtimeInfo) {
      agent.runtimeInfo = { ...agent.runtimeInfo, modeId: currentMode };
    }
    this.touchUpdatedAt(agent);
    this.emitState(agent);
    return notice;
  }

  setAgentModel(agentId: string, modelId: string | null): Promise<void> {
    return this.runLifecycleMutation(agentId, () =>
      this.withStoredInput(
        agentId,
        "configure",
        undefined,
        () => this.setAgentModelUnlocked(agentId, modelId),
        commandPayload("set-model", { modelId }),
      ),
    );
  }

  private async setAgentModelUnlocked(agentId: string, modelId: string | null): Promise<void> {
    const agent = this.requireSessionAgent(agentId);
    const normalizedModelId =
      typeof modelId === "string" && modelId.trim().length > 0 ? modelId : null;

    if (agent.session.setModel) {
      await nativeDispatch(() => agent.session.setModel!(normalizedModelId));
    }
    await this.drainSessionEvents(agentId);

    agent.config.model = normalizedModelId ?? undefined;
    if (agent.runtimeInfo) {
      agent.runtimeInfo = { ...agent.runtimeInfo, model: normalizedModelId };
    }
    this.refreshSessionPersistence(agent);
    this.touchUpdatedAt(agent);
    this.emitState(agent);
  }

  setAgentThinkingOption(
    agentId: string,
    thinkingOptionId: string | null,
  ): Promise<AgentProviderNotice | null> {
    return this.runLifecycleMutation(agentId, () =>
      this.withStoredInput(
        agentId,
        "configure",
        undefined,
        () => this.setAgentThinkingOptionUnlocked(agentId, thinkingOptionId),
        commandPayload("set-thinking", { thinkingOptionId }),
      ),
    );
  }

  private async setAgentThinkingOptionUnlocked(
    agentId: string,
    thinkingOptionId: string | null,
  ): Promise<AgentProviderNotice | null> {
    const agent = this.requireSessionAgent(agentId);
    const normalizedThinkingOptionId =
      typeof thinkingOptionId === "string" && thinkingOptionId.trim().length > 0
        ? thinkingOptionId
        : null;

    let notice: AgentProviderNotice | null = null;
    if (agent.session.setThinkingOption) {
      notice =
        (await nativeDispatch(() =>
          agent.session.setThinkingOption!(normalizedThinkingOptionId),
        )) ?? null;
    }
    await this.drainSessionEvents(agentId);

    let effectiveThinkingOptionId = normalizedThinkingOptionId;
    const runtimeInfo = await agent.session.getRuntimeInfo();
    if (runtimeInfo.thinkingOptionId !== undefined) {
      effectiveThinkingOptionId = runtimeInfo.thinkingOptionId;
    }

    agent.config.thinkingOptionId = effectiveThinkingOptionId ?? undefined;
    if (agent.runtimeInfo) {
      agent.runtimeInfo = {
        ...agent.runtimeInfo,
        thinkingOptionId: effectiveThinkingOptionId,
      };
    }
    this.touchUpdatedAt(agent);
    this.emitState(agent);
    return notice;
  }

  setAgentFeature(agentId: string, featureId: string, value: unknown): Promise<void> {
    return this.runLifecycleMutation(agentId, () =>
      this.withStoredInput(
        agentId,
        "configure",
        undefined,
        () => this.setAgentFeatureUnlocked(agentId, featureId, value),
        commandPayload("set-feature", { featureId, value }),
      ),
    );
  }

  private async setAgentFeatureUnlocked(
    agentId: string,
    featureId: string,
    value: unknown,
  ): Promise<void> {
    const agent = this.requireSessionAgent(agentId);

    if (!agent.session.setFeature) {
      throw new Error("Agent session does not support setting features");
    }

    await nativeDispatch(() => agent.session.setFeature!(featureId, value));
    await this.drainSessionEvents(agentId);
    agent.config.featureValues = { ...agent.config.featureValues, [featureId]: value };
    this.touchUpdatedAt(agent);
    this.emitState(agent);
  }

  async setTitle(agentId: string, title: string): Promise<void> {
    const agent = this.requireAgent(agentId);
    const normalizedTitle = title.trim();
    if (!normalizedTitle) {
      return;
    }
    if (
      this.agentsAwaitingInitialSnapshotPersist.has(agent.id) &&
      this.registry &&
      (await this.registry.get(agent.id)) === null
    ) {
      return;
    }
    this.touchUpdatedAt(agent);
    await this.persistSnapshot(agent, { title: normalizedTitle });
    this.emitState(agent, { persist: false });
  }

  async setLabels(agentId: string, labels: Record<string, string>): Promise<void> {
    if (Object.hasOwn(labels, PARENT_AGENT_ID_LABEL))
      throw new Error("Use native owner parent adoption to change parent metadata");
    return this.runLifecycleMutation(agentId, () =>
      this.withStoredInput(
        agentId,
        "configure",
        undefined,
        () => this.writeLabels(this.requireAgent(agentId).id, labels).then(() => undefined),
        commandPayload("set-labels", { labels }),
      ),
    );
  }

  private async writeLabels(agentId: string, patch: AgentLabelPatch): Promise<WriteLabelsResult> {
    const liveAgent = this.agents.get(agentId);
    if (liveAgent) {
      liveAgent.labels = applyLabelPatch(liveAgent.labels, patch);
      this.touchUpdatedAt(liveAgent);
      await this.persistSnapshot(liveAgent);
      this.emitState(liveAgent, { persist: false });
      const record = this.registry ? await this.registry.get(agentId) : null;
      return { record, live: true };
    }

    const nextRecord = await this.writeStoredMetadata(agentId, { labels: patch });
    return { record: nextRecord, live: false };
  }

  private async writeStoredMetadata(
    agentId: string,
    patch: AgentMetadataPatch,
  ): Promise<StoredAgentRecord> {
    const registry = this.requireRegistry();
    const record = await registry.get(agentId);
    if (!record) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    const nextRecord = {
      ...record,
      ...(patch.title ? { title: patch.title } : {}),
      ...(patch.labels ? { labels: applyLabelPatch(record.labels, patch.labels) } : {}),
      updatedAt: this.nextStoredUpdatedAt(record),
    };
    await registry.upsert(nextRecord);
    return nextRecord;
  }

  private parentAdoptionTail: Promise<void> = Promise.resolve();

  async adoptAgentParent(input: ParentAdoptionInput, ownerIsCurrent: () => boolean): Promise<void> {
    const request = snapshotParentAdoption(input);
    const admitted = validateParentAdoption(request, this.agents, ownerIsCurrent);
    const childInstance = admitted.child.instanceId;
    const parentInstance = admitted.parent.instanceId;
    const childSession = admitted.child.session;
    const parentSession = admitted.parent.session;
    const validate = () => {
      const current = validateParentAdoption(request, this.agents, ownerIsCurrent);
      for (const agent of [current.child, current.parent]) {
        if (this.inFlightAgentCloses.has(agent.id) || this.mcpRefreshes.has(agent.id))
          throw new Error("Parent adoption lifecycle fence active");
      }
      if (
        current.child !== admitted.child ||
        current.parent !== admitted.parent ||
        current.child.instanceId !== childInstance ||
        current.parent.instanceId !== parentInstance ||
        current.child.session !== childSession ||
        current.parent.session !== parentSession
      )
        throw new Error("Native instance replaced before parent adoption");
    };
    validate();
    const payload = commandPayload("adopt-parent", {
      parentAgentId: request.parentAgentId,
      expectedParentAgentId: request.expectedParentAgentId,
      childNativeSessionId: request.childNativeSessionId,
      parentNativeSessionId: request.parentNativeSessionId,
    });
    const operation = this.parentAdoptionTail
      .catch(() => undefined)
      .then(() =>
        this.runLifecycleMutation(request.agentId, () =>
          this.trustedPlugins.parentAdoption(admitted.child, payload(), validate, async () => {
            await this.writeLabels(request.agentId, {
              [PARENT_AGENT_ID_LABEL]: request.parentAgentId,
            });
          }),
        ),
      );
    this.parentAdoptionTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async detachAgent(agentId: string): Promise<{
    record: StoredAgentRecord;
    live: boolean;
    previousParentAgentId: string | null;
  }> {
    return this.runLifecycleMutation(agentId, () =>
      this.withStoredInput(
        agentId,
        "configure",
        undefined,
        () => this.detachAgentUnlocked(agentId),
        commandPayload("detach"),
      ),
    );
  }

  private async detachAgentUnlocked(agentId: string): Promise<{
    record: StoredAgentRecord;
    live: boolean;
    previousParentAgentId: string | null;
  }> {
    const registry = this.requireRegistry();
    const liveAgent = this.agents.get(agentId);
    if (liveAgent) {
      const previousParentAgentId = getParentAgentIdFromLabels(liveAgent.labels);
      if (!previousParentAgentId) {
        await this.persistSnapshot(liveAgent);
        const record = await registry.get(agentId);
        if (!record) {
          throw new Error(`Agent not found in storage after detach: ${agentId}`);
        }
        return { record, live: true, previousParentAgentId: null };
      }

      const { record } = await this.writeLabels(agentId, detachedAgentLabelPatch(liveAgent.labels));
      if (!record) {
        throw new Error(`Agent not found in storage after detach: ${agentId}`);
      }
      return { record, live: true, previousParentAgentId };
    }

    const record = await registry.get(agentId);
    if (!record) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    const previousParentAgentId = getParentAgentIdFromLabels(record.labels);
    if (!previousParentAgentId) {
      return { record, live: false, previousParentAgentId: null };
    }

    const result = await this.writeLabels(agentId, detachedAgentLabelPatch(record.labels));
    if (!result.record) {
      throw new Error(`Agent not found in storage after detach: ${agentId}`);
    }
    return { record: result.record, live: false, previousParentAgentId };
  }

  notifyAgentState(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent || agent.internal) {
      return;
    }
    this.touchUpdatedAt(agent);
    this.emitState(agent);
  }

  async clearAgentAttention(agentId: string): Promise<void> {
    const agent = this.requireAgent(agentId);
    if (agent.attention.requiresAttention) {
      agent.attention = { requiresAttention: false };
      await this.persistSnapshot(agent);
      this.emitState(agent, { persist: false });
    }
  }

  async markAgentUnread(agentId: string): Promise<void> {
    const liveAgent = this.agents.get(agentId);
    if (liveAgent) {
      const isFinished = liveAgent.lifecycle === "idle";
      const hasPendingPermissions = liveAgent.pendingPermissions.size > 0;
      const canMarkUnread =
        isFinished && !liveAgent.attention.requiresAttention && !hasPendingPermissions;
      if (!canMarkUnread) {
        throw new Error(`Agent is no longer finished and read: ${agentId}`);
      }
      liveAgent.attention = {
        requiresAttention: true,
        attentionReason: "finished",
        attentionTimestamp: new Date(),
      };
      await this.persistSnapshot(liveAgent);
      this.emitState(liveAgent, { persist: false });
      return;
    }

    const registry = this.requireRegistry();
    const record = await registry.get(agentId);
    const hasFinishedStatus = record?.lastStatus === "idle" || record?.lastStatus === "closed";
    const canMarkUnread =
      record && !record.internal && !record.archivedAt && !record.requiresAttention;
    if (!canMarkUnread || !hasFinishedStatus) {
      throw new Error(`Agent is no longer finished and read: ${agentId}`);
    }
    const updatedAt = this.nextStoredUpdatedAt(record);
    const nextRecord: StoredAgentRecord = {
      ...record,
      updatedAt,
      requiresAttention: true,
      attentionReason: "finished",
      attentionTimestamp: updatedAt,
    };
    await registry.upsert(nextRecord);
    this.dispatchStoredAgentState(nextRecord);
  }

  async archiveSnapshot(
    agentId: string,
    archivedAt: string,
    handle?: TrustedOperationHandle,
  ): Promise<StoredAgentRecord> {
    return this.withInput(
      agentId,
      "archive",
      undefined,
      async (operationHandle) => {
        return this.runLifecycleMutation(agentId, () =>
          this.archiveSnapshotUnlocked(agentId, archivedAt, operationHandle),
        );
      },
      commandPayload("archive", { archivedAt }),
      handle,
    );
  }

  private async archiveSnapshotUnlocked(
    agentId: string,
    archivedAt: string,
    operationHandle?: TrustedOperationHandle,
    admittedPlan?: CascadeArchivePlan,
  ): Promise<StoredAgentRecord> {
    this.withInput(
      agentId,
      "archive",
      undefined,
      () => undefined,
      commandPayload("archive", { archivedAt }),
      operationHandle,
    );
    const registry = this.requireRegistry();
    const cascadePlan = admittedPlan ?? (await this.admitArchiveDescendants(agentId));
    // A stored-only archive can have waited behind a persisted resume. Reuse the
    // live archive transition so its newly acquired runtime is closed as well.
    if (this.agents.has(agentId)) {
      await this.archiveAgentUnlocked(agentId, archivedAt, cascadePlan);
      const archivedRecord = await registry.get(agentId);
      if (!archivedRecord) throw new Error(`Agent not found: ${agentId}`);
      return archivedRecord;
    }

    const record = await registry.get(agentId);
    if (!record) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    this.trustedPlugins.input(
      record,
      "archive",
      undefined,
      () => undefined,
      commandPayload("archive", { archivedAt }),
      operationHandle,
    );
    const nextRecord = await this.persistArchivedRecord(record, { archivedAt });

    await this.syncNativeArchiveState(record.provider, record.persistence, "archive");

    this.discardRetainedAgentState(agentId);
    if (!nextRecord.internal) this.dispatchStoredAgentState(nextRecord);

    await this.fireAgentArchived(agentId);
    await this.cascadeArchiveChildren(agentId, cascadePlan);

    return nextRecord;
  }

  async unarchiveSnapshot(
    agentId: string,
    updates?: { workspaceId?: string; labels?: AgentLabelPatch },
    operationHandle?: TrustedOperationHandle,
  ): Promise<boolean> {
    return this.runLifecycleMutation(agentId, () =>
      this.withStoredInput(
        agentId,
        "unarchive",
        undefined,
        () => this.unarchiveSnapshotUnlocked(agentId, updates),
        commandPayload("unarchive", updates),
        operationHandle,
      ),
    );
  }

  private async unarchiveSnapshotUnlocked(
    agentId: string,
    updates?: { workspaceId?: string; labels?: AgentLabelPatch },
  ): Promise<boolean> {
    const registry = this.requireRegistry();
    const record = await registry.get(agentId);
    if (!record || !record.archivedAt) {
      return false;
    }

    // Close and native restore share the lifecycle lane with persisted resume.
    // No new history or interactive runtime can acquire the writer between them.
    if (this.agents.has(agentId)) await this.closeAgentRuntime(agentId);
    await nativeDispatch(() =>
      this.syncNativeArchiveState(record.provider, record.persistence, "restore"),
    );

    await registry.upsert({
      ...record,
      ...(updates?.workspaceId ? { workspaceId: updates.workspaceId } : {}),
      ...(updates?.labels ? { labels: applyLabelPatch(record.labels, updates.labels) } : {}),
      archivedAt: null,
      updatedAt: new Date().toISOString(),
    });

    if (this.getAgent(agentId)) {
      this.notifyAgentState(agentId);
    }
    return true;
  }

  async unarchiveSnapshotByHandle(handle: AgentPersistenceHandle): Promise<void> {
    const registry = this.requireRegistry();
    const records = await registry.list();
    const matched = records.find(
      (record) =>
        record.persistence?.provider === handle.provider &&
        record.persistence?.sessionId === handle.sessionId,
    );
    if (!matched) {
      return;
    }

    await this.unarchiveSnapshot(matched.id);
  }

  /** Host-generated status only. No wire route, caller-selected label or input authority. */
  async updateLimitResumeMarker(agentId: string, resumeAtIso: string | null): Promise<void> {
    if (resumeAtIso !== null && !Number.isFinite(Date.parse(resumeAtIso)))
      throw new Error("Invalid limit resume status time");
    await this.runLifecycleMutation(agentId, () =>
      this.writeLabels(agentId, { "fulcra.limit-resume-at": resumeAtIso ?? "" }).then(
        () => undefined,
      ),
    );
  }

  /** Synchronous stop fingerprint. Unknown/credential-bearing configuration is refusal, not authority. */
  getLimitResumeBinding(agentId: string): string | null {
    const agent = this.agents.get(agentId);
    if (
      !agent?.session ||
      !agent.config.model ||
      !agent.config.modeId ||
      this.lifecycleMutationTails.has(agentId) ||
      agent.pendingReplacement
    )
      return null;
    try {
      const account = agent.session.limitResumeAccountBinding?.();
      if (typeof account !== "string" || !account) return null;
      const sessionId = agent.persistence?.sessionId ?? agent.session.id;
      if (!sessionId) return null;
      return fingerprintLimitResumeBinding(agent.config, {
        provider: agent.provider,
        cwd: agent.cwd,
        sessionId,
        account,
        appendSystemPrompt: this.appendSystemPrompt,
        lastUserMessageAt: agent.lastUserMessageAt?.toISOString() ?? null,
      });
    } catch {
      return null;
    }
  }

  /** No ownership classifier exists for trusted input authorities: unknown ownership refuses fallback. */
  canRunUnscopedLimitResume(agentId: string): boolean {
    const agent = this.agents.get(agentId);
    if (!agent || agent.internal || agent.owner || !["codex", "claude"].includes(agent.provider))
      return false;
    try {
      return !this.trustedPlugins.catalog().some((plugin) => plugin.hooks.includes("input"));
    } catch {
      return false;
    }
  }

  async updateAgentMetadata(
    agentId: string,
    updates: {
      title?: string;
      labels?: Record<string, string>;
    },
  ): Promise<void> {
    if (updates.labels && Object.hasOwn(updates.labels, PARENT_AGENT_ID_LABEL))
      throw new Error("Use native owner parent adoption to change parent metadata");
    return this.runLifecycleMutation(agentId, () =>
      this.withStoredInput(
        agentId,
        "configure",
        undefined,
        () => this.updateAgentMetadataUnlocked(agentId, updates),
        commandPayload("set-metadata", { metadata: updates }),
      ),
    );
  }

  private async updateAgentMetadataUnlocked(
    agentId: string,
    updates: {
      title?: string;
      labels?: Record<string, string>;
    },
  ): Promise<void> {
    const liveAgent = this.getAgent(agentId);
    if (liveAgent) {
      if (updates.title) {
        await this.setTitle(agentId, updates.title);
      }
      if (updates.labels) {
        await this.writeLabels(agentId, updates.labels);
      }
      return;
    }

    await this.writeStoredMetadata(agentId, updates);
  }

  private async runLifecycleMutation<T>(agentId: string, mutation: () => Promise<T>): Promise<T> {
    // Parent cascade classifies a child inside the same lane used by open-tab
    // label writes, so a received ownership update cannot be overtaken.
    const previous = this.lifecycleMutationTails.get(agentId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(mutation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.lifecycleMutationTails.set(agentId, tail);
    void tail.finally(() => {
      if (this.lifecycleMutationTails.get(agentId) === tail) {
        this.lifecycleMutationTails.delete(agentId);
      }
    });
    return result;
  }

  async runAgent(
    agentId: string,
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
  ): Promise<AgentRunResult> {
    const events = this.streamAgent(agentId, prompt, options);
    const timeline: AgentTimelineItem[] = [];
    let finalText = "";
    let usage: AgentUsage | undefined;
    let canceled = false;

    for await (const event of events) {
      if (event.type === "timeline") {
        timeline.push(event.item);
      } else if (event.type === "turn_completed") {
        usage = event.usage;
      } else if (event.type === "turn_failed") {
        throw new Error(this.formatTurnFailedMessage(event));
      } else if (event.type === "turn_canceled") {
        canceled = true;
      }
    }

    finalText = this.getLastAssistantMessageFromTimeline(timeline) ?? "";

    const agent = this.requireAgent(agentId);
    const sessionId = agent.persistence?.sessionId;
    if (!sessionId) {
      throw new Error(`Agent ${agentId} has no persistence.sessionId after run completed`);
    }
    return {
      sessionId,
      finalText,
      usage,
      timeline,
      canceled,
    };
  }

  /**
   * Try to run a prompt out-of-band — i.e. without allocating a foreground turn
   * and without canceling any active turn. Returns true when the session
   * accepted the prompt as a side-effect command (e.g. /goal pause). Events
   * emitted by the handler flow through dispatchStream so they persist and
   * broadcast like normal timeline events.
   */
  tryRunOutOfBand(agentId: string, prompt: AgentPromptInput, options?: AgentRunOptions): boolean {
    return this.withInput(
      agentId,
      "prompt",
      options?.clientMessageId,
      (handle) => {
        if (handle) {
          prompt = this.trustedPlugins.dispatchPrompt(handle);
          options = snapshotRunOptions({
            ...options,
            [TRUSTED_OPERATION]: handle,
          });
        }
        const agent = this.requireSessionAgent(agentId);
        const handler = agent.session.tryHandleOutOfBand?.(prompt);
        if (!handler) {
          return false;
        }
        let emitted = Promise.resolve();
        const dispatch = (event: AgentStreamEvent): void => {
          emitted = emitted.then(async () => {
            if (event.type === "timeline") {
              this.touchUpdatedAt(agent);
              const row = await this.recordTimeline(agent.id, event.item);
              this.dispatchStream(agent.id, event, {
                seq: row.seq,
                epoch: this.timelineStore.getEpoch(agent.id),
                timestamp: row.timestamp,
              });
            } else {
              await this.drainTimelineWrites(agent.id);
              this.assertTimelineHealthy(agent.id);
              this.dispatchStream(agent.id, event, { timestamp: new Date().toISOString() });
            }
            return undefined;
          });
          void emitted.catch(() => undefined);
        };
        const task = (async () => {
          try {
            if (options?.clientMessageId) {
              await this.recordSubmittedPrompt(agent, prompt, options.clientMessageId);
              this.emitState(agent);
            }
            try {
              await handler.run({ emit: dispatch });
            } catch (error) {
              const text = error instanceof Error ? error.message : "Out-of-band command failed";
              dispatch({
                type: "timeline",
                provider: agent.provider,
                item: { type: "assistant_message", text: `[Error] ${text}` },
              });
            }
            await emitted;
          } catch (error) {
            this.logger.error({ err: error, agentId }, "Failed to persist out-of-band command");
          }
        })();
        this.trackBackgroundTask(task);
        return true;
      },
      promptPayload(prompt, options),
      options?.[TRUSTED_OPERATION],
    );
  }

  async appendTimelineItem(
    agentId: string,
    item: AgentTimelineItem,
  ): Promise<{ seq: number; epoch: string }> {
    const agent = this.requireAgent(agentId);
    item = limitAgentTimelineItemContent(item);
    this.touchUpdatedAt(agent);
    const row = await this.recordTimeline(agentId, item);
    this.dispatchStream(
      agentId,
      {
        type: "timeline",
        item,
        provider: agent.provider,
      },
      {
        seq: row.seq,
        epoch: this.timelineStore.getEpoch(agentId),
        timestamp: row.timestamp,
      },
    );
    await this.persistSnapshot(agent);
    return { seq: row.seq, epoch: this.timelineStore.getEpoch(agentId) };
  }

  async emitLiveTimelineItem(agentId: string, item: AgentTimelineItem): Promise<void> {
    const agent = this.requireAgent(agentId);
    this.touchUpdatedAt(agent);
    this.dispatchStream(agentId, {
      type: "timeline",
      item,
      provider: agent.provider,
    });
  }

  private async startPendingForegroundTurn(params: {
    agent: ActiveManagedAgent;
    agentId: string;
    pendingRun: PendingForegroundRun;
    prompt: AgentPromptInput;
    options?: AgentRunOptions;
  }): Promise<string> {
    const { agent, agentId, pendingRun, prompt, options } = params;
    try {
      const previousAdmission = options?.[CODEX_TURN_ADMISSION];
      const handle = options?.[TRUSTED_OPERATION];
      const instanceId = agent.instanceId;
      if (!instanceId) throw new Error("Live instance identity unavailable");
      const validate = () => {
        if (
          this.agents.get(agentId) !== agent ||
          agent.instanceId !== instanceId ||
          pendingRun.settled
        )
          throw new Error("Codex live instance or pending turn changed");
        if (handle) this.trustedPlugins.resumeOperation(handle, () => undefined);
        if (options?.[NATIVE_QUEUED_FINAL]) {
          if (agent.pendingPermissions.size > 0)
            throw new Error("Native queued permission boundary changed");
          validateNativeQueuedDispatch(options[NATIVE_QUEUED_FINAL]);
        }
      };
      const legacyAdmission = (quota: AgentQuotaSnapshot): true => {
        validate();
        if (handle) this.reportObservedQuotaLimit(agent, quota, handle.operation.operationId);
        if (typeof previousAdmission === "function" && previousAdmission(quota) !== true)
          throw new Error("Codex turn denied");
        return this.trustedPlugins.codexTurn(agent, quota);
      };
      let turnOptions = options;
      if (this.trustedPlugins.hasCodexTurnHooks()) {
        let admission: NonNullable<AgentRunOptions[typeof CODEX_TURN_ADMISSION]>;
        if (!this.trustedPlugins.hasV11CodexTurnHooks() && typeof previousAdmission !== "object") {
          admission = legacyAdmission;
        } else if (handle) {
          admission = {
            operation: handle.operation,
            instanceId,
            validate,
            check: (
              turn: import("@getpaseo/plugin/server").TrustedCodexTurnV11,
              quota: AgentQuotaSnapshot,
            ): true => {
              validate();
              this.reportObservedQuotaLimit(agent, quota, turn.operation.operationId);
              if (previousAdmission) {
                if (typeof previousAdmission === "function") {
                  if (previousAdmission(quota) !== true) throw new Error("Codex turn denied");
                } else {
                  previousAdmission.validate();
                  if (previousAdmission.check(turn, quota) !== true)
                    throw new Error("Codex turn denied");
                }
              }
              return this.trustedPlugins.codexTurnV11(agent, turn, quota);
            },
            onQuotaReadFailure: (
              turn: import("@getpaseo/plugin/server").TrustedCodexTurnV11,
              failure: import("@getpaseo/plugin/server").QuotaReadFailureV11,
            ): void => {
              validate();
              if (previousAdmission && typeof previousAdmission !== "function")
                previousAdmission.onQuotaReadFailure(turn, failure);
              this.trustedPlugins.quotaReadFailure(agent, turn, failure);
            },
          };
        } else {
          admission = () => {
            throw new Error("Codex operation unavailable");
          };
        }
        turnOptions = { ...options, [CODEX_TURN_ADMISSION]: admission };
      }
      const result = await this.withInput(
        agentId,
        "prompt",
        options?.clientMessageId,
        () => {
          validate();
          assertFinalInputCheck(options?.[FINAL_INPUT_CHECK]);
          if (options?.[FINAL_INPUT_CHECK] && !["codex", "claude"].includes(agent.provider))
            throw new Error("Final-checked notification provider unavailable");
          return nativeDispatch(() => agent.session.startTurn(prompt, turnOptions));
        },
        promptPayload(prompt, options),
        handle,
      );
      if (pendingRun.settled) {
        throw new Error(`Agent ${agentId} run was canceled before its turn started`);
      }
      return result.turnId;
    } catch (caught) {
      failFinalInputHandoff(options?.[FINAL_INPUT_CHECK], caught);
      const queued = options?.[NATIVE_QUEUED_FINAL];
      const error = queued ? nativeQueuedFailure(queued, caught) : caught;
      if (pendingRun.settled) {
        throw error;
      }
      if (isStaleProviderSessionError(error)) {
        pendingRun.start = { status: "failed", error: error.message };
        agent.pendingReplacement = false;
        if (!agent.activeForegroundTurnId) agent.lifecycle = "idle";
        this.runs.settleForegroundRun(agentId, pendingRun.token);
        throw error;
      }
      agent.pendingReplacement = false;
      const errorMsg = error instanceof Error ? error.message : "Failed to start turn";
      pendingRun.start = { status: "failed", error: errorMsg };
      await this.handleStreamEvent(agent, {
        type: "turn_failed",
        provider: agent.provider,
        error: errorMsg,
        ...(error instanceof PermissionAttentionError
          ? { code: error.code, diagnostic: error.diagnostic }
          : {}),
      });
      this.finalizeForegroundTurn(agent);
      this.runs.settleForegroundRun(agentId, pendingRun.token);
      throw error;
    }
  }

  streamAgent(
    agentId: string,
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
  ): AsyncGenerator<AgentStreamEvent> {
    return this.withInput(
      agentId,
      "prompt",
      options?.clientMessageId,
      (handle) => {
        if (handle) {
          prompt = this.trustedPlugins.dispatchPrompt(handle);
          options = snapshotRunOptions({
            ...options,
            [TRUSTED_OPERATION]: handle,
          });
        }
        const existingAgent = this.requireSessionAgent(agentId);
        this.logger.trace(
          {
            agentId,
            provider: existingAgent.provider,
            sessionId: existingAgent.persistence?.sessionId ?? undefined,
            turnId: existingAgent.activeForegroundTurnId ?? undefined,
            lifecycle: existingAgent.lifecycle,
            activeForegroundTurnId: existingAgent.activeForegroundTurnId,
            hasTrackedRun: this.runs.hasRun(agentId),
            promptType: typeof prompt === "string" ? "string" : "structured",
            hasRunOptions: Boolean(options),
          },
          "agent.manager.stream.request",
        );
        if (existingAgent.activeForegroundTurnId || this.runs.hasRun(agentId)) {
          this.logger.trace(
            {
              agentId,
              provider: existingAgent.provider,
              sessionId: existingAgent.persistence?.sessionId ?? undefined,
              turnId: existingAgent.activeForegroundTurnId ?? undefined,
              lifecycle: existingAgent.lifecycle,
              hasTrackedRun: this.runs.hasRun(agentId),
            },
            "agent.manager.stream.reject",
          );
          throw new Error(`Agent ${agentId} already has an active run`);
        }

        const agent = existingAgent;
        const isReplacement = agent.pendingReplacement;
        agent.lastError = undefined;

        const pendingRun = this.runs.createPendingRun(agentId);

        const streamForwarder = async function* streamForwarder(this: AgentManager) {
          let turnId: string;
          let turnStream: ReturnType<AgentRunState["createTurnStream"]> | null = null;
          turnId = await this.startPendingForegroundTurn({
            agent,
            agentId,
            pendingRun,
            prompt,
            options,
          });

          if (isReplacement) {
            agent.pendingReplacement = false;
          }
          const turnStartedAt = new Date();
          agent.activeForegroundTurnId = turnId;
          this.openActiveTurn(agent, turnId, turnStartedAt);
          agent.lifecycle = "running";
          this.touchUpdatedAt(agent);
          // AgentManager owns the accepted-turn boundary. Publish liveness before the canonical
          // prompt so clients can retire optimistic activity without painting an idle frame.
          // The provider's duplicate start for this turn is suppressed at the ingestion boundary.
          this.dispatchStream(
            agent.id,
            { type: "turn_started", provider: agent.provider, turnId },
            { timestamp: turnStartedAt.toISOString() },
          );
          const stagedSubmittedPromptEcho = options?.clientMessageId
            ? pendingRun.stagedEvents.find(
                (event): event is Extract<AgentStreamEvent, { type: "timeline" }> =>
                  event.type === "timeline" &&
                  event.item.type === "user_message" &&
                  event.item.clientMessageId === options?.clientMessageId,
              )
            : undefined;
          try {
            if (options?.clientMessageId) {
              await this.recordSubmittedPrompt(agent, prompt, options.clientMessageId, {
                messageId: options.clientMessageId,
                turnId,
                providerMessageId:
                  stagedSubmittedPromptEcho?.item.type === "user_message"
                    ? stagedSubmittedPromptEcho.item.messageId
                    : undefined,
              });
            }
          } catch (error) {
            pendingRun.start = {
              status: "failed",
              error: error instanceof Error ? error.message : "Timeline commit failed",
            };
            agent.lifecycle = "error";
            agent.lastError = pendingRun.start.error;
            this.runs.settleForegroundRun(agentId, pendingRun.token);
            this.emitState(agent);
            throw error;
          }
          pendingRun.start = { status: "started", turnId };
          for (const stagedEvent of pendingRun.stagedEvents.splice(0)) {
            const isAcceptedTurnStart =
              stagedEvent.type === "turn_started" &&
              getAgentStreamEventTurnId(stagedEvent) === turnId;
            if (isAcceptedTurnStart || stagedEvent === stagedSubmittedPromptEcho) {
              continue;
            }
            this.enqueueSessionEvent(agent.id, stagedEvent);
          }
          this.emitState(agent);
          this.logger.trace(
            {
              agentId,
              provider: agent.provider,
              sessionId: agent.persistence?.sessionId ?? undefined,
              turnId,
              lifecycle: agent.lifecycle,
              activeForegroundTurnId: agent.activeForegroundTurnId,
            },
            "agent.manager.stream.start",
          );

          turnStream = this.runs.createTurnStream(turnId);
          this.runs.addWaiter(agent, turnStream.waiter);

          try {
            const acceptedTurnStartedEvent: AgentStreamEvent = {
              type: "turn_started",
              provider: agent.provider,
              turnId,
            };
            yield acceptedTurnStartedEvent;
            for await (const event of turnStream.events(isTurnTerminalEvent)) {
              yield event;
            }
          } finally {
            if (turnStream) {
              this.runs.deleteWaiter(agent, turnStream.waiter);
            }
            this.runs.settleForegroundRun(agentId, pendingRun.token);
            this.scheduleNativeMessages(agentId);
            if (!agent.activeForegroundTurnId) {
              await this.refreshRuntimeInfo(agent);
            }
          }
        }.call(this);

        return streamForwarder;
      },
      promptPayload(prompt, options),
      options?.[TRUSTED_OPERATION],
    );
  }

  private finalizeForegroundTurn(agent: ActiveManagedAgent, turnId?: string): void {
    const mutableAgent = agent;
    if (turnId) {
      this.runs.rememberFinalizedTurn(mutableAgent, turnId);
    }
    mutableAgent.activeForegroundTurnId = null;
    this.applyActiveTurnTerminal(mutableAgent, turnId);
    const terminalError = mutableAgent.lastError;
    const shouldHoldBusyForReplacement = mutableAgent.pendingReplacement && !terminalError;
    let nextLifecycle: "running" | "error" | "idle";
    if (shouldHoldBusyForReplacement) {
      nextLifecycle = "running";
    } else if (terminalError) {
      nextLifecycle = "error";
    } else {
      nextLifecycle = "idle";
    }
    mutableAgent.lifecycle = nextLifecycle;
    const persistenceHandle =
      mutableAgent.session.describePersistence() ??
      (mutableAgent.runtimeInfo?.sessionId
        ? { provider: mutableAgent.provider, sessionId: mutableAgent.runtimeInfo.sessionId }
        : null);
    if (persistenceHandle) {
      mutableAgent.persistence = attachPersistenceCwd(persistenceHandle, mutableAgent.cwd);
    }
    this.logger.trace(
      {
        agentId: agent.id,
        provider: agent.provider,
        sessionId: mutableAgent.persistence?.sessionId ?? undefined,
        turnId,
        lifecycle: mutableAgent.lifecycle,
        terminalError,
        pendingReplacement: mutableAgent.pendingReplacement,
      },
      "agent.manager.finalize",
    );
    if (!shouldHoldBusyForReplacement) {
      this.touchUpdatedAt(mutableAgent);
      this.emitState(mutableAgent);
    }
  }

  private openActiveTurn(agent: ActiveManagedAgent, turnId: string, startedAt: Date): void {
    agent.activeTurnId = turnId;
    agent.activeTurnStartedAt = startedAt;
  }

  private applyActiveTurnTerminal(
    agent: ActiveManagedAgent,
    turnId?: string,
    fromHistory = false,
  ): ActiveTurnTerminalDisposition {
    if (fromHistory) return "stale";
    if (!agent.activeTurnId) return "untracked";
    if (turnId && agent.activeTurnId !== turnId) return "stale";
    agent.activeTurnId = null;
    agent.activeTurnStartedAt = null;
    return "closed_current";
  }

  async replaceAgentRun(
    agentId: string,
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
  ): Promise<AsyncGenerator<AgentStreamEvent>> {
    assertFinalInputCheck(options?.[FINAL_INPUT_CHECK]);
    return this.withInput(
      agentId,
      "replace",
      options?.clientMessageId,
      async (handle) => {
        if (handle) {
          prompt = this.trustedPlugins.dispatchPrompt(handle);
          options = snapshotRunOptions({
            ...options,
            [TRUSTED_OPERATION]: handle,
          });
        }
        const snapshot = this.requireAgent(agentId);
        if (
          snapshot.lifecycle !== "running" &&
          !snapshot.activeForegroundTurnId &&
          !this.runs.hasRun(agentId)
        ) {
          return this.streamAgent(agentId, prompt, options);
        }

        const agent = this.requireSessionAgent(agentId);
        agent.pendingReplacement = true;
        agent.lifecycle = "running";
        this.touchUpdatedAt(agent);
        this.emitState(agent);

        try {
          await this.cancelAgentRunBefore(agentId, "replace", options?.[TRUSTED_OPERATION]);
          assertFinalInputCheck(options?.[FINAL_INPUT_CHECK]);
          return this.streamAgent(agentId, prompt, options);
        } catch (error) {
          const latest = this.agents.get(agentId);
          if (latest) {
            latest.pendingReplacement = false;
          }
          throw error;
        }
      },
      promptPayload(prompt, options, { replaceRunning: true }),
      options?.[TRUSTED_OPERATION],
    );
  }

  async steerAgentRun(
    agentId: string,
    prompt: AgentPromptInput,
    options?: AgentSteerOptions,
  ): Promise<SteerResult> {
    assertFinalInputCheck(options?.[FINAL_INPUT_CHECK]);
    return this.withInput(
      agentId,
      "steer",
      options?.clientMessageId,
      async (handle) => {
        if (handle) {
          prompt = this.trustedPlugins.dispatchPrompt(handle);
          options = snapshotRunOptions({
            ...options,
            [TRUSTED_OPERATION]: handle,
          });
        }
        const agent = this.requireSessionAgent(agentId);
        if (options?.[FINAL_INPUT_CHECK] && !["codex", "claude"].includes(agent.provider))
          throw new Error("Final-checked notification provider unavailable");
        const expectedTurnId = agent.activeForegroundTurnId ?? agent.activeTurnId;
        if (!expectedTurnId || !agent.session.steerActiveTurn) {
          return { status: "unavailable" };
        }
        const result = await this.runSteerAdmission(agent, expectedTurnId, async () => {
          const admission = await nativeDispatch(
            () => (
              assertFinalInputCheck(options?.[FINAL_INPUT_CHECK]),
              agent.session.steerActiveTurn!(prompt, {
                ...options,
                expectedTurnId,
              })
            ),
          );
          if (admission.status === "accepted") {
            await this.recordAcceptedSteer(agent, prompt, options?.clientMessageId, expectedTurnId);
          }
          return admission;
        });
        // An unavailable answer is only safe to fall back from while this admission
        // still owns the active turn. Never let an A admission replace a later B.
        if (result.status === "unavailable" && agent.activeTurnId !== expectedTurnId) {
          throw new Error("Active turn changed before steering could be delivered");
        }
        return result;
      },
      promptPayload(prompt, options),
      options?.[TRUSTED_OPERATION],
    );
  }

  async steerOrReplaceActiveTurn(
    agentId: string,
    prompt: AgentPromptInput,
    options?: AgentSteerOptions,
  ): Promise<ActiveTurnSteerDispatchResult> {
    assertFinalInputCheck(options?.[FINAL_INPUT_CHECK]);
    return this.withInput(
      agentId,
      "steer",
      options?.clientMessageId,
      async (handle) => {
        if (handle) {
          prompt = this.trustedPlugins.dispatchPrompt(handle);
          options = snapshotRunOptions({
            ...options,
            [TRUSTED_OPERATION]: handle,
          });
        }
        const agent = this.requireSessionAgent(agentId);
        if (options?.[FINAL_INPUT_CHECK] && !["codex", "claude"].includes(agent.provider))
          throw new Error("Final-checked notification provider unavailable");
        const expectedTurnId = agent.activeForegroundTurnId ?? agent.activeTurnId;
        if (!expectedTurnId) {
          return { status: "inactive" };
        }

        const result = agent.session.steerActiveTurn
          ? await this.runSteerAdmission(agent, expectedTurnId, async () => {
              const admission = await nativeDispatch(
                () => (
                  assertFinalInputCheck(options?.[FINAL_INPUT_CHECK]),
                  agent.session.steerActiveTurn!(prompt, {
                    ...options,
                    expectedTurnId,
                  })
                ),
              );
              if (admission.status === "accepted") {
                await this.recordAcceptedSteer(
                  agent,
                  prompt,
                  options?.clientMessageId,
                  expectedTurnId,
                );
              }
              return admission;
            })
          : { status: "unavailable" as const };
        if (result.status === "accepted") {
          return { status: "steered" };
        }

        // Providers without autonomous steering keep their existing dispatch behavior. The shared
        // admission may recognize the turn, but only an accepted steer can own it without replacement.
        if (agent.activeForegroundTurnId === null && agent.activeTurnId === expectedTurnId) {
          return { status: "inactive" };
        }

        await this.beforeSteerUnavailableFallback?.({ agentId, expectedTurnId });
        assertFinalInputCheck(options?.[FINAL_INPUT_CHECK]);
        this.assertSteerAdmissionOwnsTurn(agent, expectedTurnId);
        return {
          status: "replaced",
          iterator: await this.replaceAdmittedForegroundTurn(
            agent,
            expectedTurnId,
            prompt,
            stripSteerOptions(options),
          ),
        };
      },
      promptPayload(prompt, options),
      options?.[TRUSTED_OPERATION],
    );
  }

  private assertSteerAdmissionOwnsTurn(agent: ActiveManagedAgent, expectedTurnId: string): void {
    if (agent.activeTurnId !== expectedTurnId) {
      throw new Error("Active turn changed before steering could be delivered");
    }
  }

  private async runSteerAdmission<T>(
    agent: ActiveManagedAgent,
    expectedTurnId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.runForegroundMutation(agent.id, async () => {
      await this.drainSessionEvents(agent.id);
      this.agentStreamCoalescer.flushFor(agent.id);
      await this.drainTimelineWrites(agent.id);
      this.assertTimelineHealthy(agent.id);
      this.assertSteerAdmissionOwnsTurn(agent, expectedTurnId);
      const barrier: SteerEventBarrier = { events: [] };
      this.steerEventBarriers.set(agent.id, barrier);
      try {
        return await operation();
      } finally {
        if (this.steerEventBarriers.get(agent.id) === barrier) {
          this.steerEventBarriers.delete(agent.id);
        }
        for (const event of barrier.events) {
          this.enqueueSessionEvent(agent.id, event);
        }
        await this.drainSessionEvents(agent.id);
      }
    });
  }

  private async runForegroundMutation<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.foregroundMutationTails.get(agentId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(operation);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.foregroundMutationTails.set(agentId, tail);
    try {
      return await run;
    } finally {
      if (this.foregroundMutationTails.get(agentId) === tail) {
        this.foregroundMutationTails.delete(agentId);
      }
    }
  }

  private async replaceAdmittedForegroundTurn(
    agent: ActiveManagedAgent,
    expectedTurnId: string,
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
  ): Promise<AsyncGenerator<AgentStreamEvent>> {
    this.assertSteerAdmissionOwnsTurn(agent, expectedTurnId);
    agent.pendingReplacement = true;
    agent.lifecycle = "running";
    this.touchUpdatedAt(agent);
    this.emitState(agent);

    try {
      await this.cancelAgentRunBefore(agent.id, "replace", options?.[TRUSTED_OPERATION]);
      return this.streamAgent(agent.id, prompt, options);
    } catch (error) {
      const latest = this.agents.get(agent.id);
      if (latest) {
        latest.pendingReplacement = false;
      }
      throw error;
    }
  }

  private async recordAcceptedSteer(
    agent: ActiveManagedAgent,
    prompt: AgentPromptInput,
    clientMessageId: string | undefined,
    expectedTurnId: string,
  ): Promise<void> {
    if (!clientMessageId) {
      return;
    }
    await this.recordSubmittedPrompt(agent, prompt, clientMessageId, {
      messageId: clientMessageId,
      turnId: expectedTurnId,
    });
    this.emitState(agent);
  }

  async waitForAgentRunStart(agentId: string, options?: WaitForAgentStartOptions): Promise<void> {
    const snapshot = this.getAgent(agentId);
    if (!snapshot) {
      throw new Error(`Agent ${agentId} not found`);
    }

    const pendingRun = this.runs.getPendingRun(agentId);
    if (
      (pendingRun ? pendingRun.start.status === "started" : snapshot.lifecycle === "running") &&
      !snapshot.pendingReplacement
    ) {
      return;
    }

    if (!snapshot.activeForegroundTurnId && !pendingRun && !snapshot.pendingReplacement) {
      throw new Error(`Agent ${agentId} has no pending run`);
    }

    if (options?.signal?.aborted) {
      throw createAbortError(options.signal, "wait_for_agent_start aborted");
    }

    await new Promise<void>((resolvePromise, reject) => {
      if (options?.signal?.aborted) {
        reject(createAbortError(options.signal, "wait_for_agent_start aborted"));
        return;
      }

      let unsubscribe: (() => void) | null = null;
      let abortHandler: (() => void) | null = null;

      const cleanup = () => {
        if (unsubscribe) {
          try {
            unsubscribe();
          } catch {
            // ignore cleanup errors
          }
          unsubscribe = null;
        }
        if (abortHandler && options?.signal) {
          try {
            options.signal.removeEventListener("abort", abortHandler);
          } catch {
            // ignore cleanup errors
          }
          abortHandler = null;
        }
      };

      const finishOk = () => {
        cleanup();
        resolvePromise();
      };

      const finishErr = (error: unknown) => {
        cleanup();
        reject(error);
      };

      if (options?.signal) {
        abortHandler = () =>
          finishErr(createAbortError(options.signal, "wait_for_agent_start aborted"));
        options.signal.addEventListener("abort", abortHandler, { once: true });
      }

      const checkCurrentState = () => {
        const current = this.getAgent(agentId);
        if (!current) {
          finishErr(new Error(`Agent ${agentId} not found`));
          return true;
        }

        const currentPendingRun = this.runs.getPendingRun(agentId);
        if (
          (currentPendingRun
            ? currentPendingRun.start.status === "started"
            : current.lifecycle === "running") &&
          !current.pendingReplacement
        ) {
          finishOk();
          return true;
        }

        if (currentPendingRun?.start.status === "failed") {
          finishErr(new Error(currentPendingRun.start.error));
          return true;
        }

        if (current.lifecycle === "error" && !currentPendingRun) {
          finishErr(new Error(current.lastError ?? `Agent ${agentId} failed to start`));
          return true;
        }

        if (!currentPendingRun && !current.activeForegroundTurnId && !current.pendingReplacement) {
          finishErr(new Error(`Agent ${agentId} run finished before starting`));
          return true;
        }

        return false;
      };

      unsubscribe = this.subscribe(
        (event) => {
          if (event.type !== "agent_state" || event.agent.id !== agentId) {
            return;
          }
          checkCurrentState();
        },
        { agentId, replayState: false },
      );

      checkCurrentState();
    });
  }

  async respondToPermission(
    agentId: string,
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<AgentPermissionResult | void> {
    return this.withStoredInput(
      agentId,
      "permission",
      requestId,
      async () => {
        const agent = this.requireAgent(agentId);
        const originalRequestId = requestId;
        requestId = this.trustedPlugins.permission(agent, requestId, response);
        if (requestId !== originalRequestId && !agent.pendingPermissions.has(requestId)) {
          throw new Error("Rewritten permission request is not pending on this agent");
        }
        if (agent.inFlightPermissionResponses.has(requestId)) {
          throw new Error("A response to this permission request is already being submitted");
        }
        agent.inFlightPermissionResponses.add(requestId);

        try {
          const result = await nativeDispatch(() =>
            agent.session.respondToPermission(requestId, response),
          );
          agent.pendingPermissions.delete(requestId);

          try {
            await this.refreshSessionState(agent);
          } catch {
            // Ignore refresh errors - state sync after permission approval is best effort.
          }

          this.touchUpdatedAt(agent);
          await this.persistSnapshot(agent);
          this.emitState(agent);

          const bufferedResolution = agent.bufferedPermissionResolutions.get(requestId);
          if (bufferedResolution || this.trustedPlugins.hasPermissionGuards()) {
            agent.bufferedPermissionResolutions.delete(requestId);
            this.dispatchStream(
              agent.id,
              bufferedResolution ?? {
                type: "permission_resolved",
                provider: agent.provider,
                requestId,
                resolution: response,
              },
              { timestamp: new Date().toISOString() },
            );
          }

          return result;
        } finally {
          agent.inFlightPermissionResponses.delete(requestId);
          agent.bufferedPermissionResolutions.delete(requestId);
        }
      },
      () => {
        response = normalizeTrustedPermissionResponse(response);
        return { type: "permission", requestId, response };
      },
    );
  }

  async cancelAgentRun(
    agentId: string,
    handle?: TrustedOperationHandle,
  ): Promise<AgentRunCancellationResult> {
    return this.withInput(
      agentId,
      "cancel",
      undefined,
      async (operationHandle) => {
        return this.runForegroundMutation(agentId, () =>
          this.withInput(
            agentId,
            "cancel",
            undefined,
            () => this.cancelAgentRunNow(agentId),
            commandPayload("cancel"),
            operationHandle,
          ),
        );
      },
      commandPayload("cancel"),
      handle,
    );
  }

  private async cancelAgentRunNow(agentId: string): Promise<AgentRunCancellationResult> {
    const agent = this.requireSessionAgent(agentId);
    const existingRun = this.runs.getRun(agentId);
    const run =
      existingRun ??
      (agent.lifecycle === "running" ? this.runs.trackAutonomousRun(agentId, null) : null);
    if (!run) {
      return { status: "not_running" };
    }

    const interruptAcknowledged = await this.interruptSession(agent.session, agentId);
    const settlement = await this.waitWithTimeout({
      operation: run.settledPromise,
      timeoutMs: interruptAcknowledged
        ? INTERRUPT_SESSION_TIMEOUT_MS
        : this.rescueTimeouts.interruptSessionMs,
    });

    if (!interruptAcknowledged) {
      // Orca R3b. `running` with nothing behind it: no tracked run existed (this call synthesized one), no
      // foreground or provider turn, no pending replacement, and the provider acknowledged no interrupt. Nothing
      // will ever settle it, so it is cleared. A real run -- any of those present -- keeps today's refusal.
      if (
        settlement !== "completed" &&
        !existingRun &&
        !agent.activeForegroundTurnId &&
        !agent.activeTurnId &&
        !agent.pendingReplacement
      ) {
        this.logger.warn(
          { agentId },
          "cancelAgentRun: running with no run or turn behind it; clearing stale state",
        );
        this.runs.clearAgentRun(agentId);
        agent.lifecycle = "idle";
        this.touchUpdatedAt(agent);
        this.emitState(agent);
        return { status: "not_running" };
      }
      return { status: settlement === "completed" ? "settled" : "refused" };
    }

    const runTurnId = this.runs.getTurnId(agentId);
    if (settlement === "timed_out" && runTurnId) {
      this.logger.warn(
        { agentId, turnId: runTurnId, kind: run.kind },
        "cancelAgentRun: acknowledged turn still active after timeout, force-canceling",
      );
      await this.dispatchSessionEvent(agent, {
        type: "turn_canceled",
        provider: agent.provider,
        reason: "interrupted",
        turnId: runTurnId,
      });
      await run.settledPromise;
    } else if (settlement === "timed_out" && run.kind === "foreground") {
      this.logger.warn(
        { agentId, kind: run.kind },
        "cancelAgentRun: acknowledged pending turn still active after timeout, clearing it",
      );
      this.runs.settleForegroundRun(agentId, run.token);
      if (!agent.pendingReplacement) {
        agent.lifecycle = "idle";
        this.touchUpdatedAt(agent);
        this.emitState(agent);
      }
    } else if (settlement === "timed_out" && run.kind === "autonomous") {
      this.logger.warn(
        { agentId, kind: run.kind },
        "cancelAgentRun: acknowledged turn still active after timeout, force-canceling",
      );
      await this.dispatchSessionEvent(agent, {
        type: "turn_canceled",
        provider: agent.provider,
        reason: "interrupted",
      });
    }

    if (agent.pendingPermissions.size > 0) {
      this.resolvePendingPermissionsForAgent(agent, agent.provider, undefined, "Interrupted");
      this.touchUpdatedAt(agent);
      this.emitState(agent);
    }
    return { status: "settled" };
  }

  private async cancelAgentRunBefore(
    agentId: string,
    action: "reload" | "replace" | "rewind",
    handle?: TrustedOperationHandle,
  ): Promise<void> {
    const result = await this.cancelAgentRun(agentId, handle);
    if (result.status === "refused") {
      throw new AgentRunCancellationError(agentId, action);
    }
  }

  private async interruptSession(session: AgentSession, agentId: string): Promise<boolean> {
    try {
      const result = await this.waitWithTimeout({
        operation: nativeDispatch(() => session.interrupt()),
        timeoutMs: this.rescueTimeouts.interruptSessionMs,
        onLateError: (error) => {
          this.logger.warn(
            { err: error, agentId },
            "Session interrupt failed after timeout during cancel",
          );
        },
      });

      if (result === "timed_out") {
        this.logger.warn(
          { agentId, timeoutMs: this.rescueTimeouts.interruptSessionMs },
          "Timed out interrupting session during cancel",
        );
        return false;
      }
      return true;
    } catch (error) {
      this.logger.error({ err: error, agentId }, "Failed to interrupt session");
      return false;
    }
  }

  getPendingPermissions(agentId: string): AgentPermissionRequest[] {
    const agent = this.requireSessionAgent(agentId);
    return Array.from(agent.pendingPermissions.values());
  }

  private peekPendingPermission(agent: ManagedAgent): AgentPermissionRequest | null {
    const iterator = agent.pendingPermissions.values().next();
    return iterator.done ? null : iterator.value;
  }

  /**
   * Hydrates the runtime timeline from provider history. No-ops if already hydrated.
   */
  async hydrateTimelineFromProvider(
    agentId: string,
    options?: HydrateTimelineOptions,
  ): Promise<void> {
    const agent = this.requireSessionAgent(agentId);
    await this.hydrateTimelineFromLegacyProviderHistory(agent, options);
  }

  async rewind(agentId: string, messageId: string, mode: RewindMode): Promise<void> {
    return this.withStoredInput(
      agentId,
      "rewind",
      messageId,
      async (operationHandle) => {
        const agent = this.requireSessionAgent(agentId);
        const submittedRow = this.timelineStore
          .getRows(agentId)
          .find(
            (row) =>
              row.item.type === "user_message" &&
              row.item.messageId === messageId &&
              row.item.clientMessageId === messageId,
          );
        if (submittedRow && !submittedRow.providerMessageId) {
          throw new Error("Cannot rewind before the provider acknowledges the submitted prompt");
        }
        const providerMessageId = submittedRow?.providerMessageId ?? messageId;

        if (this.hasInFlightRun(agentId)) {
          await this.cancelAgentRunBefore(agentId, "rewind", operationHandle);
        }

        const lock = this.runs.createPendingRun(agentId);
        try {
          this.logger.info(
            { agentId, provider: agent.provider, messageId, mode },
            "agent.rewind.start",
          );
          await nativeDispatch(() =>
            invokeRewindCapability(agent.session, { messageId: providerMessageId, mode }),
          );
          if (mode !== "files") {
            await this.hydrateTimelineFromProvider(agentId, {
              force: true,
              broadcast: true,
              broadcastTimeline: false,
            });
            this.dispatch({
              type: "timeline_replacement",
              agentId,
              epoch: this.timelineStore.getEpoch(agentId),
            });
          }
          // Rewind stages provider events under the run lock; publish its final state directly.
          this.refreshSessionPersistence(agent);
          await this.refreshSessionState(agent, { emit: false });
          await this.persistSnapshot(agent);
          this.emitState(agent, { persist: false });
          this.logger.info(
            { agentId, provider: agent.provider, messageId, mode },
            "agent.rewind.complete",
          );
        } catch (error) {
          this.logger.warn(
            { err: error, agentId, provider: agent.provider, messageId, mode },
            "agent.rewind.failed",
          );
          throw error;
        } finally {
          this.runs.settleForegroundRun(agentId, lock.token);
        }
      },
      commandPayload("rewind", { messageId, mode }),
    );
  }

  async deleteAgentState(agentId: string): Promise<void> {
    this.discardRetainedAgentState(agentId);
    await this.deleteCommittedTimeline(agentId);
  }

  /**
   * A user deleting an agent keeps its history in the retained area unless the daemon is set to
   * purge or the caller asks for it. The other deleteAgentState callers rebuild or discard
   * throwaway state, and still remove it.
   */
  async removeDeletedAgentState(
    agentId: string,
    options?: { purgeHistory?: boolean; placement?: AgentTimelinePlacement },
  ): Promise<void> {
    this.discardRetainedAgentState(agentId);
    await this.drainTimelineWrites(agentId);
    const store = this.durableTimelineStore;
    if (options?.purgeHistory === true || this.timelineRetention === "purge") {
      if (store?.purgeAgent) await store.purgeAgent(agentId);
      else await store?.deleteAgent(agentId);
    } else if (store?.retainAgent) {
      await store.retainAgent(agentId, options?.placement);
    } else {
      await store?.deleteAgent(agentId);
    }
    this.timelineFailures.delete(agentId);
  }

  /** Finishes a delete once the registry record is gone; retained history stays readable. */
  async finishDeletedAgentState(agentId: string): Promise<void> {
    this.trustedPlugins.deleteKnownAgent(agentId);
    await this.durableTimelineStore?.commitRetention?.(agentId);
  }

  /** Removes the retained history of a deleted agent. */
  async purgeTimelineHistory(agentId: string): Promise<{ purged: boolean }> {
    if (this.agents.has(agentId)) throw new Error("Delete the agent before purging its history");
    return (await this.durableTimelineStore?.purgeAgent?.(agentId)) ?? { purged: false };
  }

  /**
   * The turn and file index for a live, archived or deleted agent. `cwd` places paths for an
   * agent that is not loaded; a loaded agent always uses its own. Retained history is read only
   * when the caller has established that the agent no longer exists.
   */
  async getTimelineIndex(
    agentId: string,
    options?: { cwd?: string; allowRetained?: boolean },
  ): Promise<(AgentTimelineIndexSnapshot & { retained: boolean }) | null> {
    const agent = this.agents.get(agentId);
    const store = this.durableTimelineStore;
    if (!store?.getTimelineIndex) {
      if (!agent || !this.timelineStore.has(agentId)) return null;
      const rows = this.timelineStore.getRows(agentId);
      for (const row of rows) row.seq = row.seqStart;
      return {
        epoch: this.timelineStore.getEpoch(agentId),
        cwd: agent.cwd,
        index: TimelineIndexBuilder.fromRows(rows, agent.cwd).toData(),
        retained: false,
      };
    }
    const cwd = agent?.cwd ?? options?.cwd;
    if (cwd) await store.setIndexCwd?.(agentId, cwd);
    if (agent) await this.drainTimelineWrites(agentId);
    const live = await store.getTimelineIndex(agentId);
    if (live) return { ...live, retained: false };
    // A known agent never reads a retained copy left by an earlier agent with the same id.
    if (agent || options?.allowRetained !== true) return null;
    const retained = await store.getTimelineIndex(agentId, { retained: true });
    return retained ? { ...retained, retained: true } : null;
  }

  async fetchTimelineTurn(
    agentId: string,
    turnId: string,
    options?: AgentTimelineFetchOptions,
  ): Promise<AgentTimelineFetchResult> {
    this.requireAgent(agentId);
    const snapshot = await this.getTimelineIndex(agentId);
    const turn = snapshot ? findTimelineTurn(snapshot.index, turnId) : null;
    if (!turn) throw new Error(`Turn ${turnId} not found`);
    return this.timelineStore.fetch(agentId, { ...options, turn });
  }

  /** Read unloaded journal-backed history without restoring a provider runtime. */
  async fetchStoredTimeline(
    agentId: string,
    options: AgentTimelineFetchOptions & { turnId?: string },
  ): Promise<AgentTimelineFetchResult | null> {
    const store = this.durableTimelineStore;
    if (this.agents.has(agentId) || !store?.fetchExistingCommitted) return null;
    const { turnId, ...fetchOptions } = options;
    const page = await store.fetchExistingCommitted(agentId, fetchOptions);
    if (!page || this.agents.has(agentId)) return null;
    if (!turnId) return page;
    const snapshot = await store.getTimelineIndex?.(agentId);
    const turn = snapshot ? findTimelineTurn(snapshot.index, turnId) : null;
    if (!turn) throw new Error(`Turn ${turnId} not found`);
    return store.fetchExistingCommitted(agentId, { ...fetchOptions, turn });
  }

  /**
   * A page of a deleted agent's retained history, optionally one turn of it, with the placement
   * recorded when it was retained. Null when nothing was retained.
   */
  async fetchRetainedTimeline(
    agentId: string,
    options: AgentTimelineFetchOptions & { turnId?: string },
  ): Promise<{ result: AgentTimelineFetchResult; placement: AgentTimelinePlacement } | null> {
    const store = this.durableTimelineStore;
    if (this.agents.has(agentId) || !store?.fetchRetained) return null;
    const { turnId, ...fetchOptions } = options;
    let turn: AgentTimelineFetchOptions["turn"];
    if (turnId) {
      const snapshot = await store.getTimelineIndex?.(agentId, { retained: true });
      if (!snapshot) return null;
      turn = findTimelineTurn(snapshot.index, turnId) ?? undefined;
      if (!turn) throw new Error(`Turn ${turnId} not found`);
    }
    const result = await store.fetchRetained(agentId, {
      ...fetchOptions,
      ...(turn ? { turn } : {}),
    });
    if (!result) return null;
    return { result, placement: (await store.getRetainedPlacement?.(agentId)) ?? {} };
  }

  async deleteCommittedTimeline(agentId: string): Promise<void> {
    await this.drainTimelineWrites(agentId);
    await this.durableTimelineStore?.deleteAgent(agentId);
    this.timelineFailures.delete(agentId);
  }

  async getLastAssistantMessage(agentId: string): Promise<string | null> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return null;
    }

    return await this.getLastAssistantMessageFromStores(agentId);
  }

  private getLastAssistantMessageFromTimeline(
    timeline: readonly AgentTimelineItem[],
  ): string | null {
    return this.getLastAssistantMessageSegmentFromTimeline(timeline)?.text ?? null;
  }

  private getLastAssistantMessageSegmentFromTimeline(
    timeline: readonly AgentTimelineItem[],
  ): { text: string; startsAtBeginning: boolean } | null {
    // Collect the last contiguous assistant messages (Claude streams chunks)
    const chunks: string[] = [];
    let startsAtBeginning = false;
    for (let i = timeline.length - 1; i >= 0; i--) {
      const item = timeline[i];
      if (item.type !== "assistant_message") {
        if (chunks.length) {
          break;
        }
        continue;
      }
      chunks.push(item.text);
      startsAtBeginning = i === 0;
    }

    if (!chunks.length) {
      return null;
    }

    return {
      text: chunks.toReversed().join(""),
      startsAtBeginning,
    };
  }

  private async getLastAssistantMessageFromStores(agentId: string): Promise<string | null> {
    const liveTimeline = this.timelineStore.getItems(agentId);
    const liveSegment = this.getLastAssistantMessageSegmentFromTimeline(liveTimeline);
    if (!this.durableTimelineStore) {
      return liveSegment?.text ?? null;
    }
    if (!liveSegment) {
      return await this.durableTimelineStore.getLastAssistantMessage(agentId);
    }
    if (!liveSegment.startsAtBeginning) {
      return liveSegment.text;
    }
    const lastDurableItem = await this.durableTimelineStore.getLastItem(agentId);
    if (lastDurableItem?.type !== "assistant_message") {
      return liveSegment.text;
    }
    const durableMessage = await this.durableTimelineStore.getLastAssistantMessage(agentId);
    return durableMessage ? `${durableMessage}${liveSegment.text}` : liveSegment.text;
  }

  private async getLastItemFromStores(agentId: string): Promise<AgentTimelineItem | null> {
    const lastLiveItem = this.timelineStore.getLastItem(agentId);
    return lastLiveItem ?? (await this.durableTimelineStore?.getLastItem(agentId)) ?? null;
  }

  async waitForAgentEvent(
    agentId: string,
    options?: WaitForAgentOptions,
  ): Promise<WaitForAgentResult> {
    const snapshot = this.getAgent(agentId);
    if (!snapshot) {
      throw new Error(`Agent ${agentId} not found`);
    }

    const pendingForegroundRun = this.runs.getPendingRun(agentId);
    const hasForegroundTurn =
      Boolean(snapshot.activeForegroundTurnId) || Boolean(pendingForegroundRun);

    const immediatePermission = this.peekPendingPermission(snapshot);
    if (immediatePermission) {
      return {
        status: snapshot.lifecycle,
        permission: immediatePermission,
        lastMessage: await this.getLastAssistantMessage(agentId),
      };
    }

    const initialStatus = snapshot.lifecycle;
    const initialBusy = isAgentBusy(initialStatus) || hasForegroundTurn;
    const waitForActive = options?.waitForActive ?? false;
    if (!waitForActive && !initialBusy) {
      return {
        status: initialStatus,
        permission: null,
        lastMessage: await this.getLastAssistantMessage(agentId),
      };
    }
    if (waitForActive && !initialBusy && !hasForegroundTurn) {
      return {
        status: initialStatus,
        permission: null,
        lastMessage: await this.getLastAssistantMessage(agentId),
      };
    }

    if (options?.signal?.aborted) {
      throw createAbortError(options.signal, "wait_for_agent aborted");
    }

    return await new Promise<WaitForAgentResult>((resolvePromise, reject) => {
      // Bug #1 Fix: Check abort signal AGAIN inside Promise constructor
      // to avoid race condition between pre-Promise check and abort listener registration
      if (options?.signal?.aborted) {
        reject(createAbortError(options.signal, "wait_for_agent aborted"));
        return;
      }

      let currentStatus: AgentLifecycleStatus = initialStatus;
      let hasStarted =
        isAgentBusy(initialStatus) ||
        Boolean(snapshot.activeForegroundTurnId) ||
        pendingForegroundRun?.start.status === "started";
      let terminalStatusOverride: AgentLifecycleStatus | null = null;
      let finished = false;

      // Bug #3 Fix: Declare unsubscribe and abortHandler upfront so cleanup can reference them
      let unsubscribe: (() => void) | null = null;
      let abortHandler: (() => void) | null = null;

      const cleanup = () => {
        // Clean up subscription
        if (unsubscribe) {
          try {
            unsubscribe();
          } catch {
            // ignore cleanup errors
          }
          unsubscribe = null;
        }

        // Clean up abort listener
        if (abortHandler && options?.signal) {
          try {
            options.signal.removeEventListener("abort", abortHandler);
          } catch {
            // ignore cleanup errors
          }
          abortHandler = null;
        }
      };

      const finish = (permission: AgentPermissionRequest | null) => {
        if (finished) {
          return;
        }
        finished = true;
        cleanup();
        void this.getLastAssistantMessage(agentId)
          .then((lastMessage) => {
            resolvePromise({
              status: currentStatus,
              permission,
              lastMessage,
            });
            return;
          })
          .catch(reject);
      };

      // Bug #3 Fix: Set up abort handler BEFORE subscription
      // to ensure cleanup handlers exist before callback can fire
      if (options?.signal) {
        abortHandler = () => {
          cleanup();
          reject(createAbortError(options.signal, "wait_for_agent aborted"));
        };
        options.signal.addEventListener("abort", abortHandler, { once: true });
      }

      // Bug #3 Fix: Now subscribe with cleanup handlers already in place
      // This prevents race condition if callback fires synchronously with replayState: true
      unsubscribe = this.subscribe(
        (event) => {
          if (event.type === "agent_state") {
            currentStatus = event.agent.lifecycle;
            const pending = this.peekPendingPermission(event.agent);
            if (pending) {
              finish(pending);
              return;
            }
            if (isAgentBusy(event.agent.lifecycle)) {
              hasStarted = true;
              return;
            }
            if (!waitForActive || hasStarted) {
              if (terminalStatusOverride) {
                currentStatus = terminalStatusOverride;
              }
              finish(null);
            }
            return;
          }

          if (event.type === "agent_stream") {
            if (event.event.type === "permission_requested") {
              finish(event.event.request);
              return;
            }
            if (event.event.type === "turn_failed") {
              hasStarted = true;
              terminalStatusOverride = "error";
              return;
            }
            if (event.event.type === "turn_completed") {
              hasStarted = true;
            }
            if (event.event.type === "turn_canceled") {
              hasStarted = true;
            }
          }
        },
        { agentId, replayState: true },
      );
    });
  }

  private async registerSession(
    session: AgentSession,
    config: AgentSessionConfig,
    agentId: string,
    options?: {
      createdAt?: Date;
      updatedAt?: Date;
      lastUserMessageAt?: Date | null;
      labels?: Record<string, string>;
      timeline?: AgentTimelineItem[];
      timelineRows?: AgentTimelineRow[];
      timelineNextSeq?: number;
      persistence?: AgentPersistenceHandle;
      historyPrimed?: boolean;
      lastUsage?: AgentUsage;
      lastError?: string;
      attention?: AttentionState;
      /**
       * Bringing a known agent back, rather than starting a new one. Its timestamps and
       * attention come from what was already recorded, and installing the session is not
       * activity in it.
       */
      restoring?: boolean;
      initialTitle?: string | null;
      publishWhenReady?: boolean;
      deferFailureCleanup?: boolean;
      workspaceId?: string;
      owner?: AgentOwner;
    },
  ): Promise<ManagedAgent> {
    let registered = false;
    try {
      this.assertAcceptingAgentRegistrations();
      const resolvedAgentId = validateAgentId(agentId, "registerSession");
      if (this.agents.has(resolvedAgentId)) {
        throw new Error(`Agent with id ${resolvedAgentId} already exists`);
      }
      const initialPersistedTitle = await this.resolveInitialPersistedTitle(
        resolvedAgentId,
        config,
        options?.initialTitle ?? null,
      );

      const now = new Date();
      await this.durableTimelineStore?.setIndexCwd?.(resolvedAgentId, config.cwd);
      const { durableTimelineHasRows } = await this.initializeAgentTimelineForRegister({
        agentId: resolvedAgentId,
        now,
        options,
      });

      const managed = this.buildManagedAgentForRegister({
        resolvedAgentId,
        session,
        config,
        now,
        durableTimelineHasRows,
        options,
      });

      managed.archivedAt = (await this.registry?.get(resolvedAgentId))?.archivedAt ?? null;
      // Read history before publishing the agent: a provider failure must leave the
      // session unregistered so the registration catch closes it.
      const startupHistory = await this.collectStartupHistory(managed);

      this.assertAcceptingAgentRegistrations();
      this.agents.set(resolvedAgentId, managed);
      registered = true;
      // Initialize previousStatus to track transitions
      this.previousStatuses.set(resolvedAgentId, managed.lifecycle);
      await this.recordStartupTimeline(managed, startupHistory);
      await this.refreshRuntimeInfo(managed, { emit: false });
      this.assertAgentRegistrationActive(managed);
      await this.persistSnapshot(managed, {
        title: initialPersistedTitle,
      });
      this.assertAgentRegistrationActive(managed);
      if (!options?.publishWhenReady) {
        this.emitState(managed, { persist: false });
      }

      await this.refreshSessionState(managed, { emit: false });
      this.assertAgentRegistrationActive(managed);
      managed.lifecycle = "idle";
      // Stamping now over a restored timestamp rewrote the workspace's "last used" in the
      // sidebar every time a chat was reopened, because workspace `statusEnteredAt` is
      // re-derived from persisted agent `updatedAt` on every daemon start.
      if (!options?.restoring) {
        this.touchUpdatedAt(managed);
      }
      await this.persistSnapshot(managed);
      this.assertAgentRegistrationActive(managed);
      this.emitState(managed, { persist: false });
      this.subscribeToSession(managed);
      const launch = this.reportLaunches.get(resolvedAgentId);
      if (launch) launch.identity = this.currentReportIdentity(resolvedAgentId);
      return { ...managed };
    } catch (error) {
      if (!registered && !options?.deferFailureCleanup) {
        await this.closeUnregisteredSession(session);
      }
      throw error;
    }
  }

  private assertAcceptingAgentRegistrations(): void {
    if (!this.acceptingAgentRegistrations) {
      throw new AgentManagerShuttingDownError();
    }
  }

  private assertAgentRegistrationActive(agent: ActiveManagedAgent): void {
    if (!this.acceptingAgentRegistrations || this.agents.get(agent.id) !== agent) {
      throw new AgentManagerShuttingDownError();
    }
  }

  private async closeUnregisteredSession(session: AgentSession): Promise<void> {
    try {
      await nativeDispatch(() => session.close());
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to close unregistered agent session");
    }
  }

  private async collectStartupHistory(agent: ActiveManagedAgent): Promise<AgentStreamEvent[]> {
    const history: AgentStreamEvent[] = [];
    if (!agent.session.initialTimeline?.length || agent.historyPrimed) return history;
    for await (const event of agent.session.streamHistory()) {
      history.push(limitAgentStreamEventContent(event));
    }
    return history;
  }

  private async recordStartupTimeline(
    agent: ActiveManagedAgent,
    history: AgentStreamEvent[],
  ): Promise<void> {
    if (!agent.session.initialTimeline?.length) return;
    if (!agent.historyPrimed) {
      await this.primeTimelineFromLegacyProviderHistory(agent, false, history);
    } else {
      for (const entry of agent.session.initialTimeline) {
        await this.recordTimeline(agent.id, entry.item, { timestamp: entry.timestamp });
      }
    }
    this.refreshSessionPersistence(agent);
  }

  private async requireExternalMcpSupport(
    session: AgentSession,
    storedConfig: AgentSessionConfig,
  ): Promise<void> {
    if (
      Object.keys(storedConfig.mcpServers ?? {}).length === 0 ||
      session.capabilities.supportsMcpServers === true
    ) {
      return;
    }
    await this.closeUnregisteredSession(session);
    throw new Error(`Provider '${storedConfig.provider}' does not support MCP servers`);
  }

  private async initializeAgentTimelineForRegister(params: {
    agentId: string;
    now: Date;
    options:
      | {
          timeline?: AgentTimelineItem[];
          timelineRows?: AgentTimelineRow[];
          timelineNextSeq?: number;
          persistence?: AgentPersistenceHandle;
          createdAt?: Date;
          updatedAt?: Date;
        }
      | undefined;
  }): Promise<{ durableTimelineHasRows: boolean }> {
    const { agentId, now, options } = params;
    const timelineAlreadyPrimed = this.timelineStore.has(agentId);
    const explicitTimelineSeed = buildExplicitTimelineSeedForRegister(now, options);
    const shouldSeedFromDurable =
      !explicitTimelineSeed && !this.timelineStore.has(agentId) && this.durableTimelineStore;
    if (explicitTimelineSeed && this.durableTimelineStore) {
      await this.deleteCommittedTimeline(agentId);
      explicitTimelineSeed.epoch = (await this.loadCommittedTimelineSeed(agentId, now)).epoch;
    }
    const durableTimelineSeed = shouldSeedFromDurable
      ? await this.loadCommittedTimelineSeed(agentId, now)
      : null;
    const durableTimelineHasRows =
      timelineAlreadyPrimed ||
      (durableTimelineSeed != null && (durableTimelineSeed.nextSeq ?? 1) > 1);
    const timelineSeed = explicitTimelineSeed ?? durableTimelineSeed;
    if (timelineSeed || !this.timelineStore.has(agentId)) {
      this.timelineStore.initialize(agentId, timelineSeed ?? { timestamp: now.toISOString() });
    }
    if (explicitTimelineSeed) {
      await this.durableTimelineStore?.bulkInsert(agentId, this.timelineStore.getRows(agentId));
    }
    return { durableTimelineHasRows };
  }

  private buildManagedAgentForRegister(params: {
    resolvedAgentId: string;
    session: AgentSession;
    config: AgentSessionConfig;
    now: Date;
    durableTimelineHasRows: boolean;
    options:
      | {
          createdAt?: Date;
          updatedAt?: Date;
          lastUserMessageAt?: Date | null;
          labels?: Record<string, string>;
          historyPrimed?: boolean;
          lastUsage?: AgentUsage;
          lastError?: string;
          attention?: AttentionState;
          persistence?: AgentPersistenceHandle;
          workspaceId?: string;
          owner?: AgentOwner;
        }
      | undefined;
  }): ActiveManagedAgent {
    const { resolvedAgentId, session, config, now, durableTimelineHasRows, options } = params;
    const trustedPlugins = this.trustedPlugins;
    trustedPlugins.addKnownAgent(resolvedAgentId);
    return {
      id: resolvedAgentId,
      instanceId: randomUUID(),
      archivedAt: null,
      get inputSequence() {
        return trustedPlugins.sequence(resolvedAgentId);
      },
      provider: config.provider,
      cwd: config.cwd,
      workspaceId: options?.workspaceId,
      owner: options?.owner,
      session,
      capabilities: session.capabilities,
      config,
      runtimeInfo: undefined,
      lifecycle: "initializing",
      createdAt: options?.createdAt ?? now,
      updatedAt: options?.updatedAt ?? now,
      availableModes: [],
      currentModeId: null,
      pendingPermissions: new Map<string, AgentPermissionRequest>(),
      bufferedPermissionResolutions: new Map(),
      inFlightPermissionResponses: new Set(),
      pendingReplacement: false,
      activeForegroundTurnId: null,
      activeTurnId: null,
      activeTurnStartedAt: null,
      foregroundTurnWaiters: new Set<ForegroundTurnWaiter>(),
      finalizedForegroundTurnIds: new Set<string>(),
      unsubscribeSession: null,
      persistence: attachPersistenceCwd(
        options?.persistence ?? session.describePersistence(),
        config.cwd,
      ),
      historyPrimed: options?.historyPrimed ?? durableTimelineHasRows,
      lastUserMessageAt: options?.lastUserMessageAt ?? null,
      lastUsage: options?.lastUsage,
      lastError: options?.lastError,
      attention: resolveInitialAttention(options?.attention),
      internal: config.internal ?? false,
      labels: options?.labels ?? {},
    } as ActiveManagedAgent;
  }

  private async loadCommittedTimelineSeed(
    agentId: string,
    now: Date,
  ): Promise<SeedAgentTimelineOptions> {
    if (!this.durableTimelineStore) {
      return { timestamp: now.toISOString() };
    }
    const page = await this.durableTimelineStore.fetchCommitted(agentId, { limit: 1 });
    return {
      rows: await this.durableTimelineStore.getCommittedRows(agentId),
      epoch: page.epoch,
      nextSeq: page.window.nextSeq,
      timestamp: now.toISOString(),
    };
  }

  private async prepareAgentForClosure(
    agent: LiveManagedAgent,
    cancelReason: string,
  ): Promise<ManagedAgentClosed> {
    this.agentStreamCoalescer.flushAndDiscard(agent.id);
    await this.drainTimelineWrites(agent.id);
    this.agents.delete(agent.id);
    this.previousStatuses.delete(agent.id);
    if (agent.unsubscribeSession) {
      agent.unsubscribeSession();
      agent.unsubscribeSession = null;
      this.automaticPermissions.delete(agent.id);
    }
    this.runs.cancelWaiters(agent, (turnId) => ({
      type: "turn_canceled",
      provider: agent.provider,
      reason: cancelReason,
      turnId,
    }));
    this.runs.clearAgentRun(agent.id);
    return {
      ...agent,
      lifecycle: "closed",
      session: null,
      activeForegroundTurnId: null,
      activeTurnId: null,
      activeTurnStartedAt: null,
      pendingPermissions: new Map(),
      bufferedPermissionResolutions: new Map(),
      inFlightPermissionResponses: new Set(),
      pendingReplacement: false,
      foregroundTurnWaiters: new Set(),
      finalizedForegroundTurnIds: new Set(),
      unsubscribeSession: null,
    };
  }

  private discardRetainedAgentState(agentId: string): void {
    this.timelineStore.delete(agentId);
    this.paseoToolPolicies.delete(agentId);
    for (const event of this.providerSubagents.deleteParent(agentId)) {
      this.dispatch({ type: "provider_subagent", event });
    }
  }

  private emitClosedAgent(agent: ManagedAgentClosed, options?: { persist?: boolean }): void {
    this.emitState(agent, options);
  }
  private readonly evidenceProviders = new WeakSet<object>();
  private registerEvidenceProvider(agent: ActiveManagedAgent): void {
    const provider = agent.session;
    if (!this.reportRegistry || !this.nativeReceipts) return;
    if (this.evidenceProviders.has(provider)) return;
    this.evidenceProviders.add(provider);
    registerNativeEvidenceSink(
      provider,
      (completion: Readonly<NativeCompletion>, requireProvider) => {
        const source = this.currentReportIdentity(agent.id);
        const registry = this.reportRegistry;
        const ledger = this.nativeReceipts;
        if (!source || !registry || !ledger)
          throw new Error("Registered native evidence source required");
        let scopes: ReturnType<NativeReportRegistry["captureEvidenceScope"]>;
        try {
          scopes = registry.captureEvidenceScope(source);
        } catch {
          return undefined;
        }
        if (scopes.length === 0) return undefined;
        if (scopes.length !== 1)
          throw new Error("One explicitly registered native evidence task scope required");
        const guard = () => {
          requireProvider();
          if (
            this.agents.get(agent.id) !== agent ||
            agent.session !== provider ||
            nativeEvidenceDigest(this.currentReportIdentity(agent.id)) !==
              nativeEvidenceDigest(source)
          )
            throw new Error("Native evidence source replaced");
          for (const capture of scopes) {
            const current = registry.requireParent(source, capture.scope);
            if (
              nativeEvidenceDigest(current) !==
              nativeEvidenceDigest({
                sourceEpoch: capture.sourceEpoch,
                parent: capture.parent,
                parentEpoch: capture.parentEpoch,
              })
            )
              throw new Error("Native evidence scope replaced");
          }
        };
        guard();
        const at = Date.now();
        const records = scopes.map((capture) => {
          const operationDigest = nativeEvidenceDigest({
            agentId: source.agentId,
            thread: completion.threadId,
            turn: completion.turnId,
            id: completion.id,
          });
          const id = `${operationDigest.slice(0, 8)}-${operationDigest.slice(8, 12)}-4${operationDigest.slice(13, 16)}-8${operationDigest.slice(17, 20)}-${operationDigest.slice(20, 32)}`;
          const body = {
            version: 3 as const,
            recordType: "native_evidence_attempt" as const,
            source,
            sourceEpoch: capture.sourceEpoch,
            recipient: capture.parent,
            recipientEpoch: capture.parentEpoch,
            completionBodyDigest: completion.bodyHash,
            entry: {
              id,
              operationDigest,
              scope: capture.scope,
              at,
              expiresAt: at + 6 * 60 * 60 * 1000,
            },
          };
          return NativeEvidenceClaimSchema.parse({
            ...body,
            fingerprint: nativeEvidenceDigest(body),
            bytes: 4096,
          });
        });
        return {
          requireCurrent: guard,
          prepare: async () => {
            // All scopes reserve their permanent attempt before materialization; partial reservation never replays.
            for (const record of records) {
              guard();
              if (!(await ledger.prepareEvidence(record, guard))) return false;
              guard();
            }
            return true;
          },
          publish: (raw: unknown) => {
            const fact = NativeEvidenceFactSchema.parse(raw);
            guard();
            const work = (async () => {
              for (const claim of records) {
                guard();
                const { fingerprint: _fingerprint, ...captured } = claim;
                const body = {
                  ...captured,
                  recordType: "native_evidence" as const,
                  entry: { ...claim.entry, fact, metadataCommitted: true as const },
                };
                const { bytes: _bytes, ...immutable } = body;
                const record = NativeEvidenceJournalSchema.parse({
                  ...body,
                  fingerprint: nativeEvidenceDigest(immutable),
                });
                await ledger.appendEvidence(record, guard);
                guard();
              }
            })();
            this.trackBackgroundTask(work);
            return work;
          },
        };
      },
    );
  }

  private subscribeToSession(agent: ActiveManagedAgent): void {
    if (agent.unsubscribeSession) {
      return;
    }
    this.registerEvidenceProvider(agent);
    const agentId = agent.id;
    const session = agent.session,
      instanceId = agent.instanceId;
    const unsubscribe = session.subscribe((event: AgentStreamEvent) => {
      if (
        event.type === "permission_resolved" &&
        (this.agents.get(agentId) !== agent ||
          agent.session !== session ||
          agent.instanceId !== instanceId)
      )
        return;
      this.enqueueSessionEvent(agentId, event);
    });
    agent.unsubscribeSession = unsubscribe;
  }

  private enqueueSessionEvent(agentId: string, event: AgentStreamEvent): void {
    if (event.type === "permission_resolved") {
      const automatic = this.automaticPermissions.get(agentId)?.get(event.requestId);
      if (automatic) this.automaticResolutionOrigins.set(event, automatic);
    }
    this.logger.trace(
      {
        agentId,
        provider: event.provider,
        sessionId: this.agents.get(agentId)?.persistence?.sessionId ?? undefined,
        turnId: getAgentStreamEventTurnId(event),
        event,
      },
      "agent.manager.enqueue",
    );
    const steerBarrier = this.steerEventBarriers.get(agentId);
    if (steerBarrier) {
      steerBarrier.events.push(event);
      return;
    }
    const pendingRun = this.runs.getPendingRun(agentId);
    if (pendingRun?.start.status === "pending") {
      pendingRun.stagedEvents.push(event);
      return;
    }
    const previous = this.sessionEventTails.get(agentId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const current = this.agents.get(agentId);
        if (!current) {
          return;
        }
        if (current.session == null) {
          return;
        }
        this.logger.trace(
          {
            agentId,
            provider: event.provider,
            sessionId: current.persistence?.sessionId ?? undefined,
            turnId: getAgentStreamEventTurnId(event),
            event,
          },
          "agent.manager.dequeue",
        );
        await this.dispatchSessionEvent(current, event);
        return;
      })
      .catch((err) => {
        this.logger.error(
          { err, agentId, eventType: event.type },
          "Failed to process session event",
        );
      });

    this.sessionEventTails.set(agentId, next);
    this.trackBackgroundTask(next);
    void next.finally(() => {
      if (this.sessionEventTails.get(agentId) === next) {
        this.sessionEventTails.delete(agentId);
      }
    });
  }

  /**
   * Provider mutations may synchronously emit config events that are processed through the
   * asynchronous session queue. Apply those events before committing the mutation's explicit
   * manager state so call order remains authoritative.
   */
  private async drainSessionEvents(agentId: string): Promise<void> {
    while (true) {
      const tail = this.sessionEventTails.get(agentId);
      if (!tail) {
        return;
      }
      await tail;
      if (this.sessionEventTails.get(agentId) === tail) {
        return;
      }
    }
  }

  private async dispatchSessionEvent(
    agent: ActiveManagedAgent,
    event: AgentStreamEvent,
  ): Promise<void> {
    if (event.type === "provider_subagent") {
      const update = this.providerSubagents.apply(agent.id, event.provider, event.event);
      this.dispatch({ type: "provider_subagent", event: update });
      return;
    }
    if (event.type === "background_work_changed") {
      this.applyBackgroundWork(agent, event.backgroundWork);
      return;
    }
    const turnId = getAgentStreamEventTurnId(event);
    const matchingWaiters = this.runs.getMatchingWaiters(agent, turnId);
    this.logger.trace(
      {
        agentId: agent.id,
        provider: event.provider,
        sessionId: agent.persistence?.sessionId ?? undefined,
        turnId,
        matchingWaiterCount: matchingWaiters.length,
        event,
      },
      "agent.manager.dispatch_session_event",
    );

    const shouldNotifyWaiters = await this.handleStreamEvent(agent, event);

    if (!shouldNotifyWaiters) {
      return;
    }

    this.runs.notifyWaiters(matchingWaiters, event, {
      terminal: isTurnTerminalEvent(event),
    });
    this.logger.trace(
      {
        agentId: agent.id,
        provider: event.provider,
        sessionId: agent.persistence?.sessionId ?? undefined,
        turnId,
        notifiedWaiterCount: matchingWaiters.length,
        terminal: isTurnTerminalEvent(event),
        event,
      },
      "agent.manager.notify_waiters",
    );
  }

  private async resolveInitialPersistedTitle(
    agentId: string,
    config: AgentSessionConfig,
    fallbackTitle: string | null,
  ): Promise<string | null> {
    const existing = await this.registry?.get(agentId);
    if (existing) {
      return existing.title ?? null;
    }
    const explicitTitle =
      typeof config.title === "string" && config.title.trim().length > 0
        ? config.title.trim()
        : null;
    return explicitTitle ?? fallbackTitle;
  }

  private async persistSnapshot(
    agent: ManagedAgent,
    options?: { title?: string | null; internal?: boolean },
  ): Promise<void> {
    if (!this.registry) {
      return;
    }
    // Don't persist internal agents - they're ephemeral system tasks
    if (agent.internal) {
      return;
    }
    await this.registry.applySnapshot(agent, options);
  }

  private requireRegistry(): AgentStorage {
    if (!this.registry) {
      throw new Error("Agent storage unavailable");
    }
    return this.registry;
  }

  private async refreshSessionState(
    agent: ActiveManagedAgent,
    options?: { emit?: boolean },
  ): Promise<void> {
    try {
      const modes = await agent.session.getAvailableModes();
      agent.availableModes = modes;
    } catch {
      agent.availableModes = [];
    }

    try {
      agent.currentModeId = await agent.session.getCurrentMode();
    } catch {
      agent.currentModeId = null;
    }

    try {
      const pending = agent.session.getPendingPermissions();
      agent.pendingPermissions = new Map(pending.map((request) => [request.id, request]));
    } catch {
      agent.pendingPermissions.clear();
    }

    this.syncFeaturesFromSession(agent);
    await this.refreshRuntimeInfo(agent, options);
  }

  private async refreshRuntimeInfo(
    agent: ActiveManagedAgent,
    options?: { emit?: boolean },
  ): Promise<void> {
    try {
      const newInfo = await agent.session.getRuntimeInfo();
      const changed =
        newInfo.model !== agent.runtimeInfo?.model ||
        newInfo.thinkingOptionId !== agent.runtimeInfo?.thinkingOptionId ||
        newInfo.sessionId !== agent.runtimeInfo?.sessionId ||
        newInfo.modeId !== agent.runtimeInfo?.modeId;
      agent.runtimeInfo = newInfo;
      if (!agent.persistence && newInfo.sessionId) {
        agent.persistence = attachPersistenceCwd(
          { provider: agent.provider, sessionId: newInfo.sessionId },
          agent.cwd,
        );
      }
      // Emit state if runtimeInfo changed so clients get the updated model
      if (changed && options?.emit !== false) {
        this.emitState(agent);
      }
    } catch {
      // Keep existing runtimeInfo if refresh fails.
    }
  }

  private async hydrateTimelineFromLegacyProviderHistory(
    agent: ActiveManagedAgent,
    options?: HydrateTimelineOptions,
  ): Promise<void> {
    if (agent.historyPrimed && !options?.force) {
      return;
    }

    const broadcast = options?.broadcast ?? false;
    const broadcastTimeline = options?.broadcastTimeline ?? broadcast;

    if (options?.force) {
      await this.forceHydrateTimelineFromLegacyProviderHistory(
        agent,
        typeof broadcast === "function" ? broadcast() : broadcast,
        typeof broadcastTimeline === "function" ? broadcastTimeline() : broadcastTimeline,
      );
      return;
    }

    await this.primeTimelineFromLegacyProviderHistory(agent, broadcast);
  }

  private async forceHydrateTimelineFromLegacyProviderHistory(
    agent: ActiveManagedAgent,
    broadcast: boolean,
    broadcastTimeline: boolean,
  ): Promise<void> {
    const historyEvents: Extract<AgentStreamEvent, { type: "timeline" }>[] = [];
    const providerSubagentEvents: Extract<AgentStreamEvent, { type: "provider_subagent" }>[] = [];
    for await (const rawEvent of agent.session.streamHistory()) {
      const event = limitAgentStreamEventContent(rawEvent);
      if (event.type === "timeline") {
        if (event.item.type === "user_message" && isSystemInjectedEnvelope(event.item.text)) {
          continue;
        }
        historyEvents.push(event);
      } else if (event.type === "provider_subagent") {
        providerSubagentEvents.push(event);
      }
    }

    this.agentStreamCoalescer.flushAndDiscard(agent.id);
    await this.deleteCommittedTimeline(agent.id);
    this.timelineStore.delete(agent.id);
    this.timelineStore.initialize(
      agent.id,
      await this.loadCommittedTimelineSeed(agent.id, new Date()),
    );
    agent.historyPrimed = true;

    for (const event of this.providerSubagents.deleteParent(agent.id)) {
      if (broadcast) {
        this.dispatch({ type: "provider_subagent", event });
      }
    }
    for (const event of providerSubagentEvents) {
      const update = this.providerSubagents.apply(agent.id, event.provider, event.event);
      if (broadcast) {
        this.dispatch({ type: "provider_subagent", event: update });
      }
    }
    for (const event of historyEvents) {
      const row = await this.recordTimeline(
        agent.id,
        event.item,
        event.timestamp ? { timestamp: event.timestamp } : undefined,
      );
      if (broadcastTimeline) {
        this.dispatchStream(agent.id, event, {
          seq: row.seq,
          epoch: this.timelineStore.getEpoch(agent.id),
          timestamp: row.timestamp,
        });
      }
    }
    this.touchUpdatedAt(agent);
    this.emitState(agent);
  }

  private publishHistorySubagentEvent(
    event: AgentManagerEvent,
    broadcast: boolean | (() => boolean),
    pending: AgentManagerEvent[],
  ): void {
    if (typeof broadcast === "function") pending.push(event);
    else if (broadcast) this.dispatch(event);
  }

  private async primeTimelineFromLegacyProviderHistory(
    agent: ActiveManagedAgent,
    broadcast: boolean | (() => boolean),
    history:
      | AsyncIterable<AgentStreamEvent>
      | Iterable<AgentStreamEvent> = agent.session.streamHistory(),
  ): Promise<void> {
    const deferredBroadcast = typeof broadcast === "function";
    const historyEvents: Extract<AgentStreamEvent, { type: "timeline" }>[] = [];
    const historySubagentEvents: Extract<AgentStreamEvent, { type: "provider_subagent" }>[] = [];
    agent.historyPrimed = false;
    try {
      // Collect the whole replay before touching either store. A stream that fails
      // halfway then leaves the committed timeline as it was, instead of a partial
      // copy the next attempt would append to.
      for await (const rawEvent of history) {
        const event = limitAgentStreamEventContent(rawEvent);
        if (event.type === "provider_subagent") {
          historySubagentEvents.push(event);
          continue;
        }
        if (event.type !== "timeline") {
          continue;
        }
        if (event.item.type === "user_message" && isSystemInjectedEnvelope(event.item.text)) {
          continue;
        }
        historyEvents.push(event);
      }
    } catch (error) {
      this.logger.warn({ err: error, agentId: agent.id }, "Failed to hydrate provider history");
      throw error;
    }

    // The replay is the timeline, so drop the rows a previous hydration committed.
    // Keeping them would leave getTimelineRows reading one copy per hydration.
    await this.deleteCommittedTimeline(agent.id);
    this.timelineStore.delete(agent.id);
    this.timelineStore.initialize(
      agent.id,
      await this.loadCommittedTimelineSeed(agent.id, new Date()),
    );

    const timelineEvents: Array<{
      event: Extract<AgentStreamEvent, { type: "timeline" }>;
      row: AgentTimelineRow;
    }> = [];
    const providerSubagentEvents: AgentManagerEvent[] = [];
    for (const event of this.providerSubagents.deleteParent(agent.id)) {
      const managerEvent: AgentManagerEvent = { type: "provider_subagent", event };
      this.publishHistorySubagentEvent(managerEvent, broadcast, providerSubagentEvents);
    }
    for (const event of historySubagentEvents) {
      const update = this.providerSubagents.apply(agent.id, event.provider, event.event);
      const managerEvent: AgentManagerEvent = { type: "provider_subagent", event: update };
      this.publishHistorySubagentEvent(managerEvent, broadcast, providerSubagentEvents);
    }
    for (const event of historyEvents) {
      const row = await this.recordTimeline(
        agent.id,
        event.item,
        event.timestamp ? { timestamp: event.timestamp } : undefined,
      );
      if (deferredBroadcast) {
        timelineEvents.push({ event, row });
      } else if (broadcast) {
        this.dispatchStream(agent.id, event, {
          seq: row.seq,
          epoch: this.timelineStore.getEpoch(agent.id),
          timestamp: row.timestamp,
        });
      }
    }
    agent.historyPrimed = true;

    if (typeof broadcast !== "function" || !broadcast()) {
      return;
    }
    for (const event of providerSubagentEvents) {
      this.dispatch(event);
    }
    for (const { event, row } of timelineEvents) {
      this.dispatchStream(agent.id, event, {
        seq: row.seq,
        epoch: this.timelineStore.getEpoch(agent.id),
        timestamp: row.timestamp,
      });
    }
  }

  private notifyForegroundTurnWaiters(agentId: string, event: AgentStreamEvent): void {
    const turnId = getAgentStreamEventTurnId(event);
    if (turnId == null) {
      return;
    }

    const agent = this.agents.get(agentId);
    if (!agent) {
      return;
    }

    this.runs.notifyAgentWaiters(agent, event);
    this.logger.trace(
      {
        agentId,
        provider: event.provider,
        sessionId: agent.persistence?.sessionId ?? undefined,
        turnId,
        event,
      },
      "agent.manager.notify_waiters.coalesced",
    );
  }

  private async handleStreamEvent(
    agent: ActiveManagedAgent,
    event: AgentStreamEvent,
    options?: HandleStreamEventOptions,
  ): Promise<boolean> {
    const automaticOrigin = this.automaticResolutionOrigins.get(event);
    event = limitAgentStreamEventContent(event);
    const identified = attachManagedTurnIdentity(agent, event, options?.fromHistory === true);
    event = identified.event;
    if (automaticOrigin) this.automaticResolutionOrigins.set(event, automaticOrigin);
    const eventTurnId = identified.turnId;
    const isForegroundEvent = agent.activeForegroundTurnId === eventTurnId;
    this.traceHandleStreamEventStart(agent, event, eventTurnId, isForegroundEvent);
    if (
      eventTurnId &&
      isTurnTerminalEvent(event) &&
      this.runs.hasFinalizedTurn(agent, eventTurnId)
    ) {
      return false;
    }

    // Only update timestamp for live events, not history replay
    if (!options?.fromHistory) {
      this.touchUpdatedAt(agent);
      if (this.agentStreamCoalescer.handle(agent.id, event)) {
        this.traceCoalescerBuffered(agent, event, eventTurnId);
        await this.drainTimelineWrites(agent.id);
        this.assertTimelineHealthy(agent.id);
        return false;
      }
      this.agentStreamCoalescer.flushFor(agent.id);
      await this.drainTimelineWrites(agent.id);
      this.assertTimelineHealthy(agent.id);
    }

    let terminalDisposition: ActiveTurnTerminalDisposition = "untracked";
    if (isTurnTerminalEvent(event)) {
      terminalDisposition = this.applyActiveTurnTerminal(
        agent,
        eventTurnId,
        options?.fromHistory === true,
      );
    }

    const flags: StreamEventFlags = { shouldDispatchEvent: true, shouldNotifyWaiters: true };

    const dispatchPromise = this.dispatchStreamEventByType({
      agent,
      event,
      options,
      isForegroundEvent,
      eventTurnId,
      terminalDisposition,
      flags,
    });
    if (dispatchPromise) {
      await dispatchPromise;
    }

    if (!options?.fromHistory) {
      if (isTurnTerminalEvent(event)) {
        this.runs.settleTerminalRun(agent.id, eventTurnId);
        if (isForegroundEvent) {
          this.finalizeForegroundTurn(agent, eventTurnId);
        }
      }

      if (flags.shouldDispatchEvent) {
        this.dispatchStream(agent.id, event, { timestamp: new Date().toISOString() });
      }
    }

    this.traceHandleStreamEventEnd(agent, event, eventTurnId, flags);

    return flags.shouldNotifyWaiters;
  }

  private traceHandleStreamEventStart(
    agent: ActiveManagedAgent,
    event: AgentStreamEvent,
    turnId: string | undefined,
    isForegroundEvent: boolean,
  ): void {
    this.logger.trace(
      {
        agentId: agent.id,
        provider: event.provider,
        sessionId: agent.persistence?.sessionId ?? undefined,
        turnId,
        lifecycle: agent.lifecycle,
        activeForegroundTurnId: agent.activeForegroundTurnId,
        isForegroundEvent,
        event,
      },
      "agent.manager.handle_stream_event.start",
    );
  }

  private traceCoalescerBuffered(
    agent: ActiveManagedAgent,
    event: AgentStreamEvent,
    turnId: string | undefined,
  ): void {
    this.logger.trace(
      {
        agentId: agent.id,
        provider: event.provider,
        sessionId: agent.persistence?.sessionId ?? undefined,
        turnId,
        event,
      },
      "agent.manager.coalescer.buffer",
    );
  }

  private traceHandleStreamEventEnd(
    agent: ActiveManagedAgent,
    event: AgentStreamEvent,
    turnId: string | undefined,
    flags: StreamEventFlags,
  ): void {
    this.logger.trace(
      {
        agentId: agent.id,
        provider: event.provider,
        sessionId: agent.persistence?.sessionId ?? undefined,
        turnId,
        lifecycle: agent.lifecycle,
        activeForegroundTurnId: agent.activeForegroundTurnId,
        shouldDispatchEvent: flags.shouldDispatchEvent,
        shouldNotifyWaiters: flags.shouldNotifyWaiters,
        event,
      },
      "agent.manager.handle_stream_event.end",
    );
  }

  private dispatchStreamEventByType(params: {
    agent: ActiveManagedAgent;
    event: AgentStreamEvent;
    options: HandleStreamEventOptions | undefined;
    isForegroundEvent: boolean;
    eventTurnId: string | undefined;
    terminalDisposition: ActiveTurnTerminalDisposition;
    flags: StreamEventFlags;
  }): Promise<void> | undefined {
    const { agent, event, options, isForegroundEvent, eventTurnId, terminalDisposition, flags } =
      params;
    switch (event.type) {
      case "thread_started":
        this.onStreamThreadStarted(agent);
        return undefined;
      case "usage_updated":
        agent.lastUsage = event.usage;
        this.emitState(agent);
        return undefined;
      case "mode_changed":
        agent.currentModeId = event.currentModeId;
        agent.availableModes = event.availableModes;
        if (agent.runtimeInfo) {
          agent.runtimeInfo = { ...agent.runtimeInfo, modeId: event.currentModeId };
        }
        flags.shouldDispatchEvent = false;
        this.emitState(agent);
        return undefined;
      case "model_changed":
        agent.runtimeInfo = event.runtimeInfo;
        if (!agent.persistence && event.runtimeInfo.sessionId) {
          agent.persistence = attachPersistenceCwd(
            { provider: agent.provider, sessionId: event.runtimeInfo.sessionId },
            agent.cwd,
          );
        }
        agent.currentModeId = event.runtimeInfo.modeId ?? agent.currentModeId;
        flags.shouldDispatchEvent = false;
        this.emitState(agent);
        return undefined;
      case "thinking_option_changed":
        agent.config.thinkingOptionId = event.thinkingOptionId ?? undefined;
        if (agent.runtimeInfo) {
          agent.runtimeInfo = {
            ...agent.runtimeInfo,
            thinkingOptionId: event.thinkingOptionId,
          };
        }
        flags.shouldDispatchEvent = false;
        this.emitState(agent);
        return undefined;
      case "timeline":
        return this.onStreamTimelineEvent({ agent, event, options, flags });
      case "turn_completed":
        this.reportObservedLifecycle(agent, "ended", eventTurnId, isForegroundEvent);
        this.onStreamTurnCompleted({
          agent,
          event,
          eventTurnId,
          isForegroundEvent,
          terminalDisposition,
        });
        return undefined;
      case "turn_failed":
        this.reportObservedLifecycle(agent, "blocked", eventTurnId, isForegroundEvent);
        return this.onStreamTurnFailed({
          agent,
          event,
          eventTurnId,
          isForegroundEvent,
          terminalDisposition,
          options,
        });
      case "turn_canceled":
        this.onStreamTurnCanceled({
          agent,
          event,
          eventTurnId,
          isForegroundEvent,
          terminalDisposition,
          options,
        });
        return undefined;
      case "turn_started":
        this.onStreamTurnStarted({ agent, eventTurnId, isForegroundEvent, flags });
        return undefined;
      case "permission_requested":
        this.reportObservedLifecycle(agent, "needs-you", eventTurnId, isForegroundEvent);
        this.handlePermissionRequest(agent, event, flags, options);
        return undefined;
      case "permission_resolved":
        this.onStreamPermissionResolved({ agent, event, options, flags });
        return undefined;
      default:
        return undefined;
    }
  }

  private onStreamThreadStarted(agent: ActiveManagedAgent): void {
    const previousSessionId = agent.persistence?.sessionId ?? null;
    this.refreshSessionPersistence(agent);
    if (agent.persistence?.sessionId !== previousSessionId) {
      this.emitState(agent);
    }
    void this.refreshRuntimeInfo(agent);
  }

  private refreshSessionPersistence(agent: ActiveManagedAgent): void {
    const handle = agent.session.describePersistence();
    if (handle) {
      agent.persistence = attachPersistenceCwd(handle, agent.cwd);
    }
  }

  private async onStreamTimelineEvent(params: {
    agent: ActiveManagedAgent;
    event: Extract<AgentStreamEvent, { type: "timeline" }>;
    options: { fromHistory?: boolean } | undefined;
    flags: StreamEventFlags;
  }): Promise<void> {
    const { agent, event, options, flags } = params;

    if (event.item.type === "user_message" && isSystemInjectedEnvelope(event.item.text)) {
      flags.shouldDispatchEvent = false;
      flags.shouldNotifyWaiters = false;
      return;
    }

    if (
      event.item.type === "user_message" &&
      event.item.clientMessageId &&
      (await this.reconcileSubmittedPromptEcho(agent, event.item, event.turnId))
    ) {
      flags.shouldDispatchEvent = false;
      flags.shouldNotifyWaiters = false;
      return;
    }

    if (options?.fromHistory) {
      await this.recordTimeline(
        agent.id,
        event.item,
        event.timestamp ? { timestamp: event.timestamp } : undefined,
      );
      flags.shouldDispatchEvent = false;
      flags.shouldNotifyWaiters = false;
      return;
    }

    await this.recordAndDispatchTimelineItem(agent.id, event.item, event.provider, event.turnId);
    if (event.item.type === "user_message") {
      agent.lastUserMessageAt = new Date();
      this.emitState(agent);
    }
    flags.shouldDispatchEvent = false;
    flags.shouldNotifyWaiters = true;
  }

  private onStreamTurnCompleted(params: {
    agent: ActiveManagedAgent;
    event: Extract<AgentStreamEvent, { type: "turn_completed" }>;
    eventTurnId: string | undefined;
    isForegroundEvent: boolean;
    terminalDisposition: ActiveTurnTerminalDisposition;
  }): void {
    const { agent, event, eventTurnId, isForegroundEvent, terminalDisposition } = params;
    this.logger.trace(
      {
        agentId: agent.id,
        provider: agent.provider,
        sessionId: agent.persistence?.sessionId ?? undefined,
        turnId: eventTurnId,
        lifecycle: agent.lifecycle,
        activeForegroundTurnId: agent.activeForegroundTurnId,
      },
      "agent.manager.turn.completed",
    );
    if (terminalDisposition === "stale") return;
    if (event.usage) {
      agent.lastUsage = { ...agent.lastUsage, ...event.usage };
    }
    // If no usage on turn_completed, keep lastUsage as-is so context window
    // data accumulated during streaming isn't lost when the provider omits
    // it from the completion event.
    agent.lastError = undefined;
    if (
      !isForegroundEvent &&
      !agent.activeForegroundTurnId &&
      agent.lifecycle !== "idle" &&
      !agent.pendingReplacement
    ) {
      (agent as ActiveManagedAgent).lifecycle = "idle";
      this.emitState(agent);
    }
    void this.refreshRuntimeInfo(agent);
  }

  private async onStreamTurnFailed(params: {
    agent: ActiveManagedAgent;
    event: Extract<AgentStreamEvent, { type: "turn_failed" }>;
    eventTurnId: string | undefined;
    isForegroundEvent: boolean;
    terminalDisposition: ActiveTurnTerminalDisposition;
    options: { fromHistory?: boolean } | undefined;
  }): Promise<void> {
    const { agent, event, eventTurnId, isForegroundEvent, terminalDisposition, options } = params;
    this.logger.warn(
      {
        agentId: agent.id,
        provider: agent.provider,
        sessionId: agent.persistence?.sessionId ?? undefined,
        turnId: eventTurnId,
        lifecycle: agent.lifecycle,
        activeForegroundTurnId: agent.activeForegroundTurnId,
        eventTurnId,
        error: event.error,
        code: event.code,
        diagnostic: event.diagnostic,
      },
      "handleStreamEvent: turn_failed",
    );
    if (terminalDisposition === "stale") return;
    if (!isForegroundEvent && !agent.activeForegroundTurnId) {
      agent.lifecycle = "error";
    }
    agent.lastError = event.error;
    await this.appendSystemErrorTimelineMessage(
      agent,
      event.provider,
      this.formatTurnFailedMessage(event),
      options,
    );
    this.reconcilePermissionsAfterFailure(agent, event.provider, options);
    if (!isForegroundEvent && !agent.activeForegroundTurnId) {
      this.emitState(agent);
    }
  }

  private onStreamTurnCanceled(params: {
    agent: ActiveManagedAgent;
    event: Extract<AgentStreamEvent, { type: "turn_canceled" }>;
    eventTurnId: string | undefined;
    isForegroundEvent: boolean;
    terminalDisposition: ActiveTurnTerminalDisposition;
    options:
      | {
          fromHistory?: boolean;
        }
      | undefined;
  }): void {
    const { agent, event, eventTurnId, isForegroundEvent, terminalDisposition, options } = params;
    this.logger.trace(
      {
        agentId: agent.id,
        provider: agent.provider,
        sessionId: agent.persistence?.sessionId ?? undefined,
        turnId: eventTurnId,
        lifecycle: agent.lifecycle,
        activeForegroundTurnId: agent.activeForegroundTurnId,
        eventTurnId,
      },
      "agent.manager.turn.canceled",
    );
    if (terminalDisposition === "stale") return;
    if (!isForegroundEvent && !agent.activeForegroundTurnId && !agent.pendingReplacement) {
      agent.lifecycle = "idle";
    }
    agent.lastError = undefined;
    this.resolvePendingPermissionsForAgent(agent, event.provider, options, "Interrupted");
    if (!isForegroundEvent && !agent.activeForegroundTurnId) {
      this.emitState(agent);
    }
  }

  private onStreamTurnStarted(params: {
    agent: ActiveManagedAgent;
    eventTurnId: string | undefined;
    isForegroundEvent: boolean;
    flags: StreamEventFlags;
  }): void {
    const { agent, eventTurnId, isForegroundEvent, flags } = params;
    this.logger.trace(
      {
        agentId: agent.id,
        provider: agent.provider,
        sessionId: agent.persistence?.sessionId ?? undefined,
        turnId: eventTurnId,
        lifecycle: agent.lifecycle,
        activeForegroundTurnId: agent.activeForegroundTurnId,
      },
      "agent.manager.turn.started",
    );
    if (isForegroundEvent) {
      flags.shouldDispatchEvent = false;
      flags.shouldNotifyWaiters = false;
      return;
    }
    if (agent.activeForegroundTurnId) {
      flags.shouldDispatchEvent = false;
      flags.shouldNotifyWaiters = false;
      return;
    }
    this.runs.trackAutonomousRun(agent.id, eventTurnId ?? null);
    if (eventTurnId) {
      this.openActiveTurn(agent, eventTurnId, new Date());
    }
    agent.lifecycle = "running";
    this.emitState(agent);
  }

  /**
   * FIX-8 W3 (gate Z): a trusted plugin may answer a permission request before it is surfaced (Fulcra: an ordinary tool
   * call in an automatic mode -- Claude auto, Codex full-access -- on a session the controller does not own, with no
   * escalation reason). Answered that way it never becomes a pending permission: no attention, no client frame, no
   * waiter wake. If the answer cannot be delivered, the request is surfaced as usual.
   */
  private handlePermissionRequest(
    agent: ActiveManagedAgent,
    event: Extract<AgentStreamEvent, { type: "permission_requested" }>,
    flags: StreamEventFlags,
    options: { fromHistory?: boolean } | undefined,
  ): void {
    if (!options?.fromHistory && this.answerAutomatically(agent, event, flags)) return;
    this.onStreamPermissionRequested(agent, event);
  }

  private answerAutomatically(
    agent: ActiveManagedAgent,
    event: Extract<AgentStreamEvent, { type: "permission_requested" }>,
    flags: StreamEventFlags,
  ): boolean {
    const session = agent.session;
    const instanceId = agent.instanceId;
    const nativeSessionId = agent.runtimeInfo?.sessionId;
    const current = () =>
      this.agents.get(agent.id) === agent &&
      agent.session === session &&
      agent.instanceId === instanceId &&
      agent.runtimeInfo?.sessionId === nativeSessionId &&
      !agent.internal &&
      !agent.archivedAt &&
      !this.inFlightAgentCloses.has(agent.id) &&
      !this.mcpRefreshes.has(agent.id);
    if (agent.internal || !this.trustedPlugins.automaticPermission(agent, event.request))
      return false;
    let pending = this.automaticPermissions.get(agent.id);
    if (!pending) this.automaticPermissions.set(agent.id, (pending = new Map()));
    const automatic = { current, completed: false };
    pending.set(event.request.id, automatic);
    flags.shouldDispatchEvent = false;
    flags.shouldNotifyWaiters = false;
    void Promise.resolve()
      .then(() => {
        // Revalidate after the async scheduling gap, with no await between the
        // final decision and dispatch to the captured provider session.
        if (!current()) {
          this.forgetAutomaticPermission(agent.id, event.request.id, automatic);
          return;
        }
        if (!this.trustedPlugins.automaticPermission(agent, event.request)) {
          this.forgetAutomaticPermission(agent.id, event.request.id, automatic);
          this.onStreamPermissionRequested(agent, event);
          return;
        }
        return Promise.resolve(
          session.respondToPermission(event.request.id, { behavior: "allow" }),
        ).then(() => {
          this.completeAutomaticPermission(agent, event.request.id, automatic, false);
          return undefined;
        });
      })
      .catch((error: unknown) => {
        const owns = this.forgetAutomaticPermission(agent.id, event.request.id, automatic);
        this.logger.warn(
          { err: error, agentId: agent.id },
          "Automatic permission answer failed; surfacing it",
        );
        if (owns && current()) this.onStreamPermissionRequested(agent, event);
      });
    return true;
  }

  private forgetAutomaticPermission(
    agentId: string,
    requestId: string,
    automatic: { current: () => boolean; completed: boolean },
  ): boolean {
    const pending = this.automaticPermissions.get(agentId);
    if (pending?.get(requestId) !== automatic) return false;
    pending.delete(requestId);
    if (pending.size === 0) this.automaticPermissions.delete(agentId);
    return true;
  }

  private completeAutomaticPermission(
    agent: ActiveManagedAgent,
    requestId: string,
    automatic: { current: () => boolean; completed: boolean },
    nativeResolution: boolean,
  ): void {
    const active = this.automaticPermissions.get(agent.id)?.get(requestId);
    if (active && active !== automatic) return;
    if (!automatic.current()) {
      // A late matching event still needs its original scope, even after the reply promise settled.
      if (nativeResolution) this.forgetAutomaticPermission(agent.id, requestId, automatic);
      return;
    }
    if (!nativeResolution) {
      try {
        if (agent.session.getPendingPermissions().some((request) => request.id === requestId))
          return;
      } catch {
        return;
      }
      if (automatic.completed) return;
    }
    automatic.completed = true;
    // Keep the completed token until a late native event, preserving automatic event suppression.
    if (nativeResolution) this.forgetAutomaticPermission(agent.id, requestId, automatic);
    agent.pendingPermissions.delete(requestId);
    this.refreshSessionPersistence(agent);
    this.emitState(agent);
  }

  private onStreamPermissionRequested(
    agent: ActiveManagedAgent,
    event: Extract<AgentStreamEvent, { type: "permission_requested" }>,
  ): void {
    const hadPendingPermissions = agent.pendingPermissions.size > 0;
    agent.pendingPermissions.set(event.request.id, event.request);
    this.refreshSessionPersistence(agent);
    if (!hadPendingPermissions && !agent.internal) {
      this.broadcastAgentAttention(agent, "permission");
    }
    this.emitState(agent);
  }

  private onStreamPermissionResolved(params: {
    agent: ActiveManagedAgent;
    event: Extract<AgentStreamEvent, { type: "permission_resolved" }>;
    options: { fromHistory?: boolean } | undefined;
    flags: StreamEventFlags;
  }): void {
    const { agent, event, options, flags } = params;
    const automatic =
      this.automaticResolutionOrigins.get(event) ??
      this.automaticPermissions.get(agent.id)?.get(event.requestId);
    if (automatic) {
      this.completeAutomaticPermission(agent, event.requestId, automatic, true);
      flags.shouldDispatchEvent = false;
      flags.shouldNotifyWaiters = false;
      return;
    }
    agent.pendingPermissions.delete(event.requestId);
    this.refreshSessionPersistence(agent);
    if (!options?.fromHistory && agent.inFlightPermissionResponses.has(event.requestId)) {
      agent.bufferedPermissionResolutions.set(event.requestId, event);
      flags.shouldDispatchEvent = false;
      return;
    }
    this.emitState(agent);
  }

  private reconcilePermissionsAfterFailure(
    agent: ActiveManagedAgent,
    provider: AgentProvider,
    options: { fromHistory?: boolean } | undefined,
  ): void {
    let pending: AgentPermissionRequest[];
    try {
      pending = agent.session.getPendingPermissions();
    } catch {
      // Unknown provider state cannot authorize fake resolutions or hide an outstanding approval.
      this.logger.warn(
        { agentId: agent.id },
        "Provider pending permissions unavailable after failed turn; retaining projection",
      );
      return;
    }
    this.resolvePendingPermissionsForAgent(
      agent,
      provider,
      options,
      "Turn failed",
      new Set(pending.map((request) => request.id)),
    );
    for (const request of pending) {
      const automatic = this.automaticPermissions.get(agent.id)?.get(request.id);
      if (automatic && !automatic.completed && automatic.current()) continue;
      if (!agent.pendingPermissions.has(request.id))
        this.onStreamPermissionRequested(agent, {
          type: "permission_requested",
          provider,
          request,
        });
    }
    this.refreshSessionPersistence(agent);
  }

  private resolvePendingPermissionsForAgent(
    agent: ActiveManagedAgent,
    provider: AgentProvider,
    options: { fromHistory?: boolean } | undefined,
    message: string,
    retain?: ReadonlySet<string>,
  ): void {
    for (const [requestId] of agent.pendingPermissions) {
      if (retain?.has(requestId)) continue;
      agent.pendingPermissions.delete(requestId);
      if (!options?.fromHistory) {
        this.dispatchStream(agent.id, {
          type: "permission_resolved",
          provider,
          requestId,
          resolution: { behavior: "deny", message },
        });
      }
    }
  }

  private async recordAndDispatchTimelineItem(
    agentId: string,
    item: AgentTimelineItem,
    provider: AgentProvider,
    turnId?: string,
    options?: { providerMessageId?: string },
  ): Promise<AgentStreamEvent> {
    const row = await this.recordTimeline(agentId, item, { ...options, turnId });
    const event: AgentStreamEvent = {
      type: "timeline",
      item,
      provider,
      ...(turnId !== undefined ? { turnId } : {}),
    };
    this.dispatchStream(agentId, event, {
      seq: row.seq,
      epoch: this.timelineStore.getEpoch(agentId),
      timestamp: row.timestamp,
    });

    if (
      item.type === "tool_call" &&
      item.status === "completed" &&
      item.detail?.type === "shell" &&
      commandMayHaveChangedExternalState(item.detail.command)
    ) {
      const agent = this.agents.get(agentId);
      if (agent) {
        this.onWorkspaceStateMayHaveChanged?.({ cwd: agent.cwd });
      }
    }

    return event;
  }

  private async recordSubmittedPrompt(
    agent: ActiveManagedAgent,
    prompt: AgentPromptInput,
    clientMessageId: string,
    options?: { messageId?: string; providerMessageId?: string; turnId?: string },
  ): Promise<void> {
    if (this.timelineStore.getSubmittedUserMessage(agent.id, clientMessageId)) {
      return;
    }
    this.touchUpdatedAt(agent);
    agent.lastUserMessageAt = new Date();
    const item: AgentTimelineItem = {
      type: "user_message",
      text: submittedPromptText(prompt),
      clientMessageId,
      ...(options?.messageId ? { messageId: options.messageId } : {}),
    };
    await this.recordAndDispatchTimelineItem(
      agent.id,
      item,
      agent.provider,
      options?.turnId,
      options,
    );
  }

  private async reconcileSubmittedPromptEcho(
    agent: ActiveManagedAgent,
    item: Extract<AgentTimelineItem, { type: "user_message" }>,
    turnId?: string,
  ): Promise<AgentTimelineRow | null> {
    const { clientMessageId, messageId } = item;
    if (!clientMessageId) return null;
    let existing = this.timelineStore.getSubmittedUserMessage(agent.id, clientMessageId);
    if (!existing) {
      await this.recordSubmittedPrompt(agent, item.text, clientMessageId, {
        messageId: clientMessageId,
        ...(messageId ? { providerMessageId: messageId } : {}),
        ...(turnId ? { turnId } : {}),
      });
      existing = this.timelineStore.getSubmittedUserMessage(agent.id, clientMessageId);
    }
    if (!existing || existing.item.type !== "user_message") return null;
    if (messageId) {
      await this.queueTimelineWrite(agent.id, async () => {
        await this.durableTimelineStore?.updateCommittedRow(agent.id, {
          ...existing!,
          providerMessageId: messageId,
        });
        this.timelineStore.enrichSubmittedUserMessage(agent.id, clientMessageId, messageId);
      });
    }
    return existing;
  }

  private async appendSystemErrorTimelineMessage(
    agent: ActiveManagedAgent,
    provider: AgentProvider,
    message: string,
    options?: { fromHistory?: boolean },
  ): Promise<void> {
    if (options?.fromHistory) {
      return;
    }

    const normalized = message.trim();
    if (!normalized) {
      return;
    }

    const text = `${SYSTEM_ERROR_PREFIX} ${normalized}`;
    const lastItem = await this.getLastItemFromStores(agent.id);
    if (lastItem?.type === "assistant_message" && lastItem.text === text) {
      return;
    }

    const item: AgentTimelineItem = { type: "assistant_message", text };
    const row = await this.recordTimeline(agent.id, item);
    this.dispatchStream(
      agent.id,
      {
        type: "timeline",
        item,
        provider,
      },
      {
        seq: row.seq,
        epoch: this.timelineStore.getEpoch(agent.id),
        timestamp: row.timestamp,
      },
    );
  }

  private formatTurnFailedMessage(
    event: Extract<AgentStreamEvent, { type: "turn_failed" }>,
  ): string {
    const base = event.error.trim();
    const parts = [base.length > 0 ? base : "Provider run failed"];
    const code = event.code?.trim();
    if (code) {
      parts.push(`code: ${code}`);
    }
    const diagnostic = event.diagnostic?.trim();
    if (diagnostic && diagnostic !== base) {
      parts.push(diagnostic);
    }
    return parts.join("\n\n");
  }

  private recordTimeline(
    agentId: string,
    item: AgentTimelineItem,
    options?: { timestamp?: string; providerMessageId?: string; turnId?: string },
  ): Promise<AgentTimelineRow> {
    const input = structuredClone({ item: limitAgentTimelineItemContent(item), options });
    if (!this.durableTimelineStore) {
      return Promise.resolve(this.timelineStore.append(agentId, input.item, input.options));
    }
    return this.queueTimelineWrite(agentId, async () => {
      const row: AgentTimelineRow = {
        ...input.options,
        item: input.item,
        seq: this.timelineStore.getNextSeq(agentId),
        timestamp: input.options?.timestamp ?? new Date().toISOString(),
      };
      await this.durableTimelineStore?.bulkInsert(agentId, [row]);
      return this.timelineStore.append(agentId, input.item, {
        ...input.options,
        timestamp: row.timestamp,
      });
    });
  }

  private queueTimelineWrite<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
    const task = (this.timelineWrites.get(agentId) ?? Promise.resolve()).then(() => {
      if (this.timelineFailures.has(agentId)) throw this.timelineFailures.get(agentId);
      return operation();
    });
    const settled = task.then(
      () => undefined,
      (error) => {
        this.timelineFailures.set(agentId, error);
        this.logger.error({ err: error, agentId }, "Failed to commit timeline");
        const agent = this.agents.get(agentId);
        if (agent) {
          agent.lifecycle = "error";
          agent.lastError = error instanceof Error ? error.message : "Timeline commit failed";
          this.emitState(agent);
        }
      },
    );
    this.timelineWrites.set(agentId, settled);
    void settled.then(() => {
      if (this.timelineWrites.get(agentId) === settled) this.timelineWrites.delete(agentId);
      return undefined;
    });
    this.trackBackgroundTask(settled);
    return task;
  }

  private async drainTimelineWrites(agentId: string): Promise<void> {
    while (this.timelineWrites.has(agentId) || this.coalescedTimelineWrites.has(agentId)) {
      await Promise.all([
        this.timelineWrites.get(agentId),
        this.coalescedTimelineWrites.get(agentId),
      ]);
    }
  }

  private assertTimelineHealthy(agentId: string): void {
    if (this.timelineFailures.has(agentId)) throw this.timelineFailures.get(agentId);
  }

  /**
   * Starts the display-only process sample for providers that expose a process and have no task
   * protocol of their own (Codex). Opt-in: the daemon starts it at boot; tests build managers
   * without it.
   */
  startBackgroundWorkSampling(options?: Partial<BackgroundWorkSamplerOptions>): void {
    if (this.backgroundWorkSampler) return;
    this.backgroundWorkSampler = new BackgroundWorkSampler({
      listTargets: () =>
        [...this.agents.values()].flatMap((agent) => {
          const pid = agent.session.getProcessId?.() ?? null;
          return pid === null ? [] : [{ agentId: agent.id, pid, idle: agent.lifecycle === "idle" }];
        }),
      onChange: (agentId, work) => {
        const agent = this.agents.get(agentId);
        if (agent) this.applyBackgroundWork(agent, work);
      },
      ...options,
    });
    this.backgroundWorkSampler.start();
  }

  stopBackgroundWorkSampling(): void {
    this.backgroundWorkSampler?.stop();
    this.backgroundWorkSampler = null;
  }

  /**
   * Records the session's display-only background-job count and re-publishes the snapshot. It
   * deliberately leaves lifecycle, turns and waiters alone (background-work/authority-fence.test.ts).
   */
  applyBackgroundWork(agent: ManagedAgent, next: AgentBackgroundWork | null): void {
    const current = agent.backgroundWork ?? null;
    const normalized = next && next.count > 0 ? next : null;
    if (isSameBackgroundWork(current, normalized)) return;
    agent.backgroundWork = normalized;
    this.emitState(agent, { persist: false });
  }

  private emitState(agent: ManagedAgent, options?: { persist?: boolean }): void {
    // Keep attention as an edge-triggered unread signal, not a level signal.
    this.checkAndSetAttention(agent);
    if (options?.persist !== false) {
      this.enqueueBackgroundPersist(agent);
    }

    this.syncFeaturesFromSession(agent);
    this.scheduleNativeMessages(agent.id);

    this.logger.trace(
      {
        agentId: agent.id,
        provider: agent.provider,
        sessionId: agent.persistence?.sessionId ?? undefined,
        turnId: agent.activeForegroundTurnId ?? undefined,
        lifecycle: agent.lifecycle,
        activeForegroundTurnId: agent.activeForegroundTurnId,
        pendingPermissions: agent.pendingPermissions.size,
        persist: options?.persist !== false,
      },
      "agent.manager.emit_state",
    );

    this.dispatch({
      type: "agent_state",
      agent: { ...agent },
    });
  }

  private syncFeaturesFromSession(agent: ManagedAgent): void {
    if ("session" in agent && agent.session?.features) {
      agent.features = agent.session.features;
    }
  }

  private checkAndSetAttention(agent: ManagedAgent): void {
    const previousStatus = this.previousStatuses.get(agent.id);
    const currentStatus = agent.lifecycle;

    // Track the new status
    this.previousStatuses.set(agent.id, currentStatus);

    // Skip attention tracking for internal agents
    if (agent.internal) {
      return;
    }

    // Skip if already requires attention
    if (agent.attention.requiresAttention) {
      return;
    }

    // Check if agent transitioned from running to idle (finished)
    if (previousStatus === "running" && currentStatus === "idle") {
      agent.attention = {
        requiresAttention: true,
        attentionReason: "finished",
        attentionTimestamp: new Date(),
      };
      this.broadcastAgentAttention(agent, "finished");
      return;
    }

    // Check if agent entered error state
    if (previousStatus !== "error" && currentStatus === "error") {
      agent.attention = {
        requiresAttention: true,
        attentionReason: "error",
        attentionTimestamp: new Date(),
      };
      this.broadcastAgentAttention(agent, "error");
      return;
    }
  }

  private enqueueBackgroundPersist(agent: ManagedAgent): void {
    const task = this.persistSnapshot(agent).catch((err) => {
      this.logger.error({ err, agentId: agent.id }, "Failed to persist agent snapshot");
    });
    this.trackBackgroundTask(task);
  }

  private trackBackgroundTask(task: Promise<void>): void {
    this.backgroundTasks.add(task);
    void task.finally(() => {
      this.backgroundTasks.delete(task);
    });
  }

  private trackAgentRegistrationOperation<T>(result: Promise<T>): Promise<T> {
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.agentRegistrationTasks.add(settled);
    void settled.then(() => {
      this.agentRegistrationTasks.delete(settled);
      return undefined;
    });
    return result;
  }

  /**
   * Flush any background persistence work (best-effort).
   */
  async flush(): Promise<void> {
    await this.flushTasks({ includeAgentRegistrations: false });
  }

  /**
   * Flush persistence and agent registrations that crossed the synchronous
   * shutdown barrier. Those registrations own provider sessions until they
   * either install them or close them.
   */
  async flushForShutdown(): Promise<void> {
    this.stopBackgroundWorkSampling();
    await this.flushTasks({ includeAgentRegistrations: true });
  }

  private async flushTasks(options: { includeAgentRegistrations: boolean }): Promise<void> {
    this.agentStreamCoalescer.flushAll();
    // Drain tasks, including tasks spawned while awaiting.
    while (
      this.backgroundTasks.size > 0 ||
      (options.includeAgentRegistrations && this.agentRegistrationTasks.size > 0)
    ) {
      const pending = options.includeAgentRegistrations
        ? [...this.backgroundTasks, ...this.agentRegistrationTasks]
        : [...this.backgroundTasks];
      await Promise.allSettled(pending);
    }
  }

  private broadcastAgentAttention(
    agent: ManagedAgent,
    reason: "finished" | "error" | "permission",
  ): void {
    if (isDelegatedAgent(agent)) {
      return;
    }

    this.onAgentAttention?.({
      agentId: agent.id,
      provider: agent.provider,
      reason,
    });
  }

  private dispatchStream(
    agentId: string,
    event: AgentStreamEvent,
    metadata?: {
      seq?: number;
      epoch?: string;
      timestamp?: string;
    },
  ): void {
    if (event.type === "timeline") {
      event = {
        ...event,
        item: limitAgentTimelineItemContent(event.item),
      };
    }
    const agent = this.agents.get(agentId);
    this.logger.trace(
      {
        agentId,
        provider: event.provider,
        sessionId: agent?.persistence?.sessionId ?? undefined,
        turnId: getAgentStreamEventTurnId(event),
        metadata,
        event,
      },
      "agent.manager.dispatch_stream",
    );
    this.dispatch({ type: "agent_stream", agentId, event, ...metadata });
    if (this.pluginLifecycle && agent && !agent.internal && event.type !== "timeline") {
      publishAgentStream(
        this.pluginLifecycle,
        describeHookAgent({ ...agent, title: agent.config.title }),
        event,
        this.timelineStore.getItems(agentId),
      );
    }
  }

  private dispatch(event: AgentManagerEvent): void {
    for (const subscriber of this.subscribers) {
      if (
        subscriber.agentId &&
        event.type === "agent_stream" &&
        subscriber.agentId !== event.agentId
      ) {
        continue;
      }
      if (
        subscriber.agentId &&
        event.type === "agent_state" &&
        subscriber.agentId !== event.agent.id
      ) {
        continue;
      }
      if (
        subscriber.agentId &&
        event.type === "provider_subagent" &&
        subscriber.agentId !==
          (event.event.type === "upsert"
            ? event.event.subagent.parentAgentId
            : event.event.parentAgentId)
      ) {
        continue;
      }
      // Skip internal agents for global subscribers (those without a specific agentId)
      if (!subscriber.agentId && this.eventBelongsToInternalAgent(event)) {
        continue;
      }
      this.trustedPlugins.daemon(() => subscriber.callback(event));
    }
  }

  private eventBelongsToInternalAgent(event: AgentManagerEvent): boolean {
    if (event.type === "agent_state") return event.agent.internal === true;
    if (event.type === "agent_stream") return this.agents.get(event.agentId)?.internal === true;
    if (event.type !== "provider_subagent") return false;
    const parentAgentId =
      event.event.type === "upsert"
        ? event.event.subagent.parentAgentId
        : event.event.parentAgentId;
    return this.agents.get(parentAgentId)?.internal === true;
  }

  private async normalizeConfig(
    config: AgentSessionConfig,
    options: NormalizeConfigOptions = {},
  ): Promise<AgentSessionConfig> {
    const normalized: AgentSessionConfig = { ...config };

    // Always resolve cwd to absolute path for consistent history file lookup
    if (normalized.cwd) {
      normalized.cwd = resolve(normalized.cwd);
      // Only a session that will run in the directory needs it to still be there. Reading
      // an archived agent's history runs nothing, and must survive the worktree it ran in
      // being removed when its workspace was archived.
      if (options.purpose !== "history") {
        await assertUsableWorkingDirectory(normalized.cwd);
      }
    }

    if (typeof normalized.model === "string") {
      const trimmed = normalized.model.trim();
      normalized.model = trimmed.length > 0 && trimmed !== "default" ? trimmed : undefined;
    }

    const shouldResolveDefaultModel = options.resolveDefaultModel ?? true;
    if (shouldResolveDefaultModel && !normalized.model) {
      const defaultModelId = await this.resolveDefaultModelId(normalized);
      if (defaultModelId) {
        normalized.model = defaultModelId;
      }
    }

    await this.fillCreateDefaults(normalized, options);
    return this.applyProviderConfiguration(normalized);
  }

  private async fillCreateDefaults(
    normalized: AgentSessionConfig,
    options: NormalizeConfigOptions,
  ): Promise<void> {
    // Unlike a model, "default" is a real mode (Claude's Always Ask), so only an absent mode counts as unset.
    // An explicit mode -- from the caller or from a plugin's agent.create hook, which ran before this -- wins.
    if (options.resolveDefaultMode && isUnsetModeId(normalized.modeId)) {
      const defaultModeId = await this.resolveDefaultModeIdForCreate(normalized, options.env);
      if (defaultModeId) {
        normalized.modeId = defaultModeId;
      }
    }

    // Same rules for the thinking option. Resolved against the final model, so an explicit model's own
    // default is used; a model without thinking options leaves it unset.
    if (options.resolveDefaultThinking && isUnsetThinkingOptionId(normalized.thinkingOptionId)) {
      const defaultThinkingOptionId =
        await this.resolveDefaultThinkingOptionIdForCreate(normalized);
      if (defaultThinkingOptionId) {
        normalized.thinkingOptionId = defaultThinkingOptionId;
      }
    }
  }

  private applyProviderConfiguration(config: AgentSessionConfig): AgentSessionConfig {
    const definition = this.providerDefinitions.get(config.provider);
    if (config.providerOptions !== undefined && !definition?.validateOptions) {
      throw new Error(`Provider '${config.provider}' does not accept providerOptions`);
    }
    const validatedOptions = definition?.validateOptions?.(config.providerOptions);
    const withOptions = definition?.applyOptions
      ? definition.applyOptions(config, validatedOptions)
      : config;
    this.validateToolPolicyServers(withOptions);
    if (withOptions.toolPolicy && !definition?.applyToolPolicy) {
      throw new Error(
        `Provider '${config.provider}' cannot preapprove exact MCP tools for unattended execution`,
      );
    }
    return definition?.applyToolPolicy
      ? definition.applyToolPolicy(withOptions, withOptions.toolPolicy)
      : withOptions;
  }

  private validateToolPolicyServers(config: AgentSessionConfig): void {
    if (!config.toolPolicy) return;
    const serverNames = new Set(Object.keys(config.mcpServers ?? {}));
    for (const grant of config.toolPolicy.preapproved) {
      if (!serverNames.has(grant.server)) {
        throw new Error(
          `toolPolicy preapproval '${grant.server}.${grant.tool}' requires MCP server '${grant.server}' in the same agent request`,
        );
      }
    }
  }

  private describeCreateCaller(
    parentId: string | undefined,
  ): { provider: string; modeId: string | null; modeClass: ChildModeClass } | null {
    const parent = parentId ? this.agents.get(parentId) : undefined;
    if (!parent) return null;
    const modeId = parent.currentModeId ?? parent.config.modeId ?? null;
    return {
      provider: parent.provider,
      modeId,
      modeClass: childModeClass(parent.provider, modeId),
    };
  }

  private async resolveDefaultModeIdForCreate(
    config: AgentSessionConfig,
    env: Record<string, string> | undefined,
  ): Promise<string | undefined> {
    const client = this.clients.get(config.provider);
    if (!client?.persistsDefaultModeOnCreate || !client.resolveDefaultModeId) {
      return undefined;
    }
    try {
      const modeId = await client.resolveDefaultModeId({ config, env });
      return typeof modeId === "string" && modeId.trim().length > 0 ? modeId : undefined;
    } catch {
      return undefined;
    }
  }

  private async resolveDefaultThinkingOptionIdForCreate(
    config: AgentSessionConfig,
  ): Promise<string | undefined> {
    const client = this.clients.get(config.provider);
    const modelId = config.model;
    if (!client?.persistsDefaultThinkingOnCreate || !modelId) {
      return undefined;
    }
    try {
      const catalog = await client.fetchCatalog({
        scope: "workspace",
        cwd: config.cwd,
        force: false,
      });
      const model = catalog.models.find(
        (candidate) => candidate.id === modelId || candidate.aliases?.includes(modelId),
      );
      const thinkingOptionId = model
        ? normalizeAgentModelDefinition(model).defaultThinkingOptionId
        : undefined;
      return thinkingOptionId &&
        model?.thinkingOptions?.some((option) => option.id === thinkingOptionId)
        ? thinkingOptionId
        : undefined;
    } catch {
      return undefined;
    }
  }

  private async resolveDefaultModelId(config: AgentSessionConfig): Promise<string | undefined> {
    const client = this.clients.get(config.provider);
    if (!client) {
      return undefined;
    }
    try {
      const catalog = await client.fetchCatalog({
        scope: "workspace",
        cwd: config.cwd,
        force: false,
      });
      return (catalog.models.find((model) => model.isDefault) ?? catalog.models[0])?.id;
    } catch {
      // Provider may not support model listing — leave model undefined.
      return undefined;
    }
  }

  private async prepareSessionConfig(
    config: AgentSessionConfig,
    agentId: string,
    options: {
      env?: Record<string, string>;
      purpose?: AgentResumePurpose;
      resolveDefaultMode?: boolean;
      resolveDefaultThinking?: boolean;
    } = {},
  ): Promise<PreparedSessionConfig> {
    const storedConfig = await this.normalizeConfig(stripInternalPaseoMcpServer(config), {
      env: options.env,
      purpose: options.purpose,
      resolveDefaultMode: options.resolveDefaultMode,
      resolveDefaultThinking: options.resolveDefaultThinking,
    });
    const paseoToolPolicy = this.paseoToolsEnabled
      ? this.resolvePaseoToolPolicy(storedConfig.provider)
      : { enabled: false };
    const reportLaunch = this.prepareNativeReportLaunch(agentId);
    const launchConfig = this.applyDaemonAppendSystemPrompt(
      withRuntimePaseoMcpServer({
        config: storedConfig,
        agentId,
        mcpBaseUrl:
          this.paseoToolsEnabled && isPaseoToolPolicyEnabled(paseoToolPolicy)
            ? this.mcpBaseUrl
            : null,
        mcpAuthToken: this.mcpAuthToken,
        nativeReportWitness: reportLaunch?.witness,
      }),
    );
    return { storedConfig, launchConfig, paseoToolPolicy };
  }

  private applyDaemonAppendSystemPrompt(config: AgentSessionConfig): AgentSessionConfig {
    const daemonAppendSystemPrompt = this.appendSystemPrompt.trim();
    const next = { ...config };
    delete next.daemonAppendSystemPrompt;

    return daemonAppendSystemPrompt
      ? {
          ...next,
          daemonAppendSystemPrompt,
        }
      : next;
  }

  private async buildLaunchContext(
    agentId: string,
    client: AgentClient,
    cwd: string,
    paseoToolPolicy: ProviderPaseoToolsPolicy | undefined,
    env?: Record<string, string>,
    opening?: {
      reason: PluginSessionOpenRequest["reason"];
      purpose: PluginSessionOpenRequest["purpose"];
      workspaceId?: string | null;
    },
  ): Promise<AgentLaunchContext> {
    if (this.pluginLifecycle) {
      const request: PluginSessionOpenRequest = {
        agentId,
        provider: client.provider,
        cwd,
        workspaceId: opening?.workspaceId ?? null,
        reason: opening?.reason ?? "resume",
        purpose: opening?.purpose ?? "interactive",
        env: { ...env },
      };
      const transformed = await this.pluginLifecycle.before("agent.session_open", request);
      env = transformed.env;
    }
    const context: AgentLaunchContext = {
      agentId,
      env: {
        ...env,
        PASEO_AGENT_ID: agentId,
        PASEO_AGENT_CWD: cwd,
      },
    };
    if (
      this.paseoToolsEnabled &&
      isPaseoToolPolicyEnabled(paseoToolPolicy) &&
      client.capabilities.supportsNativePaseoTools &&
      this.paseoToolCatalogFactory
    ) {
      const launch = this.reportLaunches.get(agentId);
      context.paseoTools = await this.paseoToolCatalogFactory({
        nativeReportOrigin: launch?.origin,
        callerAgentId: agentId,
        paseoToolPolicy,
      });
    }
    return context;
  }

  private resolveProviderLaunchConfig(
    launchConfig: AgentSessionConfig,
    launchContext: AgentLaunchContext,
  ): AgentSessionConfig {
    return launchContext.paseoTools ? stripInternalPaseoMcpServer(launchConfig) : launchConfig;
  }

  private async requireAvailableClient(options: { provider: AgentProvider }): Promise<AgentClient> {
    const client = this.clients.get(options.provider);
    if (!client) {
      const configuredProviders = this.getConfiguredProviderIds();
      throw new Error(
        `Unknown provider '${options.provider}'. Configured providers: ${formatProviderList(
          configuredProviders,
        )}.`,
      );
    }

    let unavailableReason: string | null = null;
    try {
      const available = await client.isAvailable();
      if (available) {
        return client;
      }
    } catch (error) {
      unavailableReason = error instanceof Error ? error.message : String(error);
    }

    const availableProviders = (await this.listProviderAvailability())
      .filter((entry) => entry.available)
      .map((entry) => entry.provider);
    const providerList = formatProviderList(availableProviders);
    const reason = unavailableReason ? ` Reason: ${unavailableReason}.` : "";
    throw new Error(
      `Provider '${options.provider}' is not available.${reason} Available providers: ${providerList}. Use one of those providers, or install/configure '${options.provider}'.`,
    );
  }

  private requireEnabledProvider(provider: AgentProvider): void {
    if (this.providerEnabled.get(provider) === false) {
      throw new Error(`Provider '${provider}' is disabled`);
    }
  }

  private getConfiguredProviderIds(): AgentProvider[] {
    return Array.from(new Set([...this.providerEnabled.keys(), ...this.clients.keys()]));
  }

  private requireClient(provider: AgentProvider): AgentClient {
    const client = this.clients.get(provider);
    if (!client) {
      throw new Error(`No client registered for provider '${provider}'`);
    }
    return client;
  }

  private async syncNativeArchiveState(
    provider: AgentProvider,
    persistence: AgentPersistenceHandle | null | undefined,
    state: "archive" | "restore",
  ): Promise<void> {
    if (!persistence) return;
    const client = this.clients.get(provider);
    const sync =
      state === "archive" ? client?.archiveNativeSession : client?.unarchiveNativeSession;
    if (!sync) return;
    if (state === "restore") {
      await sync.call(client, persistence);
      return;
    }
    try {
      await sync.call(client, persistence);
    } catch (error) {
      this.logger.warn(
        { error, provider, sessionId: persistence.sessionId },
        "Failed to archive native session (best-effort)",
      );
    }
  }

  private requireAgent(id: string): LiveManagedAgent {
    const normalizedId = validateAgentId(id, "requireAgent");
    const agent = this.agents.get(normalizedId);
    if (!agent) {
      throw new Error(`Unknown agent '${normalizedId}'`);
    }
    return agent;
  }

  private requireSessionAgent(id: string): ActiveManagedAgent {
    if (this.mcpRefreshes.has(id)) {
      throw new Error(
        `Agent '${id}' is refreshing MCP configuration; retry after inspecting its state`,
      );
    }
    const agent = this.requireAgent(id);
    if (agent.session === null) {
      throw new Error(`Agent '${agent.id}' has no managed session`);
    }
    if (this.failedMcpRefreshCloses.has(agent.session)) {
      throw new Error(`Agent '${id}' requires explicit close recovery after failed MCP refresh`);
    }
    return agent;
  }

  private requirePublicAgent(id: string): LiveManagedAgent {
    const agent = this.requireAgent(id);
    if (agent.internal) {
      throw new Error(`Unknown agent '${agent.id}'`);
    }
    return agent;
  }
}

function matchesImportableSessionQuery(
  session: ImportableProviderSession,
  rawQuery: string | undefined,
): boolean {
  const query = rawQuery?.trim().toLowerCase();
  if (!query) return true;
  const cwdBasename = basename(session.cwd.replaceAll("\\", "/"));
  return [session.title, session.firstPromptPreview, session.lastPromptPreview, cwdBasename].some(
    (value) => value?.toLowerCase().includes(query),
  );
}

export function commandMayHaveChangedExternalState(command: string): boolean {
  const normalized = command.toLowerCase();
  // Commands that operate on remote state and do NOT trigger local file
  // watchers. Local git mutations (commit, checkout, merge, rebase, reset,
  // pull) are already caught by watchers on .git/HEAD and refs/heads/.
  return (
    // GitHub PR operations (merge, close, create, edit, comment, review)
    /\bgh\s+pr\s+(merge|close|create|edit|comment|review)\b/.test(normalized) ||
    // Pushes to remote — local refs unchanged, but remote state (PR checks,
    // mergeable status) may shift immediately after.
    /\bgit\s+push\b/.test(normalized) ||
    // Fetches update refs/remotes/ which our watchers do not watch, so
    // ahead/behind counts can drift stale until the next refresh.
    /\bgit\s+fetch\b/.test(normalized)
  );
}

function isSameBackgroundWork(
  left: AgentBackgroundWork | null,
  right: AgentBackgroundWork | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.count === right.count &&
    left.source === right.source &&
    left.since === right.since &&
    left.kinds.join(",") === right.kinds.join(",")
  );
}
