import { SourceChanged, RecipientBusy, authorityKey } from "./authority.mjs";
import { QuotaWait, quotaDecision } from "./quota-wait.mjs";
export class QuotaRuntime {
  constructor(control) {
    this.control = control;
    this.now = Date.now;
    this.wait = new QuotaWait(control, () => this.now());
    this.resume = Symbol("quota-resume");
  }
  get store() {
    return this.control.store;
  }
  get db() {
    return this.store.db;
  }
  interested(id) {
    return !!this.db
      .prepare("SELECT id FROM deliveries WHERE session=? AND state='queued'")
      .get(id);
  }
  sourceCheck(binding, a) {
    if (this.control.closing) throw Error("Controller closing; keep instruction queued");
    this.wait.current(this.store.get(a.sessionId), binding);
    const s = binding.source,
      c = this.control,
      get = (sql, ...args) => this.db.prepare(sql).get(...args);
    const require = (value) => {
      if (!value) throw new SourceChanged("Queued source authority changed; instruction cancelled");
    };
    if (s.kind === "direct") return true;
    if (["ingress", "notification"].includes(s.kind)) {
      // No catch-and-collapse: scope() throws SourceChanged for its definite refusals, so a failed read
      // stays unknown and the instruction stays queued instead of being cancelled for good.
      c.ingress.scope(a.sessionId, s.originHash);
    }
    if (s.kind === "ingress") {
      const p = get("SELECT body FROM management_requests WHERE id=?", s.preparation),
        b = p && JSON.parse(p.body);
      require(
        s.preparation === a.messageId &&
          b?.sessionId === a.sessionId &&
          b.expectedGeneration === binding.generation &&
          b.originHash === s.originHash &&
          b.text === a.text,
      );
    } else if (s.kind === "notification") {
      const d = this.store.delivery(s.parentMessageId),
        n = d?.result?.notification,
        proof = d?.result?.outputContext;
      require(
        d?.session === a.sessionId &&
          d.state === "delivered" &&
          n?.id === s.notificationId &&
          n.originHash === s.originHash &&
          n.generation === binding.generation &&
          n.readAt &&
          !n.consumedAt &&
          n.followup?.messageId === a.messageId &&
          n.followup.text === a.text &&
          proof?.originHash === s.originHash &&
          proof.generation === binding.generation &&
          proof.nativeId === binding.nativeId &&
          proof.boot === binding.boot &&
          binding.expected === d.id,
      );
    } else if (s.kind === "manager") {
      const role = get("SELECT * FROM manager_grants WHERE supervisor=?", s.supervisor),
        parent = this.store.get(s.supervisor);
      require(
        role?.epoch === s.epoch &&
          role.generation === s.generation &&
          parent?.mode === "delegated" &&
          parent.generation === s.generation &&
          parent.task === binding.task,
      );
      // Same, and the bare catch here also swallowed the inner require's own SourceChanged.
      require(c.manager.owned(role, a.sessionId).epoch === s.linkEpoch);
    } else if (s.kind === "event") {
      const e = get("SELECT * FROM event_inbox WHERE id=?", s.eventId),
        link = get("SELECT * FROM event_links WHERE worker=?", s.worker);
      require(
        s.eventId === a.messageId &&
          e?.supervisor === a.sessionId &&
          e.worker === s.worker &&
          e.epoch === s.epoch &&
          !e.consumed &&
          e.state === "queued" &&
          link?.epoch === s.epoch &&
          c.events.valid(link),
      );
    } else if (s.kind === "leadership") {
      const h = c.leadership.row(s.handoffId);
      require(
        h?.destination === a.sessionId &&
          h.wakeId === a.messageId &&
          h.generation === binding.generation &&
          h.state === "pending" &&
          !h.consumed,
      );
    } else if (s.kind === "role-channel") {
      const m = get("SELECT * FROM role_channel_messages WHERE messageId=?", a.messageId);
      require(
        m &&
          ["reserved", "pending", "queued"].includes(m.state) &&
          m.channel === s.channelId &&
          m.fromSeat === s.fromSeat &&
          m.toSeat === s.toSeat &&
          m.fromSession === s.fromSession &&
          m.toSession === a.sessionId &&
          m.toGeneration === binding.generation &&
          (m.inReplyTo ?? null) === (s.inReplyTo ?? null) &&
          m.text === a.text,
      );
      // Delegate to the channel's own authority, as the manager and event branches delegate to theirs --
      // but WITHOUT their catch-and-collapse. Both calls now throw SourceChanged for their definite cases,
      // so a real change still cancels while a read that merely failed propagates as unknown and the
      // instruction stays queued. Wrapping these would turn a locked database into a permanent
      // cancellation: the unknown->definite direction, the inverse of what the pump was fixed for.
      c.channels.assertOriginator(s.fromSession);
      c.channels.assertUsable(c.channels.row(s.channelId), false);
    } else require(false);
    return true;
  }
  async replay(record) {
    const binding = record.result.wait.binding,
      a = JSON.parse(record.body),
      s = binding.source;
    this.sourceCheck(binding, a);
    // A role channel is deliberately cross-task -- a prime seat sits on the programme root and a project
    // orchestrator on a member task -- so control.send re-deriving the RECIPIENT's task authority says
    // nothing about the sender's. It is the second party here exactly as the supervisor and worker are.
    const related =
      s.kind === "manager"
        ? [s.supervisor]
        : s.kind === "event"
          ? [s.worker]
          : s.kind === "role-channel"
            ? [s.fromSession]
            : [];
    for (const id of related) {
      await this.control.inspect(id);
      const row = this.store.get(id);
      // Without this the next line is a TypeError, which fails closed but names the wrong cause.
      // Retrying cannot bring the session back, so this is SourceChanged rather than a plain Error.
      if (!row) throw new SourceChanged("The queued source session no longer exists");
      if (authorityKey(await this.control.authority(row.task)) !== row.authority)
        throw new SourceChanged("Queued parent task authority changed");
      this.sourceCheck(binding, a);
    }
    return this.control.send(a, undefined, binding.generation, {
      source: s,
      resume: this.resume,
      originHash: s.originHash,
      ...(s.kind === "manager"
        ? {
            binding: {
              supervisor: s.supervisor,
              generation: s.generation,
              epoch: s.epoch,
              linkEpoch: s.linkEpoch,
            },
          }
        : {}),
      ...(s.kind === "role-channel"
        ? {
            channel: {
              channelId: s.channelId,
              fromSeat: s.fromSeat,
              toSeat: s.toSeat,
              fromSession: s.fromSession,
              inReplyTo: s.inReplyTo ?? null,
            },
          }
        : {}),
      check: () => this.sourceCheck(binding, a),
    });
  }
  admission(a, row, current, quota, supervision, check) {
    const prior = this.store.delivery(a.messageId),
      queued = prior?.state === "queued";
    if (!quota) {
      if (queued) throw Error("Session quota unavailable; saved instruction remains waiting");
      return null; // Old hosts/unsupported providers retain their existing send path, explicitly unmeasured.
    }
    if (
      quota.sessionId !== current.nativeId ||
      quota.model !== current.model ||
      quota.serviceTier !== current.serviceTier
    )
      throw Error("Quota observation does not match the current native configuration");
    if (queued)
      return this.wait.admit(a.messageId, quota, (binding) => {
        check();
        return this.sourceCheck(binding, a);
      });
    if (quotaDecision(quota, null, this.now()).state === "ready") return null;
    // DESIGN-E F2 (prime decision). A caller may declare that its send must NEVER park on quota: a parked
    // delivery replays later through sourceCheck with only its persisted source, and the caller's own
    // check closure is not persisted, so whatever that caller re-derives at dispatch would be skipped at
    // replay. An operator reply for a human-held seat is such a send. It is refused here, before anything
    // is recorded, as a typed busy the caller can retry -- never as a queued delivery.
    if (supervision?.neverPark)
      throw new RecipientBusy(
        "Recipient quota is not available now; this send is never parked on quota. Retry when quota recovers.",
      );
    const source =
      supervision?.source ??
      (!supervision?.check && !supervision?.binding ? { kind: "direct" } : null);
    const context = {
      generation: row.generation,
      boot: current.boot,
      expected: row.expected,
      expectedAt: row.expectedAt,
      nativeId: current.nativeId,
      source,
    };
    return this.wait.park(a, context, quota, (binding) => {
      check();
      return this.sourceCheck(binding, a);
    });
  }
  pump() {
    if (this.control.closing) return Promise.resolve();
    return (this.pumping ??= this.dispatch().finally(() => {
      this.pumping = null;
    }));
  }
  async dispatch() {
    const due = this.db
      .prepare(
        "SELECT id FROM deliveries WHERE state='queued' AND coalesce(json_extract(result,'$.wait.nextCheckAt'),0)<=? ORDER BY coalesce(json_extract(result,'$.wait.nextCheckAt'),0),rowid LIMIT 4",
      )
      .all(this.now());
    await Promise.all(
      due.map(async ({ id }) => {
        if (this.control.closing) return;
        const d = this.store.delivery(id);
        if (d?.state !== "queued") return;
        this.db
          .prepare(
            "UPDATE deliveries SET result=json_set(result,'$.wait.nextCheckAt',?) WHERE id=? AND state='queued'",
          )
          .run(this.now() + 30000, id);
        if (this.control.busy.has(d.session)) return;
        try {
          await this.replay(d);
        } catch (e) {
          const fresh = this.store.delivery(id);
          if (fresh?.state === "queued")
            this.store.finish(id, e instanceof SourceChanged ? "refused" : "queued", {
              ...fresh.result,
              wait: {
                ...fresh.result.wait,
                state: e instanceof SourceChanged ? "cancelled" : "unknown",
                reason: e.message.slice(0, 2000),
                checkedAt: this.now(),
              },
            });
        }
      }),
    );
  }
}
