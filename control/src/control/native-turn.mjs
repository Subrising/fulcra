import { DatabaseSync } from "node:sqlite";
import { admit, guard } from "./admission-guard.mjs";
import { quotaDecision } from "./quota-wait.mjs";
import { uuid } from "./authority.mjs";
const waiting = new WeakMap();
const refused = (reason) => Error("Orca native admission refused: " + reason);
export function quotaFailure(error, options) {
  if (["unavailable", "read_failed", "invalid_reply"].includes(error.code) && waiting.has(options))
    return waiting.get(options)(error.code);
  return refused(error.code);
}
// Only a daemon-written, attempt-bound receipt can permit a controller retry.
// An error message alone (which a provider may influence) is never that evidence.
export function nativeTurnOptions({
  journalFile,
  agent,
  getAgent,
  prompt,
  options,
  busy,
  symbol,
  now = Date.now,
}) {
  if (!options?.clientMessageId?.startsWith("orca-control:")) {
    guard(agent, prompt, options, busy());
    return options;
  }
  const messageId = options.clientMessageId.slice(13),
    nativeSession = agent.session;
  const read = (write, action) => {
    let db;
    try {
      const current = getAgent(agent.id);
      if (!nativeSession || current?.session !== nativeSession || current.pendingReplacement)
        throw refused("Native agent was replaced");
      db = new DatabaseSync(journalFile, { readOnly: !write });
      db.exec("PRAGMA busy_timeout=0; " + (write ? "BEGIN IMMEDIATE" : "BEGIN"));
      admit(db, current, prompt, messageId, busy() || Boolean(current.activeForegroundTurnId));
      const row = db.prepare("SELECT result FROM deliveries WHERE id=?").get(messageId);
      if (typeof row?.result !== "string") throw refused("Native intent missing");
      const result = JSON.parse(row.result);
      if (result.nativeQuotaWait?.attempt === result.nativeAttemptId && result.nativeAttemptId)
        throw refused("Native attempt already refused before submission");
      const value = action(db, result);
      if (write) db.exec("COMMIT");
      return value;
    } catch (error) {
      if (error.message.startsWith("Orca native admission refused")) throw error;
      throw refused("Journal or source unavailable");
    } finally {
      db?.close();
    }
  };
  const initial = read(false, (_db, result) => result);
  if (!initial.wait) return options;
  if (agent.provider !== "codex" || typeof symbol !== "symbol" || !uuid(initial.nativeAttemptId))
    throw refused("Queued native quota hook unavailable");
  const exact = (result) => {
    if (!result.wait || result.nativeAttemptId !== initial.nativeAttemptId)
      throw refused("Queued attempt changed");
  };
  const markWaiting = (reason) => {
    read(true, (db, result) => {
      exact(result);
      db.prepare(
        "UPDATE deliveries SET result=json_set(result,'$.nativeQuotaWait',json(?)) WHERE id=? AND state='intent'",
      ).run(
        JSON.stringify({
          attempt: initial.nativeAttemptId,
          boot: result.wait.binding.boot,
          nativeDispatched: false,
          reason,
          at: now(),
        }),
        messageId,
      );
    });
    return Error("Orca native quota waiting: " + reason);
  };
  const fenced = {
    ...options,
    [symbol]: (quota) => {
      const decision = read(false, (_db, result) => {
        exact(result);
        return quotaDecision(quota, result.wait.binding.quota, now());
      });
      if (decision.state === "changed") throw refused(decision.reason);
      if (decision.state !== "ready") throw markWaiting(decision.reason);
      return true;
    },
  };
  waiting.set(fenced, markWaiting);
  return fenced;
}
