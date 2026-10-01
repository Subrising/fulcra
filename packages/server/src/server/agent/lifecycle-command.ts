import { deferredCommandPayload as commandPayload } from "./trusted-operation.js";
import type { TrustedOperationHandle } from "../plugins/trusted.js";
import type { TrustedPayloadV11 } from "@getpaseo/protocol/trusted-input";
import type { Logger } from "pino";

import {
  AgentRunCancellationError,
  type AgentRunCancellationResult,
  type ManagedAgent,
} from "./agent-manager.js";
import type { StoredAgentRecord } from "./agent-storage.js";
import type { AgentProviderNotice } from "./agent-sdk-types.js";

export type LifecycleAgentSnapshot = Pick<ManagedAgent, "id" | "cwd" | "lifecycle">;

export interface LifecycleAgentManager {
  withInput<T>(
    agentId: string,
    kind: import("@getpaseo/plugin/server").TrustedInputKind,
    messageId: string | undefined,
    operation: (handle?: TrustedOperationHandle) => T,
    payload?: TrustedPayloadV11 | (() => TrustedPayloadV11),
    handle?: TrustedOperationHandle,
  ): T;
  getAgent(agentId: string): LifecycleAgentSnapshot | null;
  hasInFlightRun(agentId: string): boolean;
  cancelAgentRun(
    agentId: string,
    handle?: TrustedOperationHandle,
  ): Promise<AgentRunCancellationResult>;
  clearAgentAttention(agentId: string): Promise<void>;
  preflightArchiveDescendants(agentId: string): Promise<void>;
  archiveAgent(agentId: string, handle?: TrustedOperationHandle): Promise<{ archivedAt: string }>;
  archiveSnapshot(
    agentId: string,
    archivedAt: string,
    handle?: TrustedOperationHandle,
  ): Promise<StoredAgentRecord>;
  closeAgent(agentId: string, handle?: TrustedOperationHandle): Promise<void>;
  setLabels(agentId: string, labels: Record<string, string>): Promise<void>;
  detachAgent(agentId: string): Promise<{
    record: StoredAgentRecord;
    live: boolean;
    previousParentAgentId: string | null;
  }>;
  notifyAgentState(agentId: string): void;
  setAgentMode(agentId: string, modeId: string): Promise<AgentProviderNotice | null>;
  updateAgentMetadata(
    agentId: string,
    updates: {
      title?: string;
      labels?: Record<string, string>;
    },
  ): Promise<void>;
}

export interface LifecycleAgentStorage {
  get(agentId: string): Promise<StoredAgentRecord | null>;
  upsert(record: StoredAgentRecord): Promise<void>;
  // Orca R3b. Optional so every existing storage double keeps compiling; AgentStorage implements it.
  normalizeInterruptedTurn?(
    agentId: string,
    marker: { detectedAt: string; bootId: string | null },
    stillUnloaded: () => boolean,
  ): Promise<StoredAgentRecord | null>;
}

export interface AgentLifecycleCommandDependencies {
  agentManager: LifecycleAgentManager;
  agentStorage: LifecycleAgentStorage;
  logger: Logger;
}

export interface CancelAgentRunResult {
  agent: LifecycleAgentSnapshot;
  cancelled: boolean;
}

interface RequestedAgentRunCancellation extends CancelAgentRunResult {
  cancellation: AgentRunCancellationResult;
}

type CancellationDependencies = Pick<AgentLifecycleCommandDependencies, "agentManager" | "logger"> &
  Partial<Pick<AgentLifecycleCommandDependencies, "agentStorage">>;

// Orca R3b (review F2). Only the explicit stop command may normalise an unloaded agent's stored record: that is the
// path the admission patch guards as human input (its anchor is cancelAgentRunCommand's first line). Every other
// caller -- archiveAgentCommand today -- gets the old behaviour whatever its dependencies carry.
interface CancellationOptions {
  readonly operationHandle?: TrustedOperationHandle;
  readonly normalizeUnloadedStoredTurn?: true;
}

async function requestAgentRunCancellation(
  dependencies: CancellationDependencies,
  agentId: string,
  options: CancellationOptions = {},
): Promise<RequestedAgentRunCancellation> {
  const { agentManager, logger } = dependencies;
  const agent = agentManager.getAgent(agentId);
  if (!agent) {
    // Orca R3b. An agent no process has loaded runs no turn. A stored running/initializing record for it is a
    // dead turn: stop normalises it to idle (with the interruption marker) and reports not_running, instead of
    // failing with "not found" and leaving the stored status running forever.
    const stored = options.normalizeUnloadedStoredTurn
      ? await dependencies.agentStorage?.get(agentId)
      : null;
    if (stored && dependencies.agentStorage?.normalizeInterruptedTurn) {
      const normalized = await dependencies.agentStorage.normalizeInterruptedTurn(
        agentId,
        { detectedAt: new Date().toISOString(), bootId: null },
        () => agentManager.getAgent(agentId) === null,
      );
      const record = normalized ?? (await dependencies.agentStorage.get(agentId)) ?? stored;
      logger.info(
        { agentId, normalized: normalized !== null },
        "cancelAgentRunCommand: agent not loaded; stored turn is not running",
      );
      return {
        agent: { id: record.id, cwd: record.cwd, lifecycle: record.lastStatus },
        cancelled: false,
        cancellation: { status: "not_running" },
      };
    }
    logger.trace({ agentId }, "cancelAgentRunCommand: agent not found");
    throw new Error(`Agent ${agentId} not found`);
  }

  const hasInFlightRun = agentManager.hasInFlightRun(agentId);
  if (!hasInFlightRun) {
    logger.trace(
      { agentId, lifecycle: agent.lifecycle, hasInFlightRun },
      "cancelAgentRunCommand: skipping because agent is not running",
    );
    return { agent, cancelled: false, cancellation: { status: "not_running" } };
  }

  logger.debug(
    { agentId, lifecycle: agent.lifecycle, hasInFlightRun },
    "cancelAgentRunCommand: interrupting",
  );
  const startedAt = Date.now();
  const cancellation = await agentManager.cancelAgentRun(agentId, options.operationHandle);
  logger.debug(
    { agentId, cancellation: cancellation.status, durationMs: Date.now() - startedAt },
    "cancelAgentRunCommand: cancelAgentRun completed",
  );

  return {
    agent,
    cancelled: cancellation.status === "settled",
    cancellation,
  };
}

