// Host-only contribution. Native lifecycle events carry observations; the host retains dispatch authority.
export function registerRecoveryHooks(server, service) {
  const off = [
    server.on("agent.turn_started", ({ agent, turnId }) =>
      service.onAgentEvent({
        type: "agent_stream",
        agentId: agent.id,
        event: { type: "turn_started", turnId },
      }),
    ),
    server.on("agent.turn_ended", ({ agent, turnId, outcome, timeline }) =>
      service.onAgentEvent({
        type: "agent_stream",
        agentId: agent.id,
        event:
          outcome.kind === "failed"
            ? {
                type: "turn_failed",
                turnId,
                error: outcome.error.message,
                code: outcome.error.code,
              }
            : {
                type: outcome.kind === "completed" ? "turn_completed" : "turn_canceled",
                turnId,
                lastAssistant:
                  timeline.findLast((item) => item.type === "assistant_message")?.text ?? null,
              },
      }),
    ),
  ];
  return () => off.forEach((remove) => remove());
}
