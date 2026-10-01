import { quotaBinding, quotaDecision } from './quota-observation.mjs';
import { SourceChanged, uuid } from './authority.mjs';
// quota-wait.mjs is STAGED into the native daemon's admission root beside only admission-guard, native-turn and
// authority (stage-native-turn.mjs), and native-turn imports it there. It may import only those siblings,
// ../portable-config.mjs and node builtins (staged-imports.test.mjs): importing journal-capacity.mjs made the H5
// daemon unable to load its hooks. So it carries its own copy of the controller's capacity, and
// journal-capacity.test.mjs holds the two equal.
export const QUOTA_JOURNAL_CAPACITY = 10000;
const JOURNAL_CAPACITY = QUOTA_JOURNAL_CAPACITY, deliveryCount = db => Number(db.prepare('SELECT count(*) n FROM deliveries').get().n);

const keys = (value, names) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join() === names;
const canonical = value => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
const nonempty = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
export { quotaBinding, quotaDecision } from './quota-observation.mjs';

const SEAT = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/; // Mirrors bindings.mjs; a prime seat is a slug.
function sourceBinding(source) {
  const shapes = { direct: 'kind', ingress: 'kind,originHash,preparation', manager: 'epoch,generation,kind,linkEpoch,supervisor', notification: 'kind,notificationId,originHash,parentMessageId', event: 'epoch,eventId,kind,worker', leadership: 'handoffId,kind', 'role-channel': 'channelId,fromSeat,fromSession,inReplyTo,kind,toSeat' };
  if (!keys(source, shapes[source?.kind])) throw Error('Exact queued source authority required');
  for (const [key, value] of Object.entries(source)) {
    if (key === 'kind') continue;
    // A prime seat is a slug and a project-orchestrator seat is a project UUID, so seats are checked
    // against the same rule bindings enforces rather than against uuid().
    const valid = key === 'originHash' ? /^[a-f0-9]{64}$/.test(value)
      : key === 'generation' ? Number.isSafeInteger(value) && value >= 1
      : ['fromSeat', 'toSeat'].includes(key) ? typeof value === 'string' && (SEAT.test(value) || uuid(value))
      : key === 'inReplyTo' ? value === null || uuid(value)
      : uuid(value);
    if (!valid) throw Error('Invalid queued source authority');
  }
  return JSON.parse(canonical(source));
}
function synchronous(check, binding) {
  if (typeof check !== 'function' || check.constructor.name === 'AsyncFunction' || check(structuredClone(binding)) !== true) throw Error('Synchronous source and native authority revalidation required');
}

