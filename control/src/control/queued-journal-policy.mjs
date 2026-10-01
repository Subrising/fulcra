import { createHash } from "node:crypto";
import { readNativeRateSettings } from "./intercom-rates.mjs";
import { NativeQueuedMessageReceiptSchema } from "@getpaseo/protocol/native-intercom";
import { canonicalJson } from "@getpaseo/protocol/trusted-input";
const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const refuse = () => {
  throw Error("Orca native queued authority changed");
};
export const queuedSessionBinding = (row) =>
  row &&
  Object.fromEntries(
    [
      "id",
      "task",
      "cwd",
      "mode",
      "generation",
      "boot",
      "grantedAt",
      "authority",
      "expected",
      "expectedAt",
    ].map((key) => [key, row[key] ?? null]),
  );
export function queuedRoleSource(db, from, target, messageId) {
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const session = get("SELECT * FROM sessions WHERE id=?", from);
  const issued = get("SELECT generation,token FROM role_credentials WHERE session=?", from);
  // Bind the specific private issuance, not only delegation generation. Never expose its token/hash.
  const credential = credentialIssuance(issued);
  const seat = get(
    "SELECT role,seat,session,sessionGeneration,revision,state,task,projectId FROM role_bindings WHERE role='project-orchestrator' AND session=?",
    from,
  );
  const ownership = get(
    `SELECT o.* FROM session_ownership o JOIN deliveries d ON d.id=o.request
    WHERE d.kind='create' AND d.state='delivered' AND json_valid(d.result) AND json_extract(d.result,'$.id')=?`,
    target,
  );
  const recipient = get("SELECT task FROM sessions WHERE id=?", target);
  const followup = get("SELECT * FROM role_session_followups WHERE messageId=?", messageId);
  if (
    !session ||
    session.mode !== "delegated" ||
    credential?.generation !== session.generation ||
    seat?.state !== "assigned" ||
    seat.sessionGeneration !== session.generation ||
    ownership?.declaredBy !== "project-orchestrator" ||
    ownership.parentSession !== from ||
    ownership.seat !== seat.seat ||
    ownership.projectId !== seat.projectId ||
    ownership.task !== recipient?.task ||
    seat.task !== session.task ||
    ownership.seatRevision !== seat.revision ||
    followup?.fromSession !== from ||
    followup.session !== target
  )
    refuse();
  return {
    kind: "role-followup",
    session: queuedSessionBinding(session),
    credential,
    seat,
    ownership,
    followup,
  };
}
/** No cloned idle agent and no pinned ordinary-policy mutation. Host-owned journal purpose only. */
export function queuedJournalPolicy(observations, { rateSettingsFile = () => undefined } = {}) {
  const boot = observations.boot;
  const live = (row) => {
    const seq = row && observations.require(row.id);
    if (
      !row ||
      row.mode !== "delegated" ||
      row.boot !== boot ||
      seq.boot !== boot ||
      row.grantedAt !== seq.humanAt + 1
    )
      refuse();
    return seq;
  };
  const followupRate = (db, source, id) => {
    const now = Date.now();
    const clock = db.prepare("SELECT watermark FROM intercom_rate_clock WHERE id=1").get();
    const entry = db
      .prepare("SELECT * FROM intercom_rate_operations WHERE id=?")
      .get("followup:" + id);
    if (
      !Number.isSafeInteger(clock?.watermark) ||
      now < clock.watermark ||
      entry?.kind !== "followup" ||
      entry.scope !== source.followup.session ||
      entry.at <= now - 3600000 ||
      entry.at > now
    )
      refuse();
    const cached = db
      .prepare("SELECT settings FROM intercom_rate_native_settings WHERE id=1")
      .get()?.settings;
    const local = db
      .prepare("SELECT max FROM intercom_rate_settings WHERE kind='followup'")
      .get()?.max;
    const file = rateSettingsFile();
    const native = file
      ? readNativeRateSettings(file).followup
      : cached && JSON.parse(cached).followup;
    const maximum = Math.min(64, local ?? native ?? 32, native ?? Infinity);
    const count = db
      .prepare(
        "SELECT count(*) n FROM intercom_rate_operations WHERE kind='followup' AND scope=? AND at>? AND at<=?",
      )
      .get(source.followup.session, now - 3600000, now).n;
    if (!Number.isSafeInteger(maximum) || maximum <= 0 || count > maximum) refuse();
  };
  const sourceCheck = (db, binding, id) => {
    if (binding.source.kind === "operator") return;
    if (binding.source.kind !== "role-followup") refuse();
    const source = queuedRoleSource(db, binding.source.session.id, binding.target.id, id);
    live(source.session);
    const nativeIdentity = observations.nativeIdentity?.(source.session.id);
    if (!nativeIdentity || !same(nativeIdentity, binding.source.runtime)) refuse();
    const { runtime: _runtime, ...originalSource } = binding.source;
    if (!same(source, originalSource)) refuse();
    followupRate(db, source, id);
  };
  const admit = (db, agent, prompt, id, phase) => {
    const row = db.prepare("SELECT * FROM deliveries WHERE id=?").get(id);
    const session = db.prepare("SELECT * FROM sessions WHERE id=?").get(agent.id);
    if (
      !row ||
      row.kind !== "send" ||
      row.session !== agent.id ||
      !["intent", "queued", "dispatching"].includes(row.state)
    )
      refuse();
    const body = JSON.parse(row.body),
      intent = JSON.parse(row.result),
      binding = intent.nativeQueue;
    live(session);
    requireQueuedBinding(agent, session, body, intent, binding, prompt, id);
    // The phase comes from the native manager, never an input field. Effect admission still requires settlement.
    if (phase !== "enqueue" && (agent.activeTurnId || agent.activeForegroundTurnId)) refuse();
    sourceCheck(db, binding, id);
    return true;
  };
  const observe = (db, agent, operation, raw) => {
    const receipt = NativeQueuedMessageReceiptSchema.parse(raw);
    const id = operation.messageId?.slice("orca-control:".length);
    const row = id && db.prepare("SELECT * FROM deliveries WHERE id=?").get(id);
    if (
      !row ||
      row.kind !== "send" ||
      row.session !== agent.id ||
      receipt.messageId !== operation.messageId
    )
      refuse();
    const intent = JSON.parse(row.result),
      binding = intent.nativeQueue;
    if (
      !binding ||
      operation.agentId !== agent.id ||
      operation.kind !== "prompt" ||
      operation.attemptId !== intent.nativeAttemptId ||
      operation.payloadDigest !== binding.payloadDigest
    )
      refuse();
    const old = intent.nativeReceipt;
    if (old && !["queued", "dispatching"].includes(old.state)) return; // Permanent native terminal fact; never downgrade.
    if (receipt.state === "delivered" && !receipt.providerTurnId) refuse();
    db.prepare(
      "UPDATE deliveries SET state=?,result=json_set(result,'$.nativeReceipt',json(?)) WHERE id=?",
    ).run(receipt.state, JSON.stringify(receipt), id);
    updatePromptIdentity(db, observations, boot, agent, binding, receipt, id);
  };
  return { admit, observe };
}

