// Fulcra 0.2.14: one set of words for a chat's status from the chat list, shared by the sidebar and the Leads page.
// The chat list carries the host's own status, which can be old, so every line says "last known".

const WORDS: Record<string, string> = {
  running: "Working",
  idle: "Idle",
  initializing: "Starting",
  error: "Needs attention",
};

/** The word for a chat's status from the chat list; null when it has none. */
export function chatStatusWord(status: string | null | undefined): string | null {
  return (status && WORDS[status]) || null;
}

/** "<word> · last known", "Saved" for a closed chat, or "Status unknown". */
export function lastKnownStatusLine(status: string | null | undefined): string {
  if (status === "closed") return "Saved";
  const word = chatStatusWord(status);
  return word ? `${word} · last known` : "Status unknown";
}
