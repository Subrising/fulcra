import { permissionMode } from "../control/automatic-permission.mjs";
import { atomic, journal } from "./journal.mjs";
import { canonical, digest, exact, bookProvider } from "./protocol.mjs";
import { uuid } from "../control/authority.mjs";
import { delegationFence } from "../control/native-fence.mjs";
import { nativeIdentity } from "../control/native-identity.mjs";
import { permissionProjection } from "../control/permission-projection.mjs";
import { evaluatePermission } from "../control/permission-policy.mjs";

// The authenticated receiver calls this after Mini grant/pool admission.
// These single-use tickets grant no standing authority.
export function initializeBookPermissions(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS receiver_permissions(
    id TEXT PRIMARY KEY, identity TEXT UNIQUE NOT NULL, session TEXT NOT NULL,
    input TEXT NOT NULL, proof TEXT NOT NULL, state TEXT NOT NULL, created INTEGER NOT NULL);`);
}
export function bookPermissionReceipt(db, sessionId, id) {
  const row = db
    .prepare("SELECT * FROM receiver_permissions WHERE id=? AND session=?")
    .get(id, sessionId);
  if (!row) throw Error("Unknown Book permission ticket");
  return row;
}
function sessionFor(db, p) {
  const s = db.prepare("SELECT * FROM receiver_sessions WHERE id=?").get(p.sessionId);
  const origin = db
    .prepare("SELECT * FROM receiver_intents WHERE id=? AND session=?")
    .get(p.origin, p.sessionId);
  const last = db
    .prepare(
      "SELECT id FROM receiver_intents WHERE session=? AND consumed=1 ORDER BY rowid DESC LIMIT 1",
    )
    .get(p.sessionId);
  const sent = origin && JSON.parse(origin.body);
  if (
    !s ||
    s.phase !== "created" ||
    s.mode !== "delegated" ||
    s.generation !== p.generation ||
    !["claude", "codex"].includes(bookProvider(JSON.parse(s.creation))) ||
    !s.native ||
    s.native !== p.nativeId ||
    s.binding !== canonical(p.binding) ||
    !origin?.consumed ||
    !["admitted", "acknowledged", "uncertain"].includes(origin.state) ||
    last?.id !== p.origin ||
    sent.generation !== p.generation ||
    canonical(sent.binding) !== s.binding
  )
    throw Error("Changed Book permission delegation or origin");
  return s;
}
function live(s, p, observed) {
  if (
    observed.id !== s.agent ||
    observed.cwd !== s.cwd ||
    observed.provider !== bookProvider(JSON.parse(s.creation)) ||
    observed.owner !== "orca-book-task" ||
    observed.task !== s.task ||
    observed.route !== s.id ||
    observed.nativeIdentity?.conflict ||
    observed.nativeId !== p.nativeId ||
    observed.archivedAt ||
    observed.boot !== p.binding.boot ||
    delegationFence(observed) !== p.binding.boundary ||
    observed.lastUserAt !== p.expectedLastUserAt
  )
    throw Error("Changed Book permission native identity or human input");
}
function checkedRequest(requests, expected) {
  const matches = requests.filter((r) => r?.id === expected.id);
  if (
    matches.length !== 1 ||
    canonical(permissionProjection(matches[0])) !== canonical(permissionProjection(expected))
  )
    throw Error("Changed or ambiguous native permission request");
  return matches[0];
}
export function validateBookPermissionContext(db, p, observed) {
  const s = sessionFor(db, p);
  live(s, p, observed);
  if (observed.lastPromptId !== p.origin) throw Error("Book permission origin observation changed");
  return s;
}
export function inspectBookPermission(db, p, observed, base) {
  const s = validateBookPermissionContext(db, p, observed);
  if (observed.lastPromptId !== p.origin || !Array.isArray(observed.pendingPermissions))
    throw Error("Book permission origin observation changed");
  const request = checkedRequest(observed.pendingPermissions, p.request);
  return { s, request, proof: evaluatePermission(request, s.cwd, base, permissionMode(observed)) };
}
export function prepareBookPermission(db, p, observed, base, now = Date.now()) {
  if (
    (!exact(
      p,
      "binding,expectedLastUserAt,generation,grantEpoch,intentId,nativeId,origin,request,sessionId",
    ) &&
      !exact(
        p,
        "binding,cursor,expectedLastUserAt,generation,grantEpoch,intentId,nativeId,origin,request,sessionId",
      )) ||
    ![p.sessionId, p.intentId, p.nativeId, p.origin, p.grantEpoch].every(uuid) ||
    !Number.isSafeInteger(p.generation) ||
    p.generation < 2 ||
    !exact(p.binding, "boot,boundary,lastPromptId,nativeId") ||
    typeof p.expectedLastUserAt !== "string" ||
    !Number.isFinite(Date.parse(p.expectedLastUserAt)) ||
    typeof p.request?.id !== "string" ||
    !p.request.id ||
    p.request.id.length > 512 ||
    !Number.isSafeInteger(now) ||
    now < 0
  )
    throw Error("Invalid Book permission ticket");
  return atomic(db, () => {
    const input = canonical(p),
      old = db.prepare("SELECT * FROM receiver_permissions WHERE id=?").get(p.intentId);
    if (old) {
      if (old.input !== input) throw Error("Book permission ticket identity conflict");
      return { ...old, dispatch: false };
    }
    const { s, request, proof } = inspectBookPermission(db, p, observed, base);
    if (
      p.cursor &&
      (!exact(p.cursor, "epoch,seq") ||
        !p.cursor.epoch ||
        !Number.isSafeInteger(p.cursor.seq) ||
        canonical(p.cursor) !== canonical(observed.timelineCursor))
    )
      throw Error("Book permission cursor changed");
    // Derived from the live Book request, not the coordinator's grant/ticket ID.
    const identity = digest([s.agent, observed.nativeId, request.id]);
    if (db.prepare("SELECT id FROM receiver_permissions WHERE identity=?").get(identity))
      throw Error("Book native permission already ticketed");
    if (
      db
        .prepare("SELECT count(*) n FROM receiver_permissions WHERE identity NOT LIKE 'cancel:%'")
        .get().n >= 1000
    )
      throw Error("Book permission ticket capacity");
    db.prepare("INSERT INTO receiver_permissions VALUES (?,?,?,?,?,'prepared',?)").run(
      p.intentId,
      identity,
      s.id,
      input,
      canonical(proof),
      now,
    );
    return { ...bookPermissionReceipt(db, s.id, p.intentId), dispatch: true };
  });
}
export function cancelBookPermission(db, sessionId, id) {
  return atomic(db, () => {
    if (
      !uuid(id) ||
      !uuid(sessionId) ||
      !db.prepare("SELECT id FROM receiver_sessions WHERE id=? AND phase='created'").get(sessionId)
    )
      throw Error("Unknown Book permission session");
    const old = db.prepare("SELECT * FROM receiver_permissions WHERE id=?").get(id);
    if (old && old.session !== sessionId) throw Error("Unknown Book permission ticket");
    if (!old) {
      if (
        db
          .prepare("SELECT count(*) n FROM receiver_permissions WHERE identity LIKE 'cancel:%'")
          .get().n >= 1000 ||
        db
          .prepare(
            "SELECT count(*) n FROM receiver_permissions WHERE session=? AND identity LIKE 'cancel:%'",
          )
          .get(sessionId).n >= 32
      )
        throw Error("Book cancellation tombstone capacity; acknowledgement pending");
      db.prepare("INSERT INTO receiver_permissions VALUES (?,?,?,'{}','{}','cancelled',?)").run(
        id,
        "cancel:" + id,
        sessionId,
        Date.now(),
      );
    }
    db.prepare(
      "UPDATE receiver_permissions SET state='cancelled' WHERE id=? AND session=? AND state='prepared'",
    ).run(id, sessionId);
    return bookPermissionReceipt(db, sessionId, id); // consumed is not retroactively cancelled.
  });
}
export function admitBookPermission(db, agent, id, response, observed, base, now = Date.now()) {
  return atomic(db, () => {
    const row = db.prepare("SELECT * FROM receiver_permissions WHERE id=?").get(id);
    if (
      !row ||
      row.state !== "prepared" ||
      !Number.isSafeInteger(now) ||
      now < row.created ||
      now - row.created > 15000 ||
      canonical(response) !== '{"behavior":"allow"}'
    )
      throw Error("Unknown, expired, consumed or altered Book permission response");
    const p = JSON.parse(row.input),
      s = sessionFor(db, p),
      identity = nativeIdentity(agent);
    live(s, p, {
      ...observed,
      id: agent.id,
      cwd: agent.cwd,
      provider: agent.provider,
      owner: agent.labels?.owner,
      task: agent.labels?.task,
      route: agent.labels?.["orca.route"],
      nativeId: identity.nativeId,
      nativeIdentity: identity,
      archivedAt: agent.archivedAt,
      lastUserAt: agent.lastUserMessageAt?.toISOString() ?? null,
    });
    if (
      !(agent.pendingPermissions instanceof Map) ||
      agent.inFlightPermissionResponses?.has(p.request.id)
    )
      throw Error("Book permission response already in flight or unavailable");
    const request = checkedRequest([...agent.pendingPermissions.values()], p.request);
    if (
      agent.pendingPermissions.get(request.id) !== request ||
      digest([agent.id, identity.nativeId, request.id]) !== row.identity ||
      canonical(evaluatePermission(request, s.cwd, base, permissionMode(agent))) !== row.proof
    )
      throw Error("Book permission file or request identity changed");
    if (
      db
        .prepare("UPDATE receiver_permissions SET state='consumed' WHERE id=? AND state='prepared'")
        .run(id).changes !== 1
    )
      throw Error("Book permission admission lost cancellation race");
    return request.id; // No await between current native checks and durable consumption.
  });
}
export function createBookPermissionGuard(file, base, inputGuard) {
  return (agent, requestId, response) => {
    if (typeof requestId !== "string" || !requestId.startsWith("orca-permission:")) {
      inputGuard.guard(agent, "", undefined, false);
      return requestId;
    }
    let db;
    try {
      db = journal(file);
      return admitBookPermission(
        db,
        agent,
        requestId.slice(16),
        response,
        inputGuard.observation(agent.id),
        base,
      );
    } catch (e) {
      throw Error("Orca native permission refused: " + e.message, { cause: e });
    } finally {
      db?.close();
    }
  };
}
