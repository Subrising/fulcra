<<<<<<< HEAD
import { randomUUID } from "node:crypto";
import { SessionCostRecordsSchema } from "../../agent/session-cost.js";
import type { AgentStreamEvent, AgentTimelineItem } from "../../agent/agent-sdk-types.js";
=======
import { isDeepStrictEqual } from "node:util";
import {
  serializeAgentTool,
  agentToolMetadataSchema,
  type SessionOpenWireRequest,
  type PluginAgentTools,
} from "../agent-tools.js";
import type { AgentToolDefinition } from "@getpaseo/plugin/server";
import type { AgentStreamEvent } from "../../agent/agent-sdk-types.js";
>>>>>>> refs/remotes/upstream/tags/v0.14.0
import { z } from "zod";
import { CreateAgentRequestMessageSchema } from "@getpaseo/protocol/messages";
import type {
  PluginHookAgent,
  PluginHookContext,
  PluginLifecycleRegistration,
} from "@getpaseo/plugin/server";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type {
  PluginBeforeRequests,
  PluginHookWorkspace,
  PluginLifecycleEvents,
} from "@getpaseo/plugin/server";
import { WorkspaceCreateRequestSchema } from "@getpaseo/protocol/messages";
import type { PersistedWorkspaceRecord } from "../../workspace-registry.js";

export type PluginWireBeforeRequests = Omit<PluginBeforeRequests, "agent.session_open"> & {
  "agent.session_open": SessionOpenWireRequest;
};

/** Daemon-only results; ownership never crosses the plugin process boundary. */
export type PluginBeforeResults = PluginWireBeforeRequests & {
  "agent.session_open": SessionOpenWireRequest & { mcpServerOwners?: Record<string, string> };
};

export const lifecycleEventNames = [
  "agent.created",
  "agent.closed",
  "agent.turn_started",
  "agent.turn_ended",
  "agent.permission_requested",
  "agent.permission_resolved",
  "agent.archived",
  "workspace.created",
  "workspace.archived",
] as const;
export const beforeHookNames = [
  "agent.create",
  "agent.session_open",
  "agent.cost_read",
  "agent.cost_commit",
  "workspace.create",
] as const;

const beforeSchemas = {
  "agent.cost_commit": z
    .object({
      costCommitted: z.boolean().optional(),
      agentId: z.string(),
      provider: z.string(),
      accountId: z.string().nullable(),
      turnId: z.string(),
      costUsd: z.number().finite().nonnegative(),
      at: z.string(),
      revision: z.number().int().nonnegative().optional(),
      cursors: z.record(z.string(), z.number().finite().nonnegative()),
    })
    .strict(),
  "agent.cost_read": z
    .object({
      agentId: z.string(),
      provider: z.string(),
      runtimeSessionId: z.string().nullable(),
      records: SessionCostRecordsSchema.optional(),
    })
    .strict(),
  "agent.create": CreateAgentRequestMessageSchema.pick({
    config: true,
    env: true,
    labels: true,
  })
    .extend({
      // Update-7 W3 (R1 P-3 seam): for a create with a caller, the caller's provider, mode and mode class -- context for
      // a host's child-mode policy. Like labels, a hook's changes to it are not applied.
      caller: z
        .object({
          provider: z.string(),
          modeId: z.string().nullable(),
          modeClass: z.enum(["automatic", "restricted", "unknown"]),
        })
        .strict()
        .optional(),
    })
    .strict(),
  "agent.session_open": z
    .object({
      agentId: z.string(),
      workspaceId: z.string().nullable(),
      provider: z.string(),
      cwd: z.string(),
      reason: z.enum(["create", "resume", "refresh", "import"]),
      purpose: z.enum(["interactive", "history"]),
      title: z.string().nullable(),
      labels: z.record(z.string(), z.string()),
      tools: z.array(agentToolMetadataSchema),
      env: z.record(z.string(), z.string()),
      mcpServers: CreateAgentRequestMessageSchema.shape.config.shape.mcpServers.unwrap(),
    })
    .strict(),
  "workspace.create": WorkspaceCreateRequestSchema.omit({ type: true, requestId: true }).strict(),
};

const sessionOpenLocalResultSchema = beforeSchemas["agent.session_open"].extend({
  tools: z.array(
    z.custom<AgentToolDefinition>(
      (tool) =>
        typeof tool === "object" &&
        tool !== null &&
        "input" in tool &&
        "execute" in tool &&
        typeof tool.execute === "function",
    ),
  ),
});

export interface PluginLifecycle {
  emit<Name extends keyof PluginLifecycleEvents>(
    name: Name,
    event: PluginLifecycleEvents[Name],
  ): void;
  before<Name extends keyof PluginWireBeforeRequests>(
    name: Name,
    request: PluginWireBeforeRequests[Name],
  ): Promise<PluginBeforeResults[Name]>;
}

