// Frozen test fixture: the controller journal store as released before bac9f750 added the additive
// management_requests table. control.test.mjs opens a current journal with it to prove older controllers
// still read it. Never imported by production code.
import fs from "node:fs";
import { createHash, randomBytes, timingSafeEqual, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export class ControlStore {
  constructor(file) {
    if (fs.existsSync(file) && !fs.lstatSync(file).isFile())
      throw new Error("Regular journal required");
    this.db = new DatabaseSync(file);
    fs.chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, task TEXT NOT NULL, cwd TEXT NOT NULL, mode TEXT NOT NULL, generation INTEGER NOT NULL, token TEXT, expected TEXT, authority TEXT, expectedAt TEXT, boot TEXT, grantedAt INTEGER);
      CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, session TEXT, kind TEXT NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL, result TEXT);
      CREATE TABLE IF NOT EXISTS transfers (id TEXT PRIMARY KEY, session TEXT NOT NULL, generation INTEGER NOT NULL, mode TEXT NOT NULL, reason TEXT NOT NULL, at TEXT NOT NULL);`);
    const columns = this.db
      .prepare("PRAGMA table_info(sessions)")
      .all()
      .map((row) => row.name)
      .join(",");
    if (
      columns !== "id,task,cwd,mode,generation,token,expected,authority,expectedAt,boot,grantedAt"
    ) {
      this.db.close();
      throw new Error(
        "Unsupported journal schema; explicit migration required before control starts",
      );
    }
  }
  atomic(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  get(id) {
    return this.db.prepare("SELECT * FROM sessions WHERE id=?").get(id) ?? null;
  }
  list() {
    return this.db
      .prepare("SELECT id,task,cwd,mode,generation,expected FROM sessions ORDER BY rowid")
      .all();
  }
  delivery(id) {
    const r = this.db.prepare("SELECT * FROM deliveries WHERE id=?").get(id);
    return r ? { ...r, result: r.result ? JSON.parse(r.result) : null } : null;
  }
  check(id, token) {
    const row = this.get(id),
      candidate = hash(typeof token === "string" ? token : "");
    if (
      !row ||
      row.mode !== "delegated" ||
      !row.token ||
      !timingSafeEqual(Buffer.from(candidate), Buffer.from(row.token))
    )
      throw new Error("Delegation revoked or wrong session capability");
    return row;
  }
  admit(id, session, kind, body) {
    return this.atomic(() => {
      const encoded = JSON.stringify(
          Object.fromEntries(Object.entries(body).sort(([a], [b]) => a.localeCompare(b))),
        ),
        prior = this.delivery(id);
      if (prior) {
        if (prior.session !== session || prior.kind !== kind || prior.body !== encoded)
          throw new Error("Delivery identity conflict");
        return { prior };
      }
      if (this.db.prepare("SELECT COUNT(*) n FROM deliveries").get().n >= 1000)
        throw new Error("Journal capacity reached");
      if (
        session &&
        this.db
          .prepare("SELECT id FROM deliveries WHERE session=? AND state IN ('intent','uncertain')")
          .get(session)
      )
        throw new Error("Uncertain delivery requires an explicit disposition");
      this.db
        .prepare("INSERT INTO deliveries VALUES (?,?,?,?, 'intent',NULL)")
        .run(id, session, kind, encoded);
      return { prior: null };
    });
  }
  finish(id, state, result) {
    this.db
      .prepare("UPDATE deliveries SET state=?,result=? WHERE id=?")
      .run(state, JSON.stringify(result), id);
    return this.delivery(id);
  }
  created(id, task, cwd) {
    this.db
      .prepare("INSERT INTO sessions VALUES (?,?,?,'human',1,NULL,NULL,NULL,NULL,NULL,NULL)")
      .run(id, task, cwd);
  }
  transfer(id, mode, reason, expected = null) {
    if (
      !["human", "delegated"].includes(mode) ||
      typeof reason !== "string" ||
      reason.trim().length < 8 ||
      reason.length > 2000
    )
      throw new Error("Explicit control transfer reason required");
    return this.atomic(() => {
      if (!this.get(id)) throw new Error("Session not enrolled");
      const token = mode === "delegated" ? randomBytes(32).toString("base64url") : null;
      this.db
        .prepare("UPDATE sessions SET mode=?,generation=generation+1,token=?,expected=? WHERE id=?")
        .run(mode, token ? hash(token) : null, expected, id);
      const row = this.get(id);
      this.db
        .prepare("INSERT INTO transfers VALUES (?,?,?,?,?,?)")
        .run(randomUUID(), id, row.generation, mode, reason, new Date().toISOString());
      return { id, mode, generation: row.generation, capability: token };
    });
  }
  close() {
    this.db.close();
  }
}
