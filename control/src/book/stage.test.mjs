import test from "node:test";
import assert from "node:assert/strict";
import { apply, patchBookModules, patchBookPermissionAcknowledgement, stage } from "./stage.mjs";
const fixture = {
  "session.js": `class Session {
    async handleAgentPermissionResponse(agentId, requestId, response) {
            await respondToAgentPermission({
                agentManager: this.agentManager,
                agentId,
                requestId,
                response,
                logger: this.sessionLogger,
            });
    }
    async interruptAgentIfRunning(agentId) {}
    async fetch() {
        const agent = await this.getAgentPayloadById(resolved.agentId);
        if (!agent) {} } }`,
  "agent/lifecycle-command.js":
    "export async function cancelAgentRunCommand(dependencies, agentId) {}",
  "agent/agent-manager.js": `class Manager {
    async archiveSnapshot(agentId, archivedAt) {}
    closeAgent(agentId) {}
    async archiveAgent(agentId) {}
    async cancelAgentRun(agentId) {}
    streamAgent(agentId, prompt, options) {
        const existingAgent = this.requireSessionAgent(agentId); }
    async replaceAgentRun(agentId, prompt, options) {
        const snapshot = this.requireAgent(agentId); }
    async steerOrReplaceActiveTurn(agentId, prompt, options) {
        const agent = this.requireSessionAgent(agentId); }
    async respondToPermission(agentId, requestId, response) {
        const agent = this.requireAgent(agentId); }
    async begin(params) {
        const { agent, agentId, pendingRun, prompt, options } = params;
        try {
            const result = await agent.session.startTurn(prompt, options);
        } catch(e) { throw e; } } }`,
  "agent/agent-prompt.js": `export async function startAgentRun(agentManager, agentId, prompt, logger, options) {
    const snapshot = agentManager.getAgent(agentId); }
export async function sendPromptToAgent(params) {
    const record = await params.agentStorage.get(params.agentId);
    if (record?.archivedAt) {} }`,
};
test("patch rejects duplicate/missing anchors and makes final admission single-use", () => {
  const result = patchBookModules(fixture, "/private/tmp/reviewed-entry.mjs");
  assert.equal(result["agent/agent-manager.js"].split("),true);").length, 2);
  assert.match(result["agent/agent-manager.js"], /pendingRun.start=\{status:"failed"/);
  assert.throws(() => patchBookModules(result, "/other.mjs"), /anchor drift/);
  assert.throws(
    () =>
      patchBookModules({ ...fixture, "session.js": fixture["session.js"].repeat(2) }, "/other.mjs"),
    /anchor drift/,
  );
});
test("Book synthetic acknowledgement follows native completion and preserves original identity", async () => {
  const patched = patchBookPermissionAcknowledgement(fixture["session.js"]);
  const emitted = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const Session = Function(
    "respondToAgentPermission",
    patched + ";return Session;",
  )(async (input) => {
    assert.equal(input.requestId, "orca-permission:intent");
    await gate;
  });
  const session = new Session();
  session.emit = (e) => emitted.push(e);
  const response = { behavior: "allow" };
  const pending = session.handleAgentPermissionResponse(
    "agent",
    "orca-permission:intent",
    response,
  );
  await Promise.resolve();
  assert.deepEqual(emitted, []);
  release();
  await pending;
  assert.deepEqual(emitted, [
    {
      type: "agent_permission_resolved",
      payload: { agentId: "agent", requestId: "orca-permission:intent", resolution: response },
    },
  ]);
  assert.equal(patchBookPermissionAcknowledgement(patched), patched);
});
test("Book rejection and ordinary human permission produce no synthetic success", async () => {
  const patched = patchBookPermissionAcknowledgement(fixture["session.js"]);
  for (const rejected of [true, false]) {
    const Session = Function(
      "respondToAgentPermission",
      patched + ";return Session;",
    )(async () => {
      if (rejected) throw Error("final admission refused");
    });
    const session = new Session(),
      emitted = [];
    session.emit = (e) => emitted.push(e);
    const pending = session.handleAgentPermissionResponse(
      "agent",
      rejected ? "orca-permission:intent" : "native-request",
      { behavior: "allow" },
    );
    if (rejected) await assert.rejects(pending, /final admission refused/);
    else await pending;
    assert.deepEqual(emitted, []);
  }
});
test("Book acknowledgement patch refuses absent, duplicate and misplaced anchors", () => {
  const raw = fixture["session.js"],
    patched = patchBookPermissionAcknowledgement(raw),
    ack = patched.slice(
      patched.indexOf("\n            if (requestId.startsWith"),
      patched.indexOf("\n    }"),
    );
  assert.throws(
    () =>
      patchBookPermissionAcknowledgement(
        raw.replace("await respondToAgentPermission", "await otherHandler"),
      ),
    /anchor drift/,
  );
  assert.throws(() => patchBookPermissionAcknowledgement(raw + raw), /anchor drift/);
  assert.throws(() => patchBookPermissionAcknowledgement(patched + raw), /anchor drift/);
  assert.throws(() => patchBookPermissionAcknowledgement(patched + ack), /duplicated/);
  assert.throws(() => patchBookPermissionAcknowledgement(ack + raw), /anchor drift/);
});

test("receiver staging is retired with the SSH transport (0.2.7)", () => {
  assert.throws(() => stage("/profile.json", "/new-stage"), /retired/);
  assert.throws(() => apply("/stage", "after"), /retired/);
});
