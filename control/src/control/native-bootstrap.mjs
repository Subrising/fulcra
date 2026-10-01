// A single owned first-turn exception, anchored in a delivered controller creation.
// Neither an untouched runtime nor caller-supplied labels constitute this authority.
const refuse = () => { throw Error('Orca native admission refused: Unbound first native delivery'); };
export function bootstrapCandidate(agent) {
  return agent.provider === 'claude' && agent.runtime.status === 'known'
    && agent.runtime.nativeSessionId === null && agent.runtime.lastUserMessageAt === null;
}
export function admitBootstrap(db, agent, operation, delivery, boot) {
  if (!bootstrapCandidate(agent)) refuse();
  const runtime = agent.runtime;
  const session = db.prepare('SELECT * FROM sessions WHERE id=?').get(agent.id);
  const creates = db.prepare("SELECT id,body,result FROM deliveries WHERE kind='create' AND state='delivered' AND json_extract(result,'$.id')=?").all(agent.id);
  if (creates.length !== 1 || !session || session.boot !== boot) refuse();
  const creation = creates[0], body = JSON.parse(creation.body), result = JSON.parse(creation.result);
  if (body.provider !== 'claude' || body.taskId !== session.task || result.cwd !== session.cwd
    || result.cwd !== agent.cwd || result.runtimeInstanceId !== runtime.instanceId || !runtime.instanceId) refuse();
  // Even a refused/abandoned prior owned send burns first-delivery eligibility.
  if (db.prepare("SELECT id FROM deliveries WHERE session=? AND kind='send' AND id!=?").get(agent.id, delivery.id)) refuse();
  const prior = db.prepare('SELECT * FROM native_bootstrap WHERE session=?').get(agent.id);
  if (prior) {
    if (prior.creation !== creation.id || prior.instanceId !== runtime.instanceId || prior.delivery !== delivery.id
      || prior.attempt !== operation.attemptId || prior.operation !== operation.operationId || prior.boot !== boot || prior.nativeId !== null) refuse();
  } else {
    db.prepare('INSERT INTO native_bootstrap VALUES (?,?,?,?,?,?,?,NULL)').run(agent.id, creation.id, runtime.instanceId, delivery.id, operation.attemptId, operation.operationId, boot);
  }
}
export function requireBootstrapBinding(db, agent) {
  const binding = db.prepare('SELECT * FROM native_bootstrap WHERE session=?').get(agent.id);
  if (binding && (!binding.nativeId || binding.nativeId !== agent.runtime.nativeSessionId)) refuse();
}
// Only a controller observation of the acknowledged first message may complete the binding.
// An async SDK init may lag the acknowledgement; the next controller send reconciles again.
export function reconcileBootstrap(db, observed) {
  if (!observed?.id) return; // An adapter without a target identity cannot complete a binding.
  const binding = db.prepare('SELECT * FROM native_bootstrap WHERE session=?').get(observed.id);
  if (!binding || binding.nativeId || !observed.nativeId) return;
  const delivery = db.prepare("SELECT state FROM deliveries WHERE id=? AND session=? AND kind='send'").get(binding.delivery, observed.id);
  if (delivery?.state !== 'delivered' || observed.runtimeInstanceId !== binding.instanceId
    || observed.boot !== binding.boot || observed.lastPromptId !== binding.delivery || !observed.lastUserAt) return;
  db.prepare('UPDATE native_bootstrap SET nativeId=? WHERE session=? AND nativeId IS NULL').run(observed.nativeId, observed.id);
}
