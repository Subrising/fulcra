import { launchNativeQueued } from "./native-queued-launcher.mjs";
import { IntercomRates } from "./intercom-rates.mjs";
import { takeOverSession } from "./session-takeover.mjs";
import { poolRoot } from "./account-rotation.mjs";
import { reconcileBootstrap } from "./native-bootstrap.mjs";
import { isNativeAdmissionRefusal } from "./trusted-native-input.mjs";
import { configuredHost } from "./portable-host.mjs";
import { roleProvider, roleDefaultProvider } from "./provider-mode.mjs";
import { DEFAULT_ROLES as SESSION_ROLES } from "../../orca-organization/server/role-defaults-store.mjs"; // update-7: the five roles
import { delegationFence } from "./native-fence.mjs";
import {
  reestablishable,
  observationStable,
  sessionQuiescent,
  ensureReestablishmentJournal,
  REVOKE,
  OPERATOR,
  SWEEP,
} from "./boot-reestablishment.mjs";
import { humanLogVerdict } from "./human-log.mjs";
import { bootChainVerdict } from "./boot-chain.mjs";
import { CONTROLLER_HOME } from "./installation-settings.mjs";
import { Recovery } from "./recovery.mjs";
import { carryAuthority } from "./carry.mjs";
import { ownedBySeat } from "./seat-sweep.mjs";
// States a deliveries row can hold that mean the controller actually put this prompt on the wire.
// 'refused' and 'queued' are deliberately absent: a refused send never ran, and a queued one has not
// been dispatched, so neither may excuse a prompt from the fence.
const DISPATCHED_STATES = ["intent", "uncertain", "delivered"];
// L40: how long a finished management request still answers a same-request retry with its prior id.
export const MANAGEMENT_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;
import { Ingress } from "./ingress.mjs";
import { hash } from "./store.mjs";
import { authorityKey, uuid, authorizeTask, RecipientBusy } from "./authority.mjs";
import { readResult } from "./result.mjs";
import { Notifications, projectNotification } from "./notifications.mjs";
import { TaskAllowance } from "./allowance.mjs";
import { QuotaRuntime } from "./quota-runtime.mjs";
import { randomUUID } from "node:crypto";
import { AUTOMATION_LIMIT, JOURNAL_CAPACITY, deliveryCount } from "./journal-capacity.mjs";
// Sources whose sends are automated or model-driven (journal-capacity.mjs; REVIEW-G G-2).
export const AUTOMATED_SOURCES = new Set([
  "role-brief",
  "role-followup",
  "role-channel",
  "manager",
  "event",
  "leadership",
]);
export class Controller {
  events;
  manager;
  leadership;
  permissions;
  bindings;
  channels;
  roleSessions;
  closing;
  constructor({
    store,
    native,
    authority = authorizeTask,
    humanLogDir = CONTROLLER_HOME + "/admission/human",
    bootChainDir = null,
    now = Date.now,
  }) {
    this.store = store;
    this.rates = new IntercomRates(store, now);
    this.native = native;
    this.now = now;
    this.authority = authority;
    this.humanLogDir = humanLogDir;
    this.bootChainDir = bootChainDir;
    this.busy = new Set();
    this.notifications = new Notifications(this);
    this.ingress = new Ingress(this);
    this.allowance = new TaskAllowance(this);
    this.quota = new QuotaRuntime(this);
    ensureReestablishmentJournal(this.store.db);
    this.recovery = new Recovery(this);
  }
  result(input, capability) {
    return readResult(this, input, capability);
  }
  async exclusive(id, fn) {
    if (this.busy.has(id)) throw new Error("Session operation already in flight");
    this.busy.add(id);
    try {
      return await fn();
    } finally {
      this.busy.delete(id);
    }
  }
  // REVIEW-H6 F1: the automation limit is enforced at the journal insertion itself, inside store.admit's transaction,
  // so concurrent automated creates or sends (different sessions, different locks) cannot pass a check made before an
  // await and then all land in the manual reserve. The earlier checks stay as fast refusals; this one is the guarantee.
  automationGuard() {
    const n = deliveryCount(this.store.db);
    if (n >= AUTOMATION_LIMIT)
      throw new Error(
        `Journal automation budget reached: ${n} deliveries recorded; automated sends stop at ${AUTOMATION_LIMIT} to keep ${JOURNAL_CAPACITY - AUTOMATION_LIMIT} for manual control`,
      );
  }
  async create(a, creationOptions, { automated = false } = {}) {
    if (
      !a ||
      Object.keys(a).some(
        (k) =>
          !["messageId", "taskId", "provider", "title", "host", "defaults", "role"].includes(k),
      ) ||
      (a.host !== undefined && !configuredHost(a.host)) ||
      !uuid(a.messageId) ||
      !uuid(a.taskId) ||
      (a.provider !== undefined && !["claude", "codex"].includes(a.provider)) ||
      (a.role !== undefined && !SESSION_ROLES.includes(a.role)) ||
      typeof a.title !== "string" ||
      a.title.length < 3 ||
      a.title.length > 120
    )
      throw new Error("Invalid create request");
    if (a.provider === undefined && !this.store.delivery(a.messageId))
      a = await this.resolveProvider(a);
    a = this.withRoleProvider(a);
    return this.exclusive(`create:${a.messageId}`, async () => {
      await this.authority(a.taskId);
      // Update-7 W3: an explicit model / effort the provider does not list is refused here, before the journal admits
      // the request -- not recorded as an uncertain creation that needs operator recovery. A retry of a journaled one is not re-asked.
      if (!this.store.delivery(a.messageId)) await this.checkOverride(a);
      const { prior } = this.store.admit(
        a.messageId,
        null,
        "create",
        a,
        automated ? () => this.automationGuard() : undefined,
      );
      if (prior) return prior;
      try {
        const agent = await this.native.create(a, creationOptions);
        this.store.atomic(() => {
          this.store.created(agent.id, a.taskId, agent.cwd);
          this.store.finish(a.messageId, "delivered", {
            id: agent.id,
            cwd: agent.cwd,
            ...(agent.runtimeInstanceId ? { runtimeInstanceId: agent.runtimeInstanceId } : {}),
            mode: "human",
            ...(agent.managerToolsVersion
              ? { managerToolsVersion: agent.managerToolsVersion }
              : {}),
            ...(agent.roleToolsVersion ? { roleToolsVersion: agent.roleToolsVersion } : {}),
            ...(agent.toolSurface ? { toolSurface: agent.toolSurface } : {}),
            ...(agent.mode ? { mode: agent.mode } : {}),
            ...(typeof agent.model === "string" ? { model: agent.model } : {}),
            ...(agent.role ? { role: agent.role } : {}),
            ...(agent.fallback ? { fallback: agent.fallback } : {}),
            ...(agent.selection ? { selection: agent.selection } : {}),
          });
        });
      } catch (e) {
        this.store.finish(a.messageId, "uncertain", { error: e.message });
      }
      return this.store.delivery(a.messageId);
    });
  }
  async checkOverride(a) {
    if (a.defaults) await this.native.checkOverride?.(a);
  }
  // Update-7 W3 (gap a): an omitted provider is the role's chosen one; with none chosen, the role default's (the seed's)
  // provider -- only after checking this host offers it, so a create never reserves or journals a launch that cannot
  // happen. Every create path resolves through here before reserving anything.
  async resolveProvider(a) {
    if (a.provider !== undefined) return a;
    const chosen = roleProvider(a.role);
    if (chosen) return { ...a, provider: chosen };
    const fallback = roleDefaultProvider(a.role);
    if (!fallback)
      throw new Error(
        a.role
          ? `Name a provider: no provider is configured for the ${a.role} role (defaults.roles.${a.role}.provider)`
          : "Invalid create request",
      );
    try {
      await this.native.checkProvider?.(fallback, a.host);
    } catch {
      throw new Error(
        `Name a provider: no provider is configured for the ${a.role} role, and its default (${fallback}) is not available on this host`,
      );
    }
    return { ...a, provider: fallback };
  }
  // DESIGN-NEXT-BUILD A3 (prime Q1). A role may supply the provider when the caller names none; the resolved provider is
  // what is journaled, so a recovery replay does not depend on the configuration at replay time. A creation journaled
  // before roles existed (no `role` in its body) keeps that identity when retried with one: the role is dropped rather
  // than the retry refused as a conflict.
  withRoleProvider(a) {
    if (a.provider === undefined) {
      // A journaled creation retried without its provider: the same answer as when it was created (checked then).
      const provider = roleProvider(a.role) ?? roleDefaultProvider(a.role);
      if (!provider)
        throw new Error(
          a.role
            ? `Name a provider: no provider is configured for the ${a.role} role (defaults.roles.${a.role}.provider)`
            : "Invalid create request",
        );
      a = { ...a, provider };
    }
    if (a.role !== undefined) {
      const prior = this.store.delivery(a.messageId),
        { role, ...legacy } = a;
      if (
        prior &&
        prior.body ===
          JSON.stringify(
            Object.fromEntries(Object.entries(legacy).sort(([x], [y]) => x.localeCompare(y))),
          )
      )
        return legacy;
    }
    return a;
  }
  // DESIGN-R: the session row is read BEFORE transferRows wipes `expected`, and the interruption evidence is
  // written in this same transaction. `evidence` only describes the takeover; it never changes what it does.
  takeover(id, reason, evidence) {
    return this.store.atomic(() => {
      const before = this.store.get(id),
        generation = before?.generation;
      const grant = this.store.transferRows(id, "human", reason);
      this.recovery?.record(before, grant.generation, reason, evidence);
      delete grant.transferId;
      this.leadership?.supersede(id, generation);
      this.native.revokeChildren?.(id, generation);
      this.native.beginRevoke?.(id, grant.generation);
      return this.native.project?.(grant) ?? grant;
    });
  }
  async operatorTakeover(id, reason) {
    const pending =
      this.native.status?.(id)?.state === "revoking" ||
      (this.store.get(id)?.mode === "human" &&
        this.native.children?.(id).some((r) => r.phase === "revoking"));
    const grant = pending
      ? { id, mode: "human", generation: this.store.get(id).generation }
      : this.takeover(id, reason);
    const children = this.native.children?.(id).filter((r) => r.phase === "revoking") ?? [];
    const remoteWorkers = await Promise.all(children.map((r) => this.native.revoke(r.id)));
    const remote = await this.native.revoke?.(id);
    const fresh = this.store.get(id),
      childrenComplete =
        remoteWorkers.every((r) => r.revocationAcknowledged) &&
        fresh.mode === "human" &&
        fresh.generation === grant.generation,
      complete =
        remote?.revocationAcknowledged &&
        fresh.mode === "human" &&
        fresh.generation === remote.generation &&
        this.native.status(id).state === "human";
    return remote
      ? {
          id,
          mode: complete ? "human" : this.native.project(fresh).mode,
          generation: fresh.generation,
          remote,
          complete: !!complete,
          note: "Revocation acknowledgement fences future admission; already admitted work may continue.",
        }
      : remoteWorkers.length
        ? {
            id,
            mode: childrenComplete ? "human" : this.native.project(fresh).mode,
            generation: fresh.generation,
            complete: childrenComplete,
            remoteWorkers,
            note: "Receiver acknowledgement fences future admission; already admitted work may continue.",
          }
        : grant;
  }
  // `check`, when given, re-gates the SECOND observation at the no-gap point before the transfer (session-resume).
  async handback(id, reason, expectedGeneration, untouched = false, check) {
    const grant = await this.exclusive(id, async () => {
      const row = this.store.get(id);
      if (!row) throw new Error("Session not enrolled");
      this.native.ready?.(id);
      if (
        expectedGeneration !== undefined &&
        (!Number.isSafeInteger(expectedGeneration) || row.generation !== expectedGeneration)
      )
        throw new Error("Control changed; refresh before handback");
      const generation = row.generation,
        initial = await this.native.inspect(id),
        grantedAt = delegationFence(initial);
      const task = await this.authority(row.task);
      const current = await this.native.inspect(id);
      if (current.boot !== initial.boot || delegationFence(current) !== grantedAt)
        throw Error("Native input changed during handback");
      if (untouched && (generation !== 1 || current.lastPromptId !== null || current.humanAt !== 0))
        throw Error("New worker was touched before delegation");
      if (
        current.archivedAt ||
        (current.humanAt ?? 0) >= grantedAt ||
        !["idle", "closed"].includes(current.status) ||
        current.pending > 0 ||
        this.store.get(id).generation !== generation
      )
        throw new Error("Handback requires unchanged idle session");
      check?.(current, initial);
      const grant = this.store.transfer(id, "delegated", reason, current.lastPromptId);
      this.store.db
        .prepare("UPDATE sessions SET authority=?,expectedAt=?,boot=?,grantedAt=? WHERE id=?")
        .run(authorityKey(task), current.lastUserAt ?? null, current.boot ?? null, grantedAt, id);
      if (this.native.delegate) {
        try {
          await this.native.delegate(id, this.store.get(id), current);
        } catch (e) {
          if (
            this.store.get(id).mode === "delegated" &&
            this.store.get(id).generation === grant.generation
          )
            this.takeover(id, "Remote delegation unresolved; revoke before retry");
          await this.native.revoke?.(id);
          throw e;
        }
      }
      // A seated session keeps its role across a re-delegation: the credential is reissued at the new
      // generation and the same grant path. A failure here leaves the old credential inert, never valid.
      try {
        this.bindings?.reissueRole(id);
      } catch (e) {
        if (this.bindings)
          this.bindings.lastError = { message: e.message, at: new Date().toISOString() };
      }
      // H7 item 4 (G18): and the team authority it held at its last delegated generation (carry.mjs). A failure leaves
      // those rows at the old generation, i.e. inert, exactly as before this existed.
      try {
        grant.carried = this.store.atomic(() => carryAuthority(this.store.db, id));
      } catch (e) {
        grant.carried = { error: e.message };
      }
      return grant;
    });
    // H6 item 5: a seat holder or manager handed back is brought to this release's tool surface. Started after the
    // lock is released (the refresh takes the same lock) and not awaited: best-effort, recorded, never a failure here.
    try {
      this.tools?.afterDelegation(id);
    } catch (e) {
      if (this.tools) this.tools.lastError = { message: e.message, at: new Date().toISOString() };
    }
    return grant;
  }
  // Operator-invoked seat re-establishment across a verified daemon restart. DESIGN.md Stage 1.
  //
  // It writes EXACTLY TWO COLUMNS -- boot and grantedAt -- and that restraint is the security argument,
  // not an optimisation. It does not touch mode, so no delegation token is minted (store.transferRows).
  // It does not touch generation, so no role capability is created or revived: a credential is pinned to
  // (session, generation) in bindings.checkRole, which is precisely why the seat survives here with no
  // re-grant and no reissueRole. It writes no transfers row and no role table. A seat that had nothing
  // before the boot has nothing after it; the only effect is that inspect()/send() stop taking the
  // session over on the next touch.
  //
  // grantedAt is written as the OBSERVED humanAt+1 (always 1 at a fresh boot), never carried over from
  // the old row. That is what makes the result self-correcting: a human who types in the gap between the
  // observation and this write makes humanAt 1, so the next native admission requires 2 and refuses
  // (admission-guard.mjs), and the next inspect sees 1 >= 1 and takes over. Preserving a stale grantedAt
  // of, say, 6 against a reset counter would silently absorb the next five human inputs.
  async reestablish(id, reason) {
    if (
      !uuid(id) ||
      typeof reason !== "string" ||
      reason.trim().length < 12 ||
      reason.length > 2000
    )
      throw new Error("Invalid seat re-establishment");
    return this.repinSeat(id, reason.trim(), OPERATOR, false);
  }
  // Stage 2 (STAGE2-DESIGN.md s3). The machine trigger: the identical gate and write as the operator path,
  // with two differences, both stricter. R9b declines unless the durable human-input log is complete and
  // clean, and the attempt is claimed in seat_sweeps, so a decline here never spends the operator's attempt.
  // report=true evaluates everything and records the verdict but writes no session row and takes nothing
  // over. Its only caller is seat-sweep.mjs.
  async sweepSeat(id, { report = false } = {}) {
    if (!uuid(id) || typeof report !== "boolean") throw new Error("Invalid seat sweep");
    return this.repinSeat(
      id,
      "Automatic seat sweep after a verified daemon restart",
      SWEEP,
      report,
    );
  }
  async repinSeat(id, reason, trigger, report) {
    if (![OPERATOR, SWEEP].includes(trigger) || (report && trigger !== SWEEP))
      throw new Error("Invalid seat re-establishment trigger");
    return this.exclusive(id, async () => {
      const row = this.store.get(id);
      if (!row) throw new Error("Session not enrolled");
      this.native.ready?.(id);
      // native.inspect calls verifyActivation() and refuses unless the agent's barrier carries the
      // current boot, so the observation is bound to a verified live daemon by construction. No boot
      // value is ever accepted from a caller.
      const initial = await this.native.inspect(id);
      const previousBoot = row.boot ?? null;
      if (previousBoot && initial.boot === previousBoot)
        throw new Error("The daemon has not restarted since this session was delegated");
      // Re-derived before the attempt is claimed, so a project/authority source outage costs a retry
      // rather than this boot's only attempt. It throws through, exactly as it does in handback and send.
      // dispatchSupported answers the same question reissueRole asks before it will reissue a role
      // capability across a re-delegation. Unreadable routing reports unsupported, so an unattached or
      // unavailable native runtime declines rather than being skipped -- the same fail-closed reading
      // bindings.dispatch already applies everywhere else.
      const facts = {
        seated: Boolean(this.bindings?.seatedRow(id)),
        owned: ownedBySeat(this.store.db, id),
        authorityKey: authorityKey(await this.authority(row.task)),
        dispatchSupported: Boolean(this.bindings?.dispatch(id)?.capability?.supported),
        trigger,
        humanLog: this.humanLog(row, initial, id),
      };
      // Claim the single attempt for this (session, boot) before evaluating. A crash after the claim
      // burns the attempt, which is fail-closed: the seat stays revoked and handback still repairs it.
      const attempt = this.claimReestablishment(id, row, previousBoot, initial.boot, trigger);
      const table = trigger === SWEEP ? "seat_sweeps" : "boot_reestablishments";
      let verdict = reestablishable(row, initial, facts);
      if (verdict.allow) {
        // Second observation: anything that moved while we were re-deriving authority means we cannot
        // say what we are acting on. handback takes the same two-observation shape (controller.mjs).
        const current = await this.native.inspect(id);
        // Quiescence is re-evaluated against the SECOND observation as well as the first (C2, review
        // F2). Before this, status and pending were judged only on the first read, so a session that
        // picked up a turn or raised a permission between the two could still be re-established --
        // which was the one place this path checked an OLDER observation than handback does.
        const moved = sessionQuiescent(current);
        if (!observationStable(initial, current))
          verdict = {
            allow: false,
            disposition: REVOKE,
            reason: "Native state changed during re-establishment",
            grantedAt: null,
          };
        else if (moved) verdict = moved;
        else if (report) {
          // Report mode stops exactly here: everything the write rests on has been checked, nothing is written.
          this.finishReestablishment(attempt, "report-reestablish", "Would re-establish", table);
          return {
            sessionId: id,
            previousBoot,
            boot: current.boot,
            report: true,
            disposition: "reestablish",
            reason: null,
            grantsAuthority: false,
          };
        } else {
          const changed = this.store.atomic(() => {
            // Conditional on every fact the verdict rested on. A zero-row update is never a success:
            // the same hardening role-sessions.spend uses. A concurrent takeover wins this race.
            const applied = this.store.db
              .prepare(
                "UPDATE sessions SET boot=?,grantedAt=? WHERE id=? AND generation=? AND mode='delegated' AND boot IS ? AND expected IS ? AND expectedAt IS ?",
              )
              .run(
                current.boot,
                verdict.grantedAt,
                id,
                row.generation,
                previousBoot,
                row.expected ?? null,
                row.expectedAt ?? null,
              );
            if (Number(applied.changes) !== 1) return false;
            this.finishReestablishment(attempt, "reestablished", reason, table);
            return true;
          });
          if (!changed)
            verdict = {
              allow: false,
              disposition: REVOKE,
              reason: "Session control changed during re-establishment",
              grantedAt: null,
            };
        }
      }
      if (!verdict.allow) {
        if (report) {
          this.finishReestablishment(
            attempt,
            "report-" + verdict.disposition,
            verdict.reason,
            table,
          );
          return {
            sessionId: id,
            previousBoot,
            boot: initial.boot,
            report: true,
            disposition: verdict.disposition,
            reason: verdict.reason,
            grantsAuthority: false,
          };
        }
        this.finishReestablishment(
          attempt,
          verdict.disposition === REVOKE ? "revoked" : "declined",
          verdict.reason,
          table,
        );
        // A 'revoke' verdict means the session is not where we left it, so it dies here exactly as the
        // next inspect() or send() would have killed it. A 'decline' changes nothing: the row is still
        // boot-stale and therefore still unusable, so declining costs nothing and destroys nothing.
        if (verdict.disposition === REVOKE && this.store.get(id)?.mode === "delegated")
          this.takeover(id, "Seat re-establishment refused: " + verdict.reason);
        throw new Error(verdict.reason);
      }
      const fresh = this.store.get(id);
      return {
        sessionId: id,
        previousBoot,
        boot: fresh.boot,
        generation: fresh.generation,
        mode: fresh.mode,
        grantedAt: fresh.grantedAt,
        reestablished: true,
        grantsAuthority: false,
        trigger,
        note: "The delegation fence is re-pinned to the current daemon. Nothing else changed: no control transfer, no new generation, no role capability issued. Human input to this session still revokes it.",
      };
    });
  }
  // The durable human-input verdict for this seat: the owned daemon's sealed boot chain (boot-chain.mjs) for the V4
  // owned child, else the legacy guard's log (human-log.mjs). A reader fault is 'unavailable', never clean: nothing
  // here can turn "could not look" into evidence.
  humanLog(row, current, id) {
    const facts = {
      currentBoot: current.boot,
      grantBoot: row.boot,
      grantedAt: row.grantedAt,
      session: id,
    };
    try {
      return this.bootChainDir
        ? bootChainVerdict({ dir: this.bootChainDir, ...facts })
        : humanLogVerdict({ dir: this.humanLogDir, ...facts });
    } catch (e) {
      return {
        state: "unavailable",
        reason: "The human-input log could not be read: " + e.message,
        path: [],
      };
    }
  }
  claimReestablishment(id, row, previousBoot, boot, trigger = OPERATOR) {
    const attempt = randomUUID();
    try {
      this.store.db
        .prepare(
          `INSERT INTO ${trigger === SWEEP ? "seat_sweeps" : "boot_reestablishments"} VALUES (?,?,?,?,?,'attempted','',?)`,
        )
        .run(attempt, id, previousBoot ?? "", boot, row.generation, new Date().toISOString());
    } catch {
      throw new Error("Seat re-establishment has already been attempted for this daemon boot");
    }
    return attempt;
  }
  finishReestablishment(attempt, outcome, reason, table = "boot_reestablishments") {
    this.store.db
      .prepare(
        `UPDATE ${table === "seat_sweeps" ? "seat_sweeps" : "boot_reestablishments"} SET outcome=?,reason=? WHERE id=?`,
      )
      .run(outcome, String(reason ?? "").slice(0, 500), attempt);
  }

