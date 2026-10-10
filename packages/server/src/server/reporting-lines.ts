import {
  DIRECT_LINK_LABEL,
  MAIN_ASSISTANT_REF,
  PARENT_AGENT_ID_LABEL,
  REPORTS_TO_LABEL,
  REPORTS_TO_OWNER,
  MAIN_ASSISTANT_ROLE,
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
  /** A live agent keeps its title in its config. */
  config?: unknown;
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

export const NO_MAIN_ASSISTANT = "No chat is the main assistant now. Ask the owner to set one.";
export const TWO_MAIN_ASSISTANTS =
  "Two chats are marked as the main assistant. Fulcra corrects this within a minute; send again then.";

export type RoleHolder = { id: string } | { ambiguous: true } | null;

/**
 * The live chat that holds a role. Only the controller writes the seat label, from its seat bindings, so normally
 * one chat has it. Two holders (a seat change part-way) are not guessed between: the send is refused until the
 * controller's next seat sync, which clears the stale one.
 */
export function findRoleHolder(agents: readonly LineAgent[], role: string): RoleHolder {
  const holders = agents.filter(
    (agent) => !agent.archivedAt && agent.labels?.[SEAT_LABEL]?.trim() === role,
  );
  if (holders.length > 1) return { ambiguous: true };
  return holders[0] ? { id: holders[0].id } : null;
}

export interface LineStore {
  get(id: string): Promise<LineAgent | null>;
  /** The chats on this computer, without internal helpers. */
  list(): Promise<readonly LineAgent[]>;
}

/** The send target, with "role:main-assistant" read as the chat that holds the role at delivery time. */
export async function resolveRoleTarget(
  store: LineStore,
  identifier: string,
): Promise<{ ok: true; agentId: string } | { ok: false; error: string } | null> {
  if (identifier.trim() !== MAIN_ASSISTANT_REF) return null;
  const holder = findRoleHolder(await store.list(), MAIN_ASSISTANT_ROLE);
  if (!holder) return { ok: false, error: NO_MAIN_ASSISTANT };
  if ("ambiguous" in holder) return { ok: false, error: TWO_MAIN_ASSISTANTS };
  return { ok: true, agentId: holder.id };
}

/** The decision for one stamped send, read from this computer's records. Null when the target is not here. */
export async function decideSend(
  store: LineStore,
  sender: { agentId: string; serverId?: string },
  targetId: string,
  localServerId: string | null,
): Promise<LineDecision | null> {
  const target = await store.get(targetId);
  if (!target) return null;
  const remote = Boolean(sender.serverId && sender.serverId !== localServerId);
  const senderAgent = remote ? null : await store.get(sender.agentId);
  // A stamp from this computer names a chat that exists here; a made-up id is not "no line recorded".
  if (!remote && !senderAgent)
    return { allowed: false, reason: "This send names a chat that is not on this computer." };
  const holder = findRoleHolder(await store.list(), MAIN_ASSISTANT_ROLE);
  const mainAssistantId = holder && "id" in holder ? holder.id : null;
  const parentRef = resolveLineRef(reportsTo(senderAgent), mainAssistantId);
  const senderParent =
    parentRef && parentRef !== REPORTS_TO_OWNER
      ? await store.get(parentRef.split("@", 1)[0]!)
      : null;
  return checkReportingLine({
    sender,
    senderAgent,
    target,
    senderParent,
    localServerId,
    mainAssistantId,
  });
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

function titleOf(agent: LineAgent | null): string {
  const config = agent?.config as { title?: unknown } | null | undefined;
  const live = typeof config?.title === "string" ? config.title.trim() : "";
  return agent?.title?.trim() || live;
}

const name = (agent: LineAgent | null, fallback: string) =>
  `${titleOf(agent) || fallback} (${(agent?.id ?? fallback).slice(0, 8)})`;

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
  // The sender's line is the main assistant, and no chat on this computer holds that role. The send is not refused
  // for the missing role: it is refused because the target does not report to the sender.
  if (rawLine === MAIN_ASSISTANT_REF && !line)
    return {
      allowed: false,
      reason: `${name(input.target, input.target.id)} does not report to you, so you cannot send to it. Your line is the main assistant, and no chat on this computer holds that role now. Ask the owner to add a direct link.`,
    };
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

interface LineRecord extends LineAgent {
  internal?: boolean;
}

/** This computer's chats as the line check reads them: the stored record first, then the live one. */
export function lineStoreOf(deps: {
  agentManager: { getAgent(id: string): LineAgent | null | undefined };
  agentStorage: {
    get(id: string): Promise<LineAgent | null>;
    list(): Promise<readonly LineRecord[]>;
  };
}): LineStore {
  return {
    get: async (id) =>
      (await deps.agentStorage.get(id).catch(() => null)) ?? deps.agentManager.getAgent(id) ?? null,
    list: async () => (await deps.agentStorage.list()).filter((record) => !record.internal),
  };
}

/**
 * A prompt from a chat through the Paseo MCP tool: the daemon knows the calling chat, so the line is checked here.
 * Returns the chat to prompt ("role:main-assistant" resolved); throws the plain refusal. A call with no calling chat
 * (the owner's own MCP client) is never refused.
 */
export async function checkPromptLine(
  store: LineStore,
  callerAgentId: string | null | undefined,
  requested: string,
): Promise<string> {
  const role = await resolveRoleTarget(store, requested);
  if (role && !role.ok) throw new Error(role.error);
  const agentId = role?.ok ? role.agentId : requested;
  if (!callerAgentId) return agentId;
  const decision = await decideSend(store, { agentId: callerAgentId }, agentId, null);
  if (decision && !decision.allowed) throw new Error(decision.reason);
  return agentId;
}
