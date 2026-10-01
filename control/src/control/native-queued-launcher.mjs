import { randomUUID } from "node:crypto";
import { uuid } from "./authority.mjs";
import { authorityKey } from "./authority.mjs";
import { queuedSessionBinding, queuedRoleSource } from "./queued-journal-policy.mjs";
import { queuedSendPayload, payloadDigest } from "./trusted-contribution.mjs";
import { isNativeAdmissionRefusal } from "./trusted-native-input.mjs";
import { AUTOMATION_LIMIT, deliveryCount } from "./journal-capacity.mjs";
import { canonicalJson } from "@getpaseo/protocol/trusted-input";
/** Installed private controller route. The native manager/ledger remains the only queue and sender. */
export async function launchNativeQueued(control, raw, token, operatorGeneration, supervision) {
  if (
    !raw ||
    Object.keys(raw).sort().join() !== "messageId,sessionId,text" ||
    !uuid(raw.sessionId) ||
    !uuid(raw.messageId) ||
    typeof raw.text !== "string" ||
    !raw.text.trim() ||
    Buffer.byteLength(raw.text) > 16384 ||
    raw.text.trimStart().startsWith("/")
  )
    throw Error("Invalid native queued instruction");
  const a = { ...raw, text: raw.text.trim() };
  if (typeof control.native.sendQueued !== "function")
    throw Error("Installed native queue unavailable");
  const check = () => {
    supervision?.check?.();
    if (operatorGeneration === undefined) return control.store.check(a.sessionId, token);
    const row = control.store.get(a.sessionId);
    if (
      !Number.isSafeInteger(operatorGeneration) ||
      row?.mode !== "delegated" ||
      row.generation !== operatorGeneration
    )
      throw Error("Control changed; refresh before assigning");
    return row;
  };
  return control.exclusive(a.sessionId, async () => {
    const original = check();
    control.native.ready?.(a.sessionId);
    if (authorityKey(await control.authority(original.task)) !== original.authority)
      throw Error("Task authority changed since handback");
    const prior = control.store.delivery(a.messageId);
    if (prior) {
      check();
      if (
        prior.session !== a.sessionId ||
        prior.kind !== "send" ||
        canonicalJson(JSON.parse(prior.body)) !== canonicalJson(a)
      )
        throw Error("Delivery identity conflict");
      // Never mint another native operation or resend, including lost acknowledgements and pending tickets.
      return prior;
    }
    if (
      control.store.db
        .prepare(
          "SELECT id FROM deliveries WHERE session=? AND state IN ('intent','uncertain','reserved','queued','dispatching')",
        )
        .get(a.sessionId)
    )
      throw Error("Pending native delivery requires observation, not resend");
    const current = await control.native.inspect(a.sessionId);
    const row = check();
    if (authorityKey(await control.authority(row.task)) !== row.authority)
      throw Error("Task authority changed during observation");
    check();
    requireQueuedTarget(control, current, row);
    const source = await captureQueuedSource(control, supervision, a, check);
    const binding = {
      version: 1,
      target: queuedSessionBinding(row),
      runtime: {
        instanceId: current.runtimeInstanceId,
        nativeSessionId: current.nativeId,
        model: current.model,
        serviceTier: current.serviceTier ?? null,
      },
      source,
      payloadDigest: payloadDigest(
        a.sessionId,
        "prompt",
        "orca-control:" + a.messageId,
        queuedSendPayload(a.text),
      ),
    };
    const automated = source.kind === "role-followup";
    const intent = {
      nativeAttemptId: randomUUID(),
      generation: row.generation,
      expectedLastUserAt: current.lastUserAt ?? null,
      nativeQueue: binding,
      outputContext: {
        generation: row.generation,
        boot: row.boot,
        nativeId: current.nativeId,
        cursor: current.timelineCursor ?? null,
        quota: { state: "native-owned" },
      },
    };
    control.store.admit(a.messageId, a.sessionId, "send", a, () => {
      check();
      if (automated && deliveryCount(control.store.db) >= AUTOMATION_LIMIT)
        throw Error("Journal automation capacity reached");
      if (automated) control.automationGuard();
      control.allowance.charge(row.task, a.messageId);
    });
    // No await between charged intent and immutable private-purpose binding. A crash here cannot mint provenance.
    control.store.finish(a.messageId, "intent", intent);
    try {
      const receipt = await control.native.sendQueued(
        a.sessionId,
        a.text,
        a.messageId,
        intent.nativeAttemptId,
      );
      // A private native observer may have committed a later lifecycle fact before this acknowledgement arrives.
      const observed = control.store.delivery(a.messageId);
      if (
        observed.result.nativeReceipt &&
        !["queued", "dispatching"].includes(observed.result.nativeReceipt.state)
      )
        return observed;
      return control.store.finish(a.messageId, receipt.state, {
        ...intent,
        nativeReceipt: receipt,
        note: "Native queue lifecycle snapshot; queued is not provider acceptance or completion",
      });
    } catch (error) {
      const observed = control.store.delivery(a.messageId);
      if (observed.result.nativeReceipt) return observed;
      return control.store.finish(
        a.messageId,
        isNativeAdmissionRefusal(error) ? "refused" : "uncertain",
        {
          ...intent,
          error: "Native queue acknowledgement unavailable; no resend",
          ...(isNativeAdmissionRefusal(error) ? { nativeDispatched: false } : {}),
        },
      );
    }
  });
}

function requireQueuedTarget(control, current, row) {
  if (
    current.archivedAt ||
    current.pending > 0 ||
    !["idle", "running"].includes(current.status) ||
    current.boot !== row.boot ||
    current.humanAt >= row.grantedAt ||
    control.promptIdentityChanged(current, row) ||
    !current.nativeId ||
    !current.runtimeInstanceId ||
    !current.model
  )
    throw Error("Native queued identity, permission or delegation changed");
}

async function captureQueuedSource(control, supervision, a, check) {
  let source = { kind: "operator" };
  if (supervision?.source) {
    if (supervision.source.kind !== "role-followup")
      throw Error("Unsupported native queued source");
    source = queuedRoleSource(
      control.store.db,
      supervision.source.fromSession,
      a.sessionId,
      a.messageId,
    );
    const observedSource = await control.native.inspect(source.session.id);
    check();
    if (
      observedSource.boot !== source.session.boot ||
      observedSource.humanAt >= source.session.grantedAt ||
      observedSource.archivedAt ||
      !observedSource.nativeId ||
      !observedSource.runtimeInstanceId
    )
      throw Error("Native queued source identity unavailable");
    source.runtime = {
      instanceId: observedSource.runtimeInstanceId,
      nativeSessionId: observedSource.nativeId,
    };
  }
  return source;
}
