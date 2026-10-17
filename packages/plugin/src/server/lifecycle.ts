import type { SessionCost } from "@getpaseo/protocol/recorded-usage";
import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentTimelineItem,
  AgentSessionConfig,
  AgentUsage,
} from "@getpaseo/protocol/agent-types";
import type { PaseoApi } from "@getpaseo/client";
import type { WorkspaceCreateRequest } from "@getpaseo/protocol/messages";

export interface PluginHookContext {
  paseo: PaseoApi;
  signal: AbortSignal;
}

export interface PluginHookWorkspace {
  id: string;
  projectId: string;
  cwd: string;
  name: string | null;
  archivedAt: string | null;
}

export interface PluginHookAgent {
  accountId?: string;
  id: string;
  workspaceId: string | null;
  parentAgentId: string | null;
  provider: string;
  cwd: string;
  title: string | null;
}

export interface PluginSessionOpenRequest {
  agentId: string;
  workspaceId: string | null;
  provider: string;
  cwd: string;
  reason: "create" | "resume" | "refresh" | "import";
  purpose: "interactive" | "history";
  env: Record<string, string>;
}

export type PluginTurnOutcome =
  | { kind: "completed" }
  | { kind: "failed"; error: { message: string; code?: string } }
  | { kind: "canceled"; reason: string };

export interface PluginLifecycleEvents {
  "agent.turn_started": { agent: PluginHookAgent; turnId: string | null };
  "agent.turn_ended": {
    agent: PluginHookAgent;
    turnId: string | null;
    outcome: PluginTurnOutcome;
    usage?: AgentUsage;
    timeline: readonly AgentTimelineItem[];
  };
  "agent.permission_requested": { agent: PluginHookAgent; request: AgentPermissionRequest };
  "agent.permission_resolved": {
    agent: PluginHookAgent;
    requestId: string;
    resolution: AgentPermissionResponse;
  };
  "agent.archived": { agent: PluginHookAgent; archivedAt: string };
  "agent.created": { agent: PluginHookAgent };
  "agent.closed": { agent: PluginHookAgent };
  "workspace.created": { workspace: PluginHookWorkspace };
  "workspace.archived": { workspace: PluginHookWorkspace };
}

export interface PluginBeforeRequests {
  "agent.cost_commit": {
    agentId: string;
    provider: string;
    accountId: string | null;
    turnId: string;
    costUsd: number;
    at: string;
    cursors: Record<string, number>;
  };

  "agent.cost_read": {
    agentId: string;
    provider: string;
    runtimeSessionId: string | null;
    records?: {
      cursors: Record<string, number>;
      turns: Record<string, { accountId: string | null; amountUsd: number; at: string }>;
    };
  };
  "agent.turn_start": {
    agentId: string;
    provider: string;
    accountId: string | null;
    labels: Record<string, string>;
    sessionCost?: SessionCost;
    costRecords?: Record<string, { accountId: string | null; amountUsd: number; at: string }>;
  };
  "agent.create": {
    config: AgentSessionConfig;
    env?: Record<string, string>;
    /** The creation's labels, for context only: changes a hook makes to them are not applied. */
    labels?: Record<string, string>;
  };
  "agent.session_open": PluginSessionOpenRequest;
  "workspace.create": Omit<WorkspaceCreateRequest, "type" | "requestId">;
}

export interface PluginLifecycleRegistration {
  on<Name extends keyof PluginLifecycleEvents>(
    name: Name,
    handler: (
      event: PluginLifecycleEvents[Name],
      context: PluginHookContext,
    ) => void | Promise<void>,
  ): () => void;
  before<Name extends keyof PluginBeforeRequests>(
    name: Name,
    handler: (
      input: { request: PluginBeforeRequests[Name] },
      context: PluginHookContext,
    ) => PluginBeforeRequests[Name] | void | Promise<PluginBeforeRequests[Name] | void>,
  ): () => void;
}
