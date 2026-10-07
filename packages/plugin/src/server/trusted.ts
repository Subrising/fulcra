import type { NativeQueuedMessageReceiptSchema } from "@getpaseo/protocol/native-intercom";
import type { z } from "zod";
import type {
  TrustedOperationV11,
  TrustedInputV11,
  ProvenanceBindingV11,
  DeepReadonly,
} from "@getpaseo/protocol/trusted-input";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
export type * from "@getpaseo/protocol/trusted-input";
import type { AgentQuotaSnapshot } from "@getpaseo/protocol/messages";
import type { AgentPermissionResponse } from "@getpaseo/protocol/agent-types";

import type { TrustedInputKind, InputSequence } from "@getpaseo/protocol/trusted-input";
export interface TrustedAgent {
  id: string;
  provider?: string;
  cwd?: string;
  archivedAt?: string | null;
  labels: Readonly<Record<string, string>>;
  lifecycle?: string;
  activeTurnId?: string | null;
  activeForegroundTurnId?: string | null;
  pendingPermissionIds: readonly string[];
  persistenceSessionId?: string;
  workspaceId?: string;
  inputSequence: InputSequence;
}
export interface TrustedInput {
  kind: TrustedInputKind;
  messageId?: string;
  source: "human" | "agent" | "daemon" | "plugin";
  /** Verified by the daemon. Never derived from messageId. */
  provenance: { pluginId: string } | null;
}
export interface ProvenanceBinding {
  agentId: string;
  kind: TrustedInputKind;
  messageId?: string;
}
export type AdmissionDecision = "allow" | "deny";
export type PermissionGuardDecision = AdmissionDecision | { requestId: string };
export interface LegacyTrustedPluginServer {
  admission: {
    onInput(handler: (agent: TrustedAgent, input: TrustedInput) => AdmissionDecision): void;
    mcpRefresh(
      handler: (agent: TrustedAgent) => {
        allowed: boolean;
        revision: string;
        contextRotationAllowed?: boolean;
      },
    ): void;
    codexTurn(handler: (agent: TrustedAgent, quota: AgentQuotaSnapshot) => AdmissionDecision): void;
  };
  guard(
    name: "agent.permission_respond",
    handler: (
      agent: TrustedAgent,
      requestId: string,
      response: AgentPermissionResponse,
      input: TrustedInput,
    ) => PermissionGuardDecision,
  ): void;
  claude: { deny(handler: () => readonly string[]): void };
  /** Bearer capability: keep private; send as inputProvenance on the bound RPC. */
  issueProvenance(binding: ProvenanceBinding): string;
}
/** Distribution-only index.host.js entry. Setup and all handlers must be synchronous. */
export type LegacyTrustedPluginContribution = (server: LegacyTrustedPluginServer) => void;

export type CanonicalPendingPermissionV11 = DeepReadonly<AgentPermissionRequest>;
export type TrustedPermissionStateV11 =
  | { readonly status: "unavailable" }
  | {
      readonly status: "known";
      readonly requests: readonly CanonicalPendingPermissionV11[];
      readonly inFlightRequestIds: readonly string[];
    };
export type TrustedRuntimeV11 =
  | { readonly status: "unavailable" }
  | {
      readonly status: "known";
      readonly instanceId: string;
      readonly nativeSessionId: string | null;
      readonly modeId?: string | null;
      readonly model: string | null;
      readonly serviceTier: string | null;
      readonly lastUserMessageAt: string | null;
    };
export interface TrustedAgentV11 extends Readonly<TrustedAgent> {
  readonly permissions: TrustedPermissionStateV11;
  readonly runtime: TrustedRuntimeV11;
}
export interface TrustedInputObservationsV11 {
  /** Authoritative native handle agreement; absent/unknown refuses new queued source purpose. */
  nativeIdentity?(
    agentId: string,
  ): Readonly<{ instanceId: string; nativeSessionId: string }> | null;
  readonly boot: string;
  require(agentId: string): Readonly<InputSequence>;
}
export interface TrustedCodexTurnV11 {
  readonly operation: TrustedOperationV11;
  readonly instanceId: string;
  readonly nativeSessionId: string;
  readonly model: string | null;
  readonly serviceTier: string | null;
}
export interface QuotaReadFailureV11 {
  readonly code: "unavailable" | "read_failed" | "invalid_reply";
  readonly nativeDispatched: false;
}
export interface TrustedCodexAdmissionV11 {
  check(
    agent: TrustedAgentV11,
    turn: TrustedCodexTurnV11,
    quota: AgentQuotaSnapshot,
  ): AdmissionDecision;
  onQuotaReadFailure(
    agent: TrustedAgentV11,
    turn: TrustedCodexTurnV11,
    failure: QuotaReadFailureV11,
  ): void;
}
export interface TrustedPluginServerV11 {
  readonly managementBridge: import("./management.js").TrustedManagementBridgeV11;
  readonly inputObservations: TrustedInputObservationsV11;
  admission: {
    /** Host-only observation of the original native ledger's durable lifecycle, never input authority. */
    nativeQueuedReceipt(
      handler: (
        agent: TrustedAgentV11,
        operation: TrustedOperationV11,
        receipt: z.infer<typeof NativeQueuedMessageReceiptSchema>,
      ) => void,
    ): void;
    onInput(handler: (agent: TrustedAgentV11, input: TrustedInputV11) => AdmissionDecision): void;
    mcpRefresh(
      handler: (agent: TrustedAgentV11) => {
        allowed: boolean;
        revision: string;
        /** Whether a fresh provider context may replace the native one; absent means no. */
        contextRotationAllowed?: boolean;
      },
    ): void;
    codexTurn(handlers: TrustedCodexAdmissionV11): void;
  };
  guard(
    name: "agent.permission_respond",
    handler: (
      agent: TrustedAgentV11,
      requestId: string,
      response: AgentPermissionResponse,
      input: TrustedInputV11,
    ) => PermissionGuardDecision,
  ): void;
  claude: { deny(handler: () => readonly string[]): void };
  /**
   * FIX-8 W3: decide a provider's permission request before the daemon surfaces it. Return "allow" to answer it at
   * once (it never becomes a pending permission and reaches no client); anything else, or a throw, surfaces it as
   * usual. Synchronous, like every trusted handler.
   */
  permissions: {
    automatic(
      handler: (agent: TrustedAgentV11, request: CanonicalPendingPermissionV11) => "allow" | "ask",
    ): void;
  };
  issueProvenance(binding: ProvenanceBindingV11): string;
}
export type TrustedPluginContributionV11 = (server: TrustedPluginServerV11) => void;

export type TrustedPluginServer = TrustedPluginServerV11;
export type TrustedPluginContribution = TrustedPluginContributionV11;
