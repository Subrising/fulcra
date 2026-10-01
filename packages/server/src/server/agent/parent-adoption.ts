import type { AgentSession } from "./agent-sdk-types.js";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";

export interface ParentAdoptionInput {
  agentId: string;
  parentAgentId: string;
  expectedParentAgentId: string | null;
  childNativeSessionId: string;
  parentNativeSessionId: string;
}
export interface AdoptionAgent {
  id: string;
  instanceId?: string;
  lifecycle: string;
  internal?: boolean;
  archivedAt: string | null;
  runtimeInfo?: { sessionId?: string | null } | null;
  labels: Record<string, string>;
  provider?: string;
  session?: AgentSession | null;
  persistence?: { sessionId: string } | null;
  pendingReplacement?: boolean;
}

export function snapshotParentAdoption(input: ParentAdoptionInput): Readonly<ParentAdoptionInput> {
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const copy: Record<string, string | null> = {};
  for (const key of [
    "agentId",
    "parentAgentId",
    "expectedParentAgentId",
    "childNativeSessionId",
    "parentNativeSessionId",
  ] as const) {
    const field = descriptors[key];
    if (
      !field ||
      !("value" in field) ||
      (!(key === "expectedParentAgentId" && field.value === null) &&
        (typeof field.value !== "string" || !field.value))
    )
      throw new Error("Primitive parent adoption snapshot required");
    copy[key] = field.value;
  }
  return Object.freeze(copy) as Readonly<ParentAdoptionInput>;
}

export function currentAdoptionNativeId(agent: AdoptionAgent): string {
  const session = agent.session;
  const native = session?.describePersistence();
  if (
    !session ||
    !native ||
    !session.id ||
    session.provider !== agent.provider ||
    native.provider !== agent.provider ||
    native.sessionId !== session.id ||
    agent.runtimeInfo?.sessionId !== session.id ||
    agent.persistence?.sessionId !== session.id
  )
    throw new Error("Current provider identity unavailable or changed");
  return session.id;
}

// Host-only admission reader. No caller-supplied role or label grants this permission.
export function validateParentAdoption<T extends AdoptionAgent>(
  input: ParentAdoptionInput,
  agents: ReadonlyMap<string, T>,
  ownerIsCurrent: () => boolean,
): { child: T; parent: T } {
  if (!ownerIsCurrent()) throw new Error("Current native owner admission required");
  const child = requireLive(agents, input.agentId);
  const parent = requireLive(agents, input.parentAgentId);
  if (
    currentAdoptionNativeId(child) !== input.childNativeSessionId ||
    currentAdoptionNativeId(parent) !== input.parentNativeSessionId
  )
    throw new Error("Native session identity changed");
  if ((child.labels[PARENT_AGENT_ID_LABEL] ?? null) !== input.expectedParentAgentId)
    throw new Error("Parent relationship changed");
  const seen = new Set([child.id]);
  let current: AdoptionAgent | undefined = parent;
  while (current) {
    if (seen.has(current.id)) throw new Error("Parent cycle refused");
    seen.add(current.id);
    const next: string | undefined = current.labels[PARENT_AGENT_ID_LABEL];
    current = next ? agents.get(next) : undefined;
    if (next && !current) throw new Error("New parent ancestry is not loaded");
  }
  return { child, parent };
}
function requireLive<T extends AdoptionAgent>(agents: ReadonlyMap<string, T>, id: string): T {
  const agent = agents.get(id);
  if (
    !agent ||
    agent.archivedAt ||
    agent.internal ||
    agent.pendingReplacement ||
    agent.lifecycle === "closed" ||
    agent.lifecycle === "initializing" ||
    !agent.instanceId ||
    !agent.runtimeInfo?.sessionId
  )
    throw new Error("Live native identity required on this daemon");
  return agent;
}
