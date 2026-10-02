import { randomUUID, createHash } from "node:crypto";
import { authorityKey, uuid } from "./authority.mjs";
const exact = (a, keys) => a && Object.keys(a).sort().join() === keys;
const hex = (s) => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
export function projectNotification(delivery, current) {
  const result = JSON.parse(delivery.result ?? "{}"),
    n = result.notification;
  if (!n) return delivery;
  result.notification = Object.fromEntries(
    [
      "id",
      "originHash",
      "generation",
      "createdAt",
      "readAt",
      "consumedAt",
      "attempts",
      "nextAttemptAt",
    ]
      .filter((key) => n[key] !== undefined)
      .map((key) => [key, n[key]]),
  );
  if (n.followup)
    result.notification.followup = {
      messageId: n.followup.messageId,
      createdAt: n.followup.createdAt,
    };
  result.notification.state = n.consumedAt
    ? "consumed"
    : n.generation !== current.generation
      ? "previous-generation"
      : ![delivery.id, n.followup?.messageId].includes(current.lastPromptId)
        ? "superseded"
        : n.followup
          ? "followup-reserved"
          : n.readAt
            ? "read"
            : "queued";
  if (result.notification.state === "superseded")
    result.notification.supersededBy = current.lastPromptId ?? null;
  result.notification.observedAt = current.observedAt;
  return { ...delivery, result: JSON.stringify(result) };
}
export class Notifications {
  constructor(control) {
    this.control = control;
    this.store = control.store;
    this.waiters = 0;
  }
  async wait(a, capability) {
    if (
      !exact(a, "cursor,sessionId") ||
      !uuid(a.sessionId) ||
      (a.cursor !== null && !hex(a.cursor)) ||
      this.waiters >= 32 ||
      this.control.closing
    )
      throw Error("Invalid or saturated completion wait");
    const row = this.store.check(a.sessionId, capability);
    this.waiters++;
    let unsubscribe, timer;
    try {
      let wake;
      const changed = new Promise((resolve) => {
        wake = resolve;
      });
      unsubscribe = this.control.native.subscribe((value) => {
        if (value.id === row.id) wake();
      });
      timer = setTimeout(wake, 20000);
      const observe = async () => {
        this.store.check(row.id, capability);
        if (authorityKey(await this.control.authority(row.task)) !== row.authority)
          throw Error("Completion task authority changed");
        const current = await this.control.inspect(row.id);
        this.store.check(row.id, capability);
        if (authorityKey(await this.control.authority(row.task)) !== row.authority)
          throw Error("Completion task authority changed during wait");
        this.store.check(row.id, capability);
        const o = current.observed;
        return {
          cursor: createHash("sha256")
            .update(
              JSON.stringify([
                current.generation,
                o.status,
                o.nativeId,
                o.boot,
                o.pending,
                o.lastPromptId,
                o.lastUserAt,
              ]),
            )
            .digest("hex"),
          sessionId: row.id,
        };
      };
      const first = await observe();
      if (first.cursor !== a.cursor) return first;
      await changed;
      return await observe();
    } finally {
      clearTimeout(timer);
      unsubscribe?.();
      this.waiters--;
    }
  }
  summary(delivery, includeInstructions = false) {
    const n = delivery.result.notification,
      followup = n.followup && this.store.delivery(n.followup.messageId);
    return {
      ready: true,
      notificationId: n.id,
      sourceMessageId: delivery.id,
      originHash: n.originHash,
      generation: n.generation,
      ...(includeInstructions
        ? {
            instruction: n.instruction,
            originalInstruction: n.originalInstruction ?? n.instruction,
          }
        : {}),
      state: n.consumedAt
        ? "consumed"
        : n.followup
          ? "followup-reserved"
          : n.readAt
            ? "read"
            : "queued",
      attempts: n.attempts ?? 0,
      nextAttemptAt: n.nextAttemptAt ?? 0,
      wakeExhausted: (n.attempts ?? 0) >= 5,
      followup: n.followup
        ? {
            messageId: n.followup.messageId,
            state: followup?.state ?? "prepared",
            chosenInstruction: n.followup.text,
          }
        : null,
      accepted: false,
    };
  }
  find(sessionId, notificationId) {
    const row = this.store.db
      .prepare(
        "SELECT id FROM deliveries WHERE session=? AND json_extract(result,'$.notification.id')=?",
      )
      .get(sessionId, notificationId);
    if (!row) throw Error("Unknown completion notification");
    return this.store.delivery(row.id);
  }
  async guard(a, capability) {
    const check = () => this.control.ingress.check(a.sessionId, capability, a.originHash);
    const row = check(),
      delivery = this.find(row.id, a.notificationId),
      n = delivery.result.notification,
      proof = delivery.result.outputContext;
    this.control.ingress.receipt(
      { sessionId: row.id, messageId: delivery.id, originHash: a.originHash },
      capability,
    );
    if (
      n.originHash !== a.originHash ||
      n.generation !== row.generation ||
      proof.generation !== row.generation ||
      delivery.state !== "delivered"
    )
      throw Error("Completion notification binding changed");
    if (authorityKey(await this.control.authority(row.task)) !== row.authority)
      throw Error("Completion task authority changed");
    check();
    const current = await this.control.inspect(row.id);
    check();
    if (authorityKey(await this.control.authority(row.task)) !== row.authority)
      throw Error("Completion task authority changed during observation");
    check();
    if (
      this.control.busy.has(row.id) ||
      current.observed.boot !== proof.boot ||
      current.observed.nativeId !== proof.nativeId ||
      ![delivery.id, n.followup?.messageId].includes(current.observed.lastPromptId)
    )
      throw Error("Completion native identity or current input changed");
    return this.find(row.id, a.notificationId);
  }
  mutate(deliveryId, capability, fn) {
    return this.store.atomic(() => {
      const d = this.store.delivery(deliveryId),
        row = this.store.check(d.session, capability),
        n = d.result.notification;
      this.control.ingress.check(row.id, capability, n.originHash);
      if (n.generation !== row.generation) throw Error("Completion generation changed");
      fn(n);
      this.store.db
        .prepare(
          "UPDATE deliveries SET result=json_set(result,'$.notification',json(?)) WHERE id=?",
        )
        .run(JSON.stringify(n), deliveryId);
      return this.store.delivery(deliveryId);
    });
  }
  validate(a, keys) {
    if (
      !exact(a, keys) ||
      !uuid(a.sessionId) ||
      !hex(a.originHash) ||
      (a.notificationId !== undefined && !uuid(a.notificationId))
    )
      throw Error("Invalid notification request");
  }
  async prepare(a, capability) {
    this.validate(a, "messageId,originHash,sessionId");
    if (!uuid(a.messageId)) throw Error("Invalid completion source");
    const row = this.control.ingress.check(a.sessionId, capability, a.originHash),
      prior = this.store.delivery(a.messageId);
    if (prior?.session !== row.id) throw Error("Wrong completion source");
    if (prior.result?.outputContext && prior.result.outputContext.generation !== row.generation)
      return {
        ready: false,
        state: "previous-generation",
        sourceMessageId: prior.id,
        accepted: false,
      };
    this.control.ingress.receipt(a, capability);
    if (prior.result?.notification)
      return this.summary(
        await this.guard({ ...a, notificationId: prior.result.notification.id }, capability),
        true,
      );
    const output = await this.control.result(
      { sessionId: row.id, messageId: a.messageId },
      capability,
    );
    if (!output.available || !output.ended) return { ready: false, accepted: false };
    const current = this.store.check(row.id, capability);
    if (current.generation !== row.generation) throw Error("Completion generation changed");
    this.store.atomic(() => {
      const d = this.control.ingress.receipt(a, capability);
      if (!d.result.notification) {
        const parent = this.store.db
          .prepare(
            "SELECT result FROM deliveries WHERE session=? AND json_extract(result,'$.notification.followup.messageId')=? AND json_extract(result,'$.notification.originHash')=? AND json_extract(result,'$.notification.generation')=? LIMIT 1",
          )
          .get(row.id, d.id, a.originHash, row.generation);
        const priorTask = parent && JSON.parse(parent.result).notification,
          instruction = JSON.parse(d.body).text;
        this.store.db
          .prepare(
            "UPDATE deliveries SET result=json_set(result,'$.notification',json(?)) WHERE id=?",
          )
          .run(
            JSON.stringify({
              id: randomUUID(),
              originHash: a.originHash,
              generation: row.generation,
              createdAt: Date.now(),
              instruction,
              originalInstruction:
                priorTask?.originalInstruction ?? priorTask?.instruction ?? instruction,
              output,
            }),
            d.id,
          );
      }
    });
    const d = this.store.delivery(a.messageId);
    if (d.result.notification.originHash !== a.originHash)
      throw Error("Completion belongs to another origin");
    return this.summary(d, true);
  }
  async claim(a, capability) {
    this.validate(a, "notificationId,originHash,sessionId");
    const d = await this.guard(a, capability);
    let claimed = false;
    const updated = this.mutate(d.id, capability, (n) => {
      if (n.consumedAt || (n.attempts ?? 0) >= 5 || Date.now() < (n.nextAttemptAt ?? 0)) return;
      n.attempts = (n.attempts ?? 0) + 1;
      n.nextAttemptAt = Date.now() + 240000;
      claimed = true;
    });
    return { ...this.summary(updated), claimed };
  }
  async read(a, capability) {
    this.validate(a, "notificationId,originHash,sessionId");
    const d = await this.guard(a, capability);
    const updated = this.mutate(d.id, capability, (n) => {
      n.readAt ??= Date.now();
    });
    return { ...updated.result.notification.output, notification: this.summary(updated) };
  }
  async assign(a, capability) {
    this.validate(a, "notificationId,originHash,sessionId,text");
    if (typeof a.text !== "string" || !a.text.trim() || Buffer.byteLength(a.text) > 16384)
      throw Error("Invalid completion follow-up");
    const d = await this.guard(a, capability);
    const updated = this.mutate(d.id, capability, (n) => {
      if (!n.readAt || n.consumedAt) throw Error("Read an active completion before its follow-up");
      n.followup ??= { messageId: randomUUID(), text: a.text.trim(), createdAt: Date.now() };
    });
    const n = updated.result.notification,
      followup = n.followup;
    const check = () => {
      const current = this.control.ingress.check(a.sessionId, capability, a.originHash),
        latest = this.find(a.sessionId, a.notificationId).result.notification;
      if (
        current.generation !== n.generation ||
        latest.originHash !== a.originHash ||
        latest.consumedAt ||
        latest.followup?.messageId !== followup.messageId
      )
        throw Error("Completion follow-up no longer authorized");
    };
    const delivery = await this.control.send(
      { sessionId: a.sessionId, messageId: followup.messageId, text: followup.text },
      capability,
      undefined,
      {
        check,
        originHash: a.originHash,
        source: {
          kind: "notification",
          originHash: a.originHash,
          notificationId: n.id,
          parentMessageId: d.id,
        },
      },
    );
    return {
      ...this.summary(this.store.delivery(d.id)),
      state: delivery.state,
      messageId: delivery.id,
      accepted: false,
      note: "One durable chosen instruction per completion. Reworded retries reuse that choice and receipt.",
    };
  }
  async acknowledge(a, capability) {
    this.validate(a, "notificationId,originHash,outputEvidenceHash,sessionId");
    if (a.outputEvidenceHash !== null && !hex(a.outputEvidenceHash))
      throw Error("Invalid completion evidence hash");
    const d = await this.guard(a, capability),
      updated = this.mutate(d.id, capability, (n) => {
        if (
          !n.readAt ||
          n.output.outputEvidenceHash !== a.outputEvidenceHash ||
          (a.outputEvidenceHash === null && n.output.outputObserved !== false)
        )
          throw Error("Completion must be read with matching evidence");
        const followup = n.followup && this.store.delivery(n.followup.messageId);
        if (n.followup && !["delivered", "refused", "abandoned"].includes(followup?.state))
          throw Error("Unresolved follow-up cannot be consumed");
        n.consumedAt ??= Date.now();
      });
    return { ...this.summary(updated), consumed: true, accepted: false };
  }
}
