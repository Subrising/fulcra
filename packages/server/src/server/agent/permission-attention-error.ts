import type { AgentPermissionRequest } from "./agent-sdk-types.js";

/** An input refusal is not a permission decision. Include only public request identity/type, never tool input. */
export class PermissionAttentionError extends Error {
  readonly code = "permission_attention";
  readonly diagnostic =
    "Answer or dismiss the question, or approve/deny the actual approval request using its permission control. A new send is not a permission decision.";
  constructor(provider: string, pending: readonly AgentPermissionRequest[]) {
    const identity = pending.slice(0, 8).map((request) => {
      const id = /^[A-Za-z0-9_-]{1,160}$/.test(request.id) ? request.id : "unavailable-id";
      return `${request.kind ?? "permission"}: ${id}`;
    });
    super(`${provider} turn start requires permission attention (${identity.join(", ")})`);
    this.name = "PermissionAttentionError";
  }
}
