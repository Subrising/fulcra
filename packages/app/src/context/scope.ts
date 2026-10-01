import { create } from "zustand";
import type { Agent } from "@/stores/session-store";

type ContextAgent = Pick<
  Agent,
  "id" | "createdAt" | "runtimeInfo" | "persistence" | "runtimeInstanceId"
>;
export interface ContextSelection {
  agentId: string;
  identity: string;
  clientGeneration: number;
}
export function contextWorkspaceKey(serverId: string, workspaceId: string): string {
  return JSON.stringify([serverId, workspaceId]);
}
export function contextAgentIdentity(agent: ContextAgent): string {
  return JSON.stringify([
    agent.id,
    agent.createdAt.toISOString(),
    agent.runtimeInstanceId ?? null,
    agent.runtimeInfo?.sessionId ?? null,
    agent.persistence?.sessionId ?? null,
  ]);
}
export function makeContextSelection(
  agent: ContextAgent,
  clientGeneration: number,
): ContextSelection {
  return { agentId: agent.id, identity: contextAgentIdentity(agent), clientGeneration };
}
export function matchesContextSelection(
  selection: ContextSelection,
  agent: ContextAgent | undefined,
  clientGeneration: number,
): boolean {
  return Boolean(
    agent &&
    selection.clientGeneration === clientGeneration &&
    selection.identity === contextAgentIdentity(agent),
  );
}
// Only transient UI selection. Rows/accounts/reports never enter a shared cache.
interface ContextScopeStore {
  selected: Record<string, ContextSelection | null>;
  select: (key: string, selection: ContextSelection | null) => void;
}
export const useContextScope = create<ContextScopeStore>((set) => ({
  selected: {},
  select: (key, selection) =>
    set((state) => ({ selected: { ...state.selected, [key]: selection } })),
}));
