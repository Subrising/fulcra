import type { RecordedUsage } from "@getpaseo/protocol/recorded-usage";
import type { TrustedCodexTurnV11, QuotaReadFailureV11 } from "@getpaseo/plugin/server";
import type {
  AccountCredential,
  AccountUsageReading,
} from "../../services/quota-fetcher/account-usage-types.js";
import type { TrustedOperationV11 } from "@getpaseo/protocol/trusted-input";
import type { TrustedOperationHandle } from "../plugins/trusted.js";
import type {
  AgentFeature,
  AgentFeatureSelect,
  AgentFeatureToggle,
  AgentProviderNotice,
  AgentTaskItem,
  JsonValue,
  ProviderOptions,
  ToolPolicy,
} from "@getpaseo/protocol/agent-types";
import type { AgentAttachment, AgentQuotaSnapshot } from "@getpaseo/protocol/messages";
import type { AgentBackgroundWork } from "@getpaseo/protocol/agent-background-work";
import type { PaseoToolCatalog } from "./tools/types.js";

export type {
  AgentFeature,
  AgentFeatureSelect,
  AgentFeatureToggle,
  AgentProviderNotice,
  AgentTaskItem,
};
export type { AgentQuotaSnapshot };

export type AgentProvider = string;

export interface AgentMetadata {
  [key: string]: unknown;
}

/**
 * Stdio-based MCP server (spawns a subprocess).
 */
export interface McpStdioServerConfig {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /**
   * When true, all tools from this server are always included in the prompt
   * and never deferred behind tool search. Honored by the Claude provider.
   */
  alwaysLoad?: boolean;
}

/**
 * HTTP-based MCP server.
 */
export interface McpHttpServerConfig {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  /**
   * When true, all tools from this server are always included in the prompt
   * and never deferred behind tool search. Honored by the Claude provider.
   */
  alwaysLoad?: boolean;
}

/**
 * SSE-based MCP server (Server-Sent Events over HTTP).
 */
export interface McpSseServerConfig {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
  /**
   * When true, all tools from this server are always included in the prompt
   * and never deferred behind tool search. Honored by the Claude provider.
   */
  alwaysLoad?: boolean;
}

/**
 * Canonical MCP server configuration.
 * Discriminated union by `type` field.
 * Each provider normalizes this to their expected format.
 */
export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig | McpSseServerConfig;

export interface AgentMode {
  id: string;
  label: string;
  description?: string;
  icon?: string;
  colorTier?: string;
  isUnattended?: boolean;
}

export type ProviderStatus = "ready" | "loading" | "error" | "unavailable";

export interface AgentModelDefinition {
  provider: AgentProvider;
  id: string;
  aliases?: string[];
  isSelectable?: boolean;
  label: string;
  description?: string;
  isDefault?: boolean;
  metadata?: AgentMetadata;
  contextWindowMaxTokens?: number;
  thinkingOptions?: AgentSelectOption[];
  defaultThinkingOptionId?: string;
}

export interface AgentSelectOption {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
  metadata?: AgentMetadata;
}

export function normalizeAgentModelDefinition(model: AgentModelDefinition): AgentModelDefinition {
  const defaultThinkingOptionId =
    model.defaultThinkingOptionId ?? model.thinkingOptions?.find((option) => option.isDefault)?.id;
  if (!defaultThinkingOptionId || defaultThinkingOptionId === model.defaultThinkingOptionId) {
    return model;
  }
  return { ...model, defaultThinkingOptionId };
}

export function filterSelectableAgentModels(
  models: AgentModelDefinition[] | undefined,
): AgentModelDefinition[] {
  return models?.filter((model) => model.isSelectable !== false) ?? [];
}

export interface ProviderSnapshotEntry {
  provider: AgentProvider;
  status: ProviderStatus;
  enabled: boolean;
  source?: "builtin" | "custom";
  error?: string;
  models?: AgentModelDefinition[];
  modes?: AgentMode[];
  fetchedAt?: string;
  label?: string;
  description?: string;
  iconSvg?: string;
  defaultModeId?: string | null;
}

export interface AgentCreateConfigParent {
  provider: AgentProvider;
  modeId: string | null;
  isUnattended: boolean;
}

