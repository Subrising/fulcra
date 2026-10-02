// CONTRACTS v1.6 §3.5 rule 4: what a chat or terminal channel may show. Plain text, written for the owner. Decisions
// show the title, situation, options with their examples and the recommendation; held messages show only that one
// is waiting (their bodies are for the app, never a chat); answered items show who answered, where and when.
// One renderer for every adapter (Discord/OpenClaw, the `fulcra inbox` CLI, direct sessions) and for the tests.
export const VIA_NAME = Object.freeze({
  "app-mac": "Mac",
  "app-ios": "iPhone",
  "app-android": "Android",
  "app-windows": "Windows",
  "app-linux": "Linux",
  "app-web": "the web app",
  "discord-openclaw": "Discord",
  session: "a session",
  cli: "the command line",
});
const hhmm = (iso) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
// CONTRACTS v1.8 §3.6 rule 5 (R2-3, R2-7): every place that shows an answer says whether the owner's paired device
// proved it. One wording, used by the controller, the chat channels and the app.
export const proven = (choice) =>
  Boolean(choice && choice.by === "human" && choice.proven === true);
export function answerSummary(choice, optionTitle) {
  const option = optionTitle ?? "a written answer";
  return proven(choice)
    ? `You decided on ${VIA_NAME[choice.via] ?? choice.via} at ${hhmm(choice.at)}: ${option}`
    : `Answered by the operator at ${hhmm(choice.at)}, not confirmed on your device: ${option}`;
}
// The refusal a second answer gets.
export function alreadyAnswered(choice) {
  return proven(choice)
    ? `Already answered on ${VIA_NAME[choice.via] ?? choice.via} at ${hhmm(choice.at)}`
    : `Already answered by the operator at ${hhmm(choice.at)}, not confirmed on your device`;
}
export function answeredLine(packet) {
  const c = packet.choice;
  return c ? answerSummary(c, packet.options.find((o) => o.id === c.optionId)?.title) : null;
}
export function closedLine(packet) {
  if (packet.state === "chosen") return answeredLine(packet);
  if (packet.state === "withdrawn") return "Withdrawn by the project that asked.";
  if (packet.state === "superseded") return "Replaced by a newer question.";
  if (packet.state === "expired") return "Expired without an answer.";
  return null;
}
// One inbox item as a numbered chat line.
export function itemLine(n, item) {
  const badge = item.urgency === "now" ? "Now" : item.urgency === "today" ? "Today" : "FYI";
  return `${n}. [${badge}] ${item.title}`;
}
// A decision, in full, for chat. Never includes ids, digests or evidence refs.
export function decisionText(packet, n = null) {
  const lines = [`${n ? `${n}. ` : ""}${packet.title}`, packet.situation];
  const closed = closedLine(packet);
  if (closed) return [...lines, closed].join("\n");
  const rec = packet.options.find((o) => o.id === packet.recommendation?.optionId);
  if (rec) lines.push(`Recommended: ${rec.title}. ${packet.recommendation.why}`);
  packet.options.forEach((o, i) =>
    lines.push(
      `${i + 1}) ${o.title}${o.destructive ? " (hard to undo)" : ""}: ${o.summary}${o.example ? ` ${o.example}` : ""}`,
    ),
  );
  if (!packet.options.length) lines.push("Reply with your answer in words.");
  if (packet.action.type !== "none")
    lines.push("This one starts work, so confirm it on your paired device in the Fulcra app.");
  return lines.join("\n");
}
// A held message, for chat: that it is waiting, never what it says.
export function heldText(item, n = null) {
  return `${n ? `${n}. ` : ""}${item.title}\nRead it in the Fulcra app. Held messages are only shown there.`;
}
