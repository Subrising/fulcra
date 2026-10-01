import { AgentPermissionRequestPayloadSchema } from "@getpaseo/protocol/messages";
import { canonicalJson } from "@getpaseo/protocol/trusted-input";
import { validatedTimestamp, resolvedServiceTier } from "../agent/runtime-observation.js";
import type { TrustedPermissionStateV11, TrustedRuntimeV11 } from "@getpaseo/plugin/server";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import { sanitizePendingPermissions } from "../agent/agent-projections.js";

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function assertProjectable(value: unknown, active = new Set<object>()): void {
  if (
    value === undefined ||
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  )
    return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (value instanceof Date && Number.isFinite(value.getTime())) return;
  if (typeof value !== "object" || !value || active.has(value))
    throw new TypeError("Unprojectable permission state");
  if (Object.getOwnPropertySymbols(value).length)
    throw new TypeError("Unprojectable permission symbols");
  const prototype = Object.getPrototypeOf(value);
  if (
    prototype !== Object.prototype &&
    prototype !== null &&
    !(Array.isArray(value) && prototype === Array.prototype)
  )
    throw new TypeError("Unprojectable permission object");
  active.add(value);
  try {
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if (!("value" in descriptor)) throw new TypeError("Permission accessors forbidden");
      assertProjectable(descriptor.value, active);
    }
  } finally {
    active.delete(value);
  }
}

function isClosedInstance(agent: { lifecycle?: string; session?: unknown }): boolean {
  return agent.lifecycle === "closed" || agent.session === null;
}

export function permissionFacts(agent: {
  lifecycle?: string;
  session?: unknown;
  pendingPermissions?: ReadonlyMap<string, unknown>;
  inFlightPermissionResponses?: ReadonlySet<string>;
}): TrustedPermissionStateV11 {
  if (
    isClosedInstance(agent) ||
    !(agent.pendingPermissions instanceof Map) ||
    !(agent.inFlightPermissionResponses instanceof Set)
  )
    return { status: "unavailable" };
  try {
    for (const [id, request] of agent.pendingPermissions) {
      assertProjectable(request);
      if (
        !request ||
        typeof request !== "object" ||
        !("id" in request) ||
        request.id !== id ||
        !("provider" in request) ||
        typeof request.provider !== "string" ||
        !("name" in request) ||
        typeof request.name !== "string" ||
        !("kind" in request) ||
        !["tool", "plan", "question", "mode", "other"].includes(String(request.kind))
      )
        return { status: "unavailable" };
    }
    const requests = sanitizePendingPermissions(
      new Map(agent.pendingPermissions) as Map<string, AgentPermissionRequest>,
    );
    // This is the wire projection: undefined properties are omitted and Dates become ISO.
    const copied = JSON.parse(JSON.stringify(requests));
    for (const request of copied) {
      const parsed = AgentPermissionRequestPayloadSchema.safeParse(request);
      if (!parsed.success || canonicalJson(parsed.data) !== canonicalJson(request))
        return { status: "unavailable" };
    }
    const ids = [...agent.inFlightPermissionResponses];
    if (ids.some((id) => typeof id !== "string")) return { status: "unavailable" };
    return deepFreeze({ status: "known", requests: copied, inFlightRequestIds: ids });
  } catch {
    return { status: "unavailable" };
  }
}

export function runtimeFacts(agent: {
  lifecycle?: string;
  session?: unknown;
  provider?: string;
  instanceId?: string;
  currentModeId?: string | null;
  runtimeInfo?: { sessionId?: string | null; model?: string | null };
  config?: { model?: string | null } | null;
  persistence?: { sessionId: string } | null;
  features?: readonly { id: string; type: string; value?: unknown }[];
  lastUserMessageAt?: Date | string | null;
}): TrustedRuntimeV11 {
  if (
    isClosedInstance(agent) ||
    !agent.instanceId ||
    agent.lastUserMessageAt === undefined ||
    !agent.provider
  )
    return { status: "unavailable" };
  if (agent.provider === "codex" && !Array.isArray(agent.features))
    return { status: "unavailable" };
  try {
    const nativeSessionId = agent.runtimeInfo?.sessionId ?? agent.persistence?.sessionId ?? null;
    const model = agent.runtimeInfo?.model ?? agent.config?.model ?? null;
    if (
      (nativeSessionId !== null && typeof nativeSessionId !== "string") ||
      (model !== null && typeof model !== "string")
    )
      return { status: "unavailable" };
    return deepFreeze({
      status: "known",
      instanceId: agent.instanceId,
      nativeSessionId,
      ...(typeof agent.currentModeId === "string" ? { modeId: agent.currentModeId } : {}),
      model,
      serviceTier: runtimeServiceTier(agent),
      lastUserMessageAt: validatedTimestamp(agent.lastUserMessageAt),
    });
  } catch {
    return { status: "unavailable" };
  }
}

function runtimeServiceTier(agent: {
  provider?: string;
  features?: readonly { id: string; type: string; value?: unknown }[];
}): string | null {
  if (agent.provider !== "codex") return null;
  const feature = agent.features?.find((f) => f.id === "fast_mode" && f.type === "toggle");
  return resolvedServiceTier((feature?.value ?? false) as boolean);
}
