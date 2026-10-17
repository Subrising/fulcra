import { Command } from "commander";
import { connectToDaemon } from "../../utils/client.js";
import { findAgentToArchive } from "./archive.js";
import type { CommandOptions, SingleResult, OutputSchema } from "../../output/index.js";

interface AgentRestoreResult {
  agentId: string;
  status: "restored";
}
const restoreSchema: OutputSchema<AgentRestoreResult> = {
  idField: "agentId",
  columns: [
    { header: "AGENT ID", field: "agentId" },
    { header: "STATUS", field: "status" },
  ],
};
export function addRestoreOptions(cmd: Command): Command {
  return cmd
    .description("Restore an archived agent with its original ID")
    .argument("<id>", "Agent ID, prefix, or name");
}
export async function runRestoreCommand(
  id: string,
  options: CommandOptions,
  _command: Command,
): Promise<SingleResult<AgentRestoreResult>> {
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    if (client.getLastServerInfoMessage()?.features?.agentArchiveSafety !== true)
      throw new Error("Update the host to restore the original session safely.");
    const agent = await findAgentToArchive(client, id);
    if (!agent) throw new Error(`Agent not found: ${id}`);
    if (agent.archivedAt) {
      const restored = await client.refreshAgent(agent.id, undefined, { restore: true });
      if (restored.agentId !== agent.id) throw new Error("Restore changed the agent ID.");
    }
    return {
      type: "single",
      data: { agentId: agent.id, status: "restored" },
      schema: restoreSchema,
    };
  } finally {
    await client.close();
  }
}
