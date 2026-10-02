import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import path from "node:path";
export async function acceptance(run, taskId) {
  const marker = "ORCA_BOOK_VERTICAL_" + randomUUID();
  const before = await run({ action: "allowance", taskId });
  let sessionId,
    revoked = false;
  try {
    const a = {
        action: "create",
        host: "macbook",
        taskId,
        title: "Book operator canary " + marker.slice(-12),
      },
      created = await run(a);
    sessionId = created.sessionId;
    assert.ok(sessionId);
    assert.equal((await run(a)).sessionId, sessionId);
    const observation = await run({ action: "observe", sessionId });
    assert.equal(observation.host, "macbook");
    assert.equal(observation.mode, "human");
    await run({ action: "delegate", sessionId, generation: observation.generation });
    const delegated = await run({ action: "observe", sessionId }),
      generation = delegated.generation;
    assert.equal(delegated.mode, "delegated");
    const sent = await run({
      action: "send",
      sessionId,
      generation,
      text: `This is an owned canary from root Codex Orca, not David. In your current owned directory write acceptance.txt containing exactly ${marker}. Read it back and reply exactly ${marker}. No other files, tools beyond this artifact check, sessions, Claude, network, private workplace access or services.`,
    });
    assert.equal(sent.state, "delivered", "Uncertain sends must be reconciled, never retried");
    let result;
    for (let n = 0; n < 6; n++) {
      result = await run({ action: "wait", sessionId, generation, messageId: sent.messageId });
      if (result.ended) break;
      if (result.state !== "wait-deadline")
        throw Error("Canary unresolved: " + JSON.stringify(result));
    }
    assert.equal(result.ended, true);
    assert.ok(result.outputPreview.includes(marker));
    const exact = await run({ action: "result", sessionId, generation, messageId: sent.messageId });
    assert.equal(exact.outputEvidenceHash, result.outputEvidenceHash);
    await run({ action: "ack", sessionId, generation, messageId: sent.messageId });
    const takeover = await run({
      action: "takeover",
      sessionId,
      reason: "Root canary complete; return this session to human",
    });
    assert.equal(takeover.complete, true);
    assert.equal(takeover.remote.revocationAcknowledged, true);
    revoked = true;
    await assert.rejects(
      run({ action: "send", sessionId, generation, text: "Stale generation must refuse" }),
    );
    const after = await run({ action: "allowance", taskId });
    assert.equal(
      after.admittedInstructions,
      before.admittedInstructions + 1,
      "Use an isolated canary task without concurrent instructions",
    );
    return {
      sessionId,
      agentId: observation.remote.agentId,
      cwd: created.cwd,
      marker,
      messageId: sent.messageId,
      outputEvidenceHash: exact.outputEvidenceHash,
      takeover,
      allowance: after,
      note: "Root must independently read acceptance.txt on Book; native output is not artifact acceptance.",
    };
  } finally {
    if (sessionId && !revoked)
      console.error(
        JSON.stringify({
          cleanup: await run({
            action: "takeover",
            sessionId,
            reason: "Ensure owned canary returns to human after acceptance attempt",
          }),
        }),
      );
  }
}
// ROOT ONLY after reviewed installation. Importing this module never invokes a provider.
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv[2] !== "--live" || !process.argv[3] || !process.env.ORCA_CONVERSATION_CLIENT)
    throw Error(
      "Usage: ORCA_CONVERSATION_CLIENT=/absolute/installed/client.mjs node acceptance.mjs --live TASK_UUID",
    );
  const { installedConversation } = await import(
    pathToFileURL(process.env.ORCA_CONVERSATION_CLIENT).href
  );
  console.log(JSON.stringify(await acceptance(installedConversation(), process.argv[3]), null, 2));
}
