import type { Agent } from "@/stores/session-store";
import type { ProviderUsageListPayload, AccountUsageRow } from "@/provider-usage/types";
import { runtimeUsageRevision } from "@/provider-usage/runtime-snapshot";
import { sessionAccount } from "@/sessions/session-account";

/** A label is presentation only. It never joins an account row or grants access. */
export function contextSessionAccount(agent: Pick<Agent, "provider" | "labels">) {
  return sessionAccount(agent);
}

export interface ContextAccountReadScope {
  serverId: string;
  workspaceId: string;
  clientGeneration: number;
  admission: string;
  agents: Iterable<Agent>;
  agentId: string | null;
}

/** Private UI invalidation key; runtime identity is never added to account rows. */
export function contextAccountReadKey(scope: ContextAccountReadScope): string {
  return JSON.stringify([
    scope.serverId,
    scope.workspaceId,
    scope.clientGeneration,
    scope.admission,
    scope.agentId,
    runtimeUsageRevision(scope.agents, null, true),
  ]);
}

export type ContextAccountReadResult =
  | { kind: "ready"; accounts: AccountUsageRow[] }
  | { kind: "unavailable" }
  | { kind: "superseded" };

/** Admission is checked at dispatch and after the read; raw host errors never reach the surface. */
export async function readContextAccounts(
  read: () => Promise<ProviderUsageListPayload>,
  isCurrent: () => boolean,
): Promise<ContextAccountReadResult> {
  if (!isCurrent()) return { kind: "superseded" };
  try {
    const payload = await read();
    if (!isCurrent()) return { kind: "superseded" };
    if (!payload.accounts) return { kind: "unavailable" };
    return { kind: "ready", accounts: payload.accounts };
  } catch {
    return isCurrent() ? { kind: "unavailable" } : { kind: "superseded" };
  }
}