export interface ResolveAgentCreateConfigInput {
  provider: AgentProvider;
  requestedMode: string | undefined;
  featureValues: Record<string, unknown> | undefined;
  parent: AgentCreateConfigParent | null;
  unattended: boolean;
  availableModes: AgentMode[] | undefined;
}

export interface ResolveAgentCreateConfigResult {
  modeId: string | undefined;
  featureValues: Record<string, unknown> | undefined;
}

export interface AgentCreateConfigUnattendedInput {
  modeId: string | null;
  config: AgentSessionConfig;
  features?: AgentFeature[];
  availableModes: AgentMode[];
}

export interface AgentCapabilityFlags {
  [capability: string]: boolean | undefined;
  supportsStreaming: boolean;
  supportsSessionPersistence: boolean;
  supportsSessionListing?: boolean;
  supportsDynamicModes: boolean;
  supportsMcpServers: boolean;
  supportsNativePaseoTools?: boolean;
  supportsReasoningStream: boolean;
  supportsToolInvocations: boolean;
  supportsRewindConversation?: boolean;
  supportsRewindFiles?: boolean;
  supportsRewindBoth?: boolean;
}

export interface AgentPersistenceHandle {
  provider: AgentProvider;
  sessionId: string;
  /** Provider specific handle (Codex thread id, Claude resume token, etc). */
  nativeHandle?: string;
  metadata?: AgentMetadata;
}

export type AgentPromptContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | AgentAttachment;

export type AgentPromptInput = string | AgentPromptContentBlock[];

// Daemon-only handle, additionally branded by native-queued-dispatch; wire JSON cannot mint it.
export const NATIVE_QUEUED_FINAL = Symbol("native-queued-final");
export const FINAL_INPUT_CHECK = Symbol("final-input-check");
export const TRUSTED_OPERATION = Symbol("trusted-operation");
export const CODEX_TURN_ADMISSION = Symbol("codex-turn-admission");

export interface CapturedCodexAdmission {
  readonly operation: TrustedOperationV11;
  readonly instanceId: string;
  validate(): void;
  check(turn: TrustedCodexTurnV11, quota: AgentQuotaSnapshot): true;
  onQuotaReadFailure(turn: TrustedCodexTurnV11, failure: QuotaReadFailureV11): void;
}
export interface AgentRunOptions {
  /** Human prompt intent: dismiss async question cards without authorizing tools. */
  clearPendingQuestions?: boolean;
  [FINAL_INPUT_CHECK]?: object;
  [NATIVE_QUEUED_FINAL]?: () => void;
  [TRUSTED_OPERATION]?: TrustedOperationHandle;
  [CODEX_TURN_ADMISSION]?: ((quota: AgentQuotaSnapshot) => true) | CapturedCodexAdmission;
  outputSchema?: unknown;
  resumeFrom?: AgentPersistenceHandle;
  maxThinkingTokens?: number;
  clientMessageId?: string;
}

export interface AgentSteerOptions extends AgentRunOptions {
  /** Deny permissions that block this steer. An accepted steer must honor this contract. */
  clearPendingPermissions?: boolean;
}

export type SteerResult = { status: "accepted" } | { status: "unavailable" };

export interface SteerActiveTurnOptions extends AgentSteerOptions {
  expectedTurnId: string;
}

export interface AgentUsage {
  recorded?: RecordedUsage;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalCostUsd?: number;
  contextWindowMaxTokens?: number;
  contextWindowUsedTokens?: number;
}

export const TOOL_CALL_ICON_NAMES = [
  "wrench",
  "square_terminal",
  "eye",
  "pencil",
  "search",
  "bot",
  "sparkles",
  "brain",
  "mic_vocal",
] as const;

export type ToolCallIconName = (typeof TOOL_CALL_ICON_NAMES)[number];

export interface ToolCallFileChange {
  path: string;
  kind: "add" | "delete" | "update";
  unifiedDiff?: string;
}