  // Was this prompt dispatched by us? Answered from the journal, not from what the prompt says about
  // itself. The `orca-control:` prefix is a namespace convention any daemon client can set -- the app,
  // the paseo CLI, an MCP tool, a plugin, a relay client -- so on its own it proves nothing. The
  // controller wrote a deliveries row before dispatching, keyed by the same messageId. No remote client
  // and no process outside this uid can produce one -- the journal is protected at uid granularity, and
  // delegated sessions run as this user with a shell, so it is not a claim about local processes.
  // That row is the credential; the prefix is only a claim that one should exist.
  //
  // The same facts admission checks before admitting a prefixed prompt (admission-guard.mjs:117): the
  // row is a send, for this session, at this generation. A refused or queued row means we did not
  // dispatch it, so it earns nothing here.
  controlDispatched(promptId, row) {
    if (!promptId) return false;
    const delivery = this.store.delivery(promptId);
    if (!delivery || delivery.kind !== "send" || delivery.session !== row.id) return false;
    if (!DISPATCHED_STATES.includes(delivery.state)) return false;
    // store.delivery parses `result` for us; a row with no result never recorded a generation and so
    // cannot show it was dispatched at this one.
    if (delivery.result?.generation !== row.generation) return false;
    // MOST RECENT DISPATCH. Existence is not enough: a row proves we once dispatched that id, not that
    // THIS prompt is the one we dispatched it for. The ids are not secret -- the controller reads them
    // off the ordinary timeline API, so anything with timeline read can harvest every valid id for a
    // session -- and replaying an older one used to suppress the takeover and roll `expected` backwards
    // to an attacker-chosen value. Only the newest dispatch can be the session's current prompt, so an
    // older id is a replay and `expected` cannot move backwards.
    //
    // Not "single use", which is what the previous commit called it: the newest id stays a valid
    // exemption until the next dispatch replaces it, and two occurrences of it cannot be told apart.
    // The residue is bounded -- admission refuses the replayed text, because the row is no longer
    // `intent` -- and it is named at the test that declines to assert it.
    return promptId === this.latestDispatched(row);
  }

