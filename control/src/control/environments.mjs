// Fulcra J8: Environments (CONTRACTS §6, D1: Fulcra's own registry). Per project, a path of environments
// (dev → next → prod) with what is deployed where, a setup checklist, and "Promote to next" behind one approval.
//
// Authority. Nothing here runs because someone asked it to. Every definition change is an `environment-change`
// approval (§6.2 #5, v1.15 §6.1), and a promotion runs only when
// decisions.approvalFor({decisionId, revision, action}) succeeds (§3.2 #4, #6): a chosen `approve`, proven on the
// owner's paired device, whose digest still matches. There is no RPC that runs a promotion; the watcher (pump)
// notices a chosen packet and starts the runner. Rollback is part of the approved plan (§6.2 #4).
//
// No Radius: v1 has no Radius adapter, and nothing here launches or tears down Radius resources (§6.2 #6).
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { assertColumns } from "./schema.mjs";
import { controlHome } from "./home.mjs";
import { privateJson } from "../portable-config.mjs";
import { uuid } from "./authority.mjs";
import { canonicalJson, PacketRefused } from "../../orca-organization/shared/cc/decision-rules.mjs";
import {
  validateDefinition,
  sameDefinition,
  definitionChanges,
  definitionBound,
  promotionBound,
  destructiveSteps,
  commitRef,
  EnvironmentRefused,
  FINISHED,
  LIMITS,
  KEY,
} from "../../orca-organization/shared/cc/environment-rules.mjs";
import {
  cleanCheckout,
  removeCheckout,
  runScript,
  changedFiles,
  commitExists,
  headCommit,
  recoverOwnedGroup,
  groupAlive,
} from "./environment-runner.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
// When this machine started, in seconds: a process group recorded under another boot cannot still be running.
const bootTime = () => Math.round(Date.now() / 1000 - os.uptime());
const STOPPED = Symbol("stopped");
const shaOf = (ref) => ref.slice(ref.lastIndexOf("@") + 1);
const ENV_COLUMNS =
  "id,projectId,key,revision,state,json,pending,pendingDecisionId,createdAt,updatedAt";
const HISTORY_COLUMNS = "id,entityId,action,before,after,previousRevision,revision,actor,note,at";
const DEPLOYMENT_COLUMNS = "id,environmentId,projectId,promotionId,status,at,json";
const PROMOTION_COLUMNS =
  "id,projectId,state,revision,decisionId,preparing,askedVia,json,changes,createdAt,updatedAt,basis,processGroup";
// Authored tables are bounded; the refusal is shown (CONTRACTS §1 Capacity). Deployments rotate per environment.
export const ENVIRONMENT_LIMITS = Object.freeze({
  environments: 512,
  history: 20000,
  promotions: 5000,
  deploymentsPerEnvironment: 200,
});
export const STALE_REVISION = "Changed since you looked; refresh";
export const NOT_ASKABLE =
  "Prepared. The approval can be asked by this project's orchestrator; asking it from the app needs the next decision-store update";
// What each usual step of the path means, in plain words, for packets and the app.
export const MEANING = Object.freeze({
  dev: "the working copy the team builds on",
  next: "the practice copy customers don't see yet",
  prod: "the live version customers use",
});
const keys = (a, list) =>
  a &&
  typeof a === "object" &&
  !Array.isArray(a) &&
  Object.keys(a).sort().join() === [...list].sort().join();
