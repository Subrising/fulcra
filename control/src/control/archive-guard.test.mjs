import test from "node:test";
import assert from "node:assert/strict";
import { activeAgent, isArchived } from "./archive-guard.mjs";

for (const archive of [
  { archivedAt: "2026-01-01T00:00:00.000Z" },
  { ArchivedAt: "2026-01-01T00:00:00.000Z" },
  { archived: true },
  { Archived: true },
  { status: "archived" },
]) {
  test(`ops skips native archive state ${Object.keys(archive)[0]}`, async () => {
    const calls = [];
    const rpc = async (method, input) => {
      calls.push({ method, input });
      return { agent: { id: "fixture", ...archive } };
    };
    assert.equal(isArchived(archive), true);
    assert.equal(await activeAgent(rpc, "fixture"), null);
    assert.deepEqual(calls, [
      { method: "native:fetch_agent_request", input: { agentId: "fixture" } },
    ]);
  });
}

test("ops reads native state again after a stale list or an event wait", async () => {
  let archivedAt = null;
  const rpc = async () => ({ agent: { id: "fixture", archivedAt } });
  assert.equal((await activeAgent(rpc, "fixture")).id, "fixture");
  archivedAt = "2026-01-01T00:00:00.000Z";
  assert.equal(await activeAgent(rpc, "fixture"), null);
  assert.equal(await activeAgent(async () => ({ agent: null }), "missing"), null);
});