  // The last id we put on the wire for this session. Read from rowid order, which is insertion order,
  // so it needs no new column and no write on an observation path.
  //
  // It stops at the FIRST send row and returns null unless that row carries this generation. It must
  // not walk past a row it cannot vouch for: skipping credential-less rows answers a different
  // question -- "the newest dispatch that happens to carry a generation" -- and a newer row written
  // without one would then hand an OLDER id back as the current credential, which is exactly the
  // replay this fence exists to refuse. Fail closed instead: an unreadable newest row means we cannot
  // say what the current dispatch is, and not knowing is a takeover.
  latestDispatched(row) {
    const newest = this.store.db
      .prepare(
        `SELECT id, result FROM deliveries WHERE session=? AND kind='send' AND state IN (${DISPATCHED_STATES.map(() => "?").join(",")}) ORDER BY rowid DESC LIMIT 1`,
      )
      .get(row.id, ...DISPATCHED_STATES);
    if (!newest) return null;
    // Raw row, so `result` is still TEXT here -- unlike store.delivery, which parses it.
    let generation;
    try {
      generation = newest.result ? JSON.parse(newest.result)?.generation : undefined;
    } catch {
      return null;
    }
    return generation === row.generation ? newest.id : null;
  }

  // A prompt the control plane itself dispatched is not human activity. Without this, a worker that
  // simply FINISHED the turn we sent it has a lastPromptId that no longer equals `expected`, and the
  // next thing the controller does to that session -- including delivering its next task -- revokes
  // the delegation. Observed live: a roles-request-session delivery revoked the project seat.
  //
  // It is still a takeover when the last prompt is one we cannot show we dispatched, and every other
  // clause is untouched.
  //
  // CORRECTION. a9900b3f claimed here that humanAt catches a human "even if provenance were ever
  // mislabelled". That was FALSE and is withdrawn. humanAt comes from humanInput, which the admission
  // guard advances only on the branch it reaches when the prefix is ABSENT (admission-guard.mjs:121-127)
  // -- the identical test provenance used. They were never independent signals; they were one signal
  // read twice, and a mislabelled prompt suppressed both. The real backstop for a forged prefix is
  // admission REFUSAL: a prefixed prompt with no matching deliveries row is refused before it runs. The
  // credential check above makes this fence rest on that same fact instead of on the label.
  promptIdentityChanged(current, row) {
    if (current.lastPromptId === row.expected) return false;
    if (current.promptClaimsControl && this.controlDispatched(current.lastPromptId, row))
      return false;
    return current.lastUserAt == null || current.lastUserAt !== row.expectedAt;
  }

