import { Command } from "commander";
import { connectToDaemon } from "../../utils/client.js";
<<<<<<< HEAD
import { findAgentToArchive } from "./archive.js";
=======
import { resolveAgentEntry, type AgentLookupClient } from "../../utils/agent-directory.js";
>>>>>>> refs/remotes/upstream/tags/v0.16.2
import type {
  CommandOptions,
  SingleResult,
  OutputSchema,
  CommandError,
} from "../../output/index.js";

export interface AgentReloadResult {
  agentId: string;
  status: "reloaded";
  timelineSize: number;
}

export const reloadSchema: OutputSchema<AgentReloadResult> = {
  idField: "agentId",
  columns: [
    { header: "AGENT ID", field: "agentId" },
    { header: "STATUS", field: "status" },
    { header: "TIMELINE", field: "timelineSize" },
  ],
};

export function addReloadOptions(cmd: Command): Command {
  return cmd
    .description("Reload an agent, or restore an archived worker")
    .argument("<id>", "Agent ID, prefix, or name");
}

export interface AgentReloadOptions extends CommandOptions {
  host?: string;
}

export type AgentReloadCommandResult = SingleResult<AgentReloadResult>;

export interface AgentReloadClient extends AgentLookupClient {
  refreshAgent(agentId: string): Promise<{ agentId: string; timelineSize?: number }>;
  close(): Promise<void>;
}

export async function runReloadCommand(
  agentIdArg: string,
  options: AgentReloadOptions,
  _command: Command,
): Promise<AgentReloadCommandResult> {
  return reloadAgent(agentIdArg, options);
}

export async function reloadAgent(
  agentIdArg: string,
  options: AgentReloadOptions,
  connect: (
    options: Parameters<typeof connectToDaemon>[0],
  ) => Promise<AgentReloadClient> = connectToDaemon,
): Promise<AgentReloadCommandResult> {
  if (!agentIdArg || agentIdArg.trim().length === 0) {
    const error: CommandError = {
      code: "MISSING_AGENT_ID",
      message: "Agent ID is required",
      details: "Usage: paseo agent reload <id-or-name>",
    };
    throw error;
  }

  const client = await connect({ target: options.daemonTarget });

  try {
<<<<<<< HEAD
    const agent = await findAgentToArchive(client, agentIdArg);
    const agentId = agent?.id;
    if (!agentId) {
=======
    const agent = await resolveAgentEntry(client, agentIdArg);
    if (!agent) {
>>>>>>> refs/remotes/upstream/tags/v0.16.2
      const error: CommandError = {
        code: "AGENT_NOT_FOUND",
        message: `Agent not found: ${agentIdArg}`,
        details: 'Use "paseo ls" to list available agents',
      };
      throw error;
    }

<<<<<<< HEAD
    // CLI reload is an explicit worker restore action.
    // Account switching and recovery use maintenance requests without this intent.
    const result = await client.refreshAgent(agentId, undefined, { restore: true });
=======
    const result = await client.refreshAgent(agent.id);
>>>>>>> refs/remotes/upstream/tags/v0.16.2

    await client.close();

    return {
      type: "single",
      data: {
        agentId: result.agentId,
        status: "reloaded",
        timelineSize: result.timelineSize ?? 0,
      },
      schema: reloadSchema,
    };
  } catch (err) {
    await client.close().catch(() => {});

    if (err && typeof err === "object" && "code" in err) {
      throw err;
    }

    const message = err instanceof Error ? err.message : String(err);
    const error: CommandError = {
      code: "RELOAD_FAILED",
      message: `Failed to reload agent: ${message}`,
    };
    throw error;
  }
}
