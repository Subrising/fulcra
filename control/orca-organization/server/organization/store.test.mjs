import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { OrganizationStore } from "./store.mjs";
import {
  projectReferenceKey,
  resolveIntakeDestination,
  resolveExistingContext,
  resolveIntakeWorkspace,
  parsePrimeQuestion,
  parsePrimeDestination,
} from "../../shared/workspace-organization.mjs";
const book = "srv_example_book";
const ship = { serverId: book, projectId: "prj_ship_fixture", name: "Ship It" };
const demo = { serverId: book, projectId: "prj_demo_fixture", name: "Demo Day" };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fulcra-organization-test-"));
  const store = new OrganizationStore(path.join(root, "organization.sqlite"));
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const apply = (command, requestId = randomUUID(), expectedRevision = store.read().revision) =>
    store.mutate({ command, requestId, expectedRevision });
  apply({
    action: "create-workspace",
    name: "AI Game Dev",
    prime: { serverId: "srv_example_mini", agentId: randomUUID(), seat: "delivery" },
  });
  const workspaceId = store.read().workspaces[0].id;
  for (const project of [ship, demo]) apply({ action: "add-project", workspaceId, project });
  return { store, apply, workspaceId, root };
}
test("umbrella groups real project references without changing native identities or granting authority", (t) => {
  const { store } = fixture(t);
  const workspace = store.read().workspaces[0];
  assert.deepEqual(
    workspace.projects.map((p) => p.placements[0]),
    [ship, demo].map(({ serverId, projectId }) => ({ serverId, projectId })),
  );
  assert(workspace.projects.every((p) => p.controllerProjectId === null));
  assert.equal(workspace.name, "AI Game Dev");
  assert(!JSON.stringify(workspace).includes("capability"));
});
test("repeated request preserves one intake and conflicting reuse fails", (t) => {
  const { store, apply, workspaceId } = fixture(t);
  const intakeId = randomUUID(),
    requestId = randomUUID(),
    expectedRevision = store.read().revision;
  const command = {
    action: "begin-intake",
    workspaceId,
    intakeId,
    text: "Improve Ship It onboarding",
    projectKey: null,
  };
  apply(command, requestId, expectedRevision);
  apply(command, requestId, expectedRevision);
  assert.equal(store.read().intakes.length, 1);
  assert.equal(store.read().intakes[0].projectKey, projectReferenceKey(ship));
  assert.throws(
    () => apply({ ...command, text: "Something else" }, requestId, expectedRevision),
    /different work/,
  );
});
test("concurrent stale writer cannot replace grouping or route work", (t) => {
  const { store, apply, workspaceId } = fixture(t),
    revision = store.read().revision;
  apply({
    action: "add-task",
    workspaceId,
    projectKey: projectReferenceKey(ship),
    title: "Onboarding",
    kind: "feature",
    parentId: null,
  });
  assert.throws(
    () => apply({ action: "set-prime", workspaceId, prime: null }, randomUUID(), revision),
    /Organization changed/,
  );
  assert(store.read().workspaces[0].prime);
});
test("project planning work cannot borrow another project's parent", (t) => {
  const { store, apply, workspaceId } = fixture(t);
  apply({
    action: "add-task",
    workspaceId,
    projectKey: projectReferenceKey(ship),
    title: "Onboarding",
    kind: "feature",
    parentId: null,
  });
  const parentId = store.read().workspaces[0].tasks[0].id;
  assert.throws(
    () =>
      apply({
        action: "add-task",
        workspaceId,
        projectKey: projectReferenceKey(demo),
        title: "Wrong project",
        kind: "task",
        parentId,
      }),
    /another project/,
  );
  assert.equal(store.read().workspaces[0].tasks.length, 1);
});
test("route corrections retain conversation identity and prohibit creation replay", (t) => {
  const { store, apply, workspaceId } = fixture(t),
    intakeId = randomUUID(),
    deliveryId = randomUUID(),
    agentId = randomUUID();
  apply({
    action: "begin-intake",
    workspaceId,
    intakeId,
    text: "Ship It onboarding",
    projectKey: null,
  });
  const context = { ...ship, workspaceId: "wks_existing_ship" };
  delete context.name;
  apply({ action: "route", workspaceId, intakeId, projectKey: projectReferenceKey(ship), context });
  apply({ action: "reserve-chat", workspaceId, intakeId, deliveryId, agentId });
  apply({
    action: "chat-result",
    workspaceId,
    intakeId,
    deliveryId,
    state: "created",
    taskId: null,
  });
  const second = { serverId: book, projectId: demo.projectId, workspaceId: "wks_existing_demo" };
  apply({
    action: "route",
    workspaceId,
    intakeId,
    projectKey: projectReferenceKey(demo),
    context: second,
  });
  const intake = store.read().intakes[0];
  assert.equal(intake.id, intakeId);
  assert.equal(intake.conversations[0].agentId, agentId);
  assert.equal(intake.conversations[0].workspaceId, context.workspaceId);
  assert.equal(intake.context.workspaceId, second.workspaceId);
  assert.equal(intake.state, "correction-recorded");
  assert.throws(
    () => apply({ action: "reserve-chat", workspaceId, intakeId, deliveryId, agentId }),
    /already retained/,
  );
});
test("held/offline prime outcomes retain request ID and never replay automatically", (t) => {
  const { store, apply, workspaceId } = fixture(t),
    intakeId = randomUUID(),
    requestId = randomUUID();
  apply({
    action: "begin-intake",
    workspaceId,
    intakeId,
    text: "I have a new idea",
    projectKey: null,
  });
  apply({
    action: "reserve-prime",
    workspaceId,
    intakeId,
    requestId,
    prompt: "Retained routing prompt",
  });
  apply({
    action: "prime-result",
    workspaceId,
    intakeId,
    requestId,
    state: "held",
    reply: "Held for the existing prime's operator",
  });
  assert.equal(store.read().intakes[0].primeRequest.id, requestId);
  assert.throws(
    () =>
      apply({
        action: "reserve-prime",
        workspaceId,
        intakeId,
        requestId: randomUUID(),
        prompt: "Retained routing prompt",
      }),
    /already requested/,
  );
});
test("routing uses explicit names/recorded destination and asks only real ambiguity", (t) => {
  const { store } = fixture(t),
    workspace = store.read().workspaces[0];
  assert.equal(
    resolveIntakeDestination(workspace, "ship it onboarding").projectKey,
    projectReferenceKey(ship),
  );
  assert.equal(
    resolveIntakeDestination(workspace, "a new idea", projectReferenceKey(demo)).projectKey,
    projectReferenceKey(demo),
  );
  assert.equal(resolveIntakeDestination(workspace, "Ship It and Demo Day").kind, "ambiguous");
  assert.equal(resolveIntakeDestination(workspace, "a new idea").kind, "needs-prime");
});
test("context resolution uses exact references, not matching names or paths", (t) => {
  const { store } = fixture(t),
    project = store.read().workspaces[0].projects[0];
  const correct = { ...ship, workspaceId: "wks_existing", isProjectRoot: true };
  delete correct.name;
  const foreign = { ...correct, projectId: "another-project", workspaceId: "wks_foreign" };
  assert.equal(
    resolveExistingContext(project, [foreign, correct]).context.workspaceId,
    correct.workspaceId,
  );
  assert.equal(resolveExistingContext(project, [foreign]).kind, "unavailable");
});

