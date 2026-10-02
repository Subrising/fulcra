// Project session ownership: a seat starts sessions under its own project and nowhere else, ownership is a
// fact recorded at creation, and a session with no recorded owner reads unknown rather than being attached.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { FENCE_PROTOCOL } from "./native-fence.mjs";
import { ControlStore } from "./store.mjs";
import { Controller } from "./controller.mjs";
import { Bindings } from "./bindings.mjs";
import { RoleChannels } from "./role-channels.mjs";
import { RoleSessions } from "./role-sessions.mjs";
import { COMPANY, PROGRAMME } from "./authority.mjs";
import { rpc } from "./rpc.mjs";

const P = (n) => `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`;
const T = (n) => `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;
const issue = (id) => ({
  id,
  companyId: COMPANY,
  parentId: id === PROGRAMME ? null : PROGRAMME,
  assigneeUserId: "local-board",
  assigneeAgentId: null,
  status: "in_progress",
});

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-role-ownership-")));
  const store = new ControlStore(path.join(dir, "journal.sqlite"));
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  // A named local double. It records what a provider WOULD be asked to create; no session is ever started.
  const created = [],
    states = new Map();
  let refuse = null;
  const native = {
    route: () => undefined,
    create: async (a) => {
      if (refuse) throw Error(refuse);
      const id = randomUUID();
      created.push({ ...a, id });
      return {
        id,
        cwd: path.join(dir, a.messageId),
        managerToolsVersion: "1",
        roleToolsVersion: "1",
      };
    },
    inspect: async (id) => ({
      boot: "fixture",
      fenceProtocol: FENCE_PROTOCOL,
      saturated: false,
      humanAt: 0,
      status: "idle",
      pending: 0,
      lastPromptId: null,
      ...states.get(id),
    }),
    send: async (id, _text, messageId) => {
      states.set(id, { ...states.get(id), lastPromptId: messageId });
    },
  };
  const control = new Controller({ store, native, authority: async (id) => issue(id) });
  const source = {
    value: {
      observedAt: "2026-09-19T00:00:00.000Z",
      available: true,
      partial: false,
      projects: [
        { id: P(1), name: "One", description: null, status: "in_progress" },
        { id: P(2), name: "Two", description: null, status: "in_progress" },
      ],
      membership: [
        { taskId: T(1), projectId: P(1) },
        { taskId: T(2), projectId: P(1) },
        { taskId: T(3), projectId: P(2) },
      ],
      note: "test project source",
    },
  };
  control.bindings = new Bindings(
    control,
    async () => source.value,
    path.join(dir, "grants", "role"),
  );
  control.channels = new RoleChannels(control, () => Date.now());
  control.roleSessions = new RoleSessions(control);
  const enrol = (task) => {
    const id = randomUUID();
    store.created(id, task, path.join(dir, id));
    return id;
  };
  const capabilityFor = (id) =>
    JSON.parse(
      fs.readFileSync(
        control.bindings.grantRole({ sessionId: id, expectedGeneration: store.get(id).generation })
          .grantFile,
        "utf8",
      ),
    ).capability;
  return {
    dir,
    store,
    control,
    created,
    source,
    enrol,
    capabilityFor,
    request: rpc(control, "test-operator"),
    refuseCreation: (value) => {
      refuse = value;
    },
    delegate: (id) => control.handback(id, "Delegated for the ownership verification"),
  };
}
async function leader(t) {
  const f = fixture(t),
    lead = f.enrol(T(1));
  await f.control.bindings.assign({
    role: "project-orchestrator",
    seat: P(1),
    sessionId: lead,
    expectedSessionGeneration: 1,
    expectedRevision: 0,
    note: "Owns delivery of this project",
  });
  await f.delegate(lead);
  const capability = f.capabilityFor(lead);
  await f.request({
    method: "roles-allowance-set",
    operator: "test-operator",
    input: {
      role: "project-orchestrator",
      seat: P(1),
      expectedRevision: 1,
      maxSessions: 2,
      note: "Two sessions for this delivery cycle",
    },
  });
  return { ...f, lead, capability };
}
const start = (f, extra = {}) =>
  f.request({
    method: "roles-create-session",
    capability: f.capability,
    input: {
      sessionId: f.lead,
      seat: P(1),
      taskId: T(1),
      messageId: randomUUID(),
      provider: "claude",
      title: "Implement the release flag",
      ...extra,
    },
  });

test("a project orchestrator starts a session under its project with owner and parent recorded at creation", async (t) => {
  const f = await leader(t);
  const out = await start(f);
  assert.equal(out.state, "delivered");
  assert.equal(out.accepted, false);
  assert.equal(out.remaining, 1);
  assert.equal(f.created.length, 1);
  assert.equal(f.created[0].taskId, T(1));
  // Host is not in the scoped input at all, so a seat cannot place a session on another host.
  assert.equal(f.created[0].host, undefined);
  // The ownership fact was recorded BEFORE creation, keyed by the creation identity, so it can never be absent.
  const reservation = f.store.db
    .prepare("SELECT * FROM session_ownership WHERE request=?")
    .get(out.requestId);
  assert.equal(reservation.projectId, P(1));
  assert.equal(reservation.parentSession, f.lead);
  assert.equal(reservation.task, T(1));
  const owner = await f.request({
    method: "roles-ownership",
    operator: "test-operator",
    input: out.sessionId,
  });
  assert.equal(owner.ownership, "recorded");
  assert.equal(owner.projectId, P(1));
  assert.equal(owner.parentSession, f.lead);
  assert.equal(owner.leaderChanged, false);
  assert.equal(owner.currentLeader, f.lead);
  // It appears under the project immediately, linked back to its leader.
  const view = await f.request({
    method: "bindings-project",
    operator: "test-operator",
    input: P(1),
  });
  const row = view.tasks
    .find((x) => x.taskId === T(1))
    .sessions.find((s) => s.id === out.sessionId);
  assert.equal(row.owner.ownership, "recorded");
  assert.equal(row.owner.parentSession, f.lead);
  assert.deepEqual(
    view.needed.filter((n) => n.kind === "unowned-session").map((n) => n.sessionId),
    [f.lead],
  );
  // The seat sees what it owns, with its remaining operator-set allowance.
  const mine = await f.request({
    method: "roles-sessions",
    capability: f.capability,
    input: { sessionId: f.lead },
  });
  assert.deepEqual(
    mine.projects.map((p) => [
      p.projectId,
      p.allowance.remaining,
      p.sessions.map((s) => s.sessionId),
    ]),
    [[P(1), 1, [out.sessionId]]],
  );
});

test("a seat cannot reach another project, another seat, or beyond its allowance, and cannot set it", async (t) => {
  const f = await leader(t);
  // Another project's task is refused by recorded membership, not by naming.
  await assert.rejects(start(f, { taskId: T(3) }), /not an explicitly recorded member/);
  await assert.rejects(start(f, { seat: P(2) }), /project seat this session currently holds/);
  // A task in no project at all is refused the same way.
  await assert.rejects(start(f, { taskId: T(9) }), /not an explicitly recorded member/);
  // It cannot grant itself allowance: the operator verb refuses its capability outright.
  for (const method of ["roles-allowance-set", "roles-allowances"])
    await assert.rejects(
      f.request({
        method,
        capability: f.capability,
        input: {
          role: "project-orchestrator",
          seat: P(1),
          expectedRevision: 1,
          maxSessions: 32,
          note: "Raising my own allowance",
        },
      }),
      /Operator authorization required/,
    );
  assert.equal(f.created.length, 0);
  // The allowance is real: two succeed, the third refuses and starts nothing.
  await start(f);
  await start(f);
  await assert.rejects(start(f), /allowance reached/);
  assert.equal(f.created.length, 2);
  // An operator cannot silently reset the count below what was already spent.
  await assert.rejects(
    f.request({
      method: "roles-allowance-set",
      operator: "test-operator",
      input: {
        role: "project-orchestrator",
        seat: P(1),
        expectedRevision: 1,
        maxSessions: 1,
        note: "Trying to reset the count",
      },
    }),
    /below what this seat has already used/,
  );
});

test("replacing the leader ends its allowance and leaves the parent link as recorded history", async (t) => {
  const f = await leader(t);
  const out = await start(f);
  const replacement = f.enrol(T(1));
  await f.control.bindings.assign({
    role: "project-orchestrator",
    seat: P(1),
    sessionId: replacement,
    expectedSessionGeneration: 1,
    expectedRevision: 1,
    note: "Replacing the project leader",
  });
  await f.delegate(replacement);
  f.capabilityFor(replacement);
  // The successor inherits NOTHING from its predecessor: not the operator's decision, and not what that
  // decision had left unspent. What it holds is the ordinary seating default at its own new revision, with
  // its own fresh count -- the predecessor's spend does not follow the seat (PROPOSAL.md §1).
  const allowances = await f.request({ method: "roles-allowances", operator: "test-operator" });
  assert.deepEqual(
    allowances.allowances.map((x) => [
      x.seatRevision,
      x.maxSessions,
      x.used,
      x.current,
      x.conferredBy,
    ]),
    [[2, 8, 0, true, "seating"]],
  ); // G4 default
  // Two conferrals are spent: the original seating and this replacement. The operator's own setAllowance in
  // between spends none -- an operator decision is not a default and never consumes the lifetime budget.
  assert.equal(allowances.allowances[0].defaultConferrals, 2);
  assert.equal(allowances.allowances[0].maxDefaultConferrals, 3);
  // The predecessor's capability is gone with its seat, so it cannot spend what it had left.
  await assert.rejects(
    f.request({
      method: "roles-create-session",
      capability: f.capability,
      input: {
        sessionId: f.lead,
        seat: P(1),
        taskId: T(1),
        messageId: randomUUID(),
        provider: "claude",
        title: "Spending after replacement",
      },
    }),
    /Role capability revoked or invalid/,
  );
  assert.equal(f.created.length, 1, "nothing was created by the replaced leader");
  // The existing session keeps its recorded parent; history is not rewritten to the new leader.
  const owner = await f.request({
    method: "roles-ownership",
    operator: "test-operator",
    input: out.sessionId,
  });
  assert.equal(owner.parentSession, f.lead);
  assert.equal(owner.leaderChanged, true);
  assert.equal(owner.currentLeader, replacement);
  // It still reads as owned by the project, so replacing a leader does not orphan its sessions.
  assert.equal(owner.ownership, "recorded");
  assert.equal(owner.projectId, P(1));
});

test("a session created outside this path reads unknown and is never attached to the project", async (t) => {
  const f = await leader(t);
  // An ordinary operator creation on a member task, with a title that names the project.
  const messageId = randomUUID();
  const delivery = await f.request({
    method: "create",
    operator: "test-operator",
    input: { messageId, taskId: T(1), provider: "codex", title: "One delivery work session" },
  });
  const orphan = delivery.result.id;
  const owner = await f.request({
    method: "roles-ownership",
    operator: "test-operator",
    input: orphan,
  });
  assert.equal(owner.ownership, "unknown");
  assert.equal(owner.projectId, null);
  assert.equal(owner.parentSession, null);
  assert.match(owner.detail, /owning project cannot be established/);
  const view = await f.request({
    method: "bindings-project",
    operator: "test-operator",
    input: P(1),
  });
  const row = view.tasks.find((x) => x.taskId === T(1)).sessions.find((s) => s.id === orphan);
  assert.equal(row.owner.ownership, "unknown");
  assert(view.needed.some((n) => n.kind === "unowned-session" && n.sessionId === orphan));
  // Nothing about it is owned by the seat, so a UI cannot list it under the project as the leader's work.
  const mine = await f.request({
    method: "roles-sessions",
    capability: f.capability,
    input: { sessionId: f.lead },
  });
  assert.deepEqual(mine.projects[0].sessions, []);

  // An operator MAY declare the project at creation, using the same before-create row, so the common case
  // is a recorded fact. Unknown then means genuinely unknown rather than merely un-declared.
  const declaredId = randomUUID();
  const declared = await f.request({
    method: "create",
    operator: "test-operator",
    input: {
      projectId: P(1),
      messageId: declaredId,
      taskId: T(2),
      provider: "codex",
      title: "Declared at creation",
    },
  });
  assert.equal(declared.declaredProject, P(1));
  const reservation = f.store.db
    .prepare(
      "SELECT projectId,task,declaredBy,seat,parentSession FROM session_ownership WHERE request=?",
    )
    .get(declaredId);
  assert.deepEqual(
    { ...reservation },
    { projectId: P(1), task: T(2), declaredBy: "operator", seat: null, parentSession: null },
  );
  const declaredOwner = await f.request({
    method: "roles-ownership",
    operator: "test-operator",
    input: declared.result.id,
  });
  assert.equal(declaredOwner.ownership, "declared");
  assert.equal(declaredOwner.projectId, P(1));
  assert.equal(declaredOwner.parentSession, null);
  // Declaration is never inferred and never mandatory: a wrong project is refused, and omitting it still works.
  await assert.rejects(
    f.request({
      method: "create",
      operator: "test-operator",
      input: {
        projectId: P(2),
        messageId: randomUUID(),
        taskId: T(1),
        provider: "codex",
        title: "Declared against the wrong project",
      },
    }),
    /not an explicitly recorded member/,
  );
  assert.equal(
    (
      await f.request({
        method: "create",
        operator: "test-operator",
        input: {
          messageId: randomUUID(),
          taskId: T(1),
          provider: "codex",
          title: "Bootstrap before any seat exists",
        },
      })
    ).state,
    "delivered",
  );
  // A declared session is owned by the project but led by nobody, so it does not fabricate a parent link.
  const declaredView = await f.request({
    method: "bindings-project",
    operator: "test-operator",
    input: P(1),
  });
  assert.equal(
    declaredView.tasks
      .find((x) => x.taskId === T(2))
      .sessions.find((s) => s.id === declared.result.id).owner.ownership,
    "declared",
  );

  // An uncertain creation retains its ownership reservation rather than leaving an unowned session behind.
  f.refuseCreation("Provider unavailable");
  const uncertain = await start(f);
  assert.equal(uncertain.state, "uncertain");
  assert.equal(uncertain.sessionId, null);
  assert.equal(
    f.store.db
      .prepare("SELECT count(*) n FROM session_ownership WHERE request=?")
      .get(uncertain.requestId).n,
    1,
  );
  assert.match(uncertain.note, /operator recovery/);
});

test("a declared session is adoptable by operator act only, within its own project and allowance", async (t) => {
  const f = await leader(t);
  const request = randomUUID();
  const declared = await f.request({
    method: "create",
    operator: "test-operator",
    input: {
      projectId: P(1),
      messageId: request,
      taskId: T(2),
      provider: "codex",
      title: "Declared and leaderless",
    },
  });
  const session = declared.result.id;
  // The projection names it as the hole it is, and points at the remedy.
  const before = await f.request({
    method: "bindings-project",
    operator: "test-operator",
    input: P(1),
  });
  assert(before.needed.some((n) => n.kind === "declared-session-unled" && n.sessionId === session));
  assert.equal(
    (await f.request({ method: "roles-ownership", operator: "test-operator", input: session }))
      .currentLeader,
    null,
  );

  // A seat cannot adopt: acquiring a relationship over an existing session is operator-gated everywhere.
  await assert.rejects(
    f.request({
      method: "roles-adopt",
      capability: f.capability,
      input: { request, seat: P(1), expectedRevision: 1, note: "Claiming this session for myself" },
    }),
    /Operator authorization required/,
  );
  // Nor can an operator adopt it into a different project's seat.
  await assert.rejects(
    f.request({
      method: "roles-adopt",
      operator: "test-operator",
      input: { request, seat: P(2), expectedRevision: 1, note: "Adopting into another project" },
    }),
    /different project/,
  );
  // Nor adopt a session that already recorded a seat at creation.
  const own = await start(f);
  await assert.rejects(
    f.request({
      method: "roles-adopt",
      operator: "test-operator",
      input: {
        request: own.requestId,
        seat: P(1),
        expectedRevision: 1,
        note: "Adopting an already-led session",
      },
    }),
    /not leaderless/,
  );

  const adopted = await f.request({
    method: "roles-adopt",
    operator: "test-operator",
    input: {
      request,
      seat: P(1),
      expectedRevision: 1,
      note: "Placing this session under the project leader",
    },
  });
  assert.equal(adopted.ownership, "adopted");
  assert.equal(adopted.sessionId, session);
  // Both facts stand: the creation still records no parent, and adoption is recorded separately.
  assert.equal(adopted.parentSession, null);
  const creationRow = f.store.db
    .prepare(
      "SELECT parentSession,seat,seatRole,seatRevision FROM session_ownership WHERE request=?",
    )
    .get(request);
  assert.deepEqual(
    { ...creationRow },
    { parentSession: null, seat: null, seatRole: null, seatRevision: null },
  );
  assert.equal(adopted.adoption.leaderSession, f.lead);
  assert.equal(adopted.currentLeader, f.lead);
  // It now routes to the seat, and the need is gone.
  const mine = await f.request({
    method: "roles-sessions",
    capability: f.capability,
    input: { sessionId: f.lead },
  });
  assert.deepEqual(
    mine.projects[0].sessions.map((s) => [s.sessionId, s.adopted]).sort(),
    [
      [own.sessionId, false],
      [session, true],
    ].sort(),
  );
  const after = await f.request({
    method: "bindings-project",
    operator: "test-operator",
    input: P(1),
  });
  assert.equal(
    after.needed.some((n) => n.kind === "declared-session-unled"),
    false,
  );
  // Adoption spent allowance, so it cannot be used to grow ownership past the operator's bound.
  assert.equal(mine.projects[0].allowance.remaining, 0);
  await assert.rejects(start(f), /allowance reached/);
  await assert.rejects(
    f.request({
      method: "roles-adopt",
      operator: "test-operator",
      input: { request, seat: P(1), expectedRevision: 1, note: "Adopting the same session twice" },
    }),
    /already been adopted/,
  );
});

test("adoption re-verifies membership now, not only at creation", async (t) => {
  const f = await leader(t);
  const request = randomUUID();
  await f.request({
    method: "create",
    operator: "test-operator",
    input: {
      projectId: P(1),
      messageId: request,
      taskId: T(2),
      provider: "codex",
      title: "Declared while T2 was a member",
    },
  });
  // The task leaves the project after creation. The ownership row still records that membership held then.
  f.source.value = {
    ...f.source.value,
    membership: f.source.value.membership.filter((m) => m.taskId !== T(2)),
  };
  await assert.rejects(
    f.request({
      method: "roles-adopt",
      operator: "test-operator",
      input: {
        request,
        seat: P(1),
        expectedRevision: 1,
        note: "Adopting a task that has left the project",
      },
    }),
    /not an explicitly recorded member/,
  );
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM session_adoptions").get().n, 0);
  assert.equal(
    f.store.db.prepare("SELECT used FROM role_session_allowances WHERE seat=?").get(P(1)).used,
    0,
    "a refused adoption spends nothing",
  );
  // An unavailable source fails closed, as every sibling write does.
  f.source.value = {
    observedAt: "",
    available: false,
    partial: true,
    projects: [],
    membership: [],
    note: "",
  };
  await assert.rejects(
    f.request({
      method: "roles-adopt",
      operator: "test-operator",
      input: {
        request,
        seat: P(1),
        expectedRevision: 1,
        note: "Adopting while the source is unavailable",
      },
    }),
    /Project directory unavailable/,
  );
  // Restored membership, and it adopts.
  f.source.value = {
    observedAt: "2026-09-19T00:00:00.000Z",
    available: true,
    partial: false,
    projects: [{ id: P(1), name: "One", description: null, status: "in_progress" }],
    membership: [
      { taskId: T(1), projectId: P(1) },
      { taskId: T(2), projectId: P(1) },
    ],
    note: "restored",
  };
  assert.equal(
    (
      await f.request({
        method: "roles-adopt",
        operator: "test-operator",
        input: {
          request,
          seat: P(1),
          expectedRevision: 1,
          note: "Adopting once membership is confirmed again",
        },
      })
    ).ownership,
    "adopted",
  );
});

test("an operator asks the seat; the seat is woken, acts, and is recorded as the leader", async (t) => {
  const f = await leader(t);
  const asked = await f.request({
    method: "roles-request-session",
    operator: "test-operator",
    input: {
      seat: P(1),
      expectedRevision: 1,
      taskId: T(2),
      provider: "claude",
      title: "Implement the release flag",
      note: "Board asked for this ahead of the cycle",
    },
  });
  assert.equal(asked.state, "pending");
  assert.equal(asked.created, false);
  assert.equal(asked.sessionId, null);
  // The request creates nothing and spends nothing until the seat acts.
  assert.equal(f.created.length, 0);
  assert.equal(
    f.store.db.prepare("SELECT used FROM role_session_allowances WHERE seat=?").get(P(1)).used,
    0,
  );

  // The seat is woken through the controller's own pump, over the ordinary send path.
  assert.equal(f.control.roleSessions.interested(f.lead), true);
  await f.control.roleSessions.pump();
  const wake = f.store.db
    .prepare("SELECT state,wake FROM role_session_requests WHERE id=?")
    .get(asked.requestId);
  assert.equal(wake.state, "notified");
  assert.equal(f.store.delivery(wake.wake).session, f.lead);
  assert.match(JSON.parse(f.store.delivery(wake.wake).body).text, /role_accept_session/);
  assert.equal(f.control.roleSessions.interested(f.lead), false);

  // The seat sees it and accepts. The operator's parameters are honoured exactly.
  const mine = await f.request({
    method: "roles-sessions",
    capability: f.capability,
    input: { sessionId: f.lead },
  });
  assert.deepEqual(
    mine.requests.map((r) => [r.requestId, r.taskId, r.title, r.state]),
    [[asked.requestId, T(2), "Implement the release flag", "notified"]],
  );
  // N2-req: the seat cannot redirect the request. The accepted key set is exact, so supplying a task,
  // provider or title of its own is refused outright rather than quietly ignored.
  for (const extra of [
    { taskId: T(1) },
    { provider: "codex" },
    { title: "Something else entirely" },
    { seat: P(1) },
  ])
    await assert.rejects(
      f.request({
        method: "roles-accept-session",
        capability: f.capability,
        input: { sessionId: f.lead, requestId: asked.requestId, messageId: randomUUID(), ...extra },
      }),
      /Invalid session acceptance/,
      JSON.stringify(extra),
    );
  assert.equal(f.created.length, 0);
  const out = await f.request({
    method: "roles-accept-session",
    capability: f.capability,
    input: { sessionId: f.lead, requestId: asked.requestId, messageId: randomUUID() },
  });
  assert.equal(out.state, "delivered");
  assert.equal(out.remaining, 1);
  assert.equal(f.created[0].taskId, T(2));
  assert.equal(f.created[0].title, "Implement the release flag");
  assert.equal(f.created[0].provider, "claude");
  // The seat, not the operator, is the recorded leader, and its own allowance was spent.
  const owner = await f.request({
    method: "roles-ownership",
    operator: "test-operator",
    input: out.sessionId,
  });
  assert.equal(owner.ownership, "recorded");
  assert.equal(owner.parentSession, f.lead);
  assert.equal(owner.projectId, P(1));
  assert.equal(
    f.store.db.prepare("SELECT used FROM role_session_allowances WHERE seat=?").get(P(1)).used,
    1,
  );
  assert.equal(
    (await f.request({ method: "roles-session-requests", operator: "test-operator" })).requests[0]
      .state,
    "accepted",
  );
});

test("a requested session is the seat’s act alone: the operator cannot force, bypass or impersonate", async (t) => {
  const f = await leader(t);
  const ask = (extra = {}) =>
    f.request({
      method: "roles-request-session",
      operator: "test-operator",
      input: {
        seat: P(1),
        expectedRevision: 1,
        taskId: T(2),
        provider: "claude",
        title: "Implement the release flag",
        note: "Board asked for this ahead of the cycle",
        ...extra,
      },
    });
  // A request cannot reach outside the seat's project, nor a stale seat revision.
  await assert.rejects(ask({ taskId: T(3) }), /not an explicitly recorded member/);
  await assert.rejects(ask({ expectedRevision: 2 }), /seat changed/);
  // The operator cannot call the seat's verbs: it holds no role capability and must not.
  const asked = await ask();
  for (const [method, extra] of [
    ["roles-accept-session", { messageId: randomUUID() }],
    ["roles-decline-session", { note: "Declining on the seat behalf" }],
  ])
    await assert.rejects(
      f.request({
        method,
        operator: "test-operator",
        input: { sessionId: f.lead, requestId: asked.requestId, ...extra },
      }),
      /Role capability revoked or invalid/,
    );
  assert.equal(f.created.length, 0);
  // The seat may decline, which creates nothing and spends nothing.
  const declined = await f.request({
    method: "roles-decline-session",
    capability: f.capability,
    input: {
      sessionId: f.lead,
      requestId: asked.requestId,
      note: "This belongs on the other member task",
    },
  });
  assert.equal(declined.state, "declined");
  assert.equal(f.created.length, 0);
  assert.equal(
    f.store.db.prepare("SELECT used FROM role_session_allowances WHERE seat=?").get(P(1)).used,
    0,
  );
  await assert.rejects(
    f.request({
      method: "roles-accept-session",
      capability: f.capability,
      input: { sessionId: f.lead, requestId: asked.requestId, messageId: randomUUID() },
    }),
    /not open/,
  );
  // An operator cannot request beyond the allowance it set, so a seat is never woken for work it cannot do.
  // N1-req: open requests count against the allowance, not only spent ones. With maxSessions 2 and none
  // accepted yet, a third request must refuse rather than waking the seat for work it could never satisfy.
  const first = await ask(),
    second = await ask();
  await assert.rejects(ask(), /no remaining operator session allowance/);
  assert.equal(
    f.store.db
      .prepare("SELECT count(*) n FROM role_session_requests WHERE state IN ('pending','notified')")
      .get().n,
    2,
  );
  for (const r of [first, second])
    await f.request({
      method: "roles-accept-session",
      capability: f.capability,
      input: { sessionId: f.lead, requestId: r.requestId, messageId: randomUUID() },
    });
  assert.equal(f.created.length, 2);
  await assert.rejects(ask(), /no remaining operator session allowance/);
});

test("every role table refuses a wrong shape at startup rather than failing at first use", async (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-role-schema-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // One previously unguarded table per module, each given a shape the module does not expect.
  const cases = [
    [
      "role_credentials",
      "CREATE TABLE role_credentials(session TEXT PRIMARY KEY)",
      (c) =>
        new Bindings(
          c,
          async () => ({
            observedAt: "",
            available: false,
            partial: true,
            projects: [],
            membership: [],
            note: "",
          }),
          path.join(dir, "g"),
        ),
    ],
    [
      "role_channel_requests",
      "CREATE TABLE role_channel_requests(id TEXT PRIMARY KEY)",
      (c) => new RoleChannels(c, () => Date.now()),
    ],
    [
      "session_adoptions",
      "CREATE TABLE session_adoptions(request TEXT PRIMARY KEY)",
      (c) => new RoleSessions(c),
    ],
  ];
  for (const [table, create, build] of cases) {
    const file = path.join(dir, table + ".sqlite");
    const store = new ControlStore(file);
    store.db.exec(create);
    const control = new Controller({
      store,
      native: { route: () => undefined },
      authority: async () => ({}),
    });
    // Startup refuses, naming the table, instead of starting clean and breaking on the first positional insert.
    assert.throws(
      () => build(control),
      new RegExp(`Unsupported ${table} schema; explicit migration required`),
      table,
    );
    store.close();
  }
});

test("a directly declared bootstrap session can be adopted from the ownership read alone", async (t) => {
  const f = await leader(t);
  // The bootstrap case adoption exists for: an operator creates the first session on a project, declared,
  // with no seat. Nothing but the ownership read tells a surface how to adopt it.
  const declared = await f.request({
    method: "create",
    operator: "test-operator",
    input: {
      projectId: P(1),
      messageId: randomUUID(),
      taskId: T(2),
      provider: "codex",
      title: "The first session on this project",
    },
  });
  const session = declared.result.id;

  const owner = await f.request({
    method: "roles-ownership",
    operator: "test-operator",
    input: session,
  });
  assert.equal(owner.ownership, "declared");
  // The key roles-adopt takes is on the read, so no separate lookup and no guessing is needed.
  assert.equal(typeof owner.creationRequestId, "string");
  assert.equal(
    owner.creationRequestId,
    f.store.db
      .prepare("SELECT request FROM session_ownership WHERE projectId=? AND task=?")
      .get(P(1), T(2)).request,
  );
  // It is the creation identity, not the session id -- passing the session id would be a well-formed UUID
  // the controller accepts as a lookup key and then fails to match, which is the trap the surface avoided.
  assert.notEqual(owner.creationRequestId, session);
  await assert.rejects(
    f.request({
      method: "roles-adopt",
      operator: "test-operator",
      input: {
        request: session,
        seat: P(1),
        expectedRevision: 1,
        note: "Adopting by session id instead",
      },
    }),
    /records no owning project/,
  );

  const adopted = await f.request({
    method: "roles-adopt",
    operator: "test-operator",
    input: {
      request: owner.creationRequestId,
      seat: P(1),
      expectedRevision: 1,
      note: "Adopting the bootstrap session into its seat",
    },
  });
  assert.equal(adopted.ownership, "adopted");
  assert.equal(adopted.sessionId, session);
  assert.equal(adopted.creationRequestId, owner.creationRequestId);
  assert.equal(adopted.grantsAuthority, false);
  // It reaches the surface the same way through the project projection, where leaderless sessions are found.
  const view = await f.request({
    method: "bindings-project",
    operator: "test-operator",
    input: P(1),
  });
  const row = view.tasks.find((x) => x.taskId === T(2)).sessions.find((s) => s.id === session);
  assert.equal(row.owner.creationRequestId, owner.creationRequestId);
  // A session with no ownership record genuinely has no key, and says so rather than inventing one.
  const orphan = await f.request({
    method: "create",
    operator: "test-operator",
    input: {
      messageId: randomUUID(),
      taskId: T(1),
      provider: "codex",
      title: "No declared project",
    },
  });
  assert.equal(
    (
      await f.request({
        method: "roles-ownership",
        operator: "test-operator",
        input: orphan.result.id,
      })
    ).creationRequestId,
    null,
  );
});

test("seating confers a bounded default allowance the operator can withdraw, raise, and is alone able to choose", async (t) => {
  const f = fixture(t);
  const lead = f.enrol(T(1));
  await f.control.bindings.assign({
    role: "project-orchestrator",
    seat: P(1),
    sessionId: lead,
    expectedSessionGeneration: 1,
    expectedRevision: 0,
    note: "Owns delivery of this project",
  });
  await f.delegate(lead);
  // Seating now confers a bounded default (PROPOSAL.md §1), and the surface says where it came from rather
  // than leaving an operator to guess whether a decision was ever made.
  const before = await f.request({ method: "roles-allowances", operator: "test-operator" });
  assert.deepEqual(
    before.allowances.map((a) => [a.seat, a.maxSessions, a.remaining, a.current]),
    [[P(1), 8, 8, true]],
  ); // G4 default
  assert.equal(before.allowances[0].conferredBy, "seating");
  assert.equal(before.allowances[0].blocked, null);
  assert.equal(
    before.allowances[0].defaultConferrals,
    1,
    "one of the lifetime conferrals is spent",
  );
  // An operator may take the default away entirely, and then the seat genuinely cannot act.
  await f.request({
    method: "roles-allowance-set",
    operator: "test-operator",
    input: {
      role: "project-orchestrator",
      seat: P(1),
      expectedRevision: 1,
      maxSessions: 0,
      note: "Operator withdraws the seating default",
    },
  });
  const withdrawn = await f.request({ method: "roles-allowances", operator: "test-operator" });
  assert.equal(
    withdrawn.allowances[0].conferredBy,
    "operator",
    "an operator decision is no longer reported as a default",
  );
  const capability = f.capabilityFor(lead);
  await assert.rejects(
    f.request({
      method: "roles-create-session",
      capability,
      input: {
        sessionId: lead,
        seat: P(1),
        taskId: T(1),
        messageId: randomUUID(),
        provider: "claude",
        title: "After the default was withdrawn",
      },
    }),
    /allowance reached/,
  );
  // And may raise it again. The operator remains the only party that can choose the number.
  await f.request({
    method: "roles-allowance-set",
    operator: "test-operator",
    input: {
      role: "project-orchestrator",
      seat: P(1),
      expectedRevision: 1,
      maxSessions: 1,
      note: "Granting a replacement allowance",
    },
  });
  const after = await f.request({ method: "roles-allowances", operator: "test-operator" });
  assert.deepEqual(
    after.allowances.map((a) => [a.seat, a.maxSessions, a.remaining, a.current]),
    [[P(1), 1, 1, true]],
  );
  // The seat still cannot set its own allowance, default or not.
  await assert.rejects(
    f.request({
      method: "roles-allowance-set",
      capability,
      input: {
        role: "project-orchestrator",
        seat: P(1),
        expectedRevision: 1,
        maxSessions: 32,
        note: "A seat trying to fund itself",
      },
    }),
    /Operator authorization/,
  );
});
