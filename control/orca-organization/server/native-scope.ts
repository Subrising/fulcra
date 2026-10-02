import type { PaseoApi } from "@getpaseo/client";

// U5-D09: the identity of a LOCAL session's native agent, read-only. Activity reads are registered read-only, and a
// read-only handler may invoke only the controller's READ_METHODS (server/management-context.mjs). The controller's
// `observe` is not one of them (control.inspect can take over a session), so reads that called it failed on their first
// line: every local activity-history read answered "Native tool activity unavailable; receipts retained", and the
// activity read failed outright. The native agent's own snapshot (the host API's refresh, a read) carries what these
// reads bind to: the agent id, its provider, creation time and native session, and the time of its last user message.
export interface NativeScope {
  identity: (string | null)[];
  lastUserAt: string | null;
}
export async function readOnlyNativeScope(
  paseo: PaseoApi,
  row: { id: string; task: string },
): Promise<NativeScope> {
  const refreshed = await paseo.agents.ref(row.id).refresh();
  const agent = refreshed?.agent;
  const task = agent?.labels?.task;
  if (!agent || agent.id !== row.id || (typeof task === "string" && task !== row.task))
    throw new Error("Native activity identity unavailable");
  return {
    identity: [
      agent.id,
      agent.provider ?? null,
      agent.createdAt ?? null,
      agent.persistence?.sessionId ?? null,
      agent.runtimeInstanceId ?? null,
    ],
    lastUserAt: agent.lastUserMessageAt ?? null,
  };
}