export function validateBeforeRequest<Name extends keyof PluginWireBeforeRequests>(
  name: Name,
  value: unknown,
): PluginWireBeforeRequests[Name] {
  return beforeSchemas[name].parse(value) as PluginWireBeforeRequests[Name];
}

export function describeHookWorkspace(workspace: PersistedWorkspaceRecord): PluginHookWorkspace {
  return {
    id: workspace.workspaceId,
    projectId: workspace.projectId,
    cwd: workspace.cwd,
    name: workspace.title,
    archivedAt: workspace.archivedAt,
  };
}

export function describeHookAgent(agent: {
  id: string;
  workspaceId?: string;
  provider: string;
  cwd: string;
  title?: string | null;
  labels: Record<string, string>;
  accountId?: string;
}): PluginHookAgent {
  return {
    id: agent.id,
    ...(agent.accountId ? { accountId: agent.accountId } : {}),
    workspaceId: agent.workspaceId ?? null,
    parentAgentId: agent.labels[PARENT_AGENT_ID_LABEL] ?? null,
    provider: agent.provider,
    cwd: agent.cwd,
    title: agent.title ?? null,
  };
}

function describeTurnObservation(observation?: { id: string; at: string }) {
  return {
    observedAt: observation?.at ?? new Date().toISOString(),
    observationId: observation?.id ?? randomUUID(),
    observedOrder: process.hrtime.bigint().toString(),
  };
}

export function publishAgentStream(
  lifecycle: PluginLifecycle,
  agent: PluginHookAgent,
  event: AgentStreamEvent,
<<<<<<< HEAD
  timeline: readonly AgentTimelineItem[],
  observation?: { id: string; at: string },
=======
>>>>>>> refs/remotes/upstream/tags/v0.14.0
): void {
  if (event.type === "turn_started") {
    lifecycle.emit("agent.turn_started", { agent, turnId: event.turnId ?? null });
  } else if (event.type === "turn_completed") {
    lifecycle.emit("agent.turn_ended", {
      agent,
      ...describeTurnObservation(observation),
      turnId: event.turnId ?? null,
      timeline: [],
      outcome: { kind: "completed" },
      ...(event.usage ? { usage: event.usage } : {}),
    });
  } else if (event.type === "turn_failed") {
    lifecycle.emit("agent.turn_ended", {
      agent,
      ...describeTurnObservation(observation),
      ...(event.usage ? { usage: event.usage } : {}),
      turnId: event.turnId ?? null,
<<<<<<< HEAD
      timeline,
      outcome: {
        kind: "failed",
        error: {
          message: [event.error, event.diagnostic].filter(Boolean).join(" "),
          code: event.code,
        },
      },
=======
      timeline: [],
      outcome: { kind: "failed", error: { message: event.error, code: event.code } },
>>>>>>> refs/remotes/upstream/tags/v0.14.0
    });
  } else if (event.type === "turn_canceled") {
    lifecycle.emit("agent.turn_ended", {
      agent,
      ...describeTurnObservation(observation),
      turnId: event.turnId ?? null,
      timeline: [],
      outcome: { kind: "canceled", reason: event.reason },
    });
  } else if (event.type === "permission_requested") {
    lifecycle.emit("agent.permission_requested", { agent, request: event.request });
  } else if (event.type === "permission_resolved") {
    lifecycle.emit("agent.permission_resolved", {
      agent,
      requestId: event.requestId,
      resolution: event.resolution,
    });
  }
}

<<<<<<< HEAD
function validateCostReadResult(input: unknown, result: unknown): void {
  const previous = beforeSchemas["agent.cost_read"].parse(input);
  const next = beforeSchemas["agent.cost_read"].parse(result);
  if (
    previous.agentId !== next.agentId ||
    previous.provider !== next.provider ||
    previous.runtimeSessionId !== next.runtimeSessionId
  )
    throw new Error("Cost readers cannot change session identity");
  for (const [id, row] of Object.entries(previous.records?.turns ?? {}))
    if (JSON.stringify(next.records?.turns[id]) !== JSON.stringify(row))
      throw new Error("Cost readers cannot change recorded turns");
}

