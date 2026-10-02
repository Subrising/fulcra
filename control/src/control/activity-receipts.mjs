import { uuid } from "./authority.mjs";
export function activityReceipts(store, a) {
  if (
    !a ||
    Object.keys(a).sort().join() !== "sessionId,taskId" ||
    !uuid(a.sessionId) ||
    !uuid(a.taskId) ||
    store.get(a.sessionId)?.task !== a.taskId
  )
    throw Error("Invalid enrolled activity receipt request");
  const text = (v) => (typeof v === "string" ? v.slice(0, 512) : "unknown");
  return store.db
    .prepare(
      "SELECT id,kind,state,result FROM deliveries WHERE session=? ORDER BY rowid DESC LIMIT 20",
    )
    .all(a.sessionId)
    .map((d) => {
      let r = {};
      try {
        if (typeof d.result === "string" && d.result.length <= 65536)
          r = JSON.parse(d.result) ?? {};
      } catch {}
      const h = r.outputContext?.outputEvidenceHash ?? r.outputEvidenceHash;
      return {
        id: d.id,
        kind: text(d.kind),
        state: text(d.state),
        notification: typeof r.notification?.state === "string" ? text(r.notification.state) : null,
        evidenceHash: typeof h === "string" && /^[a-f0-9]{64}$/.test(h) ? h : null,
      };
    });
}
