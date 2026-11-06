import { DaemonConnectionError } from "@getpaseo/client/internal/daemon-client";

interface CallerLookupClient {
  fetchAgent(options: { agentId: string }): Promise<{ agent: { id: string } } | null>;
}

// PASEO_AGENT_ID belongs to the daemon that launched this shell. Commands
// targeting another daemon (--host or --home) have no caller on that daemon.
export async function resolveCallerAgentId(
  client: CallerLookupClient,
  env: { PASEO_AGENT_ID?: string } = process.env,
): Promise<string | undefined> {
  const agentId = env.PASEO_AGENT_ID?.trim();
  if (!agentId) return undefined;
  const caller = await client.fetchAgent({ agentId }).catch((error: unknown) => {
    // FU-690: only "agent not found" means this daemon has no such caller. Any other failure
    // (a lost connection, a timeout, a storage fault) must not turn a worker into a top-level
    // agent with no parent, so it fails the command.
    if (isAgentNotFound(error)) return null;
    if (error instanceof DaemonConnectionError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not look up the calling agent ${agentId}: ${reason}`, { cause: error });
  });
  return caller?.agent.id === agentId ? agentId : undefined;
}

// Current daemons answer an unknown id with a null agent; older ones send this error text.
function isAgentNotFound(error: unknown): boolean {
  return error instanceof Error && /^agent not found\b/i.test(error.message.trim());
}
