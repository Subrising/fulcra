import { permissionMode, permissionToolId } from "../control/automatic-permission.mjs";
import { exact, canonical } from "./protocol.mjs";
import { atomic } from "./journal.mjs";
import { uuid } from "../control/authority.mjs";
import { delegationFence } from "../control/native-fence.mjs";
import {
  canonical as policyCanonical,
  digest,
  ownedRoot,
  evaluatePermission,
  verifyPermissionOutput,
} from "../control/permission-policy.mjs";
import { permissionProjection } from "../control/permission-projection.mjs";
import {
  bookPermissionReceipt,
  prepareBookPermission,
  cancelBookPermission,
  validateBookPermissionContext,
} from "./permissions.mjs";
const fields =
  "binding,expectedLastUserAt,generation,grantEpoch,intentId,nativeId,origin,requestDigest,requestId,sessionId";
const hash = (value) => digest(policyCanonical(value));
export const requestHash = (request) => hash(permissionProjection(request));
function identity(s, p, proof) {
  return {
    sessionId: s.id,
    intentId: p.intentId,
    agentId: s.agent,
    generation: p.generation,
    nativeId: p.nativeId,
    boot: p.binding.boot,
    origin: p.origin,
    requestDigest: requestHash(p.request),
    proofDigest: hash(proof),
  };
}
function payload(wire, observed) {
  if (
    ![fields, fields.replace("requestDigest", "proofDigest,requestDigest")].some((keys) =>
      exact(wire, keys),
    ) ||
    ![wire.sessionId, wire.intentId, wire.nativeId, wire.origin, wire.grantEpoch].every(uuid) ||
    !Number.isSafeInteger(wire.generation) ||
    wire.generation < 2 ||
    !exact(wire.binding, "boot,boundary,lastPromptId,nativeId") ||
    typeof wire.expectedLastUserAt !== "string" ||
    !Number.isFinite(Date.parse(wire.expectedLastUserAt)) ||
    typeof wire.requestId !== "string" ||
    !wire.requestId ||
    wire.requestId.length > 512 ||
    !/^[a-f0-9]{64}$/.test(wire.requestDigest)
  )
    throw Error("Invalid Book permission RPC");
  const requests = observed.pendingPermissions?.filter((r) => r.id === wire.requestId);
  if (requests?.length !== 1 || requestHash(requests[0]) !== wire.requestDigest)
    throw Error("Book pending permission changed");
  const { requestId, requestDigest, proofDigest, ...p } = wire;
  return { ...p, request: requests[0], cursor: observed.timelineCursor };
}
export async function bookPermissionRPC(receiver, action, s, wire) {
  const { db, native } = receiver;
  if (action === "permission-cancel") {
    if (!exact(wire, "intentId,sessionId")) throw Error("Invalid permission cancellation");
    const row = cancelBookPermission(db, s.id, wire.intentId);
    return { sessionId: s.id, intentId: row.id, state: row.state };
  }
  if (action === "permission-root") {
    if (!exact(wire, "generation,sessionId")) throw Error("Invalid permission root");
    const observed = await receiver.observed(s),
      fresh = receiver.row(s.id),
      binding = JSON.parse(fresh.binding ?? "null");
    if (
      fresh.mode !== "delegated" ||
      fresh.generation !== wire.generation ||
      !binding ||
      binding.boot !== observed.boot ||
      binding.boundary !== delegationFence(observed) ||
      observed.archivedAt ||
      !["claude", "codex"].includes(observed.provider)
    )
      throw Error("Book routine root authority changed");
    return {
      sessionId: s.id,
      agentId: s.agent,
      generation: fresh.generation,
      cwd: ownedRoot(s.cwd, native.tasks),
    };
  }
  if (action === "permission-result") {
    if (!exact(wire, "intentId,sessionId") || !uuid(wire.intentId))
      throw Error("Invalid permission result");
    const row = bookPermissionReceipt(db, s.id, wire.intentId);
    if (row.state !== "consumed") throw Error("Book permission has not been admitted");
    const p = JSON.parse(row.input),
      proof = JSON.parse(row.proof),
      before = await receiver.observed(s);
    validateBookPermissionContext(db, p, before);
    const key = "permission:" + row.id,
      saved = db.prepare("SELECT value FROM receiver_results WHERE id=?").get(key)?.value;
    const cursor = saved ? JSON.parse(saved).cursor : p.cursor;
    if (
      !cursor ||
      cursor.epoch !== p.cursor?.epoch ||
      !Number.isSafeInteger(cursor.seq) ||
      cursor.seq < p.cursor.seq ||
      cursor.seq > before.timelineCursor.seq
    )
      throw Error("Book permission result cursor changed");
    const tool = await native.permissionResult(s.agent, permissionToolId(p.request), cursor),
      after = await receiver.observed(s);
    validateBookPermissionContext(db, p, after);
    const output =
      tool.state === "completed"
        ? proof.kind === "automatic-tool"
          ? { toolCompleted: true }
          : verifyPermissionOutput(proof)
        : null;
    atomic(db, () => {
      validateBookPermissionContext(db, p, after);
      if (db.prepare("SELECT value FROM receiver_results WHERE id=?").get(key)?.value !== saved)
        throw Error("Permission result advanced concurrently");
      db.prepare("INSERT OR REPLACE INTO receiver_results VALUES (?,?)").run(
        key,
        canonical({ cursor: tool.cursor ?? cursor }),
      );
    });
    return { identity: identity(receiver.row(s.id), p, proof), tool, output };
  }
  if (!["permission-proof", "permission-respond"].includes(action))
    throw Error("Unknown permission action");
  const old =
    action === "permission-respond" &&
    db.prepare("SELECT * FROM receiver_permissions WHERE id=?").get(wire.intentId);
  if (old) {
    if (old.session !== s.id) throw Error("Book permission identity conflict");
    if (old.state === "cancelled") return { sessionId: s.id, intentId: old.id, state: "cancelled" };
    const p = JSON.parse(old.input),
      { request, cursor, ...context } = p;
    if (
      canonical(wire) !==
      canonical({
        ...context,
        requestId: request.id,
        requestDigest: requestHash(request),
        proofDigest: hash(JSON.parse(old.proof)),
      })
    )
      throw Error("Book permission retry identity conflict");
    return { identity: identity(s, p, JSON.parse(old.proof)), state: old.state }; // receipt only; never re-invoke.
  }
  const observed = await receiver.observed(s),
    p = payload(wire, observed);
  validateBookPermissionContext(db, p, observed);
  let proof;
  try {
    proof = evaluatePermission(p.request, s.cwd, native.tasks, permissionMode(observed));
  } catch (e) {
    if (action === "permission-proof") return { policyError: e.message };
    throw e;
  }
  if (action === "permission-proof") return { identity: identity(s, p, proof), proof };
  if (hash(proof) !== wire.proofDigest)
    throw Error("Book file proof changed since coordinator inspection");
  const row = prepareBookPermission(db, p, observed, native.tasks);
  if (!row.dispatch) return { identity: identity(s, p, proof), state: row.state };
  const receipt = await native.permission(s.agent, p.intentId);
  if (
    receipt?.agentId !== s.agent ||
    receipt.requestId !== "orca-permission:" + p.intentId ||
    canonical(receipt.resolution) !== '{"behavior":"allow"}'
  )
    throw Error("Book permission acknowledgement uncorrelated");
  if (bookPermissionReceipt(db, s.id, p.intentId).state !== "consumed")
    throw Error("Book native permission guard did not consume ticket");
  return { identity: identity(s, p, proof), state: "acknowledged", receipt };
}