  // The turn we dispatched became the session's last prompt. Record it as the expected one, so the
  // fence compares against what actually happened rather than re-deciding it on every observation.
  advanceExpected(id, current, generation) {
    this.store.db
      .prepare("UPDATE sessions SET expected=?,expectedAt=? WHERE id=? AND generation=?")
      .run(current.lastPromptId, current.lastUserAt ?? null, id, generation);
  }

  async inspect(id) {
    const row = this.store.get(id);
    if (!row) throw new Error("Session not enrolled");
    let current;
    try {
      current = await this.native.inspect(id);
    } catch (e) {
      if (!this.native.status?.(id)) throw e;
      const safe = this.store.get(id);
      delete safe.token;
      return { ...this.native.project(safe), observed: null, error: e.message, deliveries: [] };
    }
    const knownWake = await this.leadership?.observe(id, current),
      fresh = this.store.get(id);
    const delegated = fresh.mode === "delegated" && !this.busy.has(id);
    if (
      delegated &&
      (current.archivedAt ||
        (current.humanAt ?? 0) >= fresh.grantedAt ||
        (current.boot ?? null) !== fresh.boot ||
        (!knownWake && this.promptIdentityChanged(current, fresh)))
    )
      this.takeover(id, "Native input identity changed; explicit handback required", {
        observed: current,
        cause: this.recovery.cause(fresh, current, knownWake),
      });
    else if (
      delegated &&
      current.promptClaimsControl &&
      current.lastPromptId !== fresh.expected &&
      this.controlDispatched(current.lastPromptId, fresh)
    )
      this.advanceExpected(id, current, fresh.generation);
    const safe = this.store.get(id);
    delete safe.token;
    return {
      ...(this.native.project?.(safe) ?? safe),
      observed: current,
      deliveries: this.store.db
        .prepare(
          "SELECT id,kind,state,result FROM deliveries WHERE session=? ORDER BY rowid DESC LIMIT 20",
        )
        .all(id)
        .map((d) =>
          projectNotification(d, {
            generation: safe.generation,
            lastPromptId: current.lastPromptId,
            observedAt: current.observedAt,
          }),
        ),
    };
  }
  prepareManagement(kind, body, proposedId, scoped = false, check = () => {}) {
    if (
      !["create", "send", "resume", "leadership"].includes(kind) ||
      !uuid(proposedId) ||
      !body ||
      typeof body !== "object" ||
      Array.isArray(body)
    )
      throw new Error("Invalid management request");
    const encoded = JSON.stringify(
        Object.fromEntries(Object.entries(body).sort(([a], [b]) => a.localeCompare(b))),
      ),
      key = hash(kind + ":" + encoded);
    return this.store.atomic(() => {
      check();
      const prior = this.store.db
        .prepare("SELECT id,body FROM management_requests WHERE fingerprint=?")
        .get(key);
      if (prior) {
        if (prior.body !== encoded) throw new Error("Management fingerprint conflict");
        return prior.id;
      }
      const count = () =>
          this.store.db.prepare("SELECT COUNT(*) n FROM management_requests").get().n,
        cap = scoped ? 128 : 1000;
      if (count() >= cap) this.pruneManagement();
      if (count() >= cap) throw new Error("Management request capacity reached");
      this.store.db
        .prepare("INSERT INTO management_requests VALUES (?,?,?)")
        .run(key, proposedId, encoded);
      this.store.db
        .prepare("INSERT OR REPLACE INTO management_request_times VALUES (?,?)")
        .run(proposedId, this.now());
      return proposedId;
    });
  }
  // L40: a request leaves the table only when its sender acknowledges it, so senders that never do filled it to the cap
  // and every later preparation was refused. At the cap, remove exactly what an acknowledgement would accept, once it
  // can no longer serve a retry: a request whose delivery is delivered/refused/abandoned and that was prepared more than
  // MANAGEMENT_RETRY_WINDOW_MS ago (or before this build recorded times), or whose session has since moved to a later
  // generation (a retry would be a different request); and an unadmitted send whose generation moved on (the
  // obsolete-send rule of acknowledgeManagement). Inside the window a same-request retry still resolves to its prior id.
  pruneManagement() {
    const db = this.store.db,
      cutoff = this.now() - MANAGEMENT_RETRY_WINDOW_MS;
    const superseded =
      "json_extract(r.body,'$.expectedGeneration') < (SELECT generation FROM sessions WHERE id=json_extract(r.body,'$.sessionId'))";
    const finished = db
      .prepare(`SELECT r.id FROM management_requests r JOIN deliveries d ON d.id=r.id LEFT JOIN management_request_times t ON t.id=r.id
      WHERE d.state IN ('delivered','refused','abandoned') AND (t.at IS NULL OR t.at < ? OR (json_valid(r.body) AND ${superseded}))`)
      .all(cutoff)
      .map((r) => r.id);
    const obsolete = db
      .prepare(
        `SELECT r.id FROM management_requests r WHERE json_valid(r.body) AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.id=r.id) AND ${superseded}`,
      )
      .all()
      .map((r) => r.id)
      .filter((id) => {
        try {
          return this.obsoleteSend(id);
        } catch {
          return false;
        }
      });
    const remove = db.prepare("DELETE FROM management_requests WHERE id=?"),
      forget = db.prepare("DELETE FROM management_request_times WHERE id=?");
    for (const id of [...finished, ...obsolete]) {
      remove.run(id);
      forget.run(id);
    }
    return finished.length + obsolete.length;
  }
  obsoleteSend(id) {
    const prepared = this.store.db
        .prepare("SELECT body FROM management_requests WHERE id=?")
        .get(id),
      body = prepared && JSON.parse(prepared.body),
      session = typeof body?.sessionId === "string" && this.store.get(body.sessionId);
    return (
      !this.store.delivery(id) &&
      !!session &&
      Number.isSafeInteger(body.expectedGeneration) &&
      body.expectedGeneration < session.generation &&
      !this.busy.has(session.id) &&
      (Object.keys(body).sort().join() === "expectedGeneration,sessionId,text" ||
        (Object.keys(body).sort().join() === "expectedGeneration,originHash,sessionId,text" &&
          /^[a-f0-9]{64}$/.test(body.originHash)))
    );
  }
  acknowledgeManagement(id) {
    const row = this.store.delivery(id);
    const prepared = this.store.db
        .prepare("SELECT body FROM management_requests WHERE id=?")
        .get(id),
      body = prepared && JSON.parse(prepared.body),
      session = typeof body?.sessionId === "string" && this.store.get(body.sessionId);
    const obsoleteSend =
      !row &&
      session &&
      Number.isSafeInteger(body.expectedGeneration) &&
      body.expectedGeneration < session.generation &&
      !this.busy.has(session.id) &&
      (Object.keys(body).sort().join() === "expectedGeneration,sessionId,text" ||
        (Object.keys(body).sort().join() === "expectedGeneration,originHash,sessionId,text" &&
          /^[a-f0-9]{64}$/.test(body.originHash)));
    if (!obsoleteSend && (!row || !["delivered", "refused", "abandoned"].includes(row.state)))
      throw new Error("Only a confirmed delivery or obsolete unadmitted send may be acknowledged");
    this.store.db.prepare("DELETE FROM management_requests WHERE id=?").run(id);
    this.store.db.prepare("DELETE FROM management_request_times WHERE id=?").run(id);
    return { acknowledged: true };
  }
  // Track 1c: the task's deliveries through deliveries_session / deliveries_create_task (store.mjs). `session IN (SELECT id
  // FROM sessions WHERE task=?)` is the old `LEFT JOIN sessions ... WHERE s.task=?` (sessions.id is the key); same rows,
  // same order (history-index.test.mjs proves it on generated journals).
  history(task) {
    if (!uuid(task)) throw new Error("Invalid task");
    return this.store.db
      .prepare(`SELECT id,session,kind,state FROM (
      SELECT d.id,d.session,d.kind,d.state,d.rowid AS sequence FROM deliveries d WHERE d.session IN (SELECT id FROM sessions WHERE task=?) OR (d.kind='create' AND json_extract(d.body,'$.taskId')=?)
      UNION ALL SELECT r.id,NULL,'create','prepared',r.rowid FROM management_requests r WHERE json_valid(r.body) AND json_extract(r.body,'$.taskId')=? AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.id=r.id)
    ) ORDER BY (state IN ('intent','uncertain','prepared','queued')) DESC,sequence DESC LIMIT 1000`)
      .all(task, task, task);
  }
  sendQueued(a, token, operatorGeneration, supervision) {
    return launchNativeQueued(this, a, token, operatorGeneration, supervision);
  }

