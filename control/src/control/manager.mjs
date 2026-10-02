import { configuredHost } from "./portable-host.mjs";
import { controlHome } from "./home.mjs";
import fs from "node:fs";
import path from "node:path";
import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { hash } from "./store.mjs";
import { SourceChanged, uuid, authorityKey } from "./authority.mjs";
import { resumeOrganization, recoverResumption } from "./resumption.mjs";
import { workerArtifacts } from "./worker-artifacts.mjs";
import { AUTOMATION_LIMIT, JOURNAL_CAPACITY, deliveryCount } from "./journal-capacity.mjs";
import { explicitSelection } from "./provider-mode.mjs";
const keys = (a, expected) =>
  a && typeof a === "object" && !Array.isArray(a) && Object.keys(a).sort().join() === expected;
export class Manager {
  constructor(control, directory = path.join(controlHome(), "grants/manager")) {
    this.creating = new Map();
    this.control = control;
    this.store = control.store;
    this.db = this.store.db;
    this.directory = directory;
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS manager_grants(supervisor TEXT PRIMARY KEY,generation INTEGER NOT NULL,epoch TEXT NOT NULL,token TEXT NOT NULL,maxWorkers INTEGER NOT NULL,reason TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS manager_workers(request TEXT PRIMARY KEY,supervisor TEXT NOT NULL,epoch TEXT NOT NULL,body TEXT NOT NULL,worker TEXT UNIQUE,generation INTEGER,phase TEXT NOT NULL,nativeRequest TEXT UNIQUE NOT NULL);
      CREATE TABLE IF NOT EXISTS manager_origins(worker TEXT PRIMARY KEY,record TEXT NOT NULL);`);
  }
  resume(a) {
    return resumeOrganization(this, a);
  }
  recoverResume(record) {
    return recoverResumption(this, record);
  }
  local(id, token, epoch) {
    const grant = this.db.prepare("SELECT * FROM manager_grants WHERE supervisor=?").get(id),
      s = this.store.get(id);
    if (
      !grant ||
      s?.mode !== "delegated" ||
      s.generation !== grant.generation ||
      (epoch !== undefined && epoch !== grant.epoch) ||
      !timingSafeEqual(
        Buffer.from(grant.token),
        Buffer.from(hash(typeof token === "string" ? token : "")),
      )
    )
      throw Error("Manager authority revoked or invalid");
    return { ...grant, task: s.task, authority: s.authority, boot: s.boot, grantedAt: s.grantedAt };
  }
  async check(id, token, epoch) {
    const grant = this.local(id, token, epoch);
    const observed = await this.control.inspect(id);
    if (observed.observed.boot !== grant.boot || observed.observed.humanAt >= grant.grantedAt)
      throw Error("Manager native control changed");
    if (authorityKey(await this.control.authority(grant.task)) !== grant.authority)
      throw Error("Manager task authority changed");
    return this.local(id, token, grant.epoch);
  }
  // Track 1b: taskId limits the summary to supervisors of that task BEFORE the per-worker reads (158 calls per request).
  summary(taskId) {
    const grants = this.db
      .prepare("SELECT supervisor,generation,epoch,maxWorkers FROM manager_grants ORDER BY rowid")
      .all();
    return (
      taskId === undefined
        ? grants
        : grants.filter((g) => this.store.get(g.supervisor)?.task === taskId)
    ).map((g) => {
      const s = this.store.get(g.supervisor),
        active = s?.mode === "delegated" && s.generation === g.generation;
      const workers = this.db
        .prepare(
          "SELECT request,worker,generation,phase,epoch,nativeRequest FROM manager_workers WHERE supervisor=? ORDER BY rowid",
        )
        .all(g.supervisor)
        .map((w) => {
          const event =
            w.worker &&
            this.db
              .prepare(
                "SELECT kind,state,consumed,at FROM event_inbox WHERE worker=? AND supervisor=? ORDER BY rowid DESC LIMIT 1",
              )
              .get(w.worker, g.supervisor);
          const fault =
            w.worker &&
            this.db.prepare("SELECT reason FROM event_faults WHERE worker=?").get(w.worker);
          const creation =
            w.phase === "attached"
              ? null
              : {
                  startedAt: this.creating.get(g.supervisor + ":" + w.request) ?? null,
                  nativeState: this.store.delivery(w.nativeRequest)?.state ?? null,
                  generation: w.generation,
                };
          return {
            requestId: w.request,
            workerId: w.worker,
            phase: w.phase,
            creation,
            ownership: this.ownership(g, active, w),
            lastEvent: event ? { ...event, consumed: event.consumed !== null } : null,
            fault: fault?.reason.slice(0, 2000) ?? null,
          };
        });
      return {
        id: g.supervisor,
        task: s.task,
        active,
        maxWorkers: g.maxWorkers,
        reserved: workers.length,
        workers,
      };
    });
  }
  async promote(a) {
    this.control.native.assertLocal?.(a?.sessionId);
    if (
      !keys(a, "expectedGeneration,maxWorkers,reason,sessionId") ||
      !uuid(a.sessionId) ||
      !Number.isSafeInteger(a.expectedGeneration) ||
      !Number.isSafeInteger(a.maxWorkers) ||
      a.maxWorkers < 1 ||
      a.maxWorkers > 6 ||
      typeof a.reason !== "string" ||
      a.reason.length < 12 ||
      a.reason.length > 2000
    )
      throw Error("Invalid supervisor role request");
    const session = this.store.get(a.sessionId);
    if (!session || session.mode !== "human" || session.generation !== a.expectedGeneration)
      throw Error(
        "Promotion requires an unchanged human-owned session; an existing role is not rotated",
      );
    if (
      this.db
        .prepare("SELECT worker FROM event_links WHERE worker=? OR supervisor=?")
        .get(a.sessionId, a.sessionId)
    )
      throw Error("Existing worker links require explicit reassociation before another role");
    const capable = this.db
      .prepare(
        "SELECT id FROM deliveries WHERE kind='create' AND state='delivered' AND json_extract(result,'$.id')=? AND json_extract(result,'$.managerToolsVersion')='1'",
      )
      .get(a.sessionId);
    if (!capable)
      throw Error(
        "Create a new supervisor-capable session first; a native label alone is insufficient",
      );
    const delegated = await this.control.handback(a.sessionId, a.reason, a.expectedGeneration);
    try {
      await this.grant({
        ...a,
        expectedGeneration: delegated.generation,
        capability: delegated.capability,
      });
    } catch (e) {
      const current = this.store.get(a.sessionId);
      if (current?.mode === "delegated" && current.generation === delegated.generation)
        this.control.takeover(a.sessionId, "Supervisor role grant failed; preserve human control");
      throw Error(
        "Supervisor role failed; automation was revoked unless a newer control transfer already won. Refresh before retrying: " +
          e.message,
        { cause: e },
      );
    }
    return { sessionId: a.sessionId, generation: delegated.generation, maxWorkers: a.maxWorkers };
  }
  async grant(a) {
    this.control.native.assertLocal?.(a?.sessionId);
    if (
      !keys(a, "capability,expectedGeneration,maxWorkers,reason,sessionId") ||
      !uuid(a.sessionId) ||
      !Number.isSafeInteger(a.expectedGeneration) ||
      !Number.isSafeInteger(a.maxWorkers) ||
      a.maxWorkers < 1 ||
      a.maxWorkers > 6 ||
      typeof a.reason !== "string" ||
      a.reason.length < 12 ||
      a.reason.length > 2000
    )
      throw Error("Invalid manager grant");
    const s = this.store.check(a.sessionId, a.capability);
    if (s.generation !== a.expectedGeneration) throw Error("Control changed before manager grant");
    return this.issue(s, a, () => this.store.check(s.id, a.capability));
  }
  // G1 (G-FIXES-REPORT.md): an operator seating a project orchestrator may grant it manager authority in the same
  // call. The operator secret already authorizes more than a session capability (takeover/handback), so this skips
  // only store.check; every other fence of grant() applies through issue(): delegated at the expected generation,
  // unchanged native boot and no human input since delegation, unchanged task authority, and the 32-manager cap.
  async grantSeated(a, stillSeated = () => true, record = () => {}) {
    this.control.native.assertLocal?.(a?.sessionId);
    if (
      !keys(a, "expectedGeneration,maxWorkers,reason,sessionId") ||
      !uuid(a.sessionId) ||
      !Number.isSafeInteger(a.expectedGeneration) ||
      !Number.isSafeInteger(a.maxWorkers) ||
      a.maxWorkers < 1 ||
      a.maxWorkers > 6 ||
      typeof a.reason !== "string" ||
      a.reason.length < 12 ||
      a.reason.length > 2000
    )
      throw Error("Invalid seated manager grant");
    // REVIEW-G G-1: the seat is re-checked with the delegation after every await, so a seat lost mid-grant grants nothing.
    const current = () => {
      const s = this.store.get(a.sessionId);
      if (!s || s.mode !== "delegated")
        throw Error(
          "A manager grant at seating needs a delegated session; delegate it, then grant",
        );
      if (!stillSeated()) throw Error("The seat changed during the manager grant");
      return s;
    };
    const s = current();
    if (s.generation !== a.expectedGeneration) throw Error("Control changed before manager grant");
    return this.issue(s, a, current, record);
  }
  async issue(s, a, recheck, record = () => {}) {
    const observed = await this.control.inspect(s.id);
    if (observed.observed.boot !== s.boot || observed.observed.humanAt >= s.grantedAt)
      throw Error("Supervisor native control changed before grant");
    if (authorityKey(await this.control.authority(s.task)) !== s.authority)
      throw Error("Task authority changed");
    const fresh = recheck();
    if (fresh.generation !== s.generation) throw Error("Control changed during manager grant");
    if (
      !this.db.prepare("SELECT supervisor FROM manager_grants WHERE supervisor=?").get(s.id) &&
      this.db.prepare("SELECT count(*) n FROM manager_grants").get().n >= 32
    )
      throw Error("Manager capacity reached");
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(this.directory) !== this.directory || !uuid(path.basename(s.cwd)))
      throw Error("Invalid manager grant directory");
    const token = randomBytes(32).toString("base64url"),
      epoch = randomUUID(),
      file = path.join(this.directory, path.basename(s.cwd) + ".json"),
      tmp = file + "." + epoch;
    fs.writeFileSync(tmp, JSON.stringify({ sessionId: s.id, capability: token }), {
      mode: 0o600,
      flag: "wx",
      flush: true,
    });
    fs.renameSync(tmp, file);
    // REVIEW-G G-1: a seat-conferred grant is recorded against its seat in the same synchronous step as the grant
    // itself -- after the last re-check and before any await -- so a seat vacated at any point either refuses the
    // grant here or finds the record and revokes it. Recorded after an await, a vacate in that gap left it unowned.
    this.store.atomic(() => {
      this.db
        .prepare("INSERT OR REPLACE INTO manager_grants VALUES (?,?,?,?,?,?)")
        .run(s.id, s.generation, epoch, hash(token), a.maxWorkers, a.reason);
      record(epoch);
    });
    // G2: the manager's own inbox (worker completions, permission escalations, leadership handoffs) is readable from
    // the grant onwards, not only after its first worker is attached.
    const inboxFile = this.control.events?.issueInbox(s) ?? null;
    return {
      sessionId: s.id,
      generation: s.generation,
      epoch,
      maxWorkers: a.maxWorkers,
      grantFile: file,
      inboxFile,
    };
  }
  // One ownership derivation for summary() and the allowance (G27), so the two can never disagree:
  //   linked      -- this grant's worker, attached, with a valid supervision link at the recorded generations;
  //   unresolved  -- this grant's creation still in flight (reserved/created/delegated; create() resumes it by messageId);
  //   orphaned    -- anything else: an inactive supervisor, an earlier grant epoch, or an attached worker whose link was
  //                  lost (taken over, an observed archive, a changed generation).
  ownership(g, active, w) {
    const link =
      w.worker && this.db.prepare("SELECT * FROM event_links WHERE worker=?").get(w.worker);
    const linked =
      active &&
      w.epoch === g.epoch &&
      w.phase === "attached" &&
      link?.supervisor === g.supervisor &&
      link.workerGeneration === w.generation &&
      this.control.events.valid(link, true);
    return linked
      ? "linked"
      : !active || w.epoch !== g.epoch || w.phase === "attached"
        ? "orphaned"
        : "unresolved";
  }
  // G27: the allowance caps CONCURRENT live workers, not lifetime creations. Counting every row ever created left a
  // supervisor whose workers were all orphaned unable to create again, and re-granting did not help. Only 'linked' and
  // 'unresolved' rows count. Called from create() after check(), so the supervisor is active under this grant.
  liveWorkers(grant) {
    return this.db
      .prepare("SELECT worker,generation,phase,epoch FROM manager_workers WHERE supervisor=?")
      .all(grant.supervisor)
      .filter((w) => this.ownership(grant, true, w) !== "orphaned").length;
  }
  // Typed like ingress.scope: a definite ownership fact, distinguishable from a failed read.
  owned(grant, worker) {
    const owned = this.db
      .prepare("SELECT * FROM manager_workers WHERE worker=? AND supervisor=? AND epoch=?")
      .get(worker, grant.supervisor, grant.epoch);
    const link = this.db.prepare("SELECT * FROM event_links WHERE worker=?").get(worker);
    if (
      !owned ||
      owned.phase !== "attached" ||
      !link ||
      link.supervisor !== grant.supervisor ||
      link.workerGeneration !== owned.generation ||
      link.supervisorGeneration !== grant.generation ||
      !this.control.events.valid(link)
    )
      throw new SourceChanged("Worker is not currently delegated to this manager");
    return link;
  }
  async workers(a, token) {
    if (!keys(a, "sessionId")) throw Error("Invalid manager listing");
    const grant = await this.check(a.sessionId, token);
    return this.db
      .prepare(
        "SELECT request,worker,generation,phase,body,epoch FROM manager_workers WHERE supervisor=? ORDER BY rowid",
      )
      .all(a.sessionId)
      .map((r) => {
        let current = r.epoch === grant.epoch;
        // Type-insensitive on purpose: this is a listing, and marking a row orphaned is the conservative
        // answer for any failure, including a read that did not work. No authority is decided here.
        if (current && r.phase === "attached") {
          try {
            this.owned(grant, r.worker);
          } catch {
            current = false;
          }
        }
        return {
          ...r,
          state: current ? r.phase : "orphaned",
          specification: JSON.parse(r.body),
          body: undefined,
        };
      });
  }
  async create(a, token) {
    // DESIGN-NEXT-BUILD A3: a manager's worker is an implementation session. The provider may be left to that role's
    // configured preference (prime Q1); it is resolved here because it is part of the stored worker specification.
    // Update-7 W3 (gap a): the role default's provider when none is chosen, checked on this host before any reservation.
    if (a && a.provider === undefined && typeof a === "object" && !Array.isArray(a))
      a = {
        ...a,
        provider: (
          await this.control.resolveProvider({
            role: "implementation",
            ...(a.host !== undefined ? { host: a.host } : {}),
          })
        ).provider,
      };
    // Update-7 W3: an explicit model / effort wins over the implementation default; it joins the stored specification
    // only when given, so a reservation made without one keeps its identity on retry.
    let defaults;
    if (
      a &&
      typeof a === "object" &&
      !Array.isArray(a) &&
      (a.model !== undefined || a.effort !== undefined)
    ) {
      const { model, effort, ...rest } = a;
      a = rest;
      if (["claude", "codex"].includes(a.provider))
        defaults = explicitSelection(a.provider, { model, effort });
    }
    if (
      !(
        keys(a, "messageId,provider,sessionId,title") ||
        keys(a, "host,messageId,provider,sessionId,title")
      ) ||
      (a.host !== undefined && !configuredHost(a.host)) ||
      !uuid(a.messageId) ||
      !["claude", "codex"].includes(a.provider) ||
      typeof a.title !== "string" ||
      a.title.length < 3 ||
      a.title.length > 120
    )
      throw Error("Invalid managed create");
    return this.control.exclusive("manager:" + a.sessionId, async () => {
      this.creating.set(a.sessionId + ":" + a.messageId, Date.now());
      try {
        const grant = await this.check(a.sessionId, token),
          specification = {
            taskId: grant.task,
            provider: a.provider,
            title: a.title,
            ...(a.host !== undefined ? { host: a.host } : {}),
            ...(defaults ? { defaults } : {}),
          },
          encoded = JSON.stringify(specification);
        let reservation = this.db
          .prepare("SELECT * FROM manager_workers WHERE request=?")
          .get(a.messageId);
        if (
          reservation &&
          (reservation.supervisor !== a.sessionId ||
            reservation.epoch !== grant.epoch ||
            reservation.body !== encoded)
        )
          throw Error("Manager creation identity conflict");
        // Checked where the worker will run, before the reservation: an unlisted model reserves nothing.
        if (!reservation && defaults)
          await this.control.checkOverride({
            provider: a.provider,
            defaults,
            ...(a.host !== undefined ? { host: a.host } : {}),
          });
        if (!reservation) {
          if (this.store.delivery(a.messageId))
            throw Error("Creation identity already belongs to another operation");
          const live = this.liveWorkers(grant);
          if (live >= grant.maxWorkers)
            throw Error(
              `Manager worker allowance reached: ${live} live workers of ${grant.maxWorkers}; orphaned, archived and taken-over workers do not count`,
            );
          const reserved = this.db
            .prepare(
              "SELECT count(*) n FROM manager_workers w JOIN manager_grants g ON g.supervisor=w.supervisor AND g.epoch=w.epoch JOIN sessions s ON s.id=g.supervisor AND s.generation=g.generation WHERE w.phase!='attached' AND s.mode='delegated'",
            )
            .get().n;
          // Two distinct limits, reported distinctly: live supervision links, and the journal's automation budget (a new
          // worker needs its create, its handback and later wakes). One message for both hid which one was hit (G3).
          const links = this.control.events.links().length,
            journal = deliveryCount(this.db);
          if (links + reserved >= 32)
            throw Error(
              `Supervision link capacity reached before creation: ${links} live links and ${reserved} pending creations of 32`,
            );
          if (journal >= AUTOMATION_LIMIT - 2)
            throw Error(
              `Journal automation budget reached before creation: ${journal} deliveries recorded, automation stops at ${AUTOMATION_LIMIT} to keep ${JOURNAL_CAPACITY - AUTOMATION_LIMIT} for manual control`,
            );
          const nativeRequest = randomUUID();
          this.db
            .prepare("INSERT INTO manager_workers VALUES (?,?,?,?,NULL,NULL,'reserved',?)")
            .run(a.messageId, a.sessionId, grant.epoch, encoded, nativeRequest);
        }
        reservation = this.db
          .prepare("SELECT * FROM manager_workers WHERE request=?")
          .get(a.messageId);
        // Update-7: the worker records this manager as its parent and the manager's own declared project (the operator's
        // recorded ownership of the manager's creation); a manager with none gives none -- nothing is inferred.
        // The role travels beside the stored specification, never inside it, so a reservation made before roles existed
        // keeps its identity on retry.
        const delivery = await this.control.create(
          { ...specification, role: "implementation", messageId: reservation.nativeRequest },
          {
            fresh: true,
            parent: a.sessionId,
            project: this.control.roleSessions?.owner(a.sessionId)?.projectId ?? null,
          },
          { automated: true },
        );
        if (delivery.state !== "delivered")
          return {
            reservation: a.messageId,
            state: delivery.state,
            operatorRecoveryRequired: true,
          };
        const worker = delivery.result.id;
        this.db
          .prepare(
            "UPDATE manager_workers SET worker=?,phase=CASE WHEN phase='reserved' THEN 'created' ELSE phase END WHERE request=?",
          )
          .run(worker, a.messageId);
        await this.check(a.sessionId, token, grant.epoch);
        reservation = this.db
          .prepare("SELECT * FROM manager_workers WHERE request=?")
          .get(a.messageId);
        if (reservation.phase === "created") {
          await this.control.native.verifyNew(worker, reservation.nativeRequest, grant.task);
          const observed = await this.control.inspect(worker);
          if (
            observed.generation !== 1 ||
            observed.mode !== "human" ||
            observed.observed.lastPromptId !== null ||
            observed.observed.humanAt !== 0 ||
            !["idle", "closed"].includes(observed.observed.status) ||
            observed.observed.pending
          )
            throw Error("New worker was touched; explicit operator recovery required");
          await this.check(a.sessionId, token, grant.epoch);
          const delegated = await this.control.handback(
            worker,
            "Manager delegates its newly created untouched worker",
            1,
            true,
          );
          this.db
            .prepare("UPDATE manager_workers SET generation=?,phase='delegated' WHERE request=?")
            .run(delegated.generation, a.messageId);
        }
        await this.check(a.sessionId, token, grant.epoch);
        reservation = this.db
          .prepare("SELECT * FROM manager_workers WHERE request=?")
          .get(a.messageId);
        if (reservation.phase === "delegated") {
          const w = this.store.get(worker);
          if (w.mode !== "delegated" || w.generation !== reservation.generation)
            throw Error("Worker control changed before attachment");
          await this.control.events.attach(
            {
              workerId: worker,
              supervisorId: a.sessionId,
              capability: "",
              reason: "Manager owns the newly created worker and its review loop",
            },
            grant.generation,
          );
          this.local(a.sessionId, token, grant.epoch);
          this.db
            .prepare("UPDATE manager_workers SET phase='attached' WHERE request=?")
            .run(a.messageId);
        }
        this.owned(grant, worker);
        await this.control.permissions?.inherit(worker, a.sessionId);
        return {
          sessionId: worker,
          cwd: this.store.get(worker).cwd,
          state: "ready",
          accepted: false,
          generation: reservation.generation,
        };
      } finally {
        this.creating.delete(a.sessionId + ":" + a.messageId);
      }
    });
  }
  async inspect(a, token) {
    if (!keys(a, "sessionId,workerId") || !uuid(a.workerId))
      throw Error("Invalid manager inspection");
    const grant = await this.check(a.sessionId, token);
    this.owned(grant, a.workerId);
    const result = await this.control.inspect(a.workerId);
    this.local(a.sessionId, token, grant.epoch);
    this.owned(grant, a.workerId);
    const idle = (s) => ["idle", "closed"].includes(s.observed.status) && !s.observed.pending;
    if (!idle(result))
      return {
        ...result,
        artifacts: {
          state: "unavailable",
          untrusted: true,
          files: [],
          error: "Worker must be idle before inspecting declared artifacts",
        },
      };
    const artifacts = this.control.native.route?.(a.workerId)
      ? (
          await this.control.native.artifacts({
            sessionId: a.workerId,
            taskId: grant.task,
            expectedGeneration: result.generation,
          })
        ).artifacts
      : workerArtifacts(result.cwd);
    await this.check(a.sessionId, token, grant.epoch);
    const fresh = await this.control.inspect(a.workerId);
    this.local(a.sessionId, token, grant.epoch);
    this.owned(grant, a.workerId);
    if (
      !idle(fresh) ||
      fresh.cwd !== result.cwd ||
      fresh.generation !== result.generation ||
      fresh.observed.boot !== result.observed.boot ||
      fresh.observed.nativeId !== result.observed.nativeId ||
      fresh.observed.lastPromptId !== result.observed.lastPromptId
    )
      throw Error("Worker changed during artifact inspection");
    return { ...fresh, artifacts };
  }
  async assign(a, token) {
    if (!keys(a, "messageId,sessionId,text,workerId") || !uuid(a.workerId))
      throw Error("Invalid manager assignment");
    const grant = await this.check(a.sessionId, token),
      link = this.owned(grant, a.workerId);
    const supervision = {
      supervisor: grant.supervisor,
      generation: grant.generation,
      epoch: grant.epoch,
      linkEpoch: link.epoch,
    };
    // H7 item 5: a worker waiting on a question is answered with this text (questions.mjs), under the same ownership check.
    if (this.control.questions && (await this.control.questions.answers(a.workerId, a.messageId))) {
      const r = await this.control.questions.answer({
        sessionId: a.workerId,
        messageId: a.messageId,
        text: a.text,
        generation: link.workerGeneration,
        check: () => {
          this.local(a.sessionId, token, grant.epoch);
          if (this.owned(grant, a.workerId).epoch !== link.epoch)
            throw Error("Worker ownership changed");
        },
      });
      return {
        ...r,
        answered: true,
        note: "The worker was waiting on a question; your text was given to it as the answer.",
      };
    }
    return this.control.send(
      { sessionId: a.workerId, messageId: a.messageId, text: a.text },
      undefined,
      link.workerGeneration,
      {
        binding: supervision,
        source: { kind: "manager", ...supervision },
        check: () => {
          this.local(a.sessionId, token, grant.epoch);
          if (this.owned(grant, a.workerId).epoch !== link.epoch)
            throw Error("Worker ownership changed");
        },
      },
    );
  }
}
