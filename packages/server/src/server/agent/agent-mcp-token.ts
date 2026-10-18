import { createHmac, timingSafeEqual } from "node:crypto";

// FULCRA(orchestration): FU-349. The Agent MCP endpoint takes the caller id from the URL. A bare shared token cannot
// prove who is calling, so each agent gets its own token derived from the daemon token and its id. A request
// that presents the derived token for the id in its URL is a verified agent. Any other request is not.

export function agentMcpToken(daemonToken: string, agentId: string): string {
  return createHmac("sha256", daemonToken).update(`fulcra-agent-mcp:${agentId}`).digest("hex");
}

export function isAgentMcpToken(
  daemonToken: string | null,
  agentId: string | undefined,
  presented: string | null | undefined,
): boolean {
  if (!daemonToken || !agentId || !presented) return false;
  const expected = Buffer.from(agentMcpToken(daemonToken, agentId));
  const provided = Buffer.from(presented);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
