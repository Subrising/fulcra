// The daemon's admission check for a controller cleanup (trusted-contribution.mjs). Kept apart from
// worktree-lifecycle-runtime.mjs because that module reaches authority.mjs, which reads config.json on
// import; the daemon must load this file on a Command Centre home that has no config yet.
import { ownedBySeat } from "./seat-sweep.mjs";

export function admitOwnedCleanup(db, agent, operation, { now, pluginId, digest }) {
  const intent = db.prepare("SELECT * FROM cc_session_cleanup WHERE id=?").get(operation.attemptId);
  const row = db.prepare("SELECT * FROM sessions WHERE id=?").get(agent.id);
  const kind = intent?.archive ? "archive" : "close";
  const has = (table) =>
    !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (
    !intent ||
    intent.state !== "intent" ||
    intent.session !== agent.id ||
    intent.at < now - 60000 ||
    intent.at > now ||
    operation.pluginId !== pluginId ||
    operation.kind !== kind ||
    operation.agentId !== agent.id ||
    operation.messageId !== "orca-cleanup:" + intent.id ||
    operation.payloadDigest !== digest ||
    !row ||
    row.mode !== "delegated" ||
    row.generation !== intent.generation ||
    !ownedBySeat(db, agent.id) ||
    row.boot !== intent.boot ||
    row.grantedAt <= intent.humanAt ||
    agent.runtime?.status !== "known" ||
    agent.runtime.instanceId !== intent.instanceId ||
    agent.runtime.nativeSessionId !== intent.nativeId ||
    agent.inputSequence?.boot !== intent.boot ||
    agent.inputSequence?.humanAt !== intent.humanAt ||
    agent.lifecycle !== "idle" ||
    agent.archivedAt ||
    agent.activeTurnId ||
    agent.activeForegroundTurnId ||
    agent.permissions?.status !== "known" ||
    agent.permissions.requests.length ||
    agent.permissions.inFlightRequestIds.length ||
    (has("role_bindings") &&
      db
        .prepare("SELECT 1 FROM role_bindings WHERE session=? AND state='assigned'")
        .get(agent.id)) ||
    (has("manager_grants") &&
      db
        .prepare("SELECT 1 FROM manager_grants WHERE supervisor=? AND generation=?")
        .get(agent.id, row.generation))
  )
    throw Error("Orca native admission refused: Owned cleanup intent or native lifetime changed");
}
