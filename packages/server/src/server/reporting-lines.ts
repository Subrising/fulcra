import {
  DIRECT_LINK_LABEL,
  MAIN_ASSISTANT_REF,
  PARENT_AGENT_ID_LABEL,
  REPORTS_TO_LABEL,
  REPORTS_TO_OWNER,
  SEAT_LABEL,
  ROLE_REF_PREFIX,
} from "@getpaseo/protocol/agent-labels";

// FULCRA(orchestration): reporting lines (Fulcra 0.2.8). A chat sends only to the chat it reports to, to the chats
// that report to it, or to the one direct link its lead allowed. These are cooperative rules, not security: the CLI
// stamps the sender from PASEO_AGENT_ID, and a send without a stamp is the owner (the app, the phone, the owner's own
// command), which is never refused. A chat without a recorded line is not refused either; the Team map marks it.
// A line can name a role ("role:main-assistant"): it means the chat that holds the role now, so leads keep their line
// when the main assistant changes.

const CONTROLLER_PARENT_LABEL = "fulcra.parent-session";

export interface LineAgent {
  id: string;
  title?: string | null;
  labels?: Record<string, string> | null;
  archivedAt?: string | Date | null;
  updatedAt?: string | Date | null;
}

export interface LineInput {
  sender: { agentId: string; serverId?: string };
  /** The sender's record on this computer; null when the sender is on another computer or unknown here. */
  senderAgent: LineAgent | null;
  target: LineAgent;
  /** The sender's parent, when it is a chat on this computer, for the plain reason. */
  senderParent: LineAgent | null;
  localServerId: string | null;
  /** The chat on this computer that holds the main assistant role now, if any. */
  mainAssistantId?: string | null;
}

export type LineDecision = { allowed: true; why: string } | { allowed: false; reason: string };

/** The chat a record reports to: its reporting line, else the parent that created it. */
export function reportsTo(agent: LineAgent | null): string | null {
  const labels = agent?.labels ?? {};
  const line = labels[REPORTS_TO_LABEL]?.trim();
  if (line) return line;
  // A chat the controller created names its parent here; a chat a chat created, in the product's parent label.
  const parent = labels[CONTROLLER_PARENT_LABEL]?.trim() || labels[PARENT_AGENT_ID_LABEL]?.trim();
  return parent || null;
}

const time = (value: string | Date | null | undefined) =>
  value ? new Date(value).getTime() || 0 : 0;

/** The live chat that holds a role; the most recently updated one if records disagree. */
export function findRoleHolder(agents: readonly LineAgent[], role: string): LineAgent | null {
  let holder: LineAgent | null = null;
  for (const agent of agents) {
    if (agent.archivedAt || agent.labels?.[SEAT_LABEL]?.trim() !== role) continue;
    if (!holder || time(agent.updatedAt) > time(holder.updatedAt)) holder = agent;
  }
  return holder;
}

/** A role reference becomes the chat that holds the role now; other references stay as they are. */
export function resolveLineRef(ref: string | null, mainAssistantId: string | null): string | null {
  if (!ref?.startsWith(ROLE_REF_PREFIX)) return ref;
  return ref === MAIN_ASSISTANT_REF ? mainAssistantId : null;
}

/** "abc" and "abc@this-server" are the same chat on this computer. */
function sameChat(ref: string | null, agentId: string, serverId: string | null): boolean {
  if (!ref) return false;
  const [id, server] = ref.split("@", 2);
  return id === agentId && (server === undefined || server === serverId);
}

const name = (agent: LineAgent | null, fallback: string) =>
  `${agent?.title?.trim() || fallback} (${(agent?.id ?? fallback).slice(0, 8)})`;

/** The target reports to the sender, or allowed the sender as its direct link. */
function inboundDecision(
  input: LineInput,
  senderKey: string,
  remote: boolean,
): LineDecision | null {
  const { sender, target, localServerId } = input;
  const targetLine = resolveLineRef(reportsTo(target), input.mainAssistantId ?? null);
  const senderServer = remote ? (sender.serverId ?? null) : localServerId;
  if (targetLine === senderKey || sameChat(targetLine, sender.agentId, senderServer))
    return { allowed: true, why: "child" };
  if (target.labels?.[DIRECT_LINK_LABEL]?.trim() === senderKey)
    return { allowed: true, why: "direct link" };
  return null;
}

/** A chat on another computer reaches its own chats here and the main assistant. */
function remoteDecision(input: LineInput): LineDecision {
  const { target } = input;
  if (target.id === input.mainAssistantId || reportsTo(target) === REPORTS_TO_OWNER)
    return { allowed: true, why: "main assistant" };
  return {
    allowed: false,
    reason:
      "From another computer, a chat can send only to its own chats here and to the main assistant.",
  };
}

/** The plain reason for a send outside the sender's line, naming the right recipient. */
function refusal(input: LineInput, rawLine: string, line: string | null): LineDecision {
  if (rawLine === REPORTS_TO_OWNER)
    return {
      allowed: false,
      reason: "A main assistant sends to its own leads. Ask the owner to add a direct link.",
    };
  if (rawLine === MAIN_ASSISTANT_REF && !line)
    return { allowed: false, reason: "No chat is the main assistant now. Ask the owner to set one." };
  if (rawLine === MAIN_ASSISTANT_REF)
    return {
      allowed: false,
      reason: `Send this to the main assistant, ${name(input.senderParent, line!)}.`,
    };
  const parentId = (line ?? rawLine).split("@", 1)[0]!;
  return {
    allowed: false,
    reason: `Send this to your lead, ${name(input.senderParent, parentId)}.`,
  };
}

export function checkReportingLine(input: LineInput): LineDecision {
  const { sender, target, localServerId } = input;
  const remote = Boolean(sender.serverId && sender.serverId !== localServerId);
  const senderKey = remote ? `${sender.agentId}@${sender.serverId}` : sender.agentId;
  if (!remote && sender.agentId === target.id) return { allowed: true, why: "self" };
  const inbound = inboundDecision(input, senderKey, remote);
  if (inbound) return inbound;
  if (remote) return remoteDecision(input);
  const rawLine = reportsTo(input.senderAgent);
  if (!rawLine) return { allowed: true, why: "no line recorded" };
  const line = resolveLineRef(rawLine, input.mainAssistantId ?? null);
  if (sameChat(line, target.id, localServerId)) return { allowed: true, why: "parent" };
  if (input.senderAgent?.labels?.[DIRECT_LINK_LABEL]?.trim() === target.id)
    return { allowed: true, why: "direct link" };
  return refusal(input, rawLine, line);
}