export function validateBeforeResult<Name extends keyof PluginBeforeRequests>(
=======
export function validateBeforeResult<Name extends keyof PluginWireBeforeRequests>(
>>>>>>> refs/remotes/upstream/tags/v0.14.0
  name: Name,
  input: PluginWireBeforeRequests[Name],
  output: unknown,
): PluginWireBeforeRequests[Name] {
  const result = validateBeforeRequest(name, output);
  if (name === "agent.cost_read") validateCostReadResult(input, result);
  if (
    name === "agent.cost_commit" &&
    JSON.stringify({ ...input, costCommitted: undefined }) !==
      JSON.stringify({ ...result, costCommitted: undefined })
  )
    throw new Error("Cost commit hooks cannot change the request");
  if (name === "agent.session_open") {
    const previous = beforeSchemas["agent.session_open"].parse(input);
    const next = beforeSchemas["agent.session_open"].parse(result);
    if (
      previous.agentId !== next.agentId ||
      previous.workspaceId !== next.workspaceId ||
      previous.provider !== next.provider ||
      previous.cwd !== next.cwd ||
      previous.reason !== next.reason ||
      previous.purpose !== next.purpose ||
      previous.title !== next.title ||
      !isDeepStrictEqual(previous.labels, next.labels)
    ) {
      throw new Error("agent.session_open hooks can only change env, tools, and mcpServers");
    }
  }
  if (name === "agent.create") {
    const previous = beforeSchemas["agent.create"].parse(input);
    const next = beforeSchemas["agent.create"].parse(result);
    if (previous.config.cwd !== next.config.cwd) {
      throw new Error("agent.create hooks cannot change the workspace directory");
    }
  }
  return result;
}

type Handler = (input: unknown, context: PluginHookContext) => unknown;

export class PluginHookHandlers implements PluginLifecycleRegistration {
  private readonly events = new Map<string, Set<Handler>>();
  private readonly transforms = new Map<string, Set<Handler>>();
  private readonly active = new Map<string, AbortController>();

  private readonly changed: () => void;

  private readonly agentTools: PluginAgentTools | undefined;

  constructor(changed: () => void, agentTools?: PluginAgentTools) {
    this.agentTools = agentTools;
    this.changed = changed;
  }

  readonly on: PluginLifecycleRegistration["on"] = (name, handler) => {
    if (!lifecycleEventNames.includes(name)) {
      throw new Error(`Unknown lifecycle event: ${name}`);
    }
    return this.register(this.events, name, handler as Handler);
  };

  readonly before: PluginLifecycleRegistration["before"] = (name, handler) => {
    if (!beforeHookNames.includes(name)) {
      throw new Error(`Unknown before hook: ${name}`);
    }
    return this.register(this.transforms, name, handler as Handler);
  };

  catalog(): { events: string[]; before: string[] } {
    return { events: [...this.events.keys()], before: [...this.transforms.keys()] };
  }

  async invoke(
    id: string,
    kind: "event" | "before",
    name: string,
    input: unknown,
    paseo: PluginHookContext["paseo"],
  ): Promise<unknown> {
    const controller = new AbortController();
    this.active.set(id, controller);
    try {
      if (kind === "before") {
        if (
          !beforeHookNames.includes(
            name as keyof import("@getpaseo/plugin/server").PluginBeforeRequests,
          )
        ) {
          throw new Error(`Unknown before hook: ${name}`);
        }
        const hookName = name as keyof import("@getpaseo/plugin/server").PluginBeforeRequests;
        if (hookName === "agent.session_open") {
          return await this.openSession(input, { paseo, signal: controller.signal });
        }
        let request = validateBeforeRequest(hookName, input);
        for (const handler of this.transforms.get(name) ?? []) {
          controller.signal.throwIfAborted();
          const result = await handler(
            { request: structuredClone(request) },
            { paseo, signal: controller.signal },
          );
          if (result !== undefined) request = validateBeforeResult(hookName, request, result);
        }
        return request;
      }
      for (const handler of this.events.get(name) ?? []) {
        controller.signal.throwIfAborted();
        try {
          await handler(structuredClone(input), { paseo, signal: controller.signal });
        } catch (error) {
          console.error(`Lifecycle hook ${name} failed`, error);
        }
      }
      return null;
    } finally {
      this.active.delete(id);
    }
  }

  private async openSession(
    input: unknown,
    context: PluginHookContext,
  ): Promise<SessionOpenWireRequest> {
    let request = validateBeforeRequest("agent.session_open", input);
    this.agentTools?.detach(request.agentId);
    let tools: AgentToolDefinition[] = [];
    for (const handler of this.transforms.get("agent.session_open") ?? []) {
      context.signal.throwIfAborted();
      const result = await handler(
        { request: { ...structuredClone(request), tools: [...tools] } },
        context,
      );
      if (result === undefined) continue;
      const local = sessionOpenLocalResultSchema.parse(result);
      const metadata = local.tools.map(serializeAgentTool);
      request = validateBeforeResult("agent.session_open", request, { ...local, tools: metadata });
      tools = local.tools;
    }
    context.signal.throwIfAborted();
    if (request.purpose === "history") {
      request.tools = [];
      request.mcpServers = {};
    } else this.agentTools?.attach(request.agentId, tools);
    return request;
  }

  cancel(id: string): void {
    this.active.get(id)?.abort();
  }

  close(): void {
    for (const controller of this.active.values()) {
      controller.abort();
    }
    this.events.clear();
    this.transforms.clear();
  }

  private register(
    registry: Map<string, Set<Handler>>,
    name: string,
    handler: Handler,
  ): () => void {
    let handlers = registry.get(name);
    if (!handlers) {
      handlers = new Set();
      registry.set(name, handlers);
    }
    handlers.add(handler);
    this.changed();
    return () => {
      if (!handlers.delete(handler)) {
        return;
      }
      if (handlers.size === 0) {
        registry.delete(name);
      }
      this.changed();
    };
  }
}