test("company/default workspace and planning responsibility are metadata without controller grants", (t) => {
  const { store, apply, workspaceId } = fixture(t);
  apply({ action: "name-company", name: "Example Company" });
  apply({ action: "default-workspace", workspaceId });
  apply({
    action: "add-task",
    workspaceId,
    projectKey: projectReferenceKey(ship),
    title: "Ship onboarding",
    kind: "feature",
    parentId: null,
  });
  const taskId = store.read().workspaces[0].tasks[0].id;
  apply({ action: "update-task", workspaceId, taskId, status: "blocked", owner: null });
  assert.equal(store.read().companyName, "Example Company");
  assert.equal(store.read().defaultWorkspaceId, workspaceId);
  assert.deepEqual(store.read().workspaces[0].tasks[0], {
    id: taskId,
    projectKey: projectReferenceKey(ship),
    title: "Ship onboarding",
    kind: "feature",
    parentId: null,
    status: "blocked",
    owner: null,
    controllerTaskId: null,
    contexts: [],
    sessions: [],
  });
});
test("task session/context links are exact host references and reject another project's execution context", (t) => {
  const { store, apply, workspaceId } = fixture(t);
  apply({
    action: "add-task",
    workspaceId,
    projectKey: projectReferenceKey(ship),
    title: "Ship task",
    kind: "task",
    parentId: null,
  });
  const taskId = store.read().workspaces[0].tasks[0].id;
  const session = { serverId: book, workspaceId: "wks_shared_existing", agentId: randomUUID() };
  const context = { serverId: book, workspaceId: session.workspaceId, projectId: ship.projectId };
  apply({ action: "link-session", workspaceId, taskId, session, context });
  apply({ action: "link-session", workspaceId, taskId, session, context });
  assert.equal(store.read().workspaces[0].tasks[0].sessions.length, 1);
  assert.equal(store.read().workspaces[0].tasks[0].contexts.length, 1);
  assert.throws(
    () =>
      apply({
        action: "link-session",
        workspaceId,
        taskId,
        session,
        context: { ...context, projectId: demo.projectId },
      }),
    /must belong/,
  );
});