function requireQueuedBinding(agent, session, body, intent, binding, prompt, id) {
  if (
    !binding ||
    binding.version !== 1 ||
    !same(queuedSessionBinding(session), binding.target) ||
    body.messageId !== id ||
    body.sessionId !== agent.id ||
    body.text !== prompt ||
    intent.generation !== session.generation ||
    agent.archivedAt ||
    agent.provider !== "codex" ||
    agent.runtime.status !== "known" ||
    agent.runtime.instanceId !== binding.runtime.instanceId ||
    agent.runtime.nativeSessionId !== binding.runtime.nativeSessionId ||
    agent.runtime.model !== binding.runtime.model ||
    agent.runtime.serviceTier !== binding.runtime.serviceTier ||
    agent.runtime.lastUserMessageAt !== intent.expectedLastUserAt ||
    (agent.pendingPermissions?.size ?? 0) > 0
  )
    refuse();
}

function updatePromptIdentity(db, observations, boot, agent, binding, receipt, id) {
  if (receipt.state === "delivered") {
    const current = db.prepare("SELECT * FROM sessions WHERE id=?").get(agent.id);
    const seq = observations.require(agent.id);
    if (
      current?.mode === "delegated" &&
      same(queuedSessionBinding(current), binding.target) &&
      seq.boot === boot &&
      current.grantedAt === seq.humanAt + 1 &&
      agent.runtime.instanceId === binding.runtime.instanceId &&
      agent.runtime.nativeSessionId === binding.runtime.nativeSessionId
    )
      db.prepare("UPDATE sessions SET expected=?,expectedAt=? WHERE id=? AND generation=?").run(
        id,
        agent.runtime.lastUserMessageAt,
        agent.id,
        current.generation,
      );
  }
}

function credentialIssuance(issued) {
  return (
    issued && {
      generation: issued.generation,
      issuance: createHash("sha256").update(issued.token).digest("hex"),
    }
  );
}
