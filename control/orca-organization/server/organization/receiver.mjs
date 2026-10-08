// Read existing seat/hold facts. This is not an ownership classifier or an execution grant.
export function createIntakeReceiverReader(readDirectory) {
  return async ({ prime }) => {
    if (prime.kind === "human-session" || !prime.seat)
      return {
        available: false,
        binding: null,
        reason:
          "This intake is retained for its human owner. Open the existing conversation or choose a project.",
      };
    try {
      const directory = await readDirectory();
      const candidates =
        directory?.bindings?.filter(
          (binding) =>
            binding.role === "prime" &&
            binding.seat === prime.seat &&
            binding.sessionId === prime.agentId,
        ) ?? [];
      if (candidates.length !== 1)
        return {
          available: false,
          binding: null,
          reason: "The configured main assistant identity is not confirmed in the current role directory.",
        };
      const binding = candidates[0];
      const humanHeld = Array.isArray(directory.holds)
        ? directory.holds.some(
            (hold) =>
              hold.effective === true &&
              hold.role === "prime" &&
              hold.seat === binding.seat &&
              hold.revision === binding.revision &&
              hold.session === binding.sessionId,
          )
        : null;
      const session =
        Number.isSafeInteger(binding.session?.generation) && binding.session.generation > 0
          ? {
              mode: String(binding.session.mode ?? "unknown").slice(0, 32),
              generation: binding.session.generation,
            }
          : null;
      return {
        available: true,
        reason: null,
        binding: {
          sessionId: binding.sessionId,
          humanHeld,
          session,
          dispatch: { supported: binding.dispatch?.supported === true },
        },
      };
    } catch {
      return {
        available: false,
        binding: null,
        reason: "The main assistant’s current receiving controls are unavailable. Your intake is retained.",
      };
    }
  };
}
