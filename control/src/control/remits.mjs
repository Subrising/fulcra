// Fulcra Command Centre J1 (CONTRACTS.md §5): which prime owns which project or area of work. A remit drives
// the Organisation view, the brief authorship check (briefs.mjs) and inbox routing; it grants no session
// authority and changes no seat grant.
//
// Who may change a remit is derived, never read from input. Explicit edits arrive through the operator gate
// (rpc.mjs), the Fulcra app's path, and are recorded as actor `operator` until device proof (§3.6) lets the
// controller tell the owner apart; `human` is accepted for that day. No capability lane reaches these methods,
// and explicit edit methods refuse any other actor. The internal refresh applies only the authorised Delivery default.
import { randomUUID } from "node:crypto";
import { uuid } from "./authority.mjs";
import { assertColumns } from "./schema.mjs";
import { readProjectDirectory } from "./projects.mjs";
import {
  KEY,
  remitNote,
  remitScope,
  scopeKey,
  resolveOwner,
  RemitRefused,
} from "../../orca-organization/shared/cc/remit-rules.mjs";
import { personalMatch } from "../../orca-organization/shared/cc/refs.mjs";
const keys = (a, names) =>
  a && typeof a === "object" && !Array.isArray(a) && Object.keys(a).sort().join() === names;
export const STALE_REVISION = "Changed since you looked; refresh";
export const REMIT_EDITORS = Object.freeze(["human", "operator"]);
// Authored table bounds (CONTRACTS §1 Capacity). Writes stop only at the cap, and the refusal says so.
export const REMIT_LIMITS = Object.freeze({ remits: 2000, history: 10000, domains: 1000 });
const REMIT_COLUMNS =
  "id,primeSeat,scopeKind,scopeKey,projectId,domain,label,state,since,endedAt,note,revision,at";
const HISTORY_COLUMNS = "id,entityId,action,before,after,previousRevision,revision,actor,note,at";
const DOMAIN_COLUMNS = "projectId,domain,revision,at";

