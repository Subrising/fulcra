import type { Command } from "commander";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { connectToDaemon, resolveAgentId } from "../../utils/client.js";
import type {
  CommandError,
  CommandOptions,
  OutputSchema,
  SingleResult,
} from "../../output/index.js";

// Fulcra 0.2.17 (FU-102): `paseo agent adopt <child> --parent <id>` makes an existing chat the child of another chat, over
// the host's native parent adoption. The parent label is protected: `agent update --label` refuses it. Only the owner's
// own connection (the daemon password) is admitted by the host.

interface AgentAdoptResult {
  agentId: string;
  parentAgentId: string;
  previousParentAgentId: string | null;
  status: "adopted";
}

const adoptSchema: OutputSchema<AgentAdoptResult> = {
  idField: "agentId",
  columns: [
    { header: "AGENT ID", field: "agentId" },
    { header: "PARENT", field: "parentAgentId" },
    { header: "PREVIOUS PARENT", field: (row) => row.previousParentAgentId ?? "-" },
    { header: "STATUS", field: "status" },
  ],
};

interface AdoptableAgent {
  id: string;
  labels?: Record<string, string> | null;
  runtimeInfo?: { sessionId?: string | null } | null;
  persistence?: { sessionId?: string | null } | null;
}

export interface AdoptClient {
  fetchAgents(options: { filter: { includeArchived: boolean } }): Promise<{
    entries: Array<{ agent: AdoptableAgent & { title?: string | null; name?: string | null } }>;
  }>;
  adoptAgentParent(input: {
    agentId: string;
    parentAgentId: string;
    expectedParentAgentId: string | null;
    childNativeSessionId: string;
    parentNativeSessionId: string;
  }): Promise<void>;
}

const fail = (code: string, message: string): never => {
  throw { code, message } satisfies CommandError;
};

function nativeSessionId(agent: AdoptableAgent, which: string): string {
  const id = agent.runtimeInfo?.sessionId ?? agent.persistence?.sessionId;
  if (!id)
    return fail(
      "AGENT_NOT_LOADED",
      `The ${which} chat has no provider session yet. Open or start it first.`,
    );
  return id;
}

/** Makes `parentArg` the parent of `childArg`. Fails plainly for an unknown chat, the same chat, or a chat without a session. */
export async function adoptAgent(
  client: AdoptClient,
  childArg: string,
  parentArg: string,
): Promise<AgentAdoptResult> {
  const { entries } = await client.fetchAgents({ filter: { includeArchived: false } });
  const agents = entries.map((entry) => entry.agent);
  const childId = resolveAgentId(childArg, agents);
  if (!childId) return fail("AGENT_NOT_FOUND", `Agent not found: ${childArg}`);
  const parentId = resolveAgentId(parentArg, agents);
  if (!parentId) return fail("AGENT_NOT_FOUND", `Parent agent not found: ${parentArg}`);
  if (childId === parentId) return fail("INVALID_OPTIONS", "A chat cannot be its own parent");
  const child = agents.find((agent) => agent.id === childId)!;
  const parent = agents.find((agent) => agent.id === parentId)!;
  const previous = child.labels?.[PARENT_AGENT_ID_LABEL] ?? null;
  if (previous === parentId)
    return fail("ALREADY_ADOPTED", "That chat is already the parent of this chat");
  try {
    await client.adoptAgentParent({
      agentId: childId,
      parentAgentId: parentId,
      expectedParentAgentId: previous,
      childNativeSessionId: nativeSessionId(child, "child"),
      parentNativeSessionId: nativeSessionId(parent, "parent"),
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) throw error;
    return fail("ADOPT_REFUSED", error instanceof Error ? error.message : String(error));
  }
  return {
    agentId: childId,
    parentAgentId: parentId,
    previousParentAgentId: previous,
    status: "adopted",
  };
}

interface AdoptOptions extends CommandOptions {
  parent?: string;
}

export async function runAdoptCommand(
  childArg: string,
  options: AdoptOptions,
  _command: Command,
): Promise<SingleResult<AgentAdoptResult>> {
  if (!options.parent?.trim()) fail("INVALID_OPTIONS", "--parent <id> is required");
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    const data = await adoptAgent(client, childArg, options.parent!.trim());
    return { type: "single", data, schema: adoptSchema };
  } finally {
    await client.close().catch(() => undefined);
  }
}