export async function cancelAgentRunCommand(
  dependencies: CancellationDependencies,
  agentId: string,
): Promise<CancelAgentRunResult> {
  return dependencies.agentManager.withInput(
    agentId,
    "cancel",
    undefined,
    async (operationHandle) => {
      const result = await requestAgentRunCancellation(dependencies, agentId, {
        normalizeUnloadedStoredTurn: true,
        operationHandle,
      });
      if (result.cancellation.status === "refused") {
        dependencies.logger.warn(
          { agentId },
          "cancelAgentRunCommand: reported running but no active run was cancelled",
        );
        throw new AgentRunCancellationError(agentId, "stop");
      }

      return { agent: result.agent, cancelled: result.cancelled };
    },
    commandPayload("cancel"),
  );
}

export interface ArchiveAgentResult {
  agentId: string;
  archivedAt: string;
  record: StoredAgentRecord;
}

export async function archiveAgentCommand(
  dependencies: AgentLifecycleCommandDependencies,
  agentId: string,
  handle?: TrustedOperationHandle,
): Promise<ArchiveAgentResult> {
  return dependencies.agentManager.withInput(
    agentId,
    "archive",
    undefined,
    async (operationHandle) => {
      await dependencies.agentManager.preflightArchiveDescendants(agentId);
      const liveAgent = dependencies.agentManager.getAgent(agentId);
      let record: StoredAgentRecord | null;
      if (liveAgent) {
        await requestAgentRunCancellation(dependencies, agentId, { operationHandle });
        await dependencies.agentManager.clearAgentAttention(agentId).catch(() => undefined);
        await dependencies.agentManager.archiveAgent(agentId, operationHandle);
        record = await dependencies.agentStorage.get(agentId);
      } else {
        record = await archiveStoredAgent(dependencies, agentId, operationHandle);
      }

      if (!record) {
        throw new Error(`Agent not found in storage after archive: ${agentId}`);
      }
      if (!record.archivedAt) {
        throw new Error(`Agent missing archivedAt after archive: ${agentId}`);
      }

      return {
        agentId,
        archivedAt: record.archivedAt,
        record,
      };
    },
    commandPayload("archive"),
    handle,
  );
}

export async function closeAgentCommand(
  dependencies: Pick<AgentLifecycleCommandDependencies, "agentManager">,
  agentId: string,
  handle?: TrustedOperationHandle,
): Promise<void> {
  await dependencies.agentManager.closeAgent(agentId, handle);
}

export interface UpdateAgentResult {
  accepted: boolean;
  error: string | null;
}

export async function updateAgentCommand(
  dependencies: Pick<AgentLifecycleCommandDependencies, "agentManager">,
  input: {
    agentId: string;
    name?: string;
    labels?: Record<string, string>;
  },
): Promise<UpdateAgentResult> {
  const title = input.name?.trim();
  const labels = input.labels && Object.keys(input.labels).length > 0 ? input.labels : undefined;

  if (!title && !labels) {
    return {
      accepted: false,
      error: "Nothing to update (provide name and/or labels)",
    };
  }

  await dependencies.agentManager.updateAgentMetadata(input.agentId, {
    ...(title ? { title } : {}),
    ...(labels ? { labels } : {}),
  });

  return {
    accepted: true,
    error: null,
  };
}

export interface DetachAgentResult {
  agentId: string;
  record: StoredAgentRecord;
  live: boolean;
  previousParentAgentId: string | null;
}

export async function detachAgentCommand(
  dependencies: Pick<AgentLifecycleCommandDependencies, "agentManager">,
  agentId: string,
): Promise<DetachAgentResult> {
  const result = await dependencies.agentManager.detachAgent(agentId);
  return {
    agentId,
    ...result,
  };
}

export async function setAgentModeCommand(
  dependencies: Pick<AgentLifecycleCommandDependencies, "agentManager">,
  input: {
    agentId: string;
    modeId: string;
  },
): Promise<{ modeId: string; notice: AgentProviderNotice | null }> {
  const notice = await dependencies.agentManager.setAgentMode(input.agentId, input.modeId);
  return { modeId: input.modeId, notice };
}

async function archiveStoredAgent(
  dependencies: Pick<AgentLifecycleCommandDependencies, "agentManager" | "agentStorage">,
  agentId: string,
  operationHandle?: TrustedOperationHandle,
): Promise<StoredAgentRecord> {
  const existing = await dependencies.agentStorage.get(agentId);
  if (!existing) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  if (existing.archivedAt) {
    return existing;
  }

  const archivedAt = new Date().toISOString();
  return dependencies.agentManager.archiveSnapshot(agentId, archivedAt, operationHandle);
}