export type ToolCallDetail =
  | {
      type: "shell";
      command: string;
      cwd?: string;
      output?: string;
      exitCode?: number | null;
    }
  | {
      type: "read";
      filePath: string;
      content?: string;
      offset?: number;
      limit?: number;
    }
  | {
      type: "edit";
      /** The first changed file, kept for clients that predate `files`. */
      filePath: string;
      oldString?: string;
      newString?: string;
      unifiedDiff?: string;
      /** Every file in a multi-file patch, in patch order. */
      files?: ToolCallFileChange[];
    }
  | {
      type: "write";
      filePath: string;
      content?: string;
    }
  | {
      type: "search";
      query: string;
      toolName?: "search" | "grep" | "glob" | "web_search";
      content?: string;
      filePaths?: string[];
      webResults?: Array<{
        title: string;
        url: string;
      }>;
      annotations?: string[];
      numFiles?: number;
      numMatches?: number;
      durationMs?: number;
      durationSeconds?: number;
      truncated?: boolean;
      mode?: "content" | "files_with_matches" | "count";
    }
  | {
      type: "fetch";
      url: string;
      prompt?: string;
      result?: string;
      code?: number;
      codeText?: string;
      bytes?: number;
      durationMs?: number;
    }
  | {
      type: "worktree_setup";
      worktreePath: string;
      branchName: string;
      log: string;
      commands: Array<{
        index: number;
        command: string;
        cwd: string;
        log: string;
        status: "running" | "completed" | "failed";
        exitCode: number | null;
        durationMs?: number;
      }>;
      truncated?: boolean;
    }
  | {
      type: "sub_agent";
      subAgentType?: string;
      description?: string;
      childSessionId?: string;
      log: string;
      actions?: Array<{
        index: number;
        toolName: string;
        summary?: string;
      }>;
    }
  | {
      type: "plain_text";
      label?: string;
      text?: string;
      icon?: ToolCallIconName;
    }
  | {
      type: "plan";
      text: string;
    }
  | {
      type: "unknown";
      input: unknown;
      output: unknown;
      /** Files a patch touched when no preview could be rendered; paths stay usable without a diff. */
      files?: ToolCallFileChange[];
    };

interface ToolCallBase {
  [key: string]: unknown;
  type: "tool_call";
  callId: string;
  name: string;
  detail: ToolCallDetail;
  metadata?: Record<string, unknown>;
}

type ToolCallRunningTimelineItem = ToolCallBase & {
  status: "running";
  error: null;
};

type ToolCallCompletedTimelineItem = ToolCallBase & {
  status: "completed";
  error: null;
};

type ToolCallFailedTimelineItem = ToolCallBase & {
  status: "failed";
  error: unknown;
};

type ToolCallCanceledTimelineItem = ToolCallBase & {
  status: "canceled";
  error: null;
};

export type ToolCallTimelineItem =
  | ToolCallRunningTimelineItem
  | ToolCallCompletedTimelineItem
  | ToolCallFailedTimelineItem
  | ToolCallCanceledTimelineItem;

export interface CompactionTimelineItem {
  [key: string]: unknown;
  type: "compaction";
  status: "loading" | "completed";
  trigger?: "auto" | "manual";
  preTokens?: number;
}

export interface PluginTimelineItem {
  type: "plugin";
  id: string;
  pluginId: string;
  kind: string;
  version: number;
  data: JsonValue;
}

export type AgentTimelineItem =
  | { type: "user_message"; text: string; messageId?: string; clientMessageId?: string }
  | { type: "assistant_message"; text: string; messageId?: string }
  | { type: "reasoning"; text: string }
  | ToolCallTimelineItem
  | { type: "todo"; items: AgentTaskItem[] }
  | { type: "error"; message: string }
  | {
      type: "notification";
      level: "info" | "warning" | "error";
      message: string;
    }
  | CompactionTimelineItem
  | PluginTimelineItem;

