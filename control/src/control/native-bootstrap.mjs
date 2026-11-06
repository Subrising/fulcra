// A single owned first-turn exception, anchored in a delivered controller creation.
// Neither an untouched runtime nor caller-supplied labels constitute this authority.
const refuse = () => {
  throw Error("Orca native admission refused: Unbound first native delivery");
};
// FULCRA(FU-657): since upstream v0.15 (#8393) a new Codex thread has no native id until its first turn, as a
// new Claude session. Only these two providers; every other rule below and in admitBootstrap is unchanged.
const BOOTSTRAP_PROVIDERS = new Set(["claude", "codex"]);
export function bootstrapCandidate(agent) {
  return (
    BOOTSTRAP_PROVIDERS.has(agent.provider) &&
    agent.runtime.status === "known" &&
    agent.runtime.nativeSessionId === null &&
    agent.runtime.lastUserMessageAt === null
  );
}
export function admitBootstrap(db, agent, operation, delivery, boot) {
  if (!bootstrapCandidate(agent)) refuse();
  const runtime = agent.runtime;
  const session = db.prepare("SELECT * FROM sessions WHERE id=?").get(agent.id);
  const creates = db
    .prepare(
      "SELECT id,body,result FROM deliveries WHERE kind='create' AND state='delivered' AND json_extract(result,'$.id')=?",
    )
    .all(agent.id);
  if (creates.length !== 1 || !session || session.boot !== boot) refuse();
  const creation = creates[0],
    body = JSON.parse(creation.body),
    result = JSON.parse(creation.result);
  if (
    body.provider !== agent.provider ||
    body.taskId !== session.task ||
    result.cwd !== session.cwd ||
    result.cwd !== agent.cwd ||
    result.runtimeInstanceId !== runtime.instanceId ||
    !runtime.instanceId
  )
    refuse();
  // Even a refused/abandoned prior owned send burns first-delivery eligibility.
  if (
    db
      .prepare("SELECT id FROM deliveries WHERE session=? AND kind='send' AND id!=?")
      .get(agent.id, delivery.id)
  )
    refuse();
  const prior = db.prepare("SELECT * FROM native_bootstrap WHERE session=?").get(agent.id);
  if (prior) {
    if (
      prior.creation !== creation.id ||
      prior.instanceId !== runtime.instanceId ||
      prior.delivery !== delivery.id ||
      prior.attempt !== operation.attemptId ||
      prior.operation !== operation.operationId ||
      prior.boot !== boot ||
      prior.nativeId !== null
    )
      refuse();
  } else {
    db.prepare("INSERT INTO native_bootstrap VALUES (?,?,?,?,?,?,?,NULL)").run(
      agent.id,
      creation.id,
      runtime.instanceId,
      delivery.id,
      operation.attemptId,
      operation.operationId,
      boot,
    );
  }
}
// FULCRA(FU-657): a Codex app-server knows the new thread id when it prepares the first turn, but the runtime facts
// show no id until that turn starts (upstream #8393). Only the exact admitted first delivery, attempt and operation
// of a Codex bootstrap, with no id bound yet and no runtime id, may carry a prepared thread id. The first prepared
// id is saved; a different one later refuses, and the binding may complete only with that saved id.
const PREPARED_TABLE =
  "CREATE TABLE IF NOT EXISTS native_bootstrap_prepared(session TEXT PRIMARY KEY,nativeId TEXT NOT NULL)";
function preparedNativeId(db, session) {
  const table = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='native_bootstrap_prepared'")
    .get();
  return table
    ? (db.prepare("SELECT nativeId FROM native_bootstrap_prepared WHERE session=?").get(session)
        ?.nativeId ?? null)
    : null;
}
export function bootstrapTurnIdentity(db, agent, operation, deliveryId, turnNativeId) {
  if (agent.provider !== "codex" || !bootstrapCandidate(agent) || !turnNativeId) return false;
  const binding = db.prepare("SELECT * FROM native_bootstrap WHERE session=?").get(agent.id);
  if (
    !binding ||
    binding.nativeId !== null ||
    binding.delivery !== deliveryId ||
    binding.attempt !== operation.attemptId ||
    binding.operation !== operation.operationId ||
    binding.instanceId !== agent.runtime.instanceId
  )
    return false;
  const prepared = preparedNativeId(db, agent.id);
  if (prepared !== null) return prepared === turnNativeId;
  db.exec(PREPARED_TABLE);
  db.prepare("INSERT INTO native_bootstrap_prepared VALUES (?,?)").run(agent.id, turnNativeId);
  return true;
}
export function requireBootstrapBinding(db, agent) {
  const binding = db.prepare("SELECT * FROM native_bootstrap WHERE session=?").get(agent.id);
  if (binding && (!binding.nativeId || binding.nativeId !== agent.runtime.nativeSessionId))
    refuse();
}
// Only a controller observation of the acknowledged first message may complete the binding.
// An async SDK init may lag the acknowledgement; the next controller send reconciles again.
export function reconcileBootstrap(db, observed) {
  if (!observed?.id) return; // An adapter without a target identity cannot complete a binding.
  const binding = db.prepare("SELECT * FROM native_bootstrap WHERE session=?").get(observed.id);
  if (!binding || binding.nativeId || !observed.nativeId) return;
  // FULCRA(FU-657): a Codex first send that carried a prepared thread id binds only that id.
  const prepared = preparedNativeId(db, observed.id);
  if (prepared !== null && prepared !== observed.nativeId) return;
  const delivery = db
    .prepare("SELECT state FROM deliveries WHERE id=? AND session=? AND kind='send'")
    .get(binding.delivery, observed.id);
  if (
    delivery?.state !== "delivered" ||
    observed.runtimeInstanceId !== binding.instanceId ||
    observed.boot !== binding.boot ||
    observed.lastPromptId !== binding.delivery ||
    !observed.lastUserAt
  )
    return;
  db.prepare("UPDATE native_bootstrap SET nativeId=? WHERE session=? AND nativeId IS NULL").run(
    observed.nativeId,
    observed.id,
  );
}
// A clean restart during the first turn ends the runtime before that observation can happen, and the new boot has
// a new runtime instance. The automatic restart proof (automatic-restart.mjs) has already shown the native id is
// the one the boot recorded and that this exact first delivery was acknowledged in the previous boot.
export function bindBootstrapAfterRestart(db, { session, delivery, previousBoot, nativeId }) {
  if (!nativeId) return;
  const prepared = preparedNativeId(db, session);
  if (prepared !== null && prepared !== nativeId) return;
  db.prepare(
    "UPDATE native_bootstrap SET nativeId=? WHERE session=? AND nativeId IS NULL AND delivery=? AND boot=?",
  ).run(nativeId, session, delivery, previousBoot);
}
