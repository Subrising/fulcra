import fs from "node:fs";
import { createHash, randomBytes, timingSafeEqual, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { JOURNAL_CAPACITY, deliveryCount } from "./journal-capacity.mjs";
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export class ControlStore {
  constructor(file) {
    if (fs.existsSync(file) && !fs.lstatSync(file).isFile())
      throw new Error("Regular journal required");
    this.db = new DatabaseSync(file);
    fs.chmodSync(file, 0o600);
    // Track 1a (CONTROLLER-STALLS-PLAN): every SQLite call is synchronous on the controller's one thread, and with the
    // default 2 MB page cache warm pages were re-read from the journal's USB disk image (97% of the main thread in
    // pread, 26 Sep). 128 MiB of page cache and 256 MiB of memory-mapped reads keep them in memory. Per connection.
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000; PRAGMA cache_size=-131072; PRAGMA mmap_size=268435456;
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, task TEXT NOT NULL, cwd TEXT NOT NULL, mode TEXT NOT NULL, generation INTEGER NOT NULL, token TEXT, expected TEXT, authority TEXT, expectedAt TEXT, boot TEXT, grantedAt INTEGER);
      CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, session TEXT, kind TEXT NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL, result TEXT);
      CREATE TABLE IF NOT EXISTS transfers (id TEXT PRIMARY KEY, session TEXT NOT NULL, generation INTEGER NOT NULL, mode TEXT NOT NULL, reason TEXT NOT NULL, at TEXT NOT NULL);`);
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS native_bootstrap(session TEXT PRIMARY KEY,creation TEXT NOT NULL,instanceId TEXT NOT NULL,delivery TEXT UNIQUE NOT NULL,attempt TEXT NOT NULL,operation TEXT NOT NULL,boot TEXT NOT NULL,nativeId TEXT);`,
    );
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
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS management_requests (fingerprint TEXT PRIMARY KEY,id TEXT UNIQUE NOT NULL,body TEXT NOT NULL);",
    );
    // L40: when each request was prepared, so a finished one can be pruned once it can no longer serve a retry. A side
    // table rather than a column: management_requests is written positionally in several places. Additive: an older
    // controller ignores it.
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS management_request_times (id TEXT PRIMARY KEY, at INTEGER NOT NULL);",
    );
    // Track 1c: Controller.history() (the Fulcra app's per-task delivery list) scanned every delivery and parsed every
    // body. These let it read only the task's rows. Additive: an older controller ignores them; SQLite maintains them.
    this.db.exec(`CREATE INDEX IF NOT EXISTS deliveries_session ON deliveries(session);
      CREATE INDEX IF NOT EXISTS deliveries_create_task ON deliveries(json_extract(body,'$.taskId')) WHERE kind='create';
      CREATE INDEX IF NOT EXISTS sessions_task ON sessions(task);
      CREATE INDEX IF NOT EXISTS management_requests_task ON management_requests(json_extract(body,'$.taskId')) WHERE json_valid(body);`);
  }
  atomic(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        this.db.close();
        throw Error("Journal transaction outcome unresolved; restart before reconciliation");
      }
      throw error;
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
  taskIndex() {
    const rows = this.db
      .prepare(`SELECT task FROM sessions
      UNION SELECT CASE WHEN json_valid(body) THEN json_extract(body,'$.taskId') END FROM deliveries WHERE kind='create' AND state IN ('intent','uncertain')
      UNION SELECT CASE WHEN json_valid(body) THEN json_extract(body,'$.taskId') END FROM management_requests
      ORDER BY task LIMIT 2049`)
      .all();
    const ids = rows
      .map((r) => r.task)
      .filter(
        (id) => typeof id === "string" && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id),
      );
    return { taskIds: ids.slice(0, 2048), partial: rows.length > 2048 };
  }
  delivery(id) {
    const r =
      /** @type {{id: string, session: string|null, kind: string, body: string, state: string, result: string|null}} */ (
        this.db.prepare("SELECT * FROM deliveries WHERE id=?").get(id)
      );
    return r ? { ...r, result: r.result ? JSON.parse(r.result) : null } : null;
  }
  check(id, token) {
    const row = this.get(id),
      candidate = hash(typeof token === "string" ? token : "");
    if (
      !row ||
      row.mode !== "delegated" ||
      !row.token ||
      !timingSafeEqual(Buffer.from(candidate), Buffer.from(/** @type {string} */ (row.token)))
    )
      throw new Error("Delegation revoked or wrong session capability");
    return row;
  }
  admit(id, session, kind, body, beforeAdmission = () => {}) {
    return this.atomic(() => {
      const encoded = JSON.stringify(
          Object.fromEntries(Object.entries(body).sort(([a], [b]) => a.localeCompare(b))),
        ),
        prior = this.delivery(id);
      if (prior) {
        if (prior.session !== session || prior.kind !== kind || prior.body !== encoded)
          throw new Error("Delivery identity conflict");
        if (prior.state === "queued")
          throw Error("Quota wait requires fresh source and native revalidation");
        if (prior.state === "reserved") beforeAdmission();
        return { prior };
      }
      if (deliveryCount(this.db) >= JOURNAL_CAPACITY) throw new Error("Journal capacity reached");
      if (
        session &&
        this.db
          .prepare(
            "SELECT id FROM deliveries WHERE session=? AND state IN ('intent','uncertain','queued')",
          )
          .get(session)
      )
        throw new Error("Uncertain or queued delivery requires an explicit disposition");
      beforeAdmission();
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
    const { transferId, ...grant } = this.atomic(() =>
      this.transferRows(id, mode, reason, expected),
    );
    return grant;
  }
  // Internal synchronous primitive: callers hold the enclosing journal transaction.
  transferRows(id, mode, reason, expected = null) {
    if (
      !["human", "delegated"].includes(mode) ||
      typeof reason !== "string" ||
      reason.trim().length < 8 ||
      reason.length > 2000
    )
      throw new Error("Explicit control transfer reason required");
    if (!this.get(id)) throw new Error("Session not enrolled");
    this.db
      .prepare(
        "UPDATE deliveries SET state='refused',result=json_set(result,'$.nativeDispatched',json('false'),'$.wait.state','cancelled','$.wait.reason','Control transferred before admission') WHERE session=? AND state='queued'",
      )
      .run(id);
    const token = mode === "delegated" ? randomBytes(32).toString("base64url") : null;
    this.db
      .prepare("UPDATE sessions SET mode=?,generation=generation+1,token=?,expected=? WHERE id=?")
      .run(mode, token ? hash(token) : null, expected, id);
    const row = this.get(id);
    const transferId = randomUUID();
    this.db
      .prepare("INSERT INTO transfers VALUES (?,?,?,?,?,?)")
      .run(transferId, id, row.generation, mode, reason, new Date().toISOString());
    return { id, mode, generation: row.generation, capability: token, transferId };
  }
  close() {
    this.db.close();
  }
}