export type AgentStreamEvent =
  | {
      type: "host_public_baseline_transport";
      provider: AgentProvider;
      nativeSessionId: string;
      receipt: import("./host-public-baseline.js").PublicBaselineTransport;
    }
  | { type: "thread_started"; sessionId: string; provider: AgentProvider }
  | { type: "turn_started"; provider: AgentProvider; turnId?: string }
  | { type: "turn_completed"; provider: AgentProvider; usage?: AgentUsage; turnId?: string }
  | { type: "usage_updated"; provider: AgentProvider; usage: AgentUsage; turnId?: string }
  | {
      type: "mode_changed";
      provider: AgentProvider;
      currentModeId: string | null;
      availableModes: AgentMode[];
    }
  | { type: "model_changed"; provider: AgentProvider; runtimeInfo: AgentRuntimeInfo }
  | {
      type: "thinking_option_changed";
      provider: AgentProvider;
      thinkingOptionId: string | null;
    }
  | {
      type: "turn_failed";
      provider: AgentProvider;
      error: string;
      code?: string;
      diagnostic?: string;
      turnId?: string;
    }
  | { type: "turn_canceled"; provider: AgentProvider; reason: string; turnId?: string }
  | {
      type: "timeline";
      item: AgentTimelineItem;
      provider: AgentProvider;
      turnId?: string;
      timestamp?: string;
    }
  | {
      type: "permission_requested";
      provider: AgentProvider;
      request: AgentPermissionRequest;
      turnId?: string;
    }
  | {
      type: "permission_resolved";
      provider: AgentProvider;
      requestId: string;
      resolution: AgentPermissionResponse;
      turnId?: string;
    }
  | {
      type: "attention_required";
      provider: AgentProvider;
      reason: "finished" | "error" | "permission";
      timestamp: string;
    }
  | {
      type: "provider_subagent";
      provider: AgentProvider;
      event: import("./provider-subagents/store.js").ProviderSubagentInputEvent;
    }
  | {
      /**
       * Display only (MULTIHOST-DESIGN §6): the provider's count of background jobs changed. Handled
       * outside turn logic; it never changes the agent's status or reaches a waiter.
       */
      type: "background_work_changed";
      provider: AgentProvider;
      backgroundWork: AgentBackgroundWork | null;
    };

export function getAgentStreamEventTurnId(event: AgentStreamEvent): string | undefined {
  return "turnId" in event ? event.turnId : undefined;
}

export type AgentPermissionRequestKind = "tool" | "plan" | "question" | "mode" | "other";

export type AgentPermissionUpdate = AgentMetadata;

export interface AgentPermissionAction {
  id: string;
  label: string;
  behavior: "allow" | "deny";
  variant?: "primary" | "secondary" | "danger";
  intent?: "implement" | "implement_resume" | "dismiss";
}

export interface AgentPermissionRequest {
  id: string;
  provider: AgentProvider;
  name: string;
  kind: AgentPermissionRequestKind;
  title?: string;
  description?: string;
  input?: AgentMetadata;
  detail?: ToolCallDetail;
  suggestions?: AgentPermissionUpdate[];
  actions?: AgentPermissionAction[];
  metadata?: AgentMetadata;
}

export type AgentPermissionResponse =
  | {
      behavior: "allow";
      selectedActionId?: string;
      updatedInput?: AgentMetadata;
      updatedPermissions?: AgentPermissionUpdate[];
    }
  | {
      behavior: "deny";
      selectedActionId?: string;
      message?: string;
      interrupt?: boolean;
    };

export interface AgentRunResult {
  sessionId: string;
  finalText: string;
  usage?: AgentUsage;
  timeline: AgentTimelineItem[];
  canceled?: boolean;
}

export interface AgentRuntimeInfo {
  provider: AgentProvider;
  sessionId: string | null;
  model?: string | null;
  thinkingOptionId?: string | null;
  modeId?: string | null;
  extra?: AgentMetadata;
}

export type AgentSlashCommandKind = "command" | "skill";

/**
 * Represents a slash command available in an agent session.
 * Commands are executed by sending them as prompts with / prefix.
 */
export interface AgentSlashCommand {
  name: string;
  description: string;
  argumentHint: string;
  kind?: AgentSlashCommandKind;
}

export interface ListImportableSessionsOptions {
  providerOptions?: ProviderOptions;
  limit?: number;
  /** Optional case-insensitive descriptor search text. */
  query?: string;
  /**
   * Maximum number of cheap persisted-session candidates to inspect before
   * applying the result limit. Providers must cap this at 500.
   */
  scanLimit?: number;
  /**
   * Optional cwd hint. Providers that can cheaply pre-filter importable
   * sessions by working directory should do so before doing expensive work.
   */
  cwd?: string;
}