  async send(a, token, operatorGeneration, supervision) {
    if (
      !a ||
      Object.keys(a).some((k) => !["sessionId", "messageId", "text"].includes(k)) ||
      !uuid(a.sessionId) ||
      !uuid(a.messageId) ||
      typeof a.text !== "string" ||
      !a.text.trim() ||
      Buffer.byteLength(a.text) > 16384
    )
      throw new Error("Invalid send request");
    a = { ...a, text: a.text.trim() };
    const check = () => {
      supervision?.check?.();
      if (operatorGeneration === undefined) return this.store.check(a.sessionId, token);
      const row = this.store.get(a.sessionId);
      if (
        !Number.isSafeInteger(operatorGeneration) ||
        !row ||
        row.mode !== "delegated" ||
        row.generation !== operatorGeneration
      )
        throw new Error("Control changed; refresh before assigning");
      return row;
    };
    return this.exclusive(a.sessionId, async () => {
      let row = check();
      this.native.ready?.(a.sessionId);
      if (authorityKey(await this.authority(row.task)) !== row.authority)
        throw new Error("Task authority changed since handback");
      const existing = this.store.delivery(a.messageId);
      if (existing) {
        check();
        if (existing.state === "queued") {
          if (
            existing.session !== a.sessionId ||
            existing.kind !== "send" ||
            JSON.parse(existing.body).text !== a.text
          )
            throw Error("Delivery identity conflict");
          if (supervision?.resume !== this.quota.resume) return existing;
        } else {
          const prior = this.store.admit(a.messageId, a.sessionId, "send", a).prior;
          if (prior.state !== "reserved") return prior;
          if (!this.leadership?.reservation(prior, a, row.generation))
            throw Error("Invalid queued leadership reservation");
        }
      }
      if (
        this.store.db
          .prepare(
            "SELECT id FROM deliveries WHERE session=? AND state IN ('intent','uncertain','reserved','queued') AND id!=?",
          )
          .get(a.sessionId, a.messageId)
      )
        throw new Error("Uncertain or queued delivery requires explicit reconciliation");
      // REVIEW-G G-2: automated and model-driven sends may not use the journal's manual reserve. Only wakes, manager
      // creation and leadership checked AUTOMATION_LIMIT; briefs, G8 follow-ups, channel messages, manager assignments
      // and request wakes went straight to the full capacity. Operator, direct, ingress and notification sends keep it.
      // A retry of an identity already in the journal adds no row and is never refused here.
      if (
        !existing &&
        (AUTOMATED_SOURCES.has(supervision?.source?.kind) || supervision?.automated) &&
        deliveryCount(this.store.db) >= AUTOMATION_LIMIT
      )
        throw new Error(
          `Journal automation budget reached: ${deliveryCount(this.store.db)} deliveries recorded; automated sends stop at ${AUTOMATION_LIMIT} to keep ${JOURNAL_CAPACITY - AUTOMATION_LIMIT} for manual control`,
        );
      const quota = (await this.native.quota?.(a.sessionId)) ?? null;
      if (quota && authorityKey(await this.authority(row.task)) !== row.authority)
        throw Error("Task authority changed during quota observation");
      const current = await this.native.inspect(a.sessionId);
      reconcileBootstrap(this.store.db, current);
      row = check();
      if (current.archivedAt) {
        this.takeover(a.sessionId, "Native session archived; explicit human reopening required", {
          observed: current,
          cause: "archived",
        });
        throw new Error("Archived session cannot receive delegated input");
      }
      if (
        (current.boot ?? null) !== row.boot ||
        current.humanAt >= row.grantedAt ||
        this.promptIdentityChanged(current, row)
      ) {
        this.takeover(a.sessionId, "Native input identity changed before send; handback required", {
          observed: current,
          cause: this.recovery.cause(row, current),
        });
        throw new Error("Human activity or changed identity revoked delegation");
      }
      // Typed, because a caller holding an approved message must tell "not now" apart from "never" without
      // reading this string. The wording is unchanged: an operator-facing refusal stays what it was.
      if (!["idle", "closed"].includes(current.status) || current.pending > 0)
        throw new RecipientBusy("Recipient is busy or waiting for permission");
      // No asynchronous gap between the final capability check, durable intent and dispatch.
      // REVIEW-H6 F1: for automated traffic the guard runs inside the transaction that writes the row -- store.admit's
      // hook below, or the check quota-wait's park() calls inside its own transaction. A journaled retry adds no row.
      const automated =
        AUTOMATED_SOURCES.has(supervision?.source?.kind) || Boolean(supervision?.automated);
      const guarded = () => {
        const r = check();
        if (automated && !this.store.delivery(a.messageId)) this.automationGuard();
        return r;
      };
      const admission = this.quota.admission(a, row, current, quota, supervision, guarded);
      if (admission && admission.state !== "intent") return admission;
      // The hook also runs when admit converts a row RESERVED earlier inside the limit (a leadership wake): that row
      // already exists and adds nothing, so only a new identity is guarded.
      if (!admission)
        this.store.admit(a.messageId, a.sessionId, "send", a, () => {
          if (automated && !this.store.delivery(a.messageId)) this.automationGuard();
          this.allowance.charge(row.task, a.messageId);
        });
      const trail = admission?.result?.wait
        ? { wait: { ...admission.result.wait, state: "admitted", admittedAt: Date.now() } }
        : {};
      const outputContext = {
        generation: row.generation,
        boot: current.boot ?? null,
        nativeId: current.nativeId ?? null,
        cursor: current.timelineCursor ?? null,
        quota: quota
          ? { observedAt: quota.observedAt, state: "observed" }
          : { state: "unavailable" },
        ...(supervision?.originHash ? { originHash: supervision.originHash } : {}),
      };
      // intent.supervision is read by the native guard as manager supervision authority. Only a manager
      // binding may go there; a role channel carries its own field and its own re-derivation.
      const nativeAttemptId = randomUUID();
      this.store.finish(a.messageId, "intent", {
        ...trail,
        nativeAttemptId,
        generation: row.generation,
        expectedLastUserAt: current.lastUserAt ?? null,
        outputContext,
        ...(supervision?.binding ? { supervision: supervision.binding } : {}),
        ...(supervision?.channel ? { channel: supervision.channel } : {}),
      });
      try {
        this.events?.track(row, a, current);
      } catch (e) {
        return this.store.finish(a.messageId, "refused", {
          ...trail,
          outputContext,
          error: e.message,
          nativeDispatched: false,
        });
      }
      try {
        await this.native.send(a.sessionId, a.text, a.messageId, nativeAttemptId);
        // generation is carried onto the terminal row because it is what makes this delivery a
        // CREDENTIAL later: controlDispatched needs to know we dispatched this messageId for this
        // session at this generation. The 'intent' write above records it, and this overwrote it.
        this.store.finish(a.messageId, "delivered", {
          ...trail,
          generation: row.generation,
          outputContext,
          note: "Native send acknowledged; consumption and output remain separate",
        });
      } catch (e) {
        const pending = this.store.delivery(a.messageId),
          receipt = pending?.result?.nativeQuotaWait,
          owner = this.store.get(a.sessionId);
        if (
          trail.wait &&
          pending.state === "intent" &&
          receipt?.attempt === nativeAttemptId &&
          receipt.boot === current.boot &&
          receipt.nativeDispatched === false &&
          owner.mode === "delegated" &&
          owner.generation === row.generation
        ) {
          return this.store.finish(a.messageId, "queued", {
            ...trail,
            outputContext,
            nativeDispatched: false,
            wait: {
              ...trail.wait,
              state: "waiting",
              reason: receipt.reason,
              nativeRefusal: receipt,
              checkedAt: Date.now(),
              nextCheckAt: Date.now() + 30000,
            },
          });
        }
        const refused = isNativeAdmissionRefusal(e);
        this.store.finish(a.messageId, refused ? "refused" : "uncertain", {
          ...trail,
          generation: row.generation,
          outputContext,
          error: e.message,
        });
        if (refused)
          this.takeover(a.sessionId, "Native admission refused; explicit handback required");
        return this.store.delivery(a.messageId);
      }
      try {
        const accepted = await this.native.inspect(a.sessionId);
        reconcileBootstrap(this.store.db, accepted);
        if (accepted.lastPromptId !== a.messageId || (accepted.boot ?? null) !== row.boot)
          this.takeover(
            a.sessionId,
            "Input or daemon identity changed after acknowledgment; explicit handback required",
          );
        else {
          this.store.db
            .prepare("UPDATE sessions SET expected=?,expectedAt=? WHERE id=? AND generation=?")
            .run(a.messageId, accepted.lastUserAt ?? null, a.sessionId, row.generation);
          if (!outputContext.nativeId && accepted.nativeId)
            this.store.db
              .prepare(
                "UPDATE deliveries SET result=json_set(result,'$.outputContext.nativeId',?) WHERE id=? AND state='delivered'",
              )
              .run(accepted.nativeId, a.messageId);
        }
      } catch {
        this.takeover(
          a.sessionId,
          "Send acknowledged but native state unavailable; explicit handback required",
        );
      }
      return this.store.delivery(a.messageId);
    });
  }
  async recover(id) {
    const record = this.store.delivery(id);
    if (!record || !["intent", "uncertain"].includes(record.state))
      throw new Error("Only an unresolved delivery can be recovered");
    if (record.kind === "account-switch") {
      const body = JSON.parse(record.body);
      await takeOverSession(record.session, body.accountId, {
        control: this,
        root: this.poolRoot ?? poolRoot(),
        generation: body.generation,
        reconcile: true,
        switchId: id,
      });
      return this.store.delivery(id);
    }
    if (record.kind === "resume") return this.manager.recoverResume(record);
    if (record.kind === "leadership") return this.leadership.recoverTransition(record);
    if (this.leadership?.db.prepare("SELECT id FROM leadership_handoffs WHERE wakeId=?").get(id))
      return this.leadership.recoverWake(record);
    return this.exclusive(record.session ?? `create:${id}`, async () => {
      const body = JSON.parse(record.body);
      if (record.kind === "create") {
        await this.authority(body.taskId);
        const agent = await this.native.create(body);
        this.store.atomic(() => {
          const existing = this.store.get(agent.id);
          if (existing && (existing.task !== body.taskId || existing.cwd !== agent.cwd))
            throw new Error("Recovered session identity conflict");
          if (!existing) this.store.created(agent.id, body.taskId, agent.cwd);
          this.store.finish(id, "delivered", {
            id: agent.id,
            cwd: agent.cwd,
            ...(agent.runtimeInstanceId ? { runtimeInstanceId: agent.runtimeInstanceId } : {}),
            mode: "human",
            recovered: true,
            ...(agent.managerToolsVersion
              ? { managerToolsVersion: agent.managerToolsVersion }
              : {}),
            ...(agent.roleToolsVersion ? { roleToolsVersion: agent.roleToolsVersion } : {}),
            ...(agent.mode ? { mode: agent.mode } : {}),
          });
        });
      } else {
        const row = this.store.get(record.session);
        await this.authority(row.task);
        const receipt = await this.native.receipt(record.session, id, body.text);
        // generation is carried through recovery for the same reason the send path carries it: this row
        // is the prompt's credential. Recovering an uncertain send leaves the session DELEGATED, so
        // dropping it here left a healthy worker whose next observation revoked it.
        if (receipt?.state !== "completed")
          return this.store.finish(id, "uncertain", {
            outputContext: record.result?.outputContext,
            generation: row.generation,
            receipt,
            note: "Receipt does not establish completion; no native send was retried",
          });
        // This branch takes over immediately, so the credential is not load-bearing here today. It is
        // carried anyway, so the row stays truthful and this does not silently depend on that takeover.
        this.store.finish(id, "delivered", {
          outputContext: record.result?.outputContext,
          generation: row.generation,
          receipt,
          recovered: true,
        });
        this.takeover(record.session, "Native receipt recovered; explicit handback required");
      }
      return this.store.delivery(id);
    });
  }
  disposition(id, reason) {
    const row = this.store.delivery(id);
    if (
      !row ||
      !["intent", "uncertain"].includes(row.state) ||
      (row.session && this.busy.has(row.session)) ||
      this.busy.has(`create:${id}`) ||
      typeof reason !== "string" ||
      reason.trim().length < 12 ||
      reason.length > 2000
    )
      throw new Error("Explicit evidence-backed disposition required while operation is inactive");
    if (row.kind === "account-switch")
      throw Error(
        "Reconcile this account switch through recover; abandoning it cannot establish the running account",
      );
    if (row.kind === "resume") return this.manager.recoverResume(row);
    if (row.kind === "leadership") return this.leadership.recoverTransition(row);
    const handoff = this.leadership?.abandonWake(row, reason);
    if (handoff) return handoff;
    this.store.finish(id, "abandoned", {
      ...(row.kind === "send" ? { outputContext: row.result?.outputContext } : {}),
      reason,
      previousState: row.state,
      at: new Date().toISOString(),
      note: "Outcome remains unverified; this identity will never be replayed",
    });
    return this.store.delivery(id);
  }
}
