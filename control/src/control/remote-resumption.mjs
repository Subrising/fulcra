import { canonical } from "../book/protocol.mjs";

// Receiver grants are prepared while controller sessions remain human-owned.
// Only the enclosing organization transaction can make these routes usable.
export class RemoteResumptions {
  constructor(native) {
    this.native = native;
    this.store = native.store;
    this.db = native.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS remote_resume_members(
      request TEXT NOT NULL,session TEXT NOT NULL,generation INTEGER NOT NULL,
      binding TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(request,session));`);
  }
  rows(request) {
    return this.db
      .prepare("SELECT * FROM remote_resume_members WHERE request=? ORDER BY session")
      .all(request);
  }
  reserve(request, observed) {
    const record = this.store.delivery(request);
    if (record?.kind !== "resume" || record.state !== "intent" || this.rows(request).length)
      throw Error("Remote resumption receipt changed");
    const remote = observed.filter((o) => this.native.route(o.id));
    if (
      this.db.prepare("SELECT count(*) n FROM remote_resume_members").get().n + remote.length >
      6000
    )
      throw Error("Remote resumption capacity");
    for (const o of remote) {
      const s = this.store.get(o.id),
        r = this.native.route(o.id);
      if (
        s?.mode !== "human" ||
        r.phase !== "human" ||
        r.generation !== s.generation ||
        s.generation >= Number.MAX_SAFE_INTEGER
      )
        throw Error("Remote resumption requires acknowledged human ownership");
      const generation = s.generation + 1,
        binding = canonical({
          boot: o.native.boot,
          boundary: o.grantedAt,
          nativeId: o.native.nativeId ?? null,
          lastPromptId: o.native.lastPromptId,
        });
      this.db
        .prepare("INSERT INTO remote_resume_members VALUES (?,?,?,?,'prepared')")
        .run(request, s.id, generation, binding);
      this.db
        .prepare(
          "UPDATE host_routes SET phase='resuming',generation=?,binding=?,error=NULL WHERE id=?",
        )
        .run(generation, binding, s.id);
    }
    return remote.length;
  }
  check(row, committed = false) {
    const s = this.store.get(row.session),
      r = this.native.route(row.session);
    if (
      !s ||
      s.mode !== (committed ? "delegated" : "human") ||
      s.generation !== row.generation - (committed ? 0 : 1) ||
      r?.phase !== "resuming" ||
      r.generation !== row.generation ||
      r.binding !== row.binding
    )
      throw Error("Prepared remote authority changed");
  }
  async acknowledge(request) {
    for (const row of this.rows(request)) {
      if (row.state !== "prepared") throw Error("Remote preparation already changed");
      this.check(row);
      const reply = await this.native.call("delegate", {
        sessionId: row.session,
        generation: row.generation,
        binding: JSON.parse(row.binding),
      });
      this.check(row);
      if (
        reply.state !== "delegated" ||
        reply.sessionId !== row.session ||
        reply.generation !== row.generation ||
        canonical(reply.binding) !== row.binding
      )
        throw Error("Remote resumption acknowledgement mismatch");
      this.db
        .prepare(
          "UPDATE remote_resume_members SET state='acknowledged' WHERE request=? AND session=? AND state='prepared'",
        )
        .run(request, row.session);
    }
  }
  activate(request) {
    for (const row of this.rows(request)) {
      if (row.state !== "acknowledged") throw Error("Remote resumption acknowledgement missing");
      this.check(row, true);
      this.db.prepare("UPDATE host_routes SET phase='active' WHERE id=?").run(row.session);
      this.db
        .prepare("UPDATE remote_resume_members SET state='active' WHERE request=? AND session=?")
        .run(request, row.session);
    }
  }
  revokeRows(request) {
    for (const row of this.rows(request)) {
      if (["revoked", "superseded"].includes(row.state)) continue;
      if (row.state === "active")
        throw Error("Committed resumption cannot be rolled back as a preparation");
      let s = this.store.get(row.session),
        r = this.native.route(row.session);
      if (s?.mode === "human" && s.generation === row.generation - 1) {
        this.check(row);
        this.store.transferRows(s.id, "human", "Uncommitted remote team resume revoked");
        s = this.store.get(s.id);
      }
      let state;
      if (
        s?.mode === "delegated" &&
        s.generation > row.generation &&
        r?.phase === "active" &&
        r.generation === s.generation
      )
        state = "superseded";
      else if (s?.mode === "human" && s.generation >= row.generation) {
        if (r?.phase === "human" && r.generation === s.generation) state = "revoked";
        else {
          this.native.beginRevoke(s.id, s.generation);
          state = "revoking";
        }
      } else throw Error("Remote preparation recovery needs authority reconciliation");
      this.db
        .prepare("UPDATE remote_resume_members SET state=? WHERE request=? AND session=?")
        .run(state, request, row.session);
    }
  }
  restart() {
    const requests = this.db
      .prepare(
        "SELECT DISTINCT request FROM remote_resume_members WHERE state IN ('prepared','acknowledged','revoking')",
      )
      .all();
    for (const { request } of requests) this.store.atomic(() => this.revokeRows(request));
  }
  async cancel(request) {
    this.store.atomic(() => this.revokeRows(request));
    for (const row of this.rows(request).filter((r) => r.state === "revoking"))
      await this.native.revoke(row.session);
    this.store.atomic(() => this.revokeRows(request));
    const members = this.rows(request).map((r) => ({
      sessionId: r.session,
      generation: r.generation,
      state: r.state,
    }));
    return { complete: members.every((r) => ["revoked", "superseded"].includes(r.state)), members };
  }
}