test("retained organization survives reload with company/task state and unchanged chat links", (t) => {
  const { store, apply, workspaceId, root } = fixture(t);
  apply({ action: "name-company", name: "Example Company" });
  apply({
    action: "add-task",
    workspaceId,
    projectKey: projectReferenceKey(ship),
    title: "A feature",
    kind: "feature",
    parentId: null,
  });
  const reloaded = new OrganizationStore(path.join(root, "organization.sqlite"));
  try {
    assert.deepEqual(reloaded.read(), store.read());
    assert.equal(fs.statSync(path.join(root, "organization.sqlite")).mode & 0o777, 0o600);
  } finally {
    reloaded.close();
  }
});

test("workspace names use word boundaries, and the configured umbrella resolves otherwise unnamed intake", () => {
  const ai = { id: "ai", name: "AI", projects: [] },
    game = { id: "game", name: "AI Game Dev", projects: [] };
  assert.equal(
    resolveIntakeWorkspace(
      { workspaces: [ai, game], defaultWorkspaceId: "game" },
      "Improve email onboarding",
    ).workspace.id,
    "game",
  );
  assert.equal(
    resolveIntakeWorkspace({ workspaces: [ai, game] }, "Improve email onboarding").kind,
    "ambiguous",
  );
  assert.equal(resolveIntakeWorkspace({ workspaces: [ai, game] }, "AI game dev").kind, "ambiguous");
});
test("a correlated prime clarification is readable and a prior reply cannot become this request's answer", () => {
  assert.equal(
    parsePrimeQuestion(
      '{"intakeId":"request","question":"Is this for Ship It or Demo Day?"}',
      "request",
    ),
    "Is this for Ship It or Demo Day?",
  );
  assert.equal(parsePrimeQuestion('{"intakeId":"old","question":"Old question"}', "request"), null);
  assert.equal(
    parsePrimeDestination(
      '{"intakeId":"request","projectKey":"p2"}',
      { projects: [{ key: "ship" }, { key: "demo" }] },
      "request",
    ),
    "demo",
  );
});
test("destination correction cannot authorize another chat allocation under a fresh delivery ID", (t) => {
  const { store, apply, workspaceId } = fixture(t),
    intakeId = randomUUID();
  const target = { serverId: book, projectId: ship.projectId, workspaceId: "wks_existing_ship" };
  apply({ action: "begin-intake", workspaceId, intakeId, text: "Ship It", projectKey: null });
  apply({
    action: "route",
    workspaceId,
    intakeId,
    projectKey: projectReferenceKey(ship),
    context: target,
  });
  apply({
    action: "reserve-chat",
    workspaceId,
    intakeId,
    deliveryId: randomUUID(),
    agentId: randomUUID(),
  });
  apply({
    action: "route",
    workspaceId,
    intakeId,
    projectKey: projectReferenceKey(ship),
    context: target,
  });
  assert.throws(
    () =>
      apply({
        action: "reserve-chat",
        workspaceId,
        intakeId,
        deliveryId: randomUUID(),
        agentId: randomUUID(),
      }),
    /already retained/,
  );
  assert.equal(store.read().intakes[0].conversations.length, 1);
});
