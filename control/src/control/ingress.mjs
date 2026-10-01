import { SourceChanged, uuid } from './authority.mjs';
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export class Ingress {
  constructor(control) { this.control = control; this.store = control.store; }
  check(sessionId, capability, originHash) {
    this.store.check(sessionId, capability); return this.scope(sessionId, originHash);
  }
  // Typed, for the same reason assertUsable is: everything this refuses is a recorded fact about the
  // delegation, so a caller can tell it apart from a read that merely failed. quota-runtime could not, and
  // wrapped the call in catch { require(false) }, turning a locked database into a permanent cancellation.
  scope(sessionId, originHash) {
    if (!uuid(sessionId) || !hex(originHash)) throw new SourceChanged('Invalid ingress origin');
    const row = this.store.get(sessionId), db = this.store.db;
    if (row?.mode !== 'delegated') throw new SourceChanged('Ingress delegation revoked');
    // Incoming links govern this session's input. Outgoing links let a supervisor
    // manage its own workers and do not confer input authority over the supervisor.
    for (const table of ['manager_workers', 'event_links']) {
      if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) && db.prepare(`SELECT worker FROM ${table} WHERE worker=?`).get(row.id)) throw new SourceChanged('Ingress target has an incoming supervisor link');
    }
    const prepared = db.prepare("SELECT id FROM management_requests WHERE json_extract(body,'$.sessionId')=? AND json_extract(body,'$.expectedGeneration')=? AND json_extract(body,'$.originHash') IS NOT NULL AND json_extract(body,'$.originHash')!=? LIMIT 1").get(row.id, row.generation, originHash);
    const admitted = db.prepare("SELECT id FROM deliveries WHERE session=? AND json_extract(result,'$.outputContext.generation')=? AND json_extract(result,'$.outputContext.originHash') IS NOT NULL AND json_extract(result,'$.outputContext.originHash')!=? LIMIT 1").get(row.id, row.generation, originHash);
    if (prepared || admitted) throw new SourceChanged('Ingress origin binding differs from delegation');
    return row;
  }
  input(a, keys) {
    if (!a || Object.keys(a).sort().join() !== keys || !uuid(a.messageId)) throw Error('Invalid origin-bound request');
    if (keys.includes('text') && (typeof a.text !== 'string' || !a.text.trim() || Buffer.byteLength(a.text) > 16384)) throw Error('Invalid origin-bound instruction');
  }
  prepare(a, capability) {
    this.input(a, 'messageId,originHash,sessionId,text');
    const row = this.check(a.sessionId, capability, a.originHash);
    return this.control.prepareManagement('send', { sessionId: row.id, expectedGeneration: row.generation, originHash: a.originHash, text: a.text.trim() }, a.messageId, true, () => {
      if (this.check(a.sessionId, capability, a.originHash).generation !== row.generation) throw Error('Ingress generation changed');
      const expected = { expectedGeneration: row.generation, originHash: a.originHash, sessionId: row.id, text: a.text.trim() };
      const prepared = this.store.db.prepare('SELECT body FROM management_requests WHERE id=?').get(a.messageId);
      if (prepared && prepared.body !== JSON.stringify(expected)) throw Error('Ingress request identity conflict');
      const delivery = this.store.delivery(a.messageId);
      if (delivery) {
        const body = JSON.parse(delivery.body), proof = delivery.result?.outputContext;
        if (delivery.kind !== 'send' || delivery.session !== row.id || body.text !== expected.text || proof?.generation !== row.generation || proof?.originHash !== a.originHash) throw Error('Ingress request identity conflict');
      }
    });
  }
  async send(a, capability) {
    this.input(a, 'messageId,originHash,sessionId,text');
    const check = () => {
      const row = this.check(a.sessionId, capability, a.originHash);
      if (this.store.delivery(a.messageId)) this.receipt(a, capability);
      const prepared = this.store.db.prepare("SELECT body FROM management_requests WHERE id=?").get(a.messageId);
      const body = prepared && JSON.parse(prepared.body);
      if (!body || body.sessionId !== row.id || body.expectedGeneration !== row.generation || body.originHash !== a.originHash || body.text !== a.text.trim()) throw Error('Exact origin-bound preparation required');
    };
    check();
    return this.control.send({ sessionId: a.sessionId, messageId: a.messageId, text: a.text }, capability, undefined, { originHash: a.originHash, check, source: { kind: 'ingress', originHash: a.originHash, preparation: a.messageId } });
  }
  receipt(a, capability) {
    const row = this.check(a.sessionId, capability, a.originHash), delivery = this.store.delivery(a.messageId);
    if (delivery?.session !== row.id || delivery.result?.outputContext?.originHash !== a.originHash || delivery.result.outputContext.generation !== row.generation) throw Error('Delivery has no matching ingress provenance binding');
    return delivery;
  }
  acknowledge(a, capability) {
    this.input(a, 'messageId,originHash,sessionId');
    return this.store.atomic(() => {
      const delivery = this.receipt(a, capability), proof = delivery.result.outputContext;
      const prepared = this.store.db.prepare('SELECT body FROM management_requests WHERE id=?').get(a.messageId);
      const expected = { expectedGeneration: proof.generation, originHash: a.originHash, sessionId: a.sessionId, text: JSON.parse(delivery.body).text };
      if (delivery.kind !== 'send' || (prepared && prepared.body !== JSON.stringify(expected))) throw Error('Ingress request identity conflict');
      return this.control.acknowledgeManagement(a.messageId);
    });
  }
  async result(a, capability) {
    this.input(a, 'messageId,originHash,sessionId'); this.receipt(a, capability);
    const result = await this.control.result({ sessionId: a.sessionId, messageId: a.messageId }, capability);
    this.receipt(a, capability); return result;
  }
}
