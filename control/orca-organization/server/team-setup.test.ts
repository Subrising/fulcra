import test from "node:test";
import assert from "node:assert/strict";
import { createTeamChats, createTeamSetup } from "./team-setup";

// Fulcra 0.2.8: one-step team setup. The controller is faked here; its own rules are tested in src/control/team.test.mjs.

const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
const PROGRAMME = id(90);
const NOW = "2026-10-08T00:00:00.000Z";

function controller(seats: any[] = [], remits: any[] = []) {
  const calls: [string, any][] = [];
  const call = async (method: string, input?: any) => {
    calls.push([method, input]);
    switch (method) {
      case "bindings-status":
        return { bindings: seats, programme: PROGRAMME };
      case "team-enrol":
        return { action: "enrolled", generation: 1, sessionId: input.sessionId };
      case "team-project-create":
        return { projectId: id(50), taskId: id(51), name: input.name };
      case "team-project-anchor":
        return { projectId: input.projectId, taskId: id(52) };
      case "remits-list":
        return { remits };
      case "bindings-assign":
        seats.push({
          role: input.role,
          seat: input.seat,
          state: "assigned",
          sessionId: input.sessionId,
          revision: 1,
          projectId: input.role === "prime" ? null : input.seat,
        });
        return { action: "assign" };
      default:
        return {};
    }
  };
  return { calls, setup: createTeamSetup(call, () => NOW), call };
}

test("Make main assistant enrols the chat on the programme root, then seats it on the main seat", async () => {
  const c = controller();
  const r = await c.setup({ action: "main-assistant", sessionId: id(1) });
  assert.equal(r.status, "done");
  assert.deepEqual(
    c.calls.map(([m]) => m),
    ["bindings-status", "team-enrol", "bindings-status", "bindings-assign"],
  );
  assert.equal(c.calls[1][1].taskId, PROGRAMME);
  assert.deepEqual(
    { ...c.calls[3][1], note: undefined },
    {
      role: "prime",
      seat: "main",
      sessionId: id(1),
      expectedRevision: 0,
      expectedSessionGeneration: 1,
      note: undefined,
    },
  );
});

test("Make lead of a new project creates it, seats the lead and puts the project under the main assistant", async () => {
  const c = controller([
    {
      role: "prime",
      seat: "main",
      state: "assigned",
      sessionId: id(1),
      revision: 1,
      projectId: null,
    },
  ]);
  const r = await c.setup({
    action: "project-lead",
    sessionId: id(2),
    projectName: "Mac operations",
  });
  assert.equal(r.status, "done");
  assert.equal(r.projectId, id(50));
  const methods = c.calls.map(([m]) => m);
  assert.deepEqual(methods, [
    "team-project-create",
    "team-enrol",
    "bindings-status",
    "bindings-assign",
    "bindings-status",
    "remits-list",
    "remits-assign",
  ]);
  assert.equal(c.calls[1][1].taskId, id(51));
  assert.equal(c.calls[3][1].seat, id(50));
  assert.deepEqual(c.calls[6][1].scope, { kind: "project", projectId: id(50) });
  assert.equal(c.calls[6][1].primeSeat, "main");
});

test("an existing project owned by another main assistant moves to the main one", async () => {
  const c = controller(
    [
      {
        role: "prime",
        seat: "delivery",
        state: "assigned",
        sessionId: id(3),
        revision: 2,
        projectId: null,
      },
      {
        role: "prime",
        seat: "main",
        state: "assigned",
        sessionId: id(1),
        revision: 1,
        projectId: null,
      },
    ],
    [
      {
        id: id(70),
        revision: 4,
        primeSeat: "delivery",
        scope: { kind: "project", projectId: id(60) },
      },
    ],
  );
  const r = await c.setup({ action: "project-lead", sessionId: id(2), projectId: id(60) });
  assert.equal(r.status, "done");
  const move = c.calls.find(([m]) => m === "remits-move")!;
  assert.deepEqual(
    { ...move[1], messageId: undefined, note: undefined },
    {
      messageId: undefined,
      expectedRevision: 4,
      remitId: id(70),
      toPrimeSeat: "main",
      note: undefined,
    },
  );
});

test("the old main assistant record is removed only while another main assistant is kept", async () => {
  const alone = controller([
    {
      role: "prime",
      seat: "delivery",
      state: "assigned",
      sessionId: id(3),
      revision: 2,
      projectId: null,
    },
  ]);
  const refused = await alone.setup({ action: "retire-main-assistant", seat: "delivery" });
  assert.equal(refused.status, "refused");
  assert.match(refused.message, /Choose a new main assistant first/);
  assert.ok(!alone.calls.some(([m]) => m === "bindings-unassign"));

  const both = controller(
    [
      {
        role: "prime",
        seat: "delivery",
        state: "assigned",
        sessionId: id(3),
        revision: 2,
        projectId: null,
      },
      {
        role: "prime",
        seat: "main",
        state: "assigned",
        sessionId: id(1),
        revision: 1,
        projectId: null,
      },
    ],
    [
      {
        id: id(70),
        revision: 4,
        primeSeat: "delivery",
        scope: { kind: "project", projectId: id(60) },
      },
    ],
  );
  const done = await both.setup({ action: "retire-main-assistant", seat: "delivery" });
  assert.equal(done.status, "done");
  assert.deepEqual(
    both.calls.map(([m]) => m),
    ["bindings-status", "remits-list", "remits-move", "bindings-unassign"],
  );
});

test("a controller refusal is shown as it was given, with the steps that already ran", async () => {
  const c = controller();
  const call = async (method: string, input?: any) => {
    if (method === "bindings-assign") throw Error("This chat runs on another computer.");
    return c.call(method, input);
  };
  const r = await createTeamSetup(call, () => NOW)({ action: "main-assistant", sessionId: id(1) });
  assert.equal(r.status, "partly");
  assert.equal(r.message, "This chat runs on another computer.");
  assert.deepEqual(r.steps, ["The chat joined the team."]);
});

test("the chat list says each chat's place on the team in plain words", async () => {
  const call = async (method: string) =>
    method === "bindings-status"
      ? {
          bindings: [
            {
              role: "prime",
              seat: "main",
              state: "assigned",
              sessionId: id(1),
              revision: 1,
              projectId: null,
            },
            {
              role: "project-orchestrator",
              seat: id(60),
              state: "assigned",
              sessionId: id(2),
              revision: 1,
              projectId: id(60),
            },
          ],
        }
      : [{ id: id(3), task: id(61) }];
  const read = createTeamChats(
    call,
    async () => ({
      complete: true,
      entries: [
        { agent: { id: id(1), title: "Main assistant", provider: "claude", updatedAt: "3" } },
        { agent: { id: id(2), title: "Fulcra thin fork", provider: "codex", updatedAt: "2" } },
        {
          agent: {
            id: id(3),
            title: "Review",
            provider: "claude",
            status: "running",
            updatedAt: "1",
          },
        },
        { agent: { id: id(4), title: "Old", provider: "claude", archivedAt: "x", updatedAt: "4" } },
      ],
    }),
    async () => ({
      projects: [{ id: id(60), name: "Fulcra" }],
      membership: [{ taskId: id(61), projectId: id(60) }],
    }),
    () => NOW,
  );
  const r = await read();
  assert.deepEqual(
    r.chats.map((chat) => [chat.title, chat.role, chat.running]),
    [
      ["Main assistant", "Main assistant", false],
      ["Fulcra thin fork", "Lead of Fulcra", false],
      ["Review", "Worker in Fulcra", true],
    ],
  );
});
