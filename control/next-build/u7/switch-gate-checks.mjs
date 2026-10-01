export function exactAccountAudit(rows, { deviceId, startedAt, expected }) {
  const current = rows.filter(
    (row) =>
      row.device === deviceId &&
      Number.isFinite(Date.parse(row.at)) &&
      Date.parse(row.at) >= startedAt,
  );
  return (
    current.length === expected.length &&
    expected.every(
      (want) =>
        current.filter((row) => row.action === want.action && row.label === want.label).length ===
        1,
    )
  );
}

export function claudeContinuityPassed(facts, { want, marker, session }) {
  return [
    facts.reply === "ok",
    facts.sameChat,
    facts.newChats === 0,
    facts.resumedSameSession,
    facts.transcriptFound,
    facts.relaunchAccount === want,
    facts.relaunchToken === want,
    facts.recall === marker,
    facts.recallSession === session,
    facts.recallAccount === want,
    facts.recallToken === want,
    facts.bound === want,
    facts.usage.label === want,
    facts.wireAccount === want,
    facts.sameHistory,
  ].every(Boolean);
}

export function switchReplyLabel(reply) {
  if (reply?.error) return `error: ${reply.error}`;
  if (reply?.ok === true) return "ok";
  return `refused: ${String(reply?.message ?? "").slice(0, 160)}`;
}
