import { readNativeRateSettings } from "./intercom-rates.mjs";
import { automaticPermissionProof, permissionMode } from "./automatic-permission.mjs";
import { createHash } from "node:crypto";
// Journal predicates ported from admission-guard. The host is the sole sequence
// owner; reads never create a clean fence for an unknown parent or root.
export function journalPolicy(observations, { rateSettingsFile = () => undefined } = {}) {
  const BOOT = observations.boot,
    saturated = false;
  const sequence = (id) => {
    const value = observations.require(id);
    if (value.boot !== BOOT) throw Error("Host input boot changed");
    return value;
  };
  const observation = (id) => ({
    ...sequence(id),
    fenceProtocol: "orca-input-sequence-v1",
    saturated: false,
  });
  const hasChannelTables = (get) =>
    Boolean(
      get("SELECT name FROM sqlite_master WHERE type='table' AND name='role_channel_messages'"),
    );
  function rateMaximum(get, kind, maximum) {
    const local = get("SELECT max FROM intercom_rate_settings WHERE kind=?", kind)?.max;
    const cached = get("SELECT settings FROM intercom_rate_native_settings WHERE id=1")?.settings;
    let native = cached ? JSON.parse(cached)[kind] : undefined;
    const file = rateSettingsFile();
    if (file) native = readNativeRateSettings(file)[kind];
    return Math.min(
      maximum,
      local ?? native ?? { followup: 32, channel: 8, seat: 8 }[kind],
      native ?? Infinity,
    );
  }
  function ratePermit(get, kind, scope, id, maximum) {
    if (
      !get("SELECT name FROM sqlite_master WHERE type='table' AND name='intercom_rate_operations'")
    )
      return true;
    const now = Date.now(),
      watermark = get("SELECT watermark FROM intercom_rate_clock WHERE id=1")?.watermark;
    if (!Number.isSafeInteger(watermark) || now < watermark) return false;
    const entry = get("SELECT * FROM intercom_rate_operations WHERE id=?", id);
    if (
      !entry ||
      entry.kind !== kind ||
      entry.scope !== scope ||
      entry.at <= now - 3600000 ||
      entry.at > now
    )
      return false;
    const max = rateMaximum(get, kind, maximum);
    if (
      kind === "followup" &&
      get("SELECT name FROM sqlite_master WHERE type='table' AND name='role_session_followups'")
    ) {
      const historical = get(
        "SELECT count(*) n FROM role_session_followups WHERE session=? AND at>? AND at<=?",
        scope,
        new Date(now - 3600000).toISOString(),
        new Date(now).toISOString(),
      ).n;
      if (historical > max) return false;
    }
    const count = get(
      "SELECT count(*) n FROM intercom_rate_operations WHERE kind=? AND scope=? AND at>? AND at<=?",
      kind,
      scope,
      now - 3600000,
      now,
    ).n;
    return Number.isSafeInteger(max) && max > 0 && count <= max;
  }
  function channelWithinWindow(get, row, id) {
    if (
      !get("SELECT name FROM sqlite_master WHERE type='table' AND name='intercom_rate_operations'")
    )
      return row.used <= row.maxMessages;
    return ratePermit(get, "channel", row.id, "channel:" + id, row.maxMessages);
  }
  function roleChannelAdmitted(get, session, delivery, body, c) {
    // A journal with no role tables has no channels, so a declared one cannot be re-derived and must refuse.
    if (!c || typeof c.channelId !== "string" || !hasChannelTables(get)) return false;
    const m = get("SELECT * FROM role_channel_messages WHERE messageId=?", delivery.id);
    // 'reserved' is the first attempt, 'pending' a re-offer after a busy recipient, 'queued' a send parked
    // awaiting quota and later replayed. A 'delivered' or 'failed' row may never admit again.
    if (!m || !["reserved", "pending", "queued"].includes(m.state)) return false;
    const row = get("SELECT * FROM role_channels WHERE id=?", m.channel);
    if (
      !row ||
      row.state !== "open" ||
      !(Date.parse(row.expiresAt) > Date.now()) ||
      !channelWithinWindow(get, row, delivery.id)
    )
      return false;
    // The message must run along this channel's own approved pair, in exactly one of its two orientations.
    const toProject = m.fromSeat === row.primeSeat && m.toSeat === row.projectSeat;
    const toPrime = m.fromSeat === row.projectSeat && m.toSeat === row.primeSeat;
    if (toProject === toPrime) return false;
    const side = (which) =>
      which === "prime"
        ? {
            role: "prime",
            seat: row.primeSeat,
            revision: row.primeRevision,
            session: row.primeSession,
          }
        : {
            role: "project-orchestrator",
            seat: row.projectSeat,
            revision: row.projectRevision,
            session: row.projectSession,
          };
    const from = side(toProject ? "prime" : "project"),
      to = side(toProject ? "project" : "prime");
    // Both seats must still hold the exact binding the operator approved. A re-seat bumps the revision.
    for (const seat of [from, to]) {
      const b = get(
        "SELECT role,seat,session,revision,state FROM role_bindings WHERE role=? AND seat=?",
        seat.role,
        seat.seat,
      );
      if (
        !b ||
        b.state !== "assigned" ||
        b.revision !== seat.revision ||
        b.session !== seat.session
      )
        return false;
    }
    // The same facts assertOriginator establishes controller-side: the sender is still seated, still delegated,
    // and still holds a capability at its current generation. A taken-over sender cannot deliver.
    const originator = get("SELECT id,mode,generation FROM sessions WHERE id=?", m.fromSession);
    const credential = get(
      "SELECT generation FROM role_credentials WHERE session=?",
      m.fromSession,
    );
    if (
      !originator ||
      originator.mode !== "delegated" ||
      !credential ||
      credential.generation !== originator.generation
    )
      return false;
    if (!get("SELECT role FROM role_bindings WHERE session=?", m.fromSession)) return false;
    return (
      m.channel === c.channelId &&
      m.fromSeat === c.fromSeat &&
      m.toSeat === c.toSeat &&
      m.fromSession === c.fromSession &&
      (m.inReplyTo ?? null) === (c.inReplyTo ?? null) &&
      m.fromSession === from.session &&
      m.toSession === to.session &&
      m.toSession === session.id &&
      m.toGeneration === session.generation &&
      m.text === body.text &&
      body.messageId === delivery.id &&
      body.sessionId === session.id
    );
  }
  // The journal is authoritative for source revocation even after the controller sent
  // the RPC. Keep this synchronous with the native input fence, in one read snapshot.
  function queuedSource(store, agent, session, delivery, intent, body) {
    if (!intent.wait) return;
    const b = intent.wait.binding,
      source = b?.source;
    const get = (sql, ...args) => store.prepare(sql).get(...args);
    const require = (value) => {
      if (!value)
        throw Error("Orca native admission refused changed queued source or configuration");
    };
    const live = (row) =>
      row &&
      row.mode === "delegated" &&
      row.boot === BOOT &&
      row.grantedAt === sequence(row.id).humanAt + 1;
    const tier = agent.runtime.serviceTier;
    require(
      intent.wait.state === "admitted" &&
        b &&
        source &&
        live(session) &&
        b.boot === BOOT &&
        b.generation === session.generation &&
        b.task === session.task &&
        b.authority === session.authority &&
        b.expected === session.expected &&
        b.expectedAt === session.expectedAt,
    );
    require(
      body.sessionId === session.id &&
        body.messageId === delivery.id &&
        b.quota?.provider === "codex" &&
        agent.provider === "codex" &&
        b.nativeId === b.quota.sessionId &&
        b.nativeId === agent.runtime.nativeSessionId &&
        b.quota.model === agent.runtime.model &&
        b.quota.serviceTier === tier,
    );
    if (source.kind === "direct") return;
    if (["ingress", "notification"].includes(source.kind)) {
      require(/^[a-f0-9]{64}$/.test(source.originHash));
      for (const table of ["manager_workers", "event_links"])
        require(!get(`SELECT worker FROM ${table} WHERE worker=?`, session.id));
      require(
        !get(
          "SELECT id FROM management_requests WHERE json_extract(body,'$.sessionId')=? AND json_extract(body,'$.expectedGeneration')=? AND json_extract(body,'$.originHash') IS NOT NULL AND json_extract(body,'$.originHash')!=? LIMIT 1",
          session.id,
          session.generation,
          source.originHash,
        ),
      );
      require(
        !get(
          "SELECT id FROM deliveries WHERE session=? AND json_extract(result,'$.outputContext.generation')=? AND json_extract(result,'$.outputContext.originHash') IS NOT NULL AND json_extract(result,'$.outputContext.originHash')!=? LIMIT 1",
          session.id,
          session.generation,
          source.originHash,
        ),
      );
    }
    if (source.kind === "ingress") {
      const prepared = get("SELECT body FROM management_requests WHERE id=?", source.preparation),
        input = prepared && JSON.parse(prepared.body);
      require(
        source.preparation === delivery.id &&
          input?.sessionId === session.id &&
          input.expectedGeneration === b.generation &&
          input.originHash === source.originHash &&
          input.text === body.text,
      );
    } else if (source.kind === "notification") {
      const parent = get("SELECT * FROM deliveries WHERE id=?", source.parentMessageId),
        result = parent && JSON.parse(parent.result),
        n = result?.notification,
        proof = result?.outputContext;
      require(
        parent?.session === session.id &&
          parent.state === "delivered" &&
          parent.id === b.expected &&
          n?.id === source.notificationId &&
          n.originHash === source.originHash &&
          n.generation === b.generation &&
          n.readAt &&
          !n.consumedAt &&
          n.followup?.messageId === delivery.id &&
          n.followup.text === body.text &&
          proof?.originHash === source.originHash &&
          proof.generation === b.generation &&
          proof.nativeId === b.nativeId &&
          proof.boot === b.boot,
      );
    } else if (source.kind === "manager") {
      // admit() below validates the role, link, worker and live parent input fence.
      const p = intent.supervision,
        parent = get("SELECT * FROM sessions WHERE id=?", source.supervisor);
      require(parent?.authority === session.authority);
      require(
        p?.supervisor === source.supervisor &&
          p.generation === source.generation &&
          p.epoch === source.epoch &&
          p.linkEpoch === source.linkEpoch,
      );
    } else if (source.kind === "event") {
      const event = get("SELECT * FROM event_inbox WHERE id=?", source.eventId),
        link = get("SELECT * FROM event_links WHERE worker=?", source.worker),
        worker = get("SELECT * FROM sessions WHERE id=?", source.worker);
      require(
        source.eventId === delivery.id &&
          event?.supervisor === session.id &&
          event.worker === source.worker &&
          event.epoch === source.epoch &&
          !event.consumed &&
          event.state === "queued" &&
          link?.epoch === source.epoch &&
          link.supervisor === session.id &&
          link.workerGeneration === worker?.generation &&
          link.supervisorGeneration === session.generation &&
          live(worker) &&
          worker.task === session.task &&
          worker.authority === session.authority &&
          !get("SELECT worker FROM event_faults WHERE worker=?", source.worker),
      );
    } else if (source.kind === "leadership") {
      const handoff = get("SELECT * FROM leadership_handoffs WHERE id=?", source.handoffId);
      require(
        handoff?.destination === session.id &&
          handoff.wakeId === delivery.id &&
          handoff.generation === b.generation &&
          handoff.boot === b.boot &&
          handoff.grantedAt === session.grantedAt &&
          handoff.state === "pending" &&
          !handoff.consumed,
      );
    } else if (source.kind === "role-channel") {
      require(roleChannelAdmitted(get, session, delivery, body, source));
    } else require(false);
  }
  function admit(store, agent, prompt, messageId, busy) {
    const session = store.prepare("SELECT * FROM sessions WHERE id=?").get(agent.id);
    const delivery = messageId
      ? store.prepare("SELECT * FROM deliveries WHERE id=?").get(messageId)
      : null;
    if (!session || delivery?.kind !== "send")
      throw new Error("Orca native admission refused unenrolled intent");
    const intent = JSON.parse(delivery.result ?? "{}"),
      body = JSON.parse(delivery.body);
    queuedSource(store, agent, session, delivery, intent, body);
    // A declared channel must verify, and an undeclared one must not exist: without the second half, a channel
    // message could be sent through any other path and never meet the re-derivation above.
    const get = (sql, ...args) => store.prepare(sql).get(...args);
    const followup =
      get("SELECT name FROM sqlite_master WHERE type='table' AND name='role_session_followups'") &&
      get("SELECT * FROM role_session_followups WHERE messageId=?", delivery.id);
    if (followup && !ratePermit(get, "followup", session.id, "followup:" + delivery.id, 64))
      throw Error("Orca native admission refused expired or lowered followup rate");
    const channelRow = hasChannelTables(get)
      ? get("SELECT messageId FROM role_channel_messages WHERE messageId=?", delivery.id)
      : null;
    if (Boolean(channelRow) !== Boolean(intent.channel))
      throw Error("Orca native admission refused mismatched role channel declaration");
    if (intent.channel && !roleChannelAdmitted(get, session, delivery, body, intent.channel))
      throw Error("Orca native admission refused changed role channel approval");
    if (intent.supervision) {
      const parent = intent.supervision,
        supervisor = store.prepare("SELECT * FROM sessions WHERE id=?").get(parent.supervisor);
      const grant = store
        .prepare("SELECT * FROM manager_grants WHERE supervisor=?")
        .get(parent.supervisor);
      const link = store.prepare("SELECT * FROM event_links WHERE worker=?").get(agent.id);
      const owned = store.prepare("SELECT * FROM manager_workers WHERE worker=?").get(agent.id);
      if (
        !supervisor ||
        supervisor.mode !== "delegated" ||
        supervisor.generation !== parent.generation ||
        supervisor.task !== session.task ||
        supervisor.boot !== BOOT ||
        supervisor.grantedAt !== sequence(supervisor.id).humanAt + 1 ||
        grant?.epoch !== parent.epoch ||
        grant.generation !== parent.generation ||
        link?.epoch !== parent.linkEpoch ||
        link.supervisor !== supervisor.id ||
        link.supervisorGeneration !== parent.generation ||
        link.workerGeneration !== session.generation ||
        owned?.supervisor !== supervisor.id ||
        owned.epoch !== parent.epoch ||
        owned.phase !== "attached" ||
        owned.generation !== session.generation
      )
        throw Error("Orca native admission refused changed supervisor authority");
    }
    const digest = createHash("sha256")
      .update(typeof prompt === "string" ? prompt : JSON.stringify(prompt))
      .digest("hex");
    if (
      saturated ||
      session.boot !== BOOT ||
      session.grantedAt !== sequence(agent.id).humanAt + 1 ||
      delivery.session !== agent.id ||
      delivery.state !== "intent" ||
      session.mode !== "delegated" ||
      session.generation !== intent.generation ||
      digest !== createHash("sha256").update(body.text).digest("hex") ||
      busy ||
      (agent.pendingPermissions?.size ?? agent.pendingPermissions?.length ?? 0) > 0 ||
      agent.runtime.lastUserMessageAt !== intent.expectedLastUserAt
    )
      throw new Error("Orca native admission refused stale, busy or changed session");
    return true;
  }

  function mcpRefreshAdmissionInStore(db, agent) {
    const get = (sql, ...args) => db.prepare(sql).get(...args);
    const sessionFields =
      "id,task,cwd,mode,generation,expected,authority,expectedAt,boot,grantedAt";
    const session = get(`SELECT ${sessionFields} FROM sessions WHERE id=?`, agent.id);
    const live = (row) =>
      row &&
      row.mode === "delegated" &&
      row.boot === BOOT &&
      row.grantedAt === sequence(row.id).humanAt + 1;
    const link = get(
      "SELECT worker,supervisor,epoch,workerGeneration,supervisorGeneration FROM event_links WHERE worker=?",
      agent.id,
    );
    const owned = get(
      "SELECT supervisor,epoch,worker,generation,phase FROM manager_workers WHERE worker=?",
      agent.id,
    );
    const parent = link && get(`SELECT ${sessionFields} FROM sessions WHERE id=?`, link.supervisor);
    const grant =
      link &&
      get(
        "SELECT supervisor,generation,epoch,maxWorkers FROM manager_grants WHERE supervisor=?",
        link.supervisor,
      );
    const ownGrant = get(
      "SELECT supervisor,generation,epoch,maxWorkers FROM manager_grants WHERE supervisor=?",
      agent.id,
    );
    const permissions = get("SELECT * FROM permission_grants WHERE session=?", agent.id);
    const permissionRoot =
      permissions &&
      get("SELECT * FROM permission_grants WHERE session=?", permissions.rootSession);
    const pending = db
      .prepare(
        "SELECT id,kind,state,body FROM deliveries WHERE session=? AND state IN ('intent','uncertain','reserved','queued') ORDER BY id",
      )
      .all(agent.id);
    const management =
      (!link && !owned) ||
      Boolean(
        link &&
        owned &&
        live(parent) &&
        parent.task === session?.task &&
        parent.authority === session?.authority &&
        grant?.generation === parent.generation &&
        link.supervisorGeneration === parent.generation &&
        link.workerGeneration === session?.generation &&
        owned.supervisor === parent.id &&
        owned.epoch === grant.epoch &&
        owned.generation === session?.generation &&
        owned.phase === "attached",
      );
    // Only this explicit host-owned switch intent may reconnect with a pending delivery.
    // Its full body joins the revision, so target changes during preparation refuse.
    let switchBody;
    try {
      if (
        pending.length === 1 &&
        pending[0].kind === "account-switch" &&
        pending[0].state === "intent"
      )
        switchBody = JSON.parse(pending[0].body);
    } catch {}
    const switching =
      switchBody &&
      (switchBody.generation ?? null) === (session?.generation ?? null) &&
      switchBody.boot === BOOT &&
      switchBody.humanAt === sequence(agent.id).humanAt &&
      typeof switchBody.accountId === "string";
    // FIX-8 B-1: the owner's own (unenrolled) chat has no sessions row; only its explicit account-switch intent opens it.
    const authorized =
      (live(session) && management && (!ownGrant || ownGrant.generation === session.generation)) ||
      (session?.mode === "human" && switching) ||
      (!session && management && switching);
    const allowed = Boolean(
      !saturated &&
      authorized &&
      (!session || session.cwd === agent.cwd) &&
      (!pending.length || switching),
    );
    const state = {
      session,
      link,
      owned,
      parent,
      grant,
      ownGrant,
      permissions,
      permissionRoot,
      pending,
      input: observation(agent.id),
      parentInput: parent && observation(parent.id),
      allowed,
    };
    return {
      revision: createHash("sha256").update(JSON.stringify(state)).digest("hex"),
      allowed,
      contextRotationAllowed: Boolean(allowed && live(session) && !pending.length),
    };
  }

  const canonicalPermission = (x) => JSON.stringify(orderPermission(x));
  function orderPermission(x) {
    return Array.isArray(x)
      ? x.map(orderPermission)
      : x && typeof x === "object"
        ? Object.fromEntries(
            Object.keys(x)
              .sort()
              .map((k) => [k, orderPermission(x[k])]),
          )
        : x;
  }
  const permissionDigest = (x) => createHash("sha256").update(canonicalPermission(x)).digest("hex");
  // H7 item 5 (merged from the live lineage's admission-guard.mjs, adapted to V4's trusted facts): a question put by a session
  // to the seat or manager that owns it (questions.mjs). Admitted only as the exact response the controller journaled for
  // exactly this request (request digest and canonical response both pinned in the intent), on a live delegated session at
  // the journaled generation and boot, whose current turn is the controller's own delivered send, and only an allow: it can
  // answer a question and nothing else -- never a tool, file or command permission (request.kind must be 'question'), never
  // twice, and without any routine grant (a question authorizes no action).
  function admitQuestionAnswer(db, agent, row, body, session, live, response, used) {
    const request = agent.pendingPermissions?.get(body.requestId),
      key = agent.id + ":" + body.requestId;
    if (
      saturated ||
      !live(session) ||
      row.pool !== "question:" + agent.id ||
      session.generation !== body.generation ||
      body.boot !== BOOT ||
      session.expected !== body.origin ||
      session.authority !== body.authority ||
      agent.runtime.lastUserMessageAt !== body.expectedLastUserAt
    )
      throw Error("Changed question authority");
    const delivery = db
      .prepare(
        "SELECT * FROM deliveries WHERE id=? AND session=? AND kind='send' AND state='delivered'",
      )
      .get(body.origin, agent.id);
    if (
      !delivery ||
      used.has(key) ||
      used.size >= 10000 ||
      agent.inFlightPermissionResponses?.has(body.requestId) ||
      !request ||
      request.kind !== "question" ||
      permissionDigest(request) !== body.requestDigest ||
      response?.behavior !== "allow" ||
      typeof body.response !== "string" ||
      canonicalPermission(response) !== body.response ||
      db.prepare("SELECT count(*) n FROM permission_intents WHERE pool=?").get(row.pool).n > 100
    )
      throw Error("Changed, duplicate or out-of-policy question answer");
    used.add(key); // Linearization, as for a routine permission: no await or journal write before the provider receives it.
    return body.requestId;
  }
  function permissionScope(request, proof, cwd, agent) {
    if (proof?.kind === "automatic-tool") {
      if (request.provider !== agent.provider) return false;
      try {
        return (
          canonicalPermission(
            automaticPermissionProof(
              request,
              cwd,
              permissionMode(agent),
              permissionDigest(request.input ?? {}),
            ),
          ) === canonicalPermission(proof)
        );
      } catch {
        return false;
      }
    }
    return (
      request.provider === "claude" &&
      request.kind === "tool" &&
      ["Write", "Edit"].includes(request.name) &&
      permissionDigest(request.input) === proof?.inputHash &&
      request.input.file_path === proof.file &&
      proof.root === cwd &&
      proof.file.startsWith(cwd + "/")
    );
  }
  function admitPermission(db, agent, intentId, response, used) {
    const row = db.prepare("SELECT * FROM permission_intents WHERE id=?").get(intentId);
    if (!row || row.state !== "intent" || row.session !== agent.id)
      throw Error("Unknown or consumed permission intent");
    const body = JSON.parse(row.body),
      session = db.prepare("SELECT * FROM sessions WHERE id=?").get(agent.id);
    const live = (s) =>
      s && s.mode === "delegated" && s.boot === BOOT && s.grantedAt === sequence(s.id).humanAt + 1;
    if (body.kind === "question-answer")
      return admitQuestionAnswer(db, agent, row, body, session, live, response, used);
    const grant = db.prepare("SELECT * FROM permission_grants WHERE session=?").get(agent.id);
    const root =
      grant && db.prepare("SELECT * FROM permission_grants WHERE session=?").get(grant.rootSession);
    const rootSession = root && db.prepare("SELECT * FROM sessions WHERE id=?").get(root.session);
    const request = agent.pendingPermissions?.get(body.requestId),
      key = agent.id + ":" + body.requestId;
    if (
      saturated ||
      !live(session) ||
      !live(rootSession) ||
      session.generation !== body.generation ||
      body.boot !== BOOT ||
      session.expected !== body.origin ||
      session.authority !== body.authority ||
      agent.runtime.lastUserMessageAt !== body.expectedLastUserAt ||
      !grant ||
      grant.revoked ||
      grant.generation !== session.generation ||
      grant.epoch !== body.grantEpoch ||
      !root ||
      root.revoked ||
      root.epoch !== grant.rootEpoch ||
      root.epoch !== row.pool ||
      root.generation !== rootSession.generation ||
      root.rootSession !== root.session ||
      root.rootEpoch !== root.epoch
    )
      throw Error("Changed permission authority");
    const delivery = db
      .prepare(
        "SELECT * FROM deliveries WHERE id=? AND session=? AND kind='send' AND state='delivered'",
      )
      .get(body.origin, agent.id);
    if (
      !delivery ||
      used.has(key) ||
      used.size >= 10000 ||
      agent.inFlightPermissionResponses?.has(body.requestId) ||
      !request ||
      !permissionScope(request, body.proof, session.cwd, agent) ||
      permissionDigest(request) !== body.requestDigest ||
      canonicalPermission(response) !== '{"behavior":"allow"}' ||
      db
        .prepare("SELECT count(*) n FROM permission_intents WHERE pool=? AND state!='escalated'")
        .get(row.pool).n > 100
    )
      throw Error("Changed, duplicate or out-of-policy native permission");
    const link = db.prepare("SELECT * FROM event_links WHERE worker=?").get(agent.id);
    if (link) {
      const parent = db.prepare("SELECT * FROM sessions WHERE id=?").get(link.supervisor),
        manager = db
          .prepare("SELECT * FROM manager_grants WHERE supervisor=?")
          .get(link.supervisor),
        owned = db.prepare("SELECT * FROM manager_workers WHERE worker=?").get(agent.id),
        b = body.supervision;
      if (
        !b ||
        !live(parent) ||
        parent.task !== session.task ||
        parent.generation !== link.supervisorGeneration ||
        session.generation !== link.workerGeneration ||
        link.epoch !== b.linkEpoch ||
        link.supervisor !== b.supervisor ||
        manager?.epoch !== b.managerEpoch ||
        manager.generation !== parent.generation ||
        owned?.supervisor !== parent.id ||
        owned.epoch !== manager.epoch ||
        owned.generation !== session.generation ||
        owned.phase !== "attached" ||
        (grant.rootSession !== grant.session && grant.rootSession !== parent.id)
      )
        throw Error("Changed parent permission authority");
    } else if (body.supervision || grant.rootSession !== grant.session)
      throw Error("Permission ownership link missing");
    used.add(key); // Linearization: no await or journal write before the provider receives this response.
    return body.requestId;
  }

  return { admit, admitPermission, mcpRefreshAdmissionInStore };
}
