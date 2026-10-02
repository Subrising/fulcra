// cc/v02-cutover-control merge: H7 item 5 (question answers) ported into V4's bound policy (hook-journal-policy.mjs
// admitQuestionAnswer) and input adapter (trusted-native-input.mjs answer). The intent is built exactly as the controller
// side builds it (questions.mjs: permission-policy canonical/digest over permission-projection), so this also proves the
// controller-side digest and the daemon-side policy digest agree.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { journalPolicy } from "./hook-journal-policy.mjs";
import { boundNativeInputs, isNativeAdmissionRefusal } from "./trusted-native-input.mjs";
import { canonical, digest } from "./permission-policy.mjs";
import { permissionProjection } from "./permission-projection.mjs";
const BOOT = "boot-1",
  AGENT = "agent-1",
  REQ = "req-q1",
  ORIGIN = "delivery-1",
  INTENT = "intent-1";
const question = {
  kind: "question",
  provider: "claude",
  name: "AskUserQuestion",
  input: { questions: [{ question: "Which file?", options: [{ label: "a" }, { label: "b" }] }] },
};
const answer = { behavior: "allow", updatedInput: { answers: { "Which file?": "a" } } };
function fixture({ request = question, response = answer, humanAt = 0, generation = 3 } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE sessions(id TEXT, mode TEXT, boot TEXT, grantedAt INTEGER, generation INTEGER, expected TEXT, authority TEXT);
    CREATE TABLE permission_intents(id TEXT, session TEXT, state TEXT, pool TEXT, body TEXT);
    CREATE TABLE deliveries(id TEXT, session TEXT, kind TEXT, state TEXT);
    CREATE TABLE permission_grants(session TEXT, rootSession TEXT, generation INTEGER);`);
  db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?,?,?)").run(
    AGENT,
    "delegated",
    BOOT,
    1,
    3,
    ORIGIN,
    "auth-1",
  );
  db.prepare("INSERT INTO deliveries VALUES (?,?,?,?)").run(ORIGIN, AGENT, "send", "delivered");
  const body = {
    kind: "question-answer",
    requestId: REQ,
    generation,
    boot: BOOT,
    origin: ORIGIN,
    authority: "auth-1",
    expectedLastUserAt: "2026-09-28T00:00:00.000Z",
    requestDigest: digest(canonical(permissionProjection(question))),
    response: canonical(response),
  };
  db.prepare("INSERT INTO permission_intents VALUES (?,?,?,?,?)").run(
    INTENT,
    AGENT,
    "intent",
    "question:" + AGENT,
    JSON.stringify(body),
  );
  const policy = journalPolicy({ boot: BOOT, require: () => ({ boot: BOOT, humanAt }) });
  const agent = {
    id: AGENT,
    pendingPermissions: new Map([[REQ, request]]),
    runtime: { lastUserMessageAt: "2026-09-28T00:00:00.000Z" },
  };
  return { db, policy, agent };
}
test("admits exactly the journaled answer to a pending question", () => {
  const { db, policy, agent } = fixture();
  assert.equal(policy.admitPermission(db, agent, INTENT, answer, new Set()), REQ);
});
test("refuses a different response than the one journaled", () => {
  const { db, policy, agent } = fixture();
  assert.throws(
    () =>
      policy.admitPermission(
        db,
        agent,
        INTENT,
        { behavior: "allow", updatedInput: { answers: { "Which file?": "b" } } },
        new Set(),
      ),
    /out-of-policy question answer/,
  );
});
test("never admits a question intent against a tool permission request", () => {
  const tool = { kind: "tool", provider: "claude", name: "Write", input: { file_path: "/x" } };
  const { db, policy, agent } = fixture({ request: tool });
  assert.throws(
    () => policy.admitPermission(db, agent, INTENT, answer, new Set()),
    /out-of-policy question answer/,
  );
});
test("refuses a replay of the same answer", () => {
  const { db, policy, agent } = fixture(),
    used = new Set();
  assert.equal(policy.admitPermission(db, agent, INTENT, answer, used), REQ);
  assert.throws(
    () => policy.admitPermission(db, agent, INTENT, answer, used),
    /out-of-policy question answer/,
  );
});
test("refuses after human input since the grant, or at a stale generation", () => {
  const human = fixture({ humanAt: 1 });
  assert.throws(
    () => human.policy.admitPermission(human.db, human.agent, INTENT, answer, new Set()),
    /Changed question authority/,
  );
  const stale = fixture({ generation: 2 });
  assert.throws(
    () => stale.policy.admitPermission(stale.db, stale.agent, INTENT, answer, new Set()),
    /Changed question authority/,
  );
});
test("a deny is never admitted as a question answer", () => {
  const deny = { behavior: "deny", message: "no" },
    { db, policy, agent } = fixture({ response: deny });
  assert.throws(
    () => policy.admitPermission(db, agent, INTENT, deny, new Set()),
    /out-of-policy question answer/,
  );
});
test("answer(): provenance over the exact response, then the permission response carrying it", async () => {
  const sent = [],
    minted = [];
  const inputs = boundNativeInputs({
    daemon: {
      invokeRawInput: async (frame, expect) => {
        sent.push({ frame, expect });
        return { ok: true };
      },
    },
    issueProvenance: async (binding) => {
      minted.push(binding);
      return "token";
    },
    verifyActivation: () => {},
  });
  await inputs.answer(AGENT, INTENT, answer);
  assert.equal(minted.length, 1);
  assert.equal(minted[0].kind, "permission");
  assert.equal(minted[0].messageId, "orca-permission:" + INTENT);
  assert.equal(minted[0].attemptId, INTENT);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].expect, "agent_permission_resolved");
  assert.deepEqual(sent[0].frame, {
    type: "agent_permission_response",
    agentId: AGENT,
    requestId: "orca-permission:" + INTENT,
    response: answer,
    inputProvenance: "token",
  });
  // a different response yields a different provenance digest (the binding covers the response)
  const other = [];
  const i2 = boundNativeInputs({
    daemon: { invokeRawInput: async () => ({}) },
    issueProvenance: async (b) => {
      other.push(b);
      return "t";
    },
    verifyActivation: () => {},
  });
  await i2.answer(AGENT, INTENT, {
    behavior: "allow",
    updatedInput: { answers: { "Which file?": "b" } },
  });
  assert.notEqual(other[0].payloadDigest, minted[0].payloadDigest);
});
test("answer(): no activation, no mint and no dispatch (a definite refusal)", async () => {
  let minted = 0,
    sent = 0;
  const inputs = boundNativeInputs({
    daemon: { invokeRawInput: () => sent++ },
    issueProvenance: () => minted++,
    verifyActivation: () => {
      throw Error("activation missing");
    },
  });
  await assert.rejects(inputs.answer(AGENT, INTENT, answer), (e) => isNativeAdmissionRefusal(e));
  assert.equal(minted, 0);
  assert.equal(sent, 0);
});
