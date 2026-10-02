import { initializeBookPermissions } from "./permissions.mjs";
import { bookPermissionRPC } from "./permission-rpc.mjs";
import { readBookArtifacts } from "./artifacts.mjs";
import { readBookPage } from "./activity-page.mjs";
import { journal, atomic } from "./journal.mjs";
import { canonical, bookProvider, exact, digest, verify, sign } from "./protocol.mjs";
import { uuid } from "../control/authority.mjs";
import { delegationFence } from "../control/native-fence.mjs";
import { validateBookActivity } from "./activity.mjs";
const BOOK_THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export class Receiver {
  constructor({ file, native, controller, host = "macbook" }) {
    this.db = journal(file);
    initializeBookPermissions(this.db);
    this.native = native;
    this.controller = controller;
    this.host = host;
    atomic(this.db, () => {
      this.db
        .prepare("INSERT OR IGNORE INTO receiver_identity VALUES (1,?,?)")
        .run(controller, host);
      const id = this.db.prepare("SELECT * FROM receiver_identity").get();
      if (id.controller !== controller || id.host !== host)
        throw Error("Receiver authority identity changed");
    });
  }
  row(id) {
    const s = this.db.prepare("SELECT * FROM receiver_sessions WHERE id=?").get(id);
    if (!s) throw Error("Session not enrolled by this receiver");
    return s;
  }
  async observed(s, activity = false) {
    const o = await (activity
      ? this.native.activityIdentity(s.agent)
      : this.native.inspect(s.agent));
    delegationFence(o);
    if (
      o.id !== s.agent ||
      o.cwd !== s.cwd ||
      o.provider !== bookProvider(JSON.parse(s.creation)) ||
      o.owner !== "orca-book-task" ||
      o.task !== s.task ||
      o.route !== s.id ||
      o.nativeIdentity?.conflict
    )
      throw Error("Receiver native identity changed");
    if (s.native && o.nativeId !== s.native) throw Error("Pinned provider identity changed");
    if (!s.native && o.nativeId)
      this.db
        .prepare("UPDATE receiver_sessions SET native=? WHERE id=? AND native IS NULL")
        .run(o.nativeId, s.id);
    return o;
  }
  async call(a) {
    if (
      !exact(a, "action,controller,host,input,requestId,version") ||
      a.version !== 1 ||
      a.host !== this.host ||
      a.controller !== this.controller ||
      !uuid(a.requestId)
    )
      throw Error("Invalid receiver envelope");
    const p = a.input;
    if (!p || !uuid(p.sessionId)) throw Error("Invalid receiver session");
    if (a.action === "create") {
      bookProvider(p);
      // DESIGN-NEXT-BUILD A3: the controller may forward a role's (or an explicit) model and effort; both optional.
      const { model: _m, thinkingOptionId: _e, ...base } = p;
      if (
        !(
          exact(base, "messageId,sessionId,taskId,title") ||
          exact(base, "messageId,provider,sessionId,taskId,title")
        ) ||
        !uuid(p.messageId) ||
        !uuid(p.taskId) ||
        typeof p.title !== "string" ||
        p.title.length < 3 ||
        p.title.length > 120
      )
        throw Error("Invalid receiver creation");
      if (
        (p.model !== undefined &&
          (typeof p.model !== "string" || !/^[a-z][a-z0-9.-]{1,100}$/.test(p.model))) ||
        (p.thinkingOptionId !== undefined && !BOOK_THINKING.has(p.thinkingOptionId))
      )
        throw Error("Invalid receiver creation selection");
      const body = canonical(p);
      atomic(this.db, () => {
        const old = this.db
          .prepare("SELECT * FROM receiver_sessions WHERE id=? OR request=?")
          .get(p.sessionId, p.messageId);
        if (old) {
          if (old.creation !== body) throw Error("Creation identity conflict");
          return;
        }
        if (Number(this.db.prepare("SELECT count(*) n FROM receiver_sessions").get().n) >= 1000)
          throw Error("Receiver capacity");
        this.db
          .prepare(
            "INSERT INTO receiver_sessions(id,request,task,creation,phase) VALUES (?,?,?,?,'creating')",
          )
          .run(p.sessionId, p.messageId, p.taskId, body);
      });
      let s = this.row(p.sessionId),
        selection;
      if (s.phase !== "created") {
        // Only native session creation is retriable, using the SAME native idempotency key.
        const agent = await this.native.create(p);
        this.db
          .prepare(
            "UPDATE receiver_sessions SET agent=?,cwd=?,phase='created' WHERE id=? AND phase='creating'",
          )
          .run(agent.id, agent.cwd, s.id);
        s = this.row(s.id);
        selection = agent.selection;
      }
      const o = await this.observed(s);
      return {
        id: s.id,
        agentId: s.agent,
        cwd: s.cwd,
        host: this.host,
        nativeId: o.nativeId,
        ...(selection ? { selection } : {}),
      };
    }
    const s = this.row(p.sessionId);
    if (s.phase !== "created") throw Error("Creation unresolved");
    if (a.action.startsWith("permission-")) return bookPermissionRPC(this, a.action, s, p);
    if (a.action === "artifacts") return readBookArtifacts(this, s, p);
    if (a.action === "activity-page") return readBookPage(this, s, p);
    if (a.action === "activity") {
      if (!exact(p, "sessionId,taskId") || !uuid(p.taskId) || p.taskId !== s.task)
        throw Error("Invalid activity task");
      const before = await this.observed(s, true),
        projected = await this.native.activity(s.agent, s.cwd),
        after = await this.observed(s, true),
        fresh = this.row(s.id);
      if (
        fresh.phase !== "created" ||
        fresh.cwd !== s.cwd ||
        fresh.task !== s.task ||
        fresh.agent !== s.agent ||
        fresh.generation !== s.generation ||
        fresh.mode !== s.mode ||
        before.boot !== after.boot ||
        before.nativeId !== after.nativeId ||
        before.humanAt !== after.humanAt ||
        before.lastUserAt !== after.lastUserAt
      )
        throw Error("Book activity identity changed during read");
      return validateBookActivity(
        {
          sessionId: s.id,
          taskId: s.task,
          agentId: s.agent,
          nativeId: after.nativeId ?? null,
          observedAt: after.observedAt,
          ...projected,
        },
        s.cwd,
      );
    }
    if (a.action === "revoke") {
      if (
        !exact(p, "generation,sessionId") ||
        !Number.isSafeInteger(p.generation) ||
        p.generation < 1
      )
        throw Error("Invalid revocation");
      // Serializes against the final guard transaction. Already consumed work may continue.
      atomic(this.db, () => {
        const fresh = this.row(s.id);
        if (p.generation < fresh.generation) throw Error("Revocation superseded");
        this.db
          .prepare("UPDATE receiver_sessions SET mode='human',generation=?,binding=NULL WHERE id=?")
          .run(p.generation, s.id);
      });
      return {
        sessionId: s.id,
        generation: p.generation,
        state: "revoked",
        admitted: this.db
          .prepare("SELECT id,state FROM receiver_intents WHERE session=? AND consumed=1")
          .all(s.id),
        interruptionConfirmed: false,
      };
    }
    if (a.action === "delegate") {
      if (
        !exact(p, "binding,generation,sessionId") ||
        !Number.isSafeInteger(p.generation) ||
        p.generation < 2 ||
        !exact(p.binding, "boot,boundary,lastPromptId,nativeId")
      )
        throw Error("Invalid remote delegation");
      const o = await this.observed(s),
        b = p.binding;
      if (
        b.boot !== o.boot ||
        b.boundary !== delegationFence(o) ||
        b.nativeId !== o.nativeId ||
        b.lastPromptId !== o.lastPromptId ||
        o.archivedAt ||
        o.pending ||
        !["idle", "closed"].includes(o.status)
      )
        throw Error("Receiver input changed before delegation");
      atomic(this.db, () => {
        const fresh = this.row(s.id);
        if (
          p.generation < fresh.generation ||
          (p.generation === fresh.generation &&
            (fresh.mode !== "delegated" || fresh.binding !== canonical(b)))
        )
          throw Error("Delegation revoked or superseded");
        this.db
          .prepare(
            "UPDATE receiver_sessions SET generation=?,mode='delegated',binding=? WHERE id=?",
          )
          .run(p.generation, canonical(b), s.id);
      });
      return { sessionId: s.id, generation: p.generation, state: "delegated", binding: b };
    }
    if (a.action === "inspect") {
      if (!exact(p, "sessionId")) throw Error("Invalid observation");
      return { ...(await this.observed(s)), id: s.id, agentId: s.agent };
    }
    if (a.action === "send") {
      if (
        !exact(
          p,
          "binding,cursor,expectedLastUserAt,expectedNativeId,generation,messageId,sessionId,text",
        ) ||
        !uuid(p.messageId) ||
        typeof p.text !== "string" ||
        !p.text.trim() ||
        Buffer.byteLength(p.text) > 16384 ||
        (p.expectedNativeId !== null && !uuid(p.expectedNativeId)) ||
        !p.cursor?.epoch ||
        !Number.isSafeInteger(p.cursor.seq)
      )
        throw Error("Invalid receiver send");
      const fresh = atomic(this.db, () => {
        const prior = this.db.prepare("SELECT * FROM receiver_intents WHERE id=?").get(p.messageId);
        if (prior) {
          if (prior.body !== canonical(p)) throw Error("Send identity conflict");
          return false;
        }
        const current = this.row(s.id);
        if (
          current.mode !== "delegated" ||
          current.generation !== p.generation ||
          current.binding !== canonical(p.binding)
        )
          throw Error("Orca native admission refused: revoked receiver authority");
        if (
          Number(this.db.prepare("SELECT count(*) n FROM receiver_intents").get().n) >= 1000 ||
          this.db
            .prepare(
              "SELECT id FROM receiver_intents WHERE session=? AND json_extract(body,'$.generation')=? AND state IN ('prepared','admitted','uncertain')",
            )
            .get(s.id, p.generation)
        )
          throw Error("Unresolved receiver delivery or capacity");
        this.db
          .prepare("INSERT INTO receiver_intents(id,session,body,state) VALUES (?,?,?,'prepared')")
          .run(p.messageId, s.id, canonical(p));
        return true;
      });
      if (fresh) {
        try {
          await this.native.send(s.agent, p.text, p.messageId);
          this.db
            .prepare("UPDATE receiver_intents SET state='acknowledged' WHERE id=?")
            .run(p.messageId);
        } catch (e) {
          this.db
            .prepare("UPDATE receiver_intents SET state=?,error=? WHERE id=?")
            .run(
              e.message.includes("Orca native admission refused") ? "refused" : "uncertain",
              e.message.slice(0, 2000),
              p.messageId,
            );
        }
      }
      return this.delivery(p.messageId);
    }
    if (a.action === "receipt" || a.action === "completion") {
      if (
        !exact(
          p,
          a.action === "receipt" ? "messageId,sessionId,text" : "messageId,progress,sessionId",
        ) ||
        !uuid(p.messageId)
      )
        throw Error("Invalid receiver result");
      const d = this.delivery(p.messageId),
        body = JSON.parse(String(d.body));
      if (d.session !== s.id || (a.action === "receipt" && p.text !== body.text))
        throw Error("Result identity conflict");
      const before = await this.observed(s);
      if (a.action === "completion") {
        const cursor = p.progress?.cursor;
        if (
          !cursor ||
          cursor.epoch !== body.cursor.epoch ||
          !Number.isSafeInteger(cursor.seq) ||
          cursor.seq < body.cursor.seq ||
          cursor.seq > before.timelineCursor.seq ||
          before.lastPromptId !== p.messageId
        )
          throw Error("Result origin changed");
        // The authenticated caller supplies a hint, never the output accumulator.
        // Retain the checkpoint here so lost replies and stale client cursors can
        // resume without injecting evidence or replaying the worker instruction.
        const saved = this.db
          .prepare("SELECT value FROM receiver_results WHERE id=?")
          .get(p.messageId)?.value;
        if (saved !== undefined && typeof saved !== "string")
          throw Error("Invalid receiver completion checkpoint");
        const progress =
          typeof saved === "string" ? JSON.parse(saved).progress : { cursor: body.cursor };
        const output = await this.native.completion(s.agent, p.messageId, progress),
          after = await this.observed(s);
        if (
          before.boot !== after.boot ||
          before.nativeId !== after.nativeId ||
          before.humanAt !== after.humanAt ||
          after.lastPromptId !== p.messageId
        )
          throw Error("Result identity changed during read");
        atomic(this.db, () => {
          if (
            this.db.prepare("SELECT value FROM receiver_results WHERE id=?").get(p.messageId)
              ?.value !== saved
          )
            throw Error("Completion observation advanced concurrently; retry the read");
          this.db
            .prepare("INSERT OR REPLACE INTO receiver_results VALUES (?,?)")
            .run(p.messageId, canonical(output));
        });
        return output;
      }
      const r = await this.native.receipt(s.agent, p.messageId, body.text);
      if (d.consumed && r?.state === "completed") {
        this.db
          .prepare("UPDATE receiver_intents SET state='acknowledged' WHERE id=?")
          .run(p.messageId);
        return r;
      }
      return null;
    }
    throw Error("Unsupported receiver action; parent grants and permissions are not supported");
  }
  delivery(id) {
    const d = this.db.prepare("SELECT * FROM receiver_intents WHERE id=?").get(id);
    if (!d) throw Error("Unknown receiver receipt");
    return d;
  }
  close() {
    this.db.close();
  }
}
export async function receive(receiver, wire, key) {
  const a = verify(wire, key);
  let response;
  try {
    response = { result: await receiver.call(a) };
  } catch (e) {
    response = { error: e.message };
  }
  return sign({ requestHash: digest(a), ...response }, key);
}
