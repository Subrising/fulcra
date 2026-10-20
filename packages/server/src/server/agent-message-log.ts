// FU-115: which chat asked to send a message to which other chat, and when. Report-up reads it to skip a worker's
// "finished a turn" notice when the worker already messaged its lead during that turn. Only IDs and times are kept,
// never text. One daemon process, so one module-level map; the oldest entries go first.
const MAX_ENTRIES = 2000;
const sent = new Map<string, number>();
// FU-427: a send that reached the receiver (or its durable queue). A request alone can still fail, so only this map
// may suppress a finish notice.
const delivered = new Map<string, number>();

const keyOf = (senderId: string, targetId: string) => `${senderId}>${targetId}`;

/** A chat asked to send a message to another chat (stamped send, or the send tool). */
export function noteAgentMessage(senderId: string, targetId: string, at = Date.now()): void {
  if (!senderId || !targetId || senderId === targetId) return;
  const key = keyOf(senderId, targetId);
  sent.delete(key);
  sent.set(key, at);
  if (sent.size > MAX_ENTRIES) {
    const oldest = sent.keys().next().value;
    if (oldest !== undefined) sent.delete(oldest);
  }
}

/** Epoch ms of the sender's last message request to the target, or null. */
export function lastAgentMessageAt(senderId: string, targetId: string): number | null {
  return sent.get(keyOf(senderId, targetId)) ?? null;
}

/** A message from the sender reached the target, or the target's durable queue. */
export function noteAgentMessageDelivered(
  senderId: string,
  targetId: string,
  at = Date.now(),
): void {
  if (!senderId || !targetId || senderId === targetId) return;
  const key = keyOf(senderId, targetId);
  delivered.delete(key);
  delivered.set(key, at);
  if (delivered.size > MAX_ENTRIES) {
    const oldest = delivered.keys().next().value;
    if (oldest !== undefined) delivered.delete(oldest);
  }
}

/** Epoch ms of the sender's last delivered message to the target, or null. */
export function lastAgentMessageDeliveredAt(senderId: string, targetId: string): number | null {
  return delivered.get(keyOf(senderId, targetId)) ?? null;
}

export function resetAgentMessageLogForTests(): void {
  sent.clear();
  delivered.clear();
}