const clip = (s, n) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
// A deterministic child id, so a retried request asks the same packet (J3's ask is idempotent on messageId).
const childId = (messageId, what) => {
  const h = sha256(`${messageId}:${what}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

/** The operator's local copies of repositories: `$CONTROLLER_HOME/environments/repos.json`, never the journal. */
export function repositoryResolver(home = controlHome()) {
  return (repoKey) => {
    const file = path.join(home, "environments", "repos.json");
    let config;
    try {
      config = privateJson(file);
    } catch {
      throw new EnvironmentRefused(
        "No local copy of any repository is configured for Environments yet",
      );
    }
    const source =
      config?.version === 1 && Object.hasOwn(config.repos ?? {}, repoKey)
        ? config.repos[repoKey]
        : null;
    if (typeof source !== "string" || !path.isAbsolute(source))
      throw new EnvironmentRefused(
        "No local copy of this repository is configured for Environments",
      );
    return source;
  };
}

export class Environments {
  constructor(
    control,
    {
      now = Date.now,
      resolveRepo = repositoryResolver(),
      checkoutRoot = path.join(controlHome(), "environments", "checkouts"),
      pumpEveryMs = 5000,
    } = {},
  ) {
    this.control = control;
    this.store = control.store;
    this.db = this.store.db;
    this.now = now;
    this.resolveRepo = resolveRepo;
    this.checkoutRoot = checkoutRoot;
    this.pumpEveryMs = pumpEveryMs;
    this.lastPump = -Infinity;
    this.pumping = null;
    this.preparing = new Map();
    this.running = new Map();
    this.aborts = new Map();
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS cc_environments(id TEXT PRIMARY KEY,projectId TEXT NOT NULL,key TEXT NOT NULL,revision INTEGER NOT NULL,state TEXT NOT NULL,json TEXT,pending TEXT,pendingDecisionId TEXT,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS cc_environments_key ON cc_environments(projectId,key);
      CREATE TABLE IF NOT EXISTS cc_environment_history(id TEXT PRIMARY KEY,entityId TEXT NOT NULL,action TEXT NOT NULL,before TEXT,after TEXT NOT NULL,previousRevision INTEGER NOT NULL,revision INTEGER NOT NULL,actor TEXT NOT NULL,note TEXT NOT NULL,at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cc_deployments(id TEXT PRIMARY KEY,environmentId TEXT NOT NULL,projectId TEXT NOT NULL,promotionId TEXT,status TEXT NOT NULL,at TEXT NOT NULL,json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS cc_deployments_env ON cc_deployments(environmentId,at);
      CREATE TABLE IF NOT EXISTS cc_promotions(id TEXT PRIMARY KEY,projectId TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,decisionId TEXT,preparing INTEGER NOT NULL,askedVia TEXT NOT NULL,json TEXT NOT NULL,changes TEXT,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,basis TEXT NOT NULL,processGroup TEXT);
      CREATE TABLE IF NOT EXISTS cc_promotion_history(id TEXT PRIMARY KEY,entityId TEXT NOT NULL,action TEXT NOT NULL,before TEXT,after TEXT NOT NULL,previousRevision INTEGER NOT NULL,revision INTEGER NOT NULL,actor TEXT NOT NULL,note TEXT NOT NULL,at TEXT NOT NULL);`);
    assertColumns(this.db, "cc_environments", ENV_COLUMNS);
    assertColumns(this.db, "cc_environment_history", HISTORY_COLUMNS);
    assertColumns(this.db, "cc_deployments", DEPLOYMENT_COLUMNS);
    assertColumns(this.db, "cc_promotions", PROMOTION_COLUMNS);
    assertColumns(this.db, "cc_promotion_history", HISTORY_COLUMNS);
    // Bound actions (§3.2 #4), through J3's public binder registry: how the decision store reads the bound object.
    control.decisions?.binders.set("promotion", (id) => this.promotionBoundObject(id));
    control.decisions?.binders.set("environment-change", (id) => this.pendingBoundObject(id));
    this.recoverInterrupted();
  }
  iso() {
    return new Date(this.now()).toISOString();
  }
  decisions() {
    if (!this.control.decisions)
      throw Error("The decision store is not constructed in this controller");
    return this.control.decisions;
  }

  // ---- rows ---------------------------------------------------------------------------------------------------
  envRow(id) {
    return this.db.prepare("SELECT * FROM cc_environments WHERE id=?").get(id) ?? null;
  }
  environment(id) {
    const r = this.envRow(id);
    return r?.json ? JSON.parse(r.json) : null;
  }
  promotionRow(id) {
    return this.db.prepare("SELECT * FROM cc_promotions WHERE id=?").get(id) ?? null;
  }
  promotion(id) {
    const r = this.promotionRow(id);
    return r ? JSON.parse(r.json) : null;
  }
  count(table) {
    return Number(this.db.prepare(`SELECT count(*) n FROM ${table}`).get().n);
  }
  capacity(table, limit, what) {
    if (this.count(table) >= limit)
      throw new EnvironmentRefused(
        `The ${what} is full (${limit}); nothing was recorded. Ask the operator to archive old records`,
      );
  }
  history(table, id, entityId, action, before, after, revision, actor, note) {
    this.db
      .prepare(`INSERT INTO ${table} VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(
        id,
        entityId,
        action,
        before ? JSON.stringify(before) : null,
        JSON.stringify(after),
        before?.revision ?? revision - 1,
        revision,
        actor,
        note,
        this.iso(),
      );
  }
  // The actor, from the lane (§1): the operator socket, or the seat/session a role grant names. Never from input.
  // v1.15 (J8-3): a role-lane caller acts only on its own project: it holds that project's orchestrator seat, or the
  // prime seat that owns the project (J1's remits, when installed), as for briefs (§4.2).
  actorFor(lane, sessionId, projectId) {
    if (lane.kind === "operator") return { actor: "operator" };
    const who = this.decisions().asker(sessionId, lane.capability);
    const seats = this.db
      .prepare("SELECT role,seat FROM role_bindings WHERE session=? AND state='assigned'")
      .all(who.sessionId);
    const owner = uuid(projectId) ? this.control.remits?.ownerOf?.(projectId) : null;
    const mine =
      seats.some((r) => r.role === "project-orchestrator" && r.seat === projectId) ||
      (owner?.primeSeat && seats.some((r) => r.role === "prime" && r.seat === owner.primeSeat));
    if (!mine)
      throw new EnvironmentRefused(
        "Only this project's orchestrator, or the prime that owns it, can do this",
      );
    return { actor: who.actor, sessionId: who.sessionId };
  }
  // A retried write returns the original result (§1 Writes); a reused id with a different request is refused.
  replay(table, messageId, fingerprint) {
    const prior = this.db.prepare(`SELECT entityId, after FROM ${table} WHERE id=?`).get(messageId);
    if (!prior) return null;
    if (JSON.parse(prior.after).fingerprint !== fingerprint)
      throw new EnvironmentRefused("Message identity already used");
    return prior.entityId;
  }

  // ---- reads --------------------------------------------------------------------------------------------------
  view(projectId) {
    if (!uuid(projectId)) throw new EnvironmentRefused("Choose a project");
    const rows = this.db.prepare("SELECT * FROM cc_environments WHERE projectId=?").all(projectId);
    const envs = rows
      .map((r) => {
        const environment = r.json ? JSON.parse(r.json) : null,
          pending = r.pending ? JSON.parse(r.pending) : null;
        const deployments = this.db
          .prepare(
            "SELECT json FROM cc_deployments WHERE environmentId=? ORDER BY at DESC, rowid DESC LIMIT 5",
          )
          .all(r.id)
          .map((d) => JSON.parse(d.json));
        const current = deployments.find((d) => d.status === "succeeded") ?? null;
        const failing = (environment?.requirements ?? []).filter(
          (q) => q.last.state === "fail",
        ).length;
        const health = !environment
          ? "unknown"
          : failing || ["failed", "rolled-back"].includes(deployments[0]?.status)
            ? "attention"
            : current
              ? "good"
              : "unknown";
        return {
          id: r.id,
          key: r.key,
          order: environment?.order ?? pending?.order ?? 9,
          environment,
          pending: pending ? { definition: pending, decisionId: r.pendingDecisionId } : null,
          current,
          latest: deployments[0] ?? null,
          health,
          meaning: MEANING[r.key] ?? null,
        };
      })
      .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
    const promotions = this.db
      .prepare(
        "SELECT * FROM cc_promotions WHERE projectId=? ORDER BY createdAt DESC, rowid DESC LIMIT 10",
      )
      .all(projectId)
      .map((r) => ({
        promotion: JSON.parse(r.json),
        preparing: r.preparing === 1,
        askedVia: r.askedVia,
        changes: r.changes ? JSON.parse(r.changes) : null,
      }));
    return {
      version: 1,
      observedAt: this.iso(),
      partial: false,
      projectId,
      environments: envs,
      promotions,
    };
  }

  // ---- definitions (§6.2 #5) ----------------------------------------------------------------------------------
  /**
   * Adds or changes an environment. Every change waits for an `environment-change` approval (§6.2 #5; v1.15 §6.1:
   * key, label, order and target are part of the approved digest, since the promotion card is worded from them);
   * the old definition stays in force until then.
   */
  async propose(a, lane) {
    const fields =
      lane.kind === "role"
        ? [
            "sessionId",
            "messageId",
            "projectId",
            "environmentId",
            "expectedRevision",
            "definition",
            "note",
          ]
        : ["messageId", "projectId", "environmentId", "expectedRevision", "definition", "note"];
    if (
      !keys(a, fields) ||
      !uuid(a.messageId) ||
      !uuid(a.projectId) ||
      (a.environmentId !== null && !uuid(a.environmentId)) ||
      !Number.isInteger(a.expectedRevision) ||
      typeof a.note !== "string" ||
      a.note.length > 500
    )
      throw new EnvironmentRefused("Invalid environment proposal");
    const who = this.actorFor(lane, a.sessionId, a.projectId);
    const def = validateDefinition(a.definition),
      fingerprint = canonicalJson({
        projectId: a.projectId,
        environmentId: a.environmentId,
        expectedRevision: a.expectedRevision,
        def,
      });
    const replayed = this.replay("cc_environment_history", a.messageId, fingerprint);
    if (replayed) return this.proposalResult(replayed);
    const row = a.environmentId ? this.envRow(a.environmentId) : null;
    if (a.environmentId && (!row || row.projectId !== a.projectId))
      throw new EnvironmentRefused("No environment has that id in this project");
    if ((row?.revision ?? 0) !== a.expectedRevision) throw new EnvironmentRefused(STALE_REVISION);
    // One change waits at a time. A proposal that was never asked (no approval card yet) may be replaced.
    if (row?.pending && row.pendingDecisionId)
      throw new EnvironmentRefused("A change to this environment is already waiting for approval");
    const clash = this.db
      .prepare("SELECT id FROM cc_environments WHERE projectId=? AND key=?")
      .get(a.projectId, def.key);
    if (clash && clash.id !== row?.id)
      throw new EnvironmentRefused(`This project already has a ${def.key} environment`);
    const before = row?.json ? JSON.parse(row.json) : null,
      id = row?.id ?? randomUUID(),
      at = this.iso();
    // v1.15 §6.2 #1 (J8-4): the definition pins the version of the repository whose scripts it runs: the local copy's
    // current commit, shown on the approval card and bound into its digest. A newer version is a change like any other.
    const pinned = {
      ...def,
      definitionCommit: `commit:${def.repo}@${await headCommit({ source: this.resolveRepo(def.repo) })}`,
    };
    // v1.15 §6.1 (J8-1): every change, including a rename, a new order or a new target, waits for approval.
    if (sameDefinition(before, pinned))
      throw new EnvironmentRefused("That is the definition already in force; nothing changed");
    this.capacity("cc_environments", ENVIRONMENT_LIMITS.environments, "environment registry");
    this.capacity("cc_environment_history", ENVIRONMENT_LIMITS.history, "environment history");
    const bound = definitionBound(id, a.projectId, pinned),
      revision = (row?.revision ?? 0) + 1;
    this.store.atomic(() => {
      if (row)
        this.db
          .prepare(
            "UPDATE cc_environments SET revision=?,pending=?,pendingDecisionId=NULL,updatedAt=? WHERE id=?",
          )
          .run(revision, JSON.stringify(bound), at, id);
      else
        this.db
          .prepare("INSERT INTO cc_environments VALUES (?,?,?,?,?,?,?,?,?,?)")
          .run(
            id,
            a.projectId,
            def.key,
            revision,
            "active",
            null,
            JSON.stringify(bound),
            null,
            at,
            at,
          );
      this.history(
        "cc_environment_history",
        a.messageId,
        id,
        "proposed",
        before,
        { fingerprint, proposed: bound },
        revision,
        who.actor,
        a.note || "Proposed a change",
      );
    });
    try {
      await this.askEnvironmentChange(id, a.messageId, lane, a.sessionId);
    } catch (error) {
      this.dropPending(
        this.envRow(id),
        "lapsed",
        "The approval could not be asked, so nothing changed",
      );
      throw error;
    }
    return this.proposalResult(id);
  }
  proposalResult(id) {
    const r = this.envRow(id);
    return {
      environmentId: id,
      revision: r.revision,
      inForce: r.json ? JSON.parse(r.json) : null,
      pending: r.pending ? JSON.parse(r.pending) : null,
      decisionId: r.pendingDecisionId,
      waiting: r.pending && !r.pendingDecisionId ? NOT_ASKABLE : null,
    };
  }
  pendingBoundObject(environmentId) {
    const r = this.envRow(environmentId);
    return r?.pending ? JSON.parse(r.pending) : null;
  }
  async askEnvironmentChange(id, messageId, lane, sessionId) {
    const pending = this.pendingBoundObject(id),
      before = this.environment(id),
      label = pending.label;
    const destructive = destructiveSteps(pending.steps).length > 0,
      changes = definitionChanges(before, pending);
    const what = changes.length ? `This ${changes.join(", ")}.` : "";
    const packet = {
      // A change to the live environment (before or after the change) is the most important kind of question.
      kind: "approval",
      level: before?.key === "prod" || pending.key === "prod" ? 1 : 2,
      projectId: pending.projectId,
      taskId: null,
      askedOf: "human",
      title: clip(
        before
          ? `Change the ${before.label} environment?`
          : `Add ${label} to this project's environments?`,
        120,
      ),
      // Plain language (§3): the version itself is in the evidence, under Details.
      situation: clip(
        `${before ? what : `This sets up the steps Fulcra will run to update ${label}.`} Fulcra runs the scripts as they are in the repository now, never copies from a version being promoted. ${destructive ? "Nothing changes until you approve, and one of the steps cannot be undone." : "Nothing changes until you approve."}`,
        600,
      ),
      options: this.approvalOptions({
        approve: before
          ? `Use the new definition of ${label} from now on.`
          : `Start using ${label}.`,
        keep: before ? `Keep ${before.label} as it is now.` : "Do not add it.",
        destructive,
        blast: null,
      }),
      recommendation: null,
      evidence: [
        { ref: `env:${id}`, label: `The ${label} environment` },
        { ref: pending.definitionCommit, label: "The version of the scripts it will run" },
      ],
      action: {
        type: "environment-change",
        environmentId: id,
        digest: sha256(canonicalJson(pending)),
      },
      expiresAt: null,
    };
    const decision = await this.ask(
      packet,
      childId(messageId, "environment-change"),
      lane,
      sessionId,
    );
    if (decision)
      this.db
        .prepare(
          "UPDATE cc_environments SET pendingDecisionId=? WHERE id=? AND pending IS NOT NULL",
        )
        .run(decision.id, id);
  }
  applyApprovedDefinition(row, packet) {
    const pending = JSON.parse(row.pending),
      before = row.json ? JSON.parse(row.json) : null,
      revision = row.revision + 1;
    const env = {
      version: 1,
      id: row.id,
      revision,
      projectId: row.projectId,
      key: pending.key,
      label: pending.label,
      order: pending.order,
      target: pending.target,
      repo: pending.repo,
      requirements: pending.requirements.map((r) => ({
        ...r,
        last: before?.requirements.find(
          (o) => o.id === r.id && canonicalJson(o.check) === canonicalJson(r.check),
        )?.last ?? { state: "unknown", at: null, detail: "" },
      })),
      steps: pending.steps,
      state: pending.state,
      definitionCommit: pending.definitionCommit,
    };
    this.store.atomic(() => {
      this.db
        .prepare(
          "UPDATE cc_environments SET key=?,revision=?,state=?,json=?,pending=NULL,pendingDecisionId=NULL,updatedAt=? WHERE id=?",
        )
        .run(env.key, revision, env.state, JSON.stringify(env), this.iso(), row.id);
      this.history(
        "cc_environment_history",
        randomUUID(),
        row.id,
        "applied",
        before,
        { decisionId: packet.id, environment: env },
        revision,
        "human",
        "Approved on the owner's paired device",
      );
    });
  }
  dropPending(row, action, note) {
    this.store.atomic(() => {
      if (!row.json) this.db.prepare("DELETE FROM cc_environments WHERE id=?").run(row.id);
      else
        this.db
          .prepare(
            "UPDATE cc_environments SET revision=?,pending=NULL,pendingDecisionId=NULL,updatedAt=? WHERE id=?",
          )
          .run(row.revision + 1, this.iso(), row.id);
      this.history(
        "cc_environment_history",
        randomUUID(),
        row.id,
        action,
        null,
        { decisionId: row.pendingDecisionId },
        row.revision + 1,
        "system:environments",
        note,
      );
    });
  }

  // ---- promotions (§6.1, §6.2) --------------------------------------------------------------------------------
  /**
   * Prepares a promotion of `commit` from one environment to the next. Readiness runs in the background from a
   * clean checkout (requirement scripts can take minutes); the approval is asked once it is ready and nothing fails.
   */
  async promotionCreate(a, lane) {
    const fields =
      lane.kind === "role"
        ? ["sessionId", "messageId", "projectId", "from", "to", "commit", "expectedRevision"]
        : ["messageId", "projectId", "from", "to", "commit", "expectedRevision"];
    if (
      !keys(a, fields) ||
      !uuid(a.messageId) ||
      !uuid(a.projectId) ||
      !uuid(a.from) ||
      !uuid(a.to) ||
      !Number.isInteger(a.expectedRevision)
    )
      throw new EnvironmentRefused("Invalid promotion request");
    const who = this.actorFor(lane, a.sessionId, a.projectId);
    const fingerprint = canonicalJson({
      projectId: a.projectId,
      from: a.from,
      to: a.to,
      commit: a.commit,
      expectedRevision: a.expectedRevision,
    });
    const replayed = this.replay("cc_promotion_history", a.messageId, fingerprint);
    if (replayed) return this.promotionResult(replayed);
    const from = this.environment(a.from),
      to = this.environment(a.to);
    if (!from || !to || from.projectId !== a.projectId || to.projectId !== a.projectId)
      throw new EnvironmentRefused("Both environments must be set up in this project");
    if (to.state !== "active") throw new EnvironmentRefused(`${to.label} is retired`);
    if (to.order <= from.order)
      throw new EnvironmentRefused(
        `Promotions go forward along the path: ${to.label} comes before ${from.label}`,
      );
    // v1.15 §6 (J8-6): exactly one step, to the next active environment after `from`.
    const next = this.nextEnvironments(from);
    if (next.length > 1)
      throw new EnvironmentRefused(
        `${next.map((e) => e.label).join(" and ")} share the next place after ${from.label}; give them different orders first`,
      );
    if (next[0]?.id !== to.id)
      throw new EnvironmentRefused(
        `Changes move one step at a time: after ${from.label} comes ${next[0]?.label ?? "nothing"}, not ${to.label}`,
      );
    if (to.revision !== a.expectedRevision) throw new EnvironmentRefused(STALE_REVISION);
    if (to.repo !== from.repo)
      throw new EnvironmentRefused("Both environments must use the same repository");
    const { ref, sha } = commitRef(a.commit, to.repo),
      source = this.resolveRepo(to.repo);
    if (!(await commitExists({ source, sha })))
      throw new EnvironmentRefused("That version is not in the local copy of the repository");
    if (
      this.db
        .prepare(
          `SELECT id FROM cc_promotions WHERE json->>'to'=? AND state NOT IN (${FINISHED.map(() => "?").join(",")})`,
        )
        .get(a.to, ...FINISHED)
    )
      throw new EnvironmentRefused(
        `A promotion to ${to.label} is already under way; finish or cancel it first`,
      );
    this.capacity("cc_promotions", ENVIRONMENT_LIMITS.promotions, "promotion record");
    this.capacity("cc_promotion_history", ENVIRONMENT_LIMITS.history, "promotion history");
    const id = randomUUID(),
      at = this.iso();
    const p = {
      version: 1,
      id,
      revision: 1,
      projectId: a.projectId,
      from: a.from,
      to: a.to,
      commit: ref,
      impact: [ref],
      readiness: to.requirements.map((r) => ({ requirementId: r.id, state: "unknown" })),
      rollbackPlan: `If deploying or checking ${to.label} fails, Fulcra runs its undo step straight away and records what happened. Nothing else is changed.`,
      decisionId: null,
      state: "proposed",
      log: [],
      digest: "0".repeat(64),
    };
    p.digest = sha256(canonicalJson(promotionBound(p, to.steps)));
    this.store.atomic(() => {
      this.db
        .prepare("INSERT INTO cc_promotions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(
          id,
          a.projectId,
          "proposed",
          1,
          null,
          1,
          lane.kind,
          JSON.stringify(p),
          null,
          at,
          at,
          JSON.stringify(this.basis(from, to)),
          null,
        );
      this.history(
        "cc_promotion_history",
        a.messageId,
        id,
        "created",
        null,
        { fingerprint, promotion: p },
        1,
        who.actor,
        "Prepared a promotion",
      );
    });
    const preparing = this.prepare(id, source).finally(() => this.preparing.delete(id));
    this.preparing.set(id, preparing);
    return this.promotionResult(id);
  }
  /** The active environment(s) at the smallest order after `from` in its project: normally exactly one. */
  nextEnvironments(from) {
    const later = this.db
      .prepare(
        "SELECT json FROM cc_environments WHERE projectId=? AND json IS NOT NULL AND state='active'",
      )
      .all(from.projectId)
      .map((r) => JSON.parse(r.json))
      .filter((e) => e.order > from.order);
    const order = Math.min(...later.map((e) => e.order));
    return later.filter((e) => e.order === order);
  }
  promotionResult(id) {
    const r = this.promotionRow(id);
    return {
      promotion: JSON.parse(r.json),
      preparing: r.preparing === 1,
      changes: r.changes ? JSON.parse(r.changes) : null,
      waiting:
        this.askFailure(r) ??
        (r.state === "proposed" &&
        r.askedVia === "operator" &&
        !r.decisionId &&
        !this.canAskSystem()
          ? NOT_ASKABLE
          : null),
    };
  }
  update(id, change, action, actor, note) {
    const r = this.promotionRow(id),
      before = JSON.parse(r.json);
    const p = { ...before, ...change(before), revision: before.revision + 1 };
    this.db
      .prepare(
        "UPDATE cc_promotions SET state=?,revision=?,decisionId=?,json=?,updatedAt=? WHERE id=?",
      )
      .run(p.state, p.revision, p.decisionId, JSON.stringify(p), this.iso(), id);
    this.history(
      "cc_promotion_history",
      randomUUID(),
      id,
      action,
      before,
      { promotion: p },
      p.revision,
      actor,
      note,
    );
    return p;
  }
  log(p, step, lines) {
    const at = this.iso(),
      log = [...p.log, ...lines.map((line) => ({ at, step, line: clip(line, LIMITS.logLine) }))];
    return log.length > LIMITS.log
      ? [
          ...log.slice(0, 20),
          { at, step, line: `(${log.length - LIMITS.log + 1} earlier lines not kept)` },
          ...log.slice(-(LIMITS.log - 21)),
        ]
      : log;
  }
  // Readiness (§6.1) and "what changes", then the digest. v1.15 §6.2 #1 (J8-4): the checks are the environment's own,
  // from a clean checkout of its definitionCommit; the candidate is a second checkout, given to them as data.
  async prepare(id, source) {
    const p0 = this.promotion(id),
      to = this.environment(p0.to),
      sha = shaOf(p0.commit);
    let checkout = null,
      candidate = null,
      readiness = p0.readiness,
      lines = [],
      changes = null;
    const abort = new AbortController();
    this.aborts.set(id, abort);
    try {
      ({ checkout, candidate } = await this.checkouts(source, to, sha));
      readiness = [];
      for (const r of to.requirements) {
        if (r.check.kind === "manual") {
          readiness.push({
            requirementId: r.id,
            state: r.last.state === "pass" ? "pass" : "unknown",
          });
          continue;
        }
        const result = await this.script(id, "check", checkout, r.check, {
          environment: to.key,
          commit: sha,
          promotion: id,
          step: "check",
          candidate,
        });
        if (result.cancelled) {
          readiness.push({ requirementId: r.id, state: "unknown" });
          lines.push("Stopped before the setup checks finished");
          break;
        }
        readiness.push({ requirementId: r.id, state: result.ok ? "pass" : "fail" });
        this.recordCheck(to.id, r.id, result.ok ? "pass" : "fail", result.lines.at(-1) ?? "");
        if (!result.ok) lines.push(`Setup check "${r.label}" failed`);
      }
      const current = this.db
        .prepare(
          "SELECT json FROM cc_deployments WHERE environmentId=? AND status='succeeded' ORDER BY at DESC, rowid DESC LIMIT 1",
        )
        .get(to.id);
      if (current) {
        const was = JSON.parse(current.json).version.commit,
          wasSha = was.slice(was.lastIndexOf("@") + 1);
        const files = await changedFiles({ source, from: wasSha, to: sha }).catch(() => null);
        changes = files ? { from: was, files: files.length, sample: files.slice(0, 12) } : null;
      } else changes = { from: null, files: null, sample: [] };
    } catch (error) {
      lines.push(
        error instanceof EnvironmentRefused ? error.message : "The setup checks could not run",
      );
      readiness = to.requirements.map((r) => ({ requirementId: r.id, state: "unknown" }));
    } finally {
      this.aborts.delete(id);
      for (const dir of [checkout, candidate]) if (dir) removeCheckout(dir, this.checkoutRoot);
    }
    readiness = [
      ...readiness,
      ...to.requirements
        .slice(readiness.length)
        .map((r) => ({ requirementId: r.id, state: "unknown" })),
    ];
    // Cancelled while the checks ran: the checks were stopped, and the cancelled promotion keeps its record as it is.
    if (FINISHED.includes(this.promotion(id).state)) {
      this.db.prepare("UPDATE cc_promotions SET preparing=0 WHERE id=?").run(id);
      return;
    }
    const current = this.environment(p0.to);
    this.store.atomic(() => {
      this.update(
        id,
        (p) => ({
          readiness,
          log: this.log(p, "verify", lines.length ? lines : ["Setup checks finished"]),
          digest: sha256(canonicalJson(promotionBound({ ...p, readiness }, current.steps))),
        }),
        "prepared",
        "system:environments",
        "Setup checks finished",
      );
      this.db
        .prepare("UPDATE cc_promotions SET preparing=0,changes=? WHERE id=?")
        .run(changes ? JSON.stringify(changes) : null, id);
    });
    const row = this.promotionRow(id);
    if (row.askedVia !== "operator" || !this.askable(this.promotion(id))) return;
    // v1.15 §3.3 (J8-5): a failed ask is never swallowed. It is logged on the promotion and in its history, and the
    // promotion says so when read; nothing runs, and cancelling and preparing again is the way on.
    try {
      await this.askPromotion(id, randomUUID(), { kind: "operator" });
    } catch (error) {
      this.askFailed(id, error);
    }
  }
  /** The two clean checkouts a promotion uses: the environment's scripts (definitionCommit) and the candidate (data). */
  async checkouts(source, env, sha) {
    if (!env.definitionCommit)
      throw new EnvironmentRefused(
        `${env.label} has no approved version of its scripts yet; propose it again`,
      );
    const checkout = await cleanCheckout({
      source,
      sha: shaOf(env.definitionCommit),
      root: this.checkoutRoot,
    });
    try {
      return { checkout, candidate: await cleanCheckout({ source, sha, root: this.checkoutRoot }) };
    } catch (error) {
      removeCheckout(checkout, this.checkoutRoot);
      throw error;
    }
  }
  // One script for a promotion (v1.15 §6.2, J8-2/J8-7): its process group is recorded on the promotion while it runs,
  // so a restart can find it, and cancelling or stopping the controller kills the group.
  async script(id, step, checkout, s, context) {
    const signal = this.aborts.get(id)?.signal ?? null;
    if (signal?.aborted) return { ok: false, cancelled: true, lines: ["Stopped: cancelled"] };
    const onGroup = (pgid, owner) =>
      this.db
        .prepare("UPDATE cc_promotions SET processGroup=? WHERE id=?")
        .run(pgid ? JSON.stringify({ pgid, owner, step, bootAt: bootTime() }) : null, id);
    try {
      return await runScript({
        checkout,
        script: s.script,
        args: s.args,
        timeoutS: s.timeoutS,
        context,
        signal,
        onGroup,
      });
    } catch (error) {
      return { ok: false, cancelled: false, lines: [error.message] };
    }
  }
  askFailed(id, error) {
    const reason = clip(
      error instanceof EnvironmentRefused || error instanceof PacketRefused
        ? error.message
        : "the decision store refused it",
      160,
    );
    const line = `The approval could not be asked (${reason}). Nothing will run; cancel this promotion and prepare it again.`;
    this.store.atomic(() =>
      this.update(
        id,
        (p) => ({ log: this.log(p, "deploy", [line]) }),
        "ask-failed",
        "system:environments",
        line,
      ),
    );
    return line;
  }
  askFailure(row) {
    if (row.state !== "proposed" || row.decisionId) return null;
    const last = this.db
      .prepare(
        "SELECT action, note FROM cc_promotion_history WHERE entityId=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(row.id);
    return last?.action === "ask-failed" ? clip(last.note, 300) : null;
  }
  recordCheck(environmentId, requirementId, state, detail) {
    const env = this.environment(environmentId);
    const requirements = env.requirements.map((r) =>
      r.id === requirementId
        ? { ...r, last: { state, at: this.iso(), detail: clip(detail, LIMITS.detail) } }
        : r,
    );
    this.db
      .prepare("UPDATE cc_environments SET json=? WHERE id=?")
      .run(JSON.stringify({ ...env, requirements }), environmentId);
  }
  askable(p) {
    return (
      p.state === "proposed" &&
      !p.decisionId &&
      !p.readiness.some((r) => r.state === "fail") &&
      this.promotionRow(p.id).preparing === 0
    );
  }
  /** Role lane: the orchestrator asks the approval once the promotion is ready (its own grant is the asker). */
  async promotionAsk(a, lane) {
    if (
      !keys(a, ["sessionId", "messageId", "promotionId"]) ||
      !uuid(a.messageId) ||
      !uuid(a.promotionId)
    )
      throw new EnvironmentRefused("Invalid promotion ask");
    const p = this.promotion(a.promotionId);
    this.actorFor(lane, a.sessionId, p?.projectId ?? null);
    if (!p) throw new EnvironmentRefused("No promotion has that id");
    if (p.decisionId) return this.promotionResult(p.id);
    if (this.promotionRow(p.id).preparing)
      throw new EnvironmentRefused(
        "The setup checks are still running; ask again when they finish",
      );
    if (!this.askable(p))
      throw new EnvironmentRefused(
        p.readiness.some((r) => r.state === "fail")
          ? "A setup check failed; fix it and prepare the promotion again"
          : `This promotion is ${p.state}`,
      );
    await this.askPromotion(p.id, a.messageId, lane, a.sessionId);
    return this.promotionResult(p.id);
  }
  // v1.15 §6.1 (J8-1): the card is worded from both environments' approved definitions (labels, keys, target), which
  // the §6.1 digest does not name. The definitions a promotion was prepared against are its basis; if either has
  // changed since (only possible through its own approval), the bound object is gone, so any approval is void.
  basis(from, to) {
    return { from: from.revision, to: to.revision };
  }
  promotionBoundObject(id) {
    const row = this.promotionRow(id),
      p = row ? JSON.parse(row.json) : null;
    if (!p || FINISHED.includes(p.state)) return null;
    const to = this.environment(p.to),
      from = this.environment(p.from);
    if (
      !to ||
      !from ||
      canonicalJson(this.basis(from, to)) !== canonicalJson(JSON.parse(row.basis))
    )
      return null;
    return promotionBound(p, to.steps);
  }
  async askPromotion(id, messageId, lane, sessionId) {
    const p = this.promotion(id),
      to = this.environment(p.to),
      from = this.environment(p.from),
      row = this.promotionRow(id);
    const changes = row.changes ? JSON.parse(row.changes) : null,
      destructive = destructiveSteps(to.steps).length > 0;
    const unknown = p.readiness.filter((r) => r.state === "unknown").length,
      passed = p.readiness.filter((r) => r.state === "pass").length;
    const what =
      changes?.files == null
        ? "This is the first version recorded there."
        : `This version changes ${changes.files} file${changes.files === 1 ? "" : "s"}.`;
    const checks = !p.readiness.length
      ? "There are no setup checks."
      : unknown
        ? `${passed} setup check${passed === 1 ? "" : "s"} passed and ${unknown} still need a person to confirm.`
        : "Every setup check passed.";
    const meaning = MEANING[to.key] ? ` ${to.label} is ${MEANING[to.key]}.` : "";
    const packet = {
      kind: "approval",
      level: to.key === "prod" ? 1 : 2,
      projectId: p.projectId,
      taskId: null,
      askedOf: "human",
      title: clip(`Move the version on ${from.label} to ${to.label}?`, 120),
      situation: clip(`${what}${meaning} ${checks}`.replace(/\s+/g, " ").trim(), 600),
      options: this.approvalOptions({
        approve: `Put this version on ${to.label}. If a check fails, Fulcra puts the previous version back.`,
        keep: `Leave ${to.label} as it is.`,
        destructive,
        blast: `promotion:${id}`,
      }),
      recommendation: null,
      evidence: [
        { ref: `promotion:${id}`, label: "This promotion" },
        { ref: p.commit, label: "The version to promote" },
        { ref: `env:${to.id}`, label: `The ${to.label} environment` },
      ],
      action: { type: "promotion", promotionId: id, digest: p.digest },
      expiresAt: null,
    };
    const decision = await this.ask(packet, childId(messageId, "promotion"), lane, sessionId);
    if (decision)
      this.store.atomic(() =>
        this.update(
          id,
          () => ({ decisionId: decision.id, state: "awaiting-approval" }),
          "asked",
          "system:environments",
          "Asked for the owner's approval",
        ),
      );
  }
  // §3.2 #1: exactly approve and reject. #3 and §6.2 #3: a destructive step makes approving destructive.
  approvalOptions({ approve, keep, destructive, blast }) {
    return [
      {
        id: "approve",
        title: "Approve",
        summary: approve,
        example: "Like moving a rehearsed change onto the real stage, with the old set kept ready.",
        impacts: {
          benefit: "The changes reach the next step",
          cost: "A few minutes of automatic work",
          time: "A few minutes",
          risk: destructive
            ? "One step cannot be undone"
            : "Low: a failed check puts the old version back",
          reversibility: destructive ? "irreversible" : "reversible",
          blastRadius: blast,
        },
        destructive,
      },
      {
        id: "reject",
        title: "Not now",
        summary: keep,
        example: "Like keeping the old sign up for another week.",
        impacts: {
          benefit: "Nothing changes",
          cost: "The changes wait",
          time: "None",
          risk: "None",
          reversibility: "reversible",
          blastRadius: null,
        },
        destructive: false,
      },
    ];
  }
  canAskSystem() {
    return typeof this.control.decisions?.askSystem === "function";
  }
  // The asker (§3.1 askedBy) is derived from the grant: a role lane asks as its own seat through J3's ask. The app
  // (operator) has no session to ask as, so it asks through the decision store's system asker.
  async ask(packet, messageId, lane, sessionId) {
    if (lane.kind === "role")
      return (await this.decisions().ask({ sessionId, messageId, packet }, lane.capability))
        .decision;
    return this.canAskSystem() ? this.askSystem(packet, messageId) : null;
  }
  // v1.15 §3.3 (J8-5, J2-1): the one controller-internal asker with no session,
  //   decisions.askSystem({component, messageId, packet}, {seat?: slug})  →  askedBy {seat, sessionId: null, system}.
  // No session can withdraw or veto it, and nothing is delivered to a session: tick() consumes the choice.
  // INTEGRATION: coded to that exact signature. J3 is adding it on cc/j3-inbox; this base (ee9461f9) predates it, so
  // canAskSystem() is false here and the app lane reports NOT_ASKABLE until the merge. Its result is read like ask()'s.
  async askSystem(packet, messageId) {
    const result = await this.decisions().askSystem(
      { component: "environments", messageId, packet },
      {},
    );
    const decision = result?.decision ?? null;
    if (!decision || !uuid(decision.id))
      throw new EnvironmentRefused("The decision store did not return the question it asked");
    return decision;
  }
  promotionCancel(a) {
    if (
      !keys(a, ["messageId", "id", "expectedRevision", "note"]) ||
      !uuid(a.messageId) ||
      !uuid(a.id) ||
      !Number.isInteger(a.expectedRevision) ||
      typeof a.note !== "string" ||
      a.note.length > 500
    )
      throw new EnvironmentRefused("Invalid cancel");
    const p = this.promotion(a.id);
    if (!p) throw new EnvironmentRefused("No promotion has that id");
    if (this.db.prepare("SELECT id FROM cc_promotion_history WHERE id=?").get(a.messageId))
      return this.promotionResult(a.id);
    if (p.revision !== a.expectedRevision) throw new EnvironmentRefused(STALE_REVISION);
    if (!["proposed", "awaiting-approval", "approved"].includes(p.state))
      throw new EnvironmentRefused(`This promotion is ${p.state} and can no longer be cancelled`);
    this.store.atomic(() => {
      const before = this.promotion(a.id),
        next = {
          ...before,
          state: "cancelled",
          revision: before.revision + 1,
          log: this.log(before, "deploy", ["Cancelled by the operator; nothing ran"]),
        };
      this.db
        .prepare("UPDATE cc_promotions SET state=?,revision=?,json=?,updatedAt=? WHERE id=?")
        .run("cancelled", next.revision, JSON.stringify(next), this.iso(), a.id);
      this.history(
        "cc_promotion_history",
        a.messageId,
        a.id,
        "cancelled",
        before,
        { promotion: next },
        next.revision,
        "operator",
        a.note || "Cancelled",
      );
    });
    this.aborts.get(a.id)?.abort(); // setup checks still running are stopped, with their whole process group
    return this.promotionResult(a.id);
  }

  // ---- the watcher and the runner (§6.2 #2, #4) ---------------------------------------------------------------
  // Called without awaiting from the controller's refresh chain, like the decision pump: single-flight, throttled.
  pump() {
    if (this.control.closing) return Promise.resolve();
    if (this.pumping) return this.pumping;
    const now = this.now();
    if (now - this.lastPump < this.pumpEveryMs) return Promise.resolve();
    this.lastPump = now;
    this.pumping = this.tick()
      .catch(() => {})
      .finally(() => {
        this.pumping = null;
      });
    return this.pumping;
  }
  async tick() {
    for (const row of this.db
      .prepare("SELECT * FROM cc_environments WHERE pendingDecisionId IS NOT NULL")
      .all()) {
      const packet = this.decisions().packet(row.pendingDecisionId);
      if (!packet || packet.state === "open") continue;
      if (packet.state === "chosen" && packet.choice.optionId === "approve") {
        try {
          await this.decisions().approvalFor({
            decisionId: packet.id,
            revision: packet.revision,
            action: packet.action,
          });
          this.applyApprovedDefinition(row, packet);
        } catch {
          this.dropPending(
            row,
            "lapsed",
            "The approval did not match the proposed change, so the old definition stays",
          );
        }
      } else
        this.dropPending(
          row,
          packet.state === "chosen" ? "rejected" : "lapsed",
          packet.state === "chosen"
            ? "Not approved; the old definition stays"
            : `The approval was ${packet.state}; the old definition stays`,
        );
    }
    for (const row of this.db
      .prepare("SELECT * FROM cc_promotions WHERE state IN ('awaiting-approval','approved')")
      .all()) {
      if (this.running.has(row.id)) continue;
      const p = JSON.parse(row.json),
        packet = this.decisions().packet(p.decisionId);
      if (!packet || packet.state === "open") continue;
      if (packet.state !== "chosen") {
        this.finish(p.id, "cancelled", "deploy", [`The approval was ${packet.state}; nothing ran`]);
        continue;
      }
      if (packet.choice.optionId !== "approve") {
        this.finish(p.id, "cancelled", "deploy", ["Not approved; nothing ran"]);
        continue;
      }
      const run = this.run(p.id, {
        decisionId: packet.id,
        revision: packet.revision,
        action: packet.action,
      }).finally(() => this.running.delete(p.id));
      this.running.set(p.id, run);
    }
  }
  finish(id, state, step, lines, actor = "system:environments") {
    this.store.atomic(() =>
      this.update(
        id,
        (p) => ({ state, log: this.log(p, step, lines) }),
        state,
        actor,
        lines.at(-1) ?? state,
      ),
    );
  }
  /**
   * Runs an approved promotion: deploy → verify → (on failure) rollback. It re-presents the exact packet to
   * approvalFor first, so a digest change after the approval (steps, readiness, commit) stops it before anything runs.
   */
  async run(id, approval) {
    try {
      await this.decisions().approvalFor(approval);
    } catch (error) {
      const changed = /changed after you were asked/i.test(error.message);
      this.finish(id, changed ? "cancelled" : this.promotion(id).state, "deploy", [
        changed
          ? "The plan changed after it was approved, so nothing ran. Prepare it again."
          : "Waiting for an approval on the owner's paired device",
      ]);
      return;
    }
    const p = this.promotion(id),
      to = this.environment(p.to),
      sha = shaOf(p.commit);
    let checkout = null,
      candidate = null;
    const context = (step) => ({
      environment: to.key,
      commit: sha,
      promotion: id,
      step,
      candidate,
    });
    this.store.atomic(() =>
      this.update(
        id,
        (x) => ({
          state: "running",
          log: this.log(x, "deploy", ["Approved on the owner's paired device; starting"]),
        }),
        "approved",
        "human",
        "Approved",
      ),
    );
    const abort = new AbortController();
    this.aborts.set(id, abort);
    const step = async (name, state) => {
      if (state)
        this.store.atomic(() =>
          this.update(id, (x) => ({ state }), state, "system:environments", `${name} started`),
        );
      const result = await this.script(id, name, checkout, to.steps[name], context(name));
      if (result.cancelled) throw STOPPED;
      this.store.atomic(() =>
        this.update(
          id,
          (x) => ({
            log: this.log(x, name, [
              ...result.lines,
              result.ok ? `${name} finished` : `${name} failed`,
            ]),
          }),
          `${name}-${result.ok ? "ok" : "failed"}`,
          "system:environments",
          `${name} ${result.ok ? "finished" : "failed"}`,
        ),
      );
      return result.ok;
    };
    let outcome;
    try {
      ({ checkout, candidate } = await this.checkouts(this.resolveRepo(to.repo), to, sha));
      if ((await step("deploy")) && (await step("verify", "verifying"))) outcome = "succeeded";
      else outcome = (await step("rollback", "rolling-back")) ? "rolled-back" : "failed";
    } catch (error) {
      if (error === STOPPED) outcome = "stopped";
      else {
        this.store.atomic(() =>
          this.update(
            id,
            (x) => ({
              log: this.log(x, "deploy", [
                error instanceof EnvironmentRefused
                  ? error.message
                  : "The promotion could not start",
              ]),
            }),
            "error",
            "system:environments",
            "Could not start",
          ),
        );
        outcome = "failed";
      }
    } finally {
      this.aborts.delete(id);
      for (const dir of [checkout, candidate]) if (dir) removeCheckout(dir, this.checkoutRoot);
    }
    const note = {
      succeeded: `Now on ${to.label}`,
      "rolled-back": `A step failed, so the previous version was put back`,
      failed: "A step failed and the undo step did not finish; check the environment",
      stopped:
        "Stopped before it finished because the controller was shutting down; what finished is unknown. Check the environment.",
    }[outcome];
    const state = outcome === "stopped" ? "failed" : outcome,
      status = outcome === "stopped" ? "unknown" : outcome;
    this.store.atomic(() => {
      this.update(
        id,
        (x) => ({
          state,
          log: this.log(x, outcome === "succeeded" ? "verify" : "rollback", [note]),
        }),
        outcome,
        "system:environments",
        note,
      );
      this.recordDeployment({
        environmentId: to.id,
        projectId: to.projectId,
        commit: p.commit,
        promotionId: id,
        status,
        note,
        by: "human",
      });
    });
  }
  recordDeployment({ environmentId, projectId, commit, promotionId, status, note, by }) {
    const d = {
      id: randomUUID(),
      environmentId,
      version: { commit, tag: null },
      at: this.iso(),
      by,
      promotionId,
      status,
      note: clip(note, LIMITS.deploymentNote),
    };
    this.db
      .prepare("INSERT INTO cc_deployments VALUES (?,?,?,?,?,?,?)")
      .run(d.id, environmentId, projectId, promotionId, status, d.at, JSON.stringify(d));
    // Deployments are derived records: keep the newest per environment and rotate, never refuse (§1 Capacity).
    this.db
      .prepare(
        "DELETE FROM cc_deployments WHERE environmentId=? AND id NOT IN (SELECT id FROM cc_deployments WHERE environmentId=? ORDER BY at DESC, rowid DESC LIMIT ?)",
      )
      .run(environmentId, environmentId, ENVIRONMENT_LIMITS.deploymentsPerEnvironment);
    return d;
  }
  // A promotion that was running when the controller stopped is not resumed: what finished is unknown.
  // v1.15 §6.2 (J8-7): a script's process group recorded on the promotion is stopped if it is still there, or
  // reported if it cannot be. A group recorded under an earlier boot of this machine cannot be running, and its id may
  // since belong to something else, so it is never signalled.
  recoverInterrupted() {
    for (const row of this.db
      .prepare(
        "SELECT * FROM cc_promotions WHERE state IN ('running','verifying','rolling-back') OR processGroup IS NOT NULL",
      )
      .all()) {
      const p = JSON.parse(row.json),
        to = this.environment(p.to),
        group = row.processGroup ? JSON.parse(row.processGroup) : null;
      const left = group ? this.recoverGroup(group) : null,
        interrupted = ["running", "verifying", "rolling-back"].includes(row.state);
      this.store.atomic(() => {
        if (left)
          this.update(
            row.id,
            (x) => ({ log: this.log(x, group.step === "check" ? "verify" : group.step, [left]) }),
            "recovered-processes",
            "system:environments",
            left,
          );
        if (interrupted) {
          this.update(
            row.id,
            (x) => ({
              state: "failed",
              log: this.log(x, "rollback", [
                "The controller restarted during this promotion; what finished is unknown. Check the environment.",
              ]),
            }),
            "interrupted",
            "system:environments",
            "Interrupted by a restart",
          );
          if (to)
            this.recordDeployment({
              environmentId: to.id,
              projectId: to.projectId,
              commit: p.commit,
              promotionId: row.id,
              status: "unknown",
              note: "Interrupted by a restart; not observed",
              by: "system:environments",
            });
        }
        this.db.prepare("UPDATE cc_promotions SET processGroup=NULL WHERE id=?").run(row.id);
      });
    }
    this.db.prepare("UPDATE cc_promotions SET preparing=0 WHERE preparing=1").run();
  }
  recoverGroup({ pgid, owner, step, bootAt }) {
    const what = step === "check" ? "setup check" : `${step} step`;
    if (!Number.isSafeInteger(bootAt) || Math.abs(bootTime() - bootAt) > 60)
      return `The machine has restarted since the ${what} ran, so nothing it started is still running.`;
    if (!groupAlive(pgid)) return `Nothing the interrupted ${what} started is still running.`;
    const killed = recoverOwnedGroup(pgid, owner);
    if (killed === "unverified")
      return `The interrupted ${what} has an unverified process owner; no processes were signalled. Check the environment by hand.`;
    if (killed === "killed") return `Stopped what the interrupted ${what} had left running.`;
    if (killed === "denied")
      return `Something the interrupted ${what} started may still be running, and Fulcra could not stop it (process group ${pgid}). Stop it by hand.`;
    return `Nothing the interrupted ${what} started is still running.`;
  }
  /** Controller shutdown: let running work finish for up to `waitMs`, then stop every script's process group. */
  async stop(waitMs = 10000) {
    const work = () => Promise.allSettled([...this.preparing.values(), ...this.running.values()]);
    let timer;
    const finished = await Promise.race([
      work().then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), waitMs);
      }),
    ]);
    clearTimeout(timer);
    if (!finished) for (const abort of this.aborts.values()) abort.abort();
    await work();
  }
}
export { EnvironmentRefused, KEY };