export class Remits {
  constructor(control, { now = Date.now, readProjects = readProjectDirectory } = {}) {
    this.control = control;
    this.store = control.store;
    this.db = this.store.db;
    this.now = now;
    this.readProjects = readProjects;
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS cc_remits(id TEXT PRIMARY KEY,primeSeat TEXT NOT NULL,scopeKind TEXT NOT NULL,scopeKey TEXT NOT NULL,projectId TEXT,domain TEXT,label TEXT,state TEXT NOT NULL,since TEXT NOT NULL,endedAt TEXT,note TEXT NOT NULL,revision INTEGER NOT NULL,at TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS cc_remits_one_active_owner ON cc_remits(scopeKey) WHERE state='active';
      CREATE TABLE IF NOT EXISTS cc_remit_history(id TEXT PRIMARY KEY,entityId TEXT NOT NULL,action TEXT NOT NULL,before TEXT,after TEXT NOT NULL,previousRevision INTEGER NOT NULL,revision INTEGER NOT NULL,actor TEXT NOT NULL,note TEXT NOT NULL,at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cc_project_domains(projectId TEXT PRIMARY KEY,domain TEXT,revision INTEGER NOT NULL,at TEXT NOT NULL);`);
    assertColumns(this.db, "cc_remits", REMIT_COLUMNS);
    assertColumns(this.db, "cc_remit_history", HISTORY_COLUMNS);
    assertColumns(this.db, "cc_project_domains", DOMAIN_COLUMNS);
  }
  iso() {
    return new Date(this.now()).toISOString();
  }
  count(table) {
    return Number(this.db.prepare(`SELECT count(*) n FROM ${table}`).get().n);
  }
  assertCapacity(table, limit, what) {
    if (this.count(table) >= limit)
      throw Error(
        `The ${what} is full (${limit}); nothing was changed. Archiving old remits arrives in a later Fulcra update`,
      );
  }
  // CONTRACTS §1 Capacity (v1.14, R-C-J1-2): how full each bound is, for the Inbox's 90% attention item. There is no
  // archive for remits yet (a documented v1 exception).
  capacityUsage() {
    return [
      ["cc_remits", REMIT_LIMITS.remits, "project ownership records"],
      ["cc_remit_history", REMIT_LIMITS.history, "project ownership history"],
      ["cc_project_domains", REMIT_LIMITS.domains, "project areas"],
    ].map(([table, limit, what]) => ({ ratio: this.count(table) / limit, what, projectId: null }));
  }
  assertEditor(actor) {
    if (!REMIT_EDITORS.includes(actor))
      throw Error("Only the operator can change who owns a project, from the Fulcra app");
  }
  row(id) {
    return this.db.prepare("SELECT * FROM cc_remits WHERE id=?").get(id) ?? null;
  }
  remit(r) {
    return r
      ? {
          version: 1,
          id: r.id,
          revision: r.revision,
          primeSeat: r.primeSeat,
          scope:
            r.scopeKind === "project"
              ? { kind: "project", projectId: r.projectId }
              : { kind: "domain", domain: r.domain, label: r.label },
          state: r.state,
          since: r.since,
          endedAt: r.endedAt,
          note: r.note,
        }
      : null;
  }
  domainRow(projectId) {
    return (
      this.db.prepare("SELECT * FROM cc_project_domains WHERE projectId=?").get(projectId) ?? null
    );
  }
  projectDomain(r) {
    return r ? { projectId: r.projectId, domain: r.domain, revision: r.revision } : null;
  }
  history(id, entityId, action, before, after, previousRevision, revision, actor, note, at) {
    this.db
      .prepare("INSERT INTO cc_remit_history VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(
        id,
        entityId,
        action,
        before ? JSON.stringify(before) : null,
        JSON.stringify(after),
        previousRevision,
        revision,
        actor,
        note,
        at,
      );
  }
  // CONTRACTS §1 Writes (v1.14, R-C-J1-1): a retry with the same messageId returns the ORIGINAL result snapshot, as
  // recorded in the history row it wrote, never the row's later state; a different request under it is refused.
  replay(messageId, matches) {
    const h = this.db.prepare("SELECT * FROM cc_remit_history WHERE id=?").get(messageId);
    if (!h) return null;
    const before = h.before ? JSON.parse(h.before) : null,
      after = JSON.parse(h.after);
    if (!matches(h, before, after)) throw Error("Message identity already used");
    return { h, before, after };
  }
  // The prime must be a prime seat recorded in role_bindings, never a hard-coded name.
  assertPrime(seat) {
    if (typeof seat !== "string" || !KEY.test(seat)) throw new RemitRefused("Choose a prime");
    if (!this.db.prepare("SELECT seat FROM role_bindings WHERE role='prime' AND seat=?").get(seat))
      throw new RemitRefused("There is no prime seat with that name");
  }
  async assertProject(projectId) {
    const d = await this.readProjects();
    if (!d.available)
      throw Error(
        "The project list is unavailable, so the project cannot be checked; nothing was changed",
      );
    if (!d.projects.some((p) => p.id === projectId))
      throw new RemitRefused("That project is not in the current project list");
  }

  // ---- Writes (operator gate only) ---------------------------------------------------------------------------
  async assign(a, { actor } = {}) {
    this.assertEditor(actor);
    if (
      !keys(a, "expectedRevision,messageId,note,primeSeat,scope") ||
      !uuid(a.messageId) ||
      !Number.isSafeInteger(a.expectedRevision) ||
      a.expectedRevision < 0
    )
      throw Error(
        "Invalid remit assignment; it takes messageId, expectedRevision, primeSeat, scope and note",
      );
    const note = remitNote(a.note),
      scope = remitScope(a.scope),
      key = scopeKey(scope);
    const same = (h, _b, after) =>
      h.action === "assigned" &&
      h.previousRevision === a.expectedRevision &&
      after.primeSeat === a.primeSeat &&
      scopeKey(after.scope) === key &&
      h.note === note;
    const early = this.replay(a.messageId, same);
    if (early) return { remit: early.after, resend: true };
    this.assertPrime(a.primeSeat);
    if (scope.kind === "project") await this.assertProject(scope.projectId);
    return this.store.atomic(() => {
      const again = this.replay(a.messageId, same);
      if (again) return { remit: again.after, resend: true };
      const current = this.db
        .prepare("SELECT * FROM cc_remits WHERE scopeKey=? AND state='active'")
        .get(key);
      // A new remit has no revision yet; an existing owner means the caller's view is out of date.
      if (current || a.expectedRevision !== 0)
        throw Error(
          current
            ? `${STALE_REVISION}: it already has a prime, so move it instead`
            : STALE_REVISION,
        );
      this.assertCapacity("cc_remits", REMIT_LIMITS.remits, "remit store");
      this.assertCapacity("cc_remit_history", REMIT_LIMITS.history, "remit history");
      const at = this.iso(),
        id = randomUUID();
      this.insert(id, a.primeSeat, scope, key, note, at);
      const remit = this.remit(this.row(id));
      this.history(a.messageId, id, "assigned", null, remit, 0, 1, actor, note, at);
      return { remit, resend: false };
    });
  }
  insert(id, primeSeat, scope, key, note, at) {
    this.db
      .prepare("INSERT INTO cc_remits VALUES (?,?,?,?,?,?,?,'active',?,NULL,?,1,?)")
      .run(
        id,
        primeSeat,
        scope.kind,
        key,
        scope.kind === "project" ? scope.projectId : null,
        scope.kind === "domain" ? scope.domain : null,
        scope.kind === "domain" ? scope.label : null,
        at,
        note,
        at,
      );
  }
  // §5.2: one transaction ends the old remit and activates the new one, with ONE history event.
  move(a, { actor } = {}) {
    this.assertEditor(actor);
    if (
      !keys(a, "expectedRevision,messageId,note,remitId,toPrimeSeat") ||
      !uuid(a.messageId) ||
      !uuid(a.remitId) ||
      !Number.isSafeInteger(a.expectedRevision) ||
      a.expectedRevision < 1
    )
      throw Error(
        "Invalid remit move; it takes messageId, expectedRevision, remitId, toPrimeSeat and note",
      );
    const note = remitNote(a.note);
    const same = (h, before, after) =>
      h.action === "moved" &&
      before?.id === a.remitId &&
      h.previousRevision === a.expectedRevision &&
      after.primeSeat === a.toPrimeSeat &&
      h.note === note;
    // The ended remit as the move left it: the history keeps its state before the move, and the move changed exactly
    // state, endedAt (the move's time) and revision.
    const result = (r) => ({
      remit: r.after,
      ended: { ...r.before, state: "ended", endedAt: r.h.at, revision: r.before.revision + 1 },
      resend: true,
    });
    const early = this.replay(a.messageId, same);
    if (early) return result(early);
    this.assertPrime(a.toPrimeSeat);
    return this.store.atomic(() => {
      const again = this.replay(a.messageId, same);
      if (again) return result(again);
      const old = this.row(a.remitId);
      if (!old) throw new RemitRefused("No remit has that id");
      if (old.state !== "active") throw Error(`${STALE_REVISION}: that remit has already ended`);
      if (old.revision !== a.expectedRevision) throw Error(STALE_REVISION);
      if (old.primeSeat === a.toPrimeSeat)
        throw new RemitRefused("It already belongs to that prime");
      this.assertCapacity("cc_remits", REMIT_LIMITS.remits, "remit store");
      this.assertCapacity("cc_remit_history", REMIT_LIMITS.history, "remit history");
      const at = this.iso(),
        before = this.remit(old),
        id = randomUUID();
      this.db
        .prepare("UPDATE cc_remits SET state='ended',endedAt=?,revision=?,at=? WHERE id=?")
        .run(at, old.revision + 1, at, old.id);
      this.insert(id, a.toPrimeSeat, before.scope, old.scopeKey, note, at);
      const remit = this.remit(this.row(id));
      this.history(a.messageId, id, "moved", before, remit, old.revision, 1, actor, note, at);
      return { remit, ended: this.remit(this.row(old.id)), resend: false };
    });
  }
  end(a, { actor } = {}) {
    this.assertEditor(actor);
    if (
      !keys(a, "expectedRevision,messageId,note,remitId") ||
      !uuid(a.messageId) ||
      !uuid(a.remitId) ||
      !Number.isSafeInteger(a.expectedRevision) ||
      a.expectedRevision < 1
    )
      throw Error("Invalid remit end; it takes messageId, expectedRevision, remitId and note");
    const note = remitNote(a.note);
    const same = (h, _b, after) =>
      h.action === "ended" &&
      after.id === a.remitId &&
      h.previousRevision === a.expectedRevision &&
      h.note === note;
    return this.store.atomic(() => {
      const again = this.replay(a.messageId, same);
      if (again) return { remit: again.after, resend: true };
      const old = this.row(a.remitId);
      if (!old) throw new RemitRefused("No remit has that id");
      if (old.state !== "active") throw Error(`${STALE_REVISION}: that remit has already ended`);
      if (old.revision !== a.expectedRevision) throw Error(STALE_REVISION);
      this.assertCapacity("cc_remit_history", REMIT_LIMITS.history, "remit history");
      const at = this.iso(),
        before = this.remit(old);
      this.db
        .prepare("UPDATE cc_remits SET state='ended',endedAt=?,revision=?,at=? WHERE id=?")
        .run(at, old.revision + 1, at, old.id);
      const remit = this.remit(this.row(old.id));
      this.history(
        a.messageId,
        old.id,
        "ended",
        before,
        remit,
        old.revision,
        old.revision + 1,
        actor,
        note,
        at,
      );
      return { remit, resend: false };
    });
  }
  // The optional area tag a project is grouped under. Its changes share the remit history (entityId = project).
  async setDomain(a, { actor } = {}) {
    this.assertEditor(actor);
    if (
      !keys(a, "domain,expectedRevision,messageId,note,projectId") ||
      !uuid(a.messageId) ||
      !uuid(a.projectId) ||
      !Number.isSafeInteger(a.expectedRevision) ||
      a.expectedRevision < 0 ||
      (a.domain !== null && (typeof a.domain !== "string" || !KEY.test(a.domain)))
    )
      throw Error(
        "Invalid project area; it takes messageId, expectedRevision, projectId, domain (or null) and note",
      );
    const note = remitNote(a.note);
    const personal = a.domain && personalMatch(a.domain);
    if (personal) throw new RemitRefused(`The area contains ${personal}`);
    const same = (h, _b, after) =>
      h.action === "domain-set" &&
      h.entityId === a.projectId &&
      h.previousRevision === a.expectedRevision &&
      after.domain === a.domain &&
      h.note === note;
    const early = this.replay(a.messageId, same);
    if (early) return { domain: early.after, resend: true };
    await this.assertProject(a.projectId);
    return this.store.atomic(() => {
      const again = this.replay(a.messageId, same);
      if (again) return { domain: again.after, resend: true };
      const current = this.domainRow(a.projectId),
        revision = current?.revision ?? 0;
      if (revision !== a.expectedRevision) throw Error(STALE_REVISION);
      if ((current?.domain ?? null) === a.domain)
        throw new RemitRefused(
          a.domain ? "The project is already in that area" : "The project is in no area already",
        );
      if (!current)
        this.assertCapacity("cc_project_domains", REMIT_LIMITS.domains, "project area list");
      this.assertCapacity("cc_remit_history", REMIT_LIMITS.history, "remit history");
      const at = this.iso(),
        next = revision + 1;
      this.db
        .prepare("INSERT OR REPLACE INTO cc_project_domains VALUES (?,?,?,?)")
        .run(a.projectId, a.domain, next, at);
      const after = this.projectDomain(this.domainRow(a.projectId));
      this.history(
        a.messageId,
        a.projectId,
        "domain-set",
        this.projectDomain(current),
        after,
        revision,
        next,
        actor,
        note,
        at,
      );
      return { domain: after, resend: false };
    });
  }

  // ---- Reads ---------------------------------------------------------------------------------------------------
  activeRemits() {
    return this.db
      .prepare("SELECT * FROM cc_remits WHERE state='active' ORDER BY since,id")
      .all()
      .map((r) => this.remit(r));
  }
  domains() {
    return new Map(
      this.db
        .prepare("SELECT projectId,domain FROM cc_project_domains")
        .all()
        .map((r) => [r.projectId, r.domain]),
    );
  }
  // §5.2 resolution for one project: the brief authorship check and inbox routing ask this.
  ownerOf(projectId) {
    return resolveOwner(projectId, this.activeRemits(), this.domains());
  }
  // Controller-internal write trigger: startup/event refresh, never a read RPC.
  // One in-flight directory read; shutdown drains it and prevents a late write.
  refresh() {
    if (this.control.closing) return Promise.resolve();
    return (this.refreshing ??= (async () => {
      const directory = await this.readProjects();
      if (!this.control.closing) this.defaultUnowned(directory);
    })().finally(() => {
      this.refreshing = null;
    }));
  }
  // The internal refresh installs the authorised default only for never-owned projects.
  // Ended remits and domain edits are durable opt-outs, including after a controller restart.
  defaultUnowned(directory) {
    if (
      !directory?.available ||
      !this.db
        .prepare("SELECT seat FROM role_bindings WHERE role='prime' AND seat='delivery'")
        .get()
    )
      return;
    this.store.atomic(() => {
      const active = this.activeRemits(),
        domains = this.domains();
      for (const project of directory.projects) {
        if (resolveOwner(project.id, active, domains).kind !== "unassigned") continue;
        if (
          this.db.prepare("SELECT id FROM cc_remits WHERE projectId=? LIMIT 1").get(project.id) ||
          this.domainRow(project.id)
        )
          continue;
        this.assertCapacity("cc_remits", REMIT_LIMITS.remits, "remit store");
        this.assertCapacity("cc_remit_history", REMIT_LIMITS.history, "remit history");
        const id = randomUUID(),
          at = this.iso(),
          scope = { kind: "project", projectId: project.id };
        const note = "default: every unowned project goes to Delivery; the operator can move it";
        this.insert(id, "delivery", scope, scopeKey(scope), note, at);
        const remit = this.remit(this.row(id));
        this.history(randomUUID(), id, "assigned", null, remit, 0, 1, "operator", note, at);
        active.push(remit);
      }
    });
  }
  async list({ defaults = false } = {}) {
    const observedAt = this.iso();
    let directory = null;
    try {
      directory = await this.readProjects();
    } catch {
      directory = null;
    }
    if (defaults) this.defaultUnowned(directory);
    const remits = this.activeRemits(),
      domains = this.domains();
    const ended = this.db
      .prepare("SELECT * FROM cc_remits WHERE state='ended' ORDER BY at DESC,id LIMIT 100")
      .all()
      .map((r) => this.remit(r));
    const primes = this.db
      .prepare("SELECT seat,state,session FROM role_bindings WHERE role='prime' ORDER BY seat")
      .all()
      .map((r) => ({
        seat: r.seat,
        state: r.state === "assigned" ? "assigned" : "vacant",
        sessionId: uuid(r.session) ? r.session : null,
      }));
    const known = directory?.available ? directory.projects : [];
    const ids = [
      ...new Set([
        ...known.map((p) => p.id),
        ...remits.filter((r) => r.scope.kind === "project").map((r) => r.scope.projectId),
        ...domains.keys(),
      ]),
    ];
    const projects = ids.slice(0, 256).map((projectId) => {
      const d = this.domainRow(projectId);
      return {
        projectId,
        name: known.find((p) => p.id === projectId)?.name ?? null,
        domain: d?.domain ?? null,
        domainRevision: d?.revision ?? 0,
        owner: resolveOwner(projectId, remits, domains),
      };
    });
    const history = this.db
      .prepare("SELECT * FROM cc_remit_history ORDER BY rowid DESC LIMIT 100")
      .all()
      .map((h) => ({
        id: h.id,
        entityId: h.entityId,
        action: h.action,
        before: h.before ? JSON.parse(h.before) : null,
        after: JSON.parse(h.after),
        previousRevision: h.previousRevision,
        revision: h.revision,
        actor: h.actor,
        note: h.note,
        at: h.at,
      }));
    return {
      version: 1,
      observedAt,
      partial: !directory?.available || Boolean(directory?.partial),
      primes,
      remits: [...remits, ...ended],
      domains: [...domains].map(([projectId]) => this.projectDomain(this.domainRow(projectId))),
      projects,
      history,
      capacity: {
        remits: this.count("cc_remits"),
        remitLimit: REMIT_LIMITS.remits,
        history: this.count("cc_remit_history"),
        historyLimit: REMIT_LIMITS.history,
      },
    };
  }
}