export interface ImportableProviderSession {
  providerHandleId: string;
  cwd: string;
  title: string | null;
  firstPromptPreview: string | null;
  lastPromptPreview: string | null;
  lastActivityAt: Date;
}

export interface ImportProviderSessionInput {
  providerHandleId: string;
  cwd: string;
}

export interface ImportProviderSessionContext {
  config: AgentSessionConfig;
  storedConfig: AgentSessionConfig;
  launchContext?: AgentLaunchContext;
}

export interface ImportedTimelineEntry {
  item: AgentTimelineItem;
  timestamp?: string;
}

export interface ImportedProviderSession {
  session: AgentSession;
  config: AgentSessionConfig;
  persistence: AgentPersistenceHandle;
  timeline: ImportedTimelineEntry[];
  providerSubagentEvents?: Extract<AgentStreamEvent, { type: "provider_subagent" }>[];
}

export interface AgentSessionConfig {
  provider: AgentProvider;
  cwd: string;
  /**
   * Provider-agnostic system/developer instruction string.
   * Mapped by each provider to its native instruction field.
   */
  systemPrompt?: string;
  /**
   * Daemon-level instructions appended at runtime. This is deliberately not
   * persisted into agent config so daemon setting changes apply cleanly.
   */
  daemonAppendSystemPrompt?: string;
  modeId?: string;
  model?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
  title?: string | null;
  providerOptions?: ProviderOptions;
  toolPolicy?: ToolPolicy;
  mcpServers?: Record<string, McpServerConfig>;
  /**
   * Internal agents are hidden from listings and don't trigger notifications.
   * They are used for ephemeral system tasks like commit/PR generation.
   */
  internal?: boolean;
}

export interface AgentLaunchContext {
  /** Host-selected public text/hash snapshot. Runtime-only; never an account/profile/config override. */
  publicBaseline?: import("./host-public-baseline.js").HostPublicBaseline;
  agentId?: string;
  env?: Record<string, string>;
  /**
   * Runtime-only internal Paseo tools. This must never be persisted into
   * AgentSessionConfig; providers may adapt it to their native tool surface.
   */
  paseoTools?: PaseoToolCatalog;
}

export interface AgentCreateSessionOptions {
  /**
   * Whether the provider should leave a durable native session behind.
   * Defaults to true. Providers that cannot honor false should no-op.
   */
  persistSession?: boolean;
  /**
<<<<<<< HEAD
   * A context rotation needs the fresh native session's id before its first turn. Providers that
   * allocate ids lazily (Claude) start the conversation under this id; others ignore it.
   */
  freshSessionId?: string;
=======
   * Model ids added by provider configuration (`models` / `additionalModels`).
   * Providers that validate against runtime-advertised models must accept these.
   */
  configuredModelIds?: readonly string[];
>>>>>>> refs/tags/v0.11.2
}

/** What a resumed session is for: driving the agent, or reading what it already did. */
export type AgentResumePurpose = "interactive" | "history";

/** Runtime-only intent for a persisted-session resume. Never persist this option. */
export interface AgentResumeSessionOptions {
  /** Defaults to interactive. History loading may be read-only for archived native sessions. */
  purpose?: AgentResumePurpose;
  /** See AgentCreateSessionOptions.configuredModelIds. */
  configuredModelIds?: readonly string[];
}

/**
 * Returned by respondToPermission when the permission resolution requires
 * a follow-up turn (e.g. Codex plan approval → implementation).
 */
export interface AgentPermissionResult {
  followUpPrompt?: AgentPromptInput;
}

export interface AgentUsageSession {
  provider: string;
  model?: string;
  env: Record<string, string>;
  sessionKey: string;
}

