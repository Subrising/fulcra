import { Command } from "commander";
import { connectToDaemon, resolveAgentId } from "../../utils/client.js";
import type {
  CommandOptions,
  SingleResult,
  OutputSchema,
  CommandError,
} from "../../output/index.js";

/** Result type for agent archive command */
export interface AgentArchiveResult {
  agentId: string;
  status: "archived";
  archivedAt: string;
}

/** Schema for archive command output */
export const archiveSchema: OutputSchema<AgentArchiveResult> = {
  idField: "agentId",
  columns: [
    { header: "AGENT ID", field: "agentId" },
    { header: "STATUS", field: "status" },
    { header: "ARCHIVED AT", field: "archivedAt" },
  ],
};

export function addArchiveOptions(cmd: Command): Command {
  return cmd
    .description("Archive an agent (soft-delete)")
    .argument("<id>", "Agent ID, prefix, or name")
    .option("--force", "Force archive running agent (interrupts active run first)");
}

export interface AgentArchiveOptions extends CommandOptions {
  force?: boolean;
  host?: string;
}

export type AgentArchiveCommandResult = SingleResult<AgentArchiveResult>;

type ArchiveClient = Pick<
  Awaited<ReturnType<typeof connectToDaemon>>,
  "fetchAgent" | "fetchAgents"
>;

/**
 * The chat to archive. The daemon looks the ID up itself first, so a stored chat that is not loaded is found. A
 * list read gives only one page, and old chats fall outside it. The list is the fallback, for names the daemon does
 * not know.
 */
export async function findAgentToArchive(client: ArchiveClient, idOrName: string) {
  // An error from the daemon (the ID or title is ambiguous, the connection dropped) is shown as it is. Only "not
  // found" (null) falls back to the list: the list could pick one of several chats the daemon just said it cannot tell
  // apart.
  const direct = await client.fetchAgent({ agentId: idOrName.trim() });
  if (direct?.agent) return direct.agent;
  const payload = await client.fetchAgents({ filter: { includeArchived: true } });
  const agents = payload.entries.map((entry) => entry.agent);
  const agentId = resolveAgentId(idOrName, agents);
  return agentId ? (agents.find((entry) => entry.id === agentId) ?? null) : null;
}

export async function runArchiveCommand(
  agentIdArg: string,
  options: AgentArchiveOptions,
  _command: Command,
): Promise<AgentArchiveCommandResult> {
  // Validate arguments
  if (!agentIdArg || agentIdArg.trim().length === 0) {
    const error: CommandError = {
      code: "MISSING_AGENT_ID",
      message: "Agent ID is required",
      details: "Usage: paseo agent archive <id-or-name>",
    };
    throw error;
  }

  const client = await connectToDaemon({ target: options.daemonTarget });

  try {
    const agent = await findAgentToArchive(client, agentIdArg);
    if (!agent) {
      const error: CommandError = {
        code: "AGENT_NOT_FOUND",
        message: `Agent not found: ${agentIdArg}`,
        details: 'Use "paseo ls" to list available agents',
      };
      throw error;
    }
    const agentId = agent.id;

    // Check if agent is already archived
    if (agent.archivedAt) {
      const error: CommandError = {
        code: "AGENT_ALREADY_ARCHIVED",
        message: `Agent ${agentId.slice(0, 7)} is already archived`,
        details: `Archived at: ${agent.archivedAt}`,
      };
      throw error;
    }

    // Check if agent is running and reject unless --force is set
    if (agent.status === "running" && !options.force) {
      const error: CommandError = {
        code: "AGENT_RUNNING",
        message: `Agent ${agentId.slice(0, 7)} is currently running`,
        details:
          "Use --force to archive a running agent (it will interrupt the active run), or stop it first with: paseo agent stop. Use paseo agent delete to hard-delete it.",
      };
      throw error;
    }

    // Archive the agent
    const result = await client.archiveAgent(agentId);

    await client.close();

    return {
      type: "single",
      data: {
        agentId,
        status: "archived",
        archivedAt: result.archivedAt,
      },
      schema: archiveSchema,
    };
  } catch (err) {
    await client.close().catch(() => {});

    // Re-throw CommandError as-is
    if (err && typeof err === "object" && "code" in err) {
      throw err;
    }

    const message = err instanceof Error ? err.message : String(err);
    const error: CommandError = {
      code: "ARCHIVE_FAILED",
      message: `Failed to archive agent: ${message}`,
    };
    throw error;
  }
}