// Internal journal primitive, not a public control API. The source adapter must
// authenticate before park(), then revalidate that exact source and native fence
// synchronously in admit(). No capability or replay closure is persisted.
export class QuotaWait {
  constructor(control, now = Date.now) { this.control = control; this.now = now; }
  get store() { return this.control.store; }
  get db() { return this.store.db; }
  get allowance() { return this.control.allowance; }
  // Every condition here is a recorded, definite fact -- mode, generation, boot, expected, expectedAt,
  // task, authority -- and none is a read that merely failed. Typed, because a plain Error made
  // quota-runtime class it unknown and requeue at now+30s: a quota wait is MEANT to retry indefinitely,
  // so unlike the channel pump there is no attempt bound to stop it, and a delivery whose control had
  // definitely changed retried forever. Mode and generation are pre-empted by the takeover path, which
  // cancels first; boot, expected, expectedAt, task and authority reached here and never cancelled.
  current(row, binding) {
    if (!row || row.mode !== 'delegated' || row.generation !== binding.generation || row.boot !== binding.boot || row.expected !== binding.expected || row.expectedAt !== binding.expectedAt || row.task !== binding.task || row.authority !== binding.authority) throw new SourceChanged('Queued instruction control changed');
  }
  park(a, context, quota, check) {
    if (!keys(a, 'messageId,sessionId,text') || !uuid(a.messageId) || !uuid(a.sessionId) || typeof a.text !== 'string' || !a.text.trim() || Buffer.byteLength(a.text) > 16384) throw Error('Invalid queued instruction');
    const source = sourceBinding(context?.source), binding = quotaBinding(quota);
    if (!keys(context, 'boot,expected,expectedAt,generation,nativeId,source') || !binding || binding.sessionId !== context.nativeId || !nonempty(context.boot) || !Number.isSafeInteger(context.generation)) throw Error('Exact queued native binding required');
    const decision = quotaDecision(quota, binding, this.now());
    if (!['waiting', 'unknown'].includes(decision.state)) throw Error('Only unavailable quota may be queued');
    const row = this.store.get(a.sessionId);
    const body = canonical({ ...a, text: a.text.trim() }), identity = { ...context, source, quota: binding, task: row?.task, authority: row?.authority };
    return this.store.atomic(() => {
      synchronous(check, identity); this.current(this.store.get(a.sessionId), identity);
      const prior = this.store.delivery(a.messageId);
      const reservation = prior?.state === 'reserved' && source.kind === 'leadership';
      if (prior && !reservation) {
        if (prior.session !== a.sessionId || prior.kind !== 'send' || prior.body !== body || prior.state !== 'queued' || canonical(prior.result.wait.binding) !== canonical(identity)) throw Error('Queued instruction identity conflict');
        return prior;
      }
      if (reservation && (prior.session !== a.sessionId || prior.kind !== 'send' || prior.body !== body)) throw Error('Queued leadership identity conflict');
      if (!reservation && deliveryCount(this.db) >= JOURNAL_CAPACITY) throw Error('Journal capacity reached');
      if (this.db.prepare("SELECT id FROM deliveries WHERE session=? AND id!=? AND state IN ('queued','reserved','intent','uncertain')").get(a.sessionId, a.messageId)) throw Error('Pending instruction requires reconciliation');
      const outputContext = { generation: context.generation, boot: context.boot, nativeId: context.nativeId, ...(source.originHash ? { originHash: source.originHash } : {}) };
      const result = { outputContext, nativeDispatched: false, wait: { binding: identity, since: this.now(), nextCheckAt: this.now() + 30000, ...decision } };
      if (reservation) this.store.finish(a.messageId, 'queued', result);
      else this.db.prepare("INSERT INTO deliveries VALUES (?,?,'send',?,'queued',?)").run(a.messageId, a.sessionId, body, JSON.stringify(result));
      return this.store.delivery(a.messageId);
    });
  }
  admit(id, quota, check) {
    return this.store.atomic(() => {
      const prior = this.store.delivery(id);
      if (!prior || prior.state !== 'queued') throw Error('Only a queued instruction may resume');
      synchronous(check, prior.result.wait.binding); this.current(this.store.get(prior.session), prior.result.wait.binding);
      const decision = quotaDecision(quota, prior.result.wait.binding.quota, this.now());
      if (decision.state !== 'ready') {
        return this.store.finish(id, decision.state === 'changed' ? 'refused' : 'queued', { ...prior.result, wait: { ...prior.result.wait, ...decision, checkedAt: this.now() } });
      }
      // Revalidation must check the saved source descriptor plus native ID, boot,
      // input boundary and model/tier. It cannot rely on generation alone.
      this.allowance.charge(prior.result.wait.binding.task, id); this.current(this.store.get(prior.session), prior.result.wait.binding);
      if (quotaDecision(quota, prior.result.wait.binding.quota, this.now()).state !== 'ready') throw Error('Quota observation expired during admission');
      const { nativeDispatched, ...result } = prior.result, source = result.wait.binding.source;
      const supervision = source.kind === 'manager' ? { supervisor: source.supervisor, generation: source.generation, epoch: source.epoch, linkEpoch: source.linkEpoch } : null;
      return this.store.finish(id, 'intent', { ...result, generation: result.wait.binding.generation, expectedLastUserAt: result.wait.binding.expectedAt, ...(supervision ? { supervision } : {}), wait: { ...result.wait, state: 'resuming', checkedAt: this.now() } });
    });
  }
}
