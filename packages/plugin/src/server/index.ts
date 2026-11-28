export type * from "./trusted.js";
export type {
  UsageSourceRegistration,
  UsageReport,
  UsageWindow,
  UsageBalance,
  UsageDetail,
} from "./usage.js";
export type {
  PluginCredentialRequest,
  PluginCredentialResponse,
  PluginCredentials,
  PluginHandlerContext,
  PluginNotifyInput,
  PluginNotifyResult,
  PluginSecrets,
  PluginServerContext,
  PluginServerContribution,
  PluginSettings,
  PluginSettingsState,
  PluginSubscriptionContext,
} from "./contracts.js";
export type {
  PluginHooks,
  PluginHookEvents,
  PluginHookRequests,
  PluginHookPayload,
  PluginHookResult,
  PluginHookContext,
  PluginHookWorkspace,
  PluginHookWorktree,
  PluginWorktreeCreateRequest,
  PluginLaunchWrap,
  PluginTerminalCreateRequest,
  PluginCommandRunRequest,
  PluginHookAgent,
  PluginSessionOpenRequest,
  PluginTurnOutcome,
  PluginLifecycleEvents,
  PluginBeforeRequests,
  PluginLifecycleRegistration,
} from "./lifecycle.js";

export type * from "./management.js";
export { spawnProcess, execCommand, terminateProcess } from "./process.js";
export type { SpawnProcessOptions } from "./process.js";

export { defineAgentTool } from "./agent-tools.js";
export type { AgentToolDefinition, AgentToolResult, AgentToolContext } from "./agent-tools.js";
export type {
  PluginWorktreeContext,
  PluginWorktreeCreateInput,
  PluginWorktreeCreateResult,
  PluginWorktreeRemoveRequest,
  PluginWorktreeRemoveResult,
  PluginWorktreeRestoreTarget,
  PluginWorktreeRestoreRequest,
  PluginWorktreeRestoreResult,
  WorktreeManagerRegistration,
} from "./worktree.js";
