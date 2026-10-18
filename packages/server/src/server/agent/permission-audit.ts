import { createHash } from "node:crypto";
import type { AgentPermissionRequest } from "./agent-sdk-types.js";

/** Keep arguments private. The request ID and input digest identify the exact tool input. */
export function permissionAudit(
  agent: {
    id: string;
    title?: string | null;
    runtimeInfo?: { sessionId?: string | null };
    cwd: string;
  },
  request: AgentPermissionRequest | undefined,
  requestId: string,
  decision: "allow" | "deny" | "defer" | "failed",
  rule: string,
  source: string,
) {
  return {
    event: "permission.decision",
    time: new Date().toISOString(),
    agentId: agent.id,
    sessionId: agent.runtimeInfo?.sessionId ?? null,
    sessionName: agent.title ?? null,
    requestId,
    tool: request?.name ?? null,
    target: {
      cwd: agent.cwd,
      inputSha256: request
        ? createHash("sha256")
            .update(JSON.stringify(request.input ?? {}))
            .digest("hex")
        : null,
    },
    decision,
    rule,
    source,
  };
}
