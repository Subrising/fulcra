// FULCRA(plugin-host): agent questions seam. A plugin shows a session's pending ask-the-user questions where that
// session appears (a home card, a team card) with the chat's own question card, so answering there answers the
// chat. Only questions: tool approvals stay in the chat, where their detail is.
import React, { Suspense, lazy, useMemo } from "react";
import { View } from "react-native";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import type { PendingPermission } from "@/types/shared";

// Loaded on first use so the plugin UI kit does not pull the whole chat view in with it.
const PermissionRequestCard = lazy(() =>
  import("@/agent-stream/view").then((module) => ({ default: module.PermissionRequestCard })),
);

export function pendingQuestionsFor(
  pending: ReadonlyMap<string, PendingPermission> | undefined,
  agentId: string,
): PendingPermission[] {
  if (!pending) return [];
  return [...pending.values()].filter(
    (permission) => permission.agentId === agentId && permission.request.kind === "question",
  );
}

export function AgentQuestions({
  serverId,
  agentId,
  testID,
}: {
  serverId: string;
  agentId: string;
  testID?: string;
}) {
  const pending = useSessionStore((state) => state.sessions[serverId]?.pendingPermissions);
  const client = useHostRuntimeClient(serverId);
  const questions = useMemo(() => pendingQuestionsFor(pending, agentId), [pending, agentId]);
  if (!questions.length) return null;
  return (
    <View testID={testID}>
      <Suspense fallback={null}>
        {questions.map((permission) => (
          <PermissionRequestCard key={permission.key} permission={permission} client={client} />
        ))}
      </Suspense>
    </View>
  );
}
