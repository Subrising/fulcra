import test from "node:test";
import assert from "node:assert/strict";
import { createIntakeReceiverReader } from "./receiver.mjs";
const prime = { agentId: "original-prime", seat: "delivery" };
const row = {
  role: "prime",
  seat: "delivery",
  revision: 3,
  sessionId: prime.agentId,
  session: { generation: 7, mode: "delegated" },
  dispatch: { supported: true },
  cwd: "private",
  capability: "private",
};
test("receiver facts retain exact current identity and effective holds without capabilities or cwd", async () => {
  const read = createIntakeReceiverReader(async () => ({
    bindings: [row],
    holds: [
      { role: "prime", seat: "delivery", revision: 3, session: prime.agentId, effective: true },
    ],
  }));
  const result = await read({ prime });
  assert.equal(result.binding.humanHeld, true);
  assert.equal(result.binding.session.generation, 7);
  assert(!JSON.stringify(result).includes("private"));
  assert(!JSON.stringify(result).includes("capability"));
});
test("missing hold knowledge is unknown and an old hold is never applied to a successor", async () => {
  assert.equal(
    (await createIntakeReceiverReader(async () => ({ bindings: [row] }))({ prime })).binding
      .humanHeld,
    null,
  );
  const result = await createIntakeReceiverReader(async () => ({
    bindings: [row],
    holds: [
      { role: "prime", seat: "delivery", revision: 2, session: "old-prime", effective: true },
    ],
  }))({ prime });
  assert.equal(result.binding.humanHeld, false);
});
test("changed or unreadable seats remain unavailable rather than substituting a prime", async () => {
  const changed = await createIntakeReceiverReader(async () => ({
    bindings: [{ ...row, sessionId: "successor" }],
    holds: [],
  }))({ prime });
  assert.equal(changed.available, false);
  assert.equal(changed.binding, null);
  const failed = await createIntakeReceiverReader(async () => {
    throw Error("Unavailable");
  })({ prime });
  assert.equal(failed.available, false);
});
