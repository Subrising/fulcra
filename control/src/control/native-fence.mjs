// This protocol is also emitted by the self-contained, pinned daemon admission guard.
export const FENCE_PROTOCOL = "orca-input-sequence-v1";
export function delegationFence(observed) {
  if (
    observed?.fenceProtocol !== FENCE_PROTOCOL ||
    typeof observed.boot !== "string" ||
    !observed.boot ||
    observed.saturated !== false ||
    !Number.isSafeInteger(observed.humanAt) ||
    observed.humanAt < 0 ||
    observed.humanAt >= Number.MAX_SAFE_INTEGER
  )
    throw Error("Native input sequence fence unavailable");
  // grantedAt is the existing journal column, now the first disallowed input sequence.
  // No timestamp from the controller (or another host) participates in this boundary.
  return observed.humanAt + 1;
}
// V1.1 wire observation. Legacy injected labels are never authority for this path.
export function hostInputFence(snapshot, boot) {
  const sequence = snapshot?.inputSequence;
  if (!sequence || sequence.boot !== boot)
    throw Error("Native input barrier observation unavailable");
  const fence = {
    boot: sequence.boot,
    humanAt: sequence.humanAt,
    fenceProtocol: FENCE_PROTOCOL,
    saturated: false,
  };
  delegationFence(fence);
  return fence;
}