export interface AgentSession {
  usageSession?(): AgentUsageSession | null;
  readonly provider: AgentProvider;
  readonly id: string | null;
  readonly capabilities: AgentCapabilityFlags;
  readonly features?: AgentFeature[];
  /** New provider-owned rows to commit on registration. streamHistory must also
   * replay them at their original timestamps; restored sessions omit old rows. */
  readonly initialTimeline?: ImportedTimelineEntry[];
  run(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<AgentRunResult>;
  startTurn(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<{ turnId: string }>;
  steerActiveTurn?(prompt: AgentPromptInput, options: SteerActiveTurnOptions): Promise<SteerResult>;
  subscribe(callback: (event: AgentStreamEvent) => void): () => void;
  streamHistory(): AsyncGenerator<AgentStreamEvent>;
  /**
   * The provider process's pid, for the display-only background-job sample of providers without a
   * task protocol (agent/background-work). Absent or null when there is no such process.
   */
  getProcessId?(): number | null;
  getRuntimeInfo(): Promise<AgentRuntimeInfo>;
  /** Read the attached provider without connecting, creating a thread or starting a turn. */
  getQuota?(): Promise<AgentQuotaSnapshot>;
  /** Non-secret account label captured by this runtime at launch, never read from a mutable assignment. */
  usageSourceLabel?(): string | null;
  /** Cached non-secret account identity only; no credential read, transport request or authorization. */
  limitResumeAccountBinding?(): string | null;
  /** Fulcra account pool: the credential this session was launched with and its account label (daemon-internal). */
  usageCredential?(): {
    credential: AccountCredential;
    label: string | null;
    /** Fulcra's id for the account (not a secret). */
    accountId?: string | null;
    /** The last rate-limit reading this session's own traffic produced (free; update-7c). */
    observation?: AccountUsageReading | null;
  } | null;
  getAvailableModes(): Promise<AgentMode[]>;
  getCurrentMode(): Promise<string | null>;
  setMode(modeId: string): Promise<void | AgentProviderNotice>;
  getPendingPermissions(): AgentPermissionRequest[];
  respondToPermission(
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<AgentPermissionResult | void>;
  describePersistence(): AgentPersistenceHandle | null;
  /**
   * Resolve once every foreground turn that predates this call can no longer run or become active.
   * Calling while already idle is a successful no-op. Reject only when foreground ownership is
   * still uncertain.
   */
  interrupt(): Promise<void>;
  /** Release live runtime resources without archiving or deleting the durable native session. */
  close(): Promise<void>;
  listCommands?(): Promise<AgentSlashCommand[]>;
  setModel?(modelId: string | null): Promise<void>;
  setThinkingOption?(thinkingOptionId: string | null): Promise<void | AgentProviderNotice>;
  setFeature?(featureId: string, value: unknown): Promise<void>;
  revertConversation?(input: { messageId: string }): Promise<void>;
  revertFiles?(input: { messageId: string }): Promise<void>;
  revertBoth?(input: { messageId: string }): Promise<void>;
  /**
   * Out-of-band prompt handler. When non-null, the manager runs the returned
   * handler instead of allocating a turn. The handler emits stream events
   * directly via the provided `emit` callback, which routes through the
   * manager's persistence + broadcast pipeline. The active foreground turn
   * (if any) is left untouched, so this is how mid-turn side-effect commands
   * (e.g. /goal pause) reach the provider without canceling the running turn.
   */
  tryHandleOutOfBand?(prompt: AgentPromptInput): {
    run(ctx: { emit: (event: AgentStreamEvent) => void }): Promise<void>;
  } | null;
}

export type FetchCatalogOptions = { providerOptions?: ProviderOptions } & (
  | {
      scope: "global";
      force: boolean;
    }
  | {
      scope: "workspace";
      cwd: string;
      force: boolean;
    }
);

export interface ProviderRefreshContext {
  readonly signal: AbortSignal;
  /** Track an upstream operation so timeout errors identify the work still pending. */
  runActivity<T>(name: string, operation: () => Promise<T>): Promise<T>;
}

export interface ProviderCatalog {
  models: AgentModelDefinition[];
  modes: AgentMode[];
  defaultModeId?: string | null;
}

export interface ResolveAgentDefaultModeInput {
  config: AgentSessionConfig;
  env?: Record<string, string>;
  signal?: AbortSignal;
}

export interface AgentClient {
  readonly provider: AgentProvider;
  readonly capabilities: AgentCapabilityFlags;
  createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
    options?: AgentCreateSessionOptions,
  ): Promise<AgentSession>;
  resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    launchContext?: AgentLaunchContext,
    options?: AgentResumeSessionOptions,
  ): Promise<AgentSession>;
  /** Equal keys share availability and catalogue discovery within this configured client.
   * Include the execution environment and effective configuration; omit to use target identity.
   * force must not affect identity. Resolve before every cache lookup. */
  getCatalogCacheKey?(options: FetchCatalogOptions): Promise<string | undefined>;
  /**
   * Discover models and modes together. Implementations may use one upstream
   * process, separate upstream calls, static modes, or private helpers; callers
   * outside the provider do not get separate runtime model/mode probes.
   * The registry is responsible for merging configured model overrides.
   * ProviderSnapshotManager supplies a shared context. Providers must pass its
   * signal downstream and finish resource cleanup before rejecting on abort.
   */
  fetchCatalog(
    options: FetchCatalogOptions,
    context?: ProviderRefreshContext,
  ): Promise<ProviderCatalog>;
  /** Apply provider-owned defaults to a model supplied through provider configuration. */
  resolveConfiguredModel?(model: AgentModelDefinition): AgentModelDefinition;
  resolveDefaultModeId?(input: ResolveAgentDefaultModeInput): Promise<string | undefined>;
  /**
   * Store the provider's default mode on a session created without one, so the session keeps it.
   *
   * Opt-in, and only right for a provider whose "no mode" fallback is NOT its declared default. Claude
   * falls back to `default` (Always Ask) while its catalog default is `auto`, so a mode-less session is
   * stuck in Always Ask for life. Codex opts in too (update-7 W3): a new Codex session takes its built-in default
   * (full-access, FIX-8 B), or the host's Fulcra default via the plugin hook, rather than deferring approval and
   * sandbox to the user's own Codex config.
   */
  readonly persistsDefaultModeOnCreate?: boolean;
  /**
   * Update-7 W3 (R1 P-1): the mode an `internal` helper agent runs in when it names none. Internal creates skip
   * plugin hooks and are fed untrusted text (branch names, commit and PR text), so this must never be an
   * unattended mode.
   */
  readonly internalModeId?: string;
  /**
   * Store the created model's default thinking option on a session created without one.
   *
   * Opt-in, on the same terms as persistsDefaultModeOnCreate. A Claude session without a thinking option
   * sends no effort, so Claude Code picks its own rather than the model's declared default. Codex must not
   * opt in: a Codex session without one defers reasoning effort to the user's own Codex config.
   */
  readonly persistsDefaultThinkingOnCreate?: boolean;
  resolveCreateConfig?(input: ResolveAgentCreateConfigInput): ResolveAgentCreateConfigResult;
  isCreateConfigUnattended?(input: AgentCreateConfigUnattendedInput): boolean;
  listCommands?(config: AgentSessionConfig): Promise<AgentSlashCommand[]>;
  listFeatures?(config: AgentSessionConfig): Promise<AgentFeature[]>;
  listImportableSessions?(
    options?: ListImportableSessionsOptions,
  ): Promise<ImportableProviderSession[]>;
  importSession?(
    input: ImportProviderSessionInput,
    context: ImportProviderSessionContext,
  ): Promise<ImportedProviderSession>;
  /**
   * Check availability in the catalogue target when supplied (CLI binary is installed).
   * Returns true if available, false otherwise.
   */
  isAvailable(signal?: AbortSignal, options?: FetchCatalogOptions): Promise<boolean>;
  getDiagnostic?(): Promise<{ diagnostic: string }>;
  /**
   * Archive a durable native session (best-effort). Runtime release belongs to AgentSession.close().
   * Called when Paseo archives an agent so the provider's own UI reflects the same state.
   */
  archiveNativeSession?(handle: AgentPersistenceHandle): Promise<void>;
  /**
   * Unarchive a durable native session in the provider.
   * Called before Paseo clears its archived flag so provider resume can succeed.
   */
  unarchiveNativeSession?(handle: AgentPersistenceHandle): Promise<void>;
  /**
   * Release any provider-owned resources held by this client (background
   * processes, sockets, cached subprocesses, etc.). Called when the daemon
   * shuts down. Must be idempotent.
   */
  shutdown?(): Promise<void>;
}
