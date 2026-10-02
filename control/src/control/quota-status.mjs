// Read-only projection. Never expose saved prompts, bindings, grants or arbitrary errors.
const stamp = (v) =>
  Number.isSafeInteger(v) && v >= 0 && v <= 8640000000000000 ? new Date(v).toISOString() : null;
export function quotaStatus(store, now = Date.now()) {
  const rows = store.db
    .prepare(
      "SELECT d.id,d.session,s.task,s.mode,s.generation,d.result FROM deliveries d JOIN sessions s ON s.id=d.session WHERE d.state='queued' ORDER BY d.rowid LIMIT 65",
    )
    .all();
  const entries = rows.slice(0, 64).map((row) => {
    let wait;
    try {
      if (typeof row.result === "string" && row.result.length <= 65536)
        wait = JSON.parse(row.result).wait;
    } catch {
      /* Malformed remains visible as unknown. */
    }
    const current =
      row.mode === "delegated" &&
      wait?.binding?.generation === row.generation &&
      wait.binding.task === row.task;
    const waiting = current && wait?.state === "waiting";
    const reason =
      waiting && wait.reason === "Provider denies ordinary usage"
        ? "provider-limit"
        : waiting && wait.reason === "Provider denies selected model usage"
          ? "model-limit"
          : "verification";
    return {
      messageId: row.id,
      sessionId: row.session,
      taskId: row.task,
      state: !current ? "attention" : waiting ? "waiting" : "checking",
      reason,
      since: stamp(wait?.since),
      checkedAt: stamp(wait?.checkedAt),
      nextCheckAt: current ? stamp(wait?.nextCheckAt) : null,
    };
  });
  return {
    version: 1,
    observedAt: new Date(now).toISOString(),
    partial: rows.length > 64,
    entries,
  };
}
