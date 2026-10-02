import { authorityKey, uuid } from "./authority.mjs";

export async function readResult(control, input, capability) {
  if (
    !input ||
    Object.keys(input).sort().join() !== "messageId,sessionId" ||
    !uuid(input.messageId) ||
    !uuid(input.sessionId)
  )
    throw Error("Invalid result request");
  const check = () => control.store.check(input.sessionId, capability);
  check();
  const before = await control.inspect(input.sessionId),
    row = check();
  if (authorityKey(await control.authority(row.task)) !== row.authority)
    throw Error("Result task authority changed");
  check();
  const delivery = control.store.delivery(input.messageId);
  let proof = delivery?.result?.outputContext;
  if (delivery?.session !== row.id || delivery.kind !== "send")
    throw Error("Result delivery belongs to another session");
  if (
    delivery.state !== "delivered" ||
    !proof?.cursor?.epoch ||
    !Number.isSafeInteger(proof.cursor.seq)
  )
    return {
      messageId: input.messageId,
      state: delivery.state,
      available: false,
      accepted: false,
      note: "Confirmed cursor-bound output unavailable; inspect the native conversation. No input was sent.",
    };
  if (!before.observed)
    return {
      messageId: input.messageId,
      state: before.remote?.state ?? "unavailable",
      available: false,
      accepted: false,
      error: before.error,
    };
  let nativeId = proof.nativeId ?? before.observed.nativeId;
  if (!uuid(nativeId)) throw Error("Native result identity unavailable");
  const stable = (observed) => {
    const current = check();
    if (
      !observed ||
      current.generation !== row.generation ||
      proof.generation !== current.generation ||
      observed.boot !== proof.boot ||
      observed.nativeId !== nativeId ||
      observed.lastPromptId !== input.messageId
    )
      throw Error("Result identity or delegation changed");
  };
  stable(before.observed);
  if (!proof.nativeId) {
    control.store.db
      .prepare(
        "UPDATE deliveries SET result=json_set(result,'$.outputContext.nativeId',?,'$.outputContext.nativeIdentitySource','retained-first-result-observation') WHERE id=? AND state='delivered' AND json_extract(result,'$.outputContext.nativeId') IS NULL",
      )
      .run(nativeId, input.messageId);
    proof = control.store.delivery(input.messageId)?.result?.outputContext;
    if (!proof?.nativeId) throw Error("Native identity observation could not be retained");
    nativeId = proof.nativeId;
    stable(before.observed);
  }
  const result = await control.native.completion(row.id, input.messageId, { cursor: proof.cursor });
  const after = await control.inspect(row.id);
  stable(after.observed);
  if (authorityKey(await control.authority(row.task)) !== row.authority)
    throw Error("Result task authority changed during read");
  stable(after.observed);
  if (control.store.delivery(input.messageId)?.state !== "delivered")
    throw Error("Result delivery changed during read");
  return {
    messageId: input.messageId,
    state: "delivered",
    available: true,
    accepted: false,
    ended: result.ended,
    interrupted: result.interrupted ?? false,
    outputObserved: result.outputObserved,
    outputPreview: result.outputPreview,
    outputTruncated: result.outputTruncated,
    outputEvidenceHash: result.outputEvidenceHash,
    partial: !result.ended,
    observedAt: after.observed.observedAt,
    nativeIdentitySource: proof.nativeIdentitySource ?? "send-receipt",
    note: "Correlated native output; an ended turn does not establish success or independent acceptance.",
  };
}
