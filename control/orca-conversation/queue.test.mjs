import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { WatchQueue, processOne, watchKey } from './queue.mjs';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orca-queue-'))), directory = path.join(root, 'queue');
  const queue = new WatchQueue(directory), input = { sessionId: randomUUID(), generation: 2, messageId: randomUUID(), sessionKey: 'agent:main:queue-test' };
  t.after(() => { queue.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, directory, queue, input };
}
test('durable dedup and independent connection claims enforce one dispatch, preserving original outcome', async t => {
  const { directory, queue, input } = fixture(t), other = new WatchQueue(directory);
  t.after(() => other.close()); queue.enqueue(input); other.enqueue(input);
  assert.equal(queue.list().watches.length, 1);
  let wakes = 0;
  const run = async () => ({ ended: true, originalInstruction: 'Verify the artifact' });
  await Promise.all([processOne(queue, run, async () => { wakes++; }), processOne(other, run, async () => { wakes++; })]);
  const state = queue.get(watchKey(input)); assert.equal(wakes, 1); assert.equal(state.state, 'wake-submitted');
  assert.equal(state.detail.originalInstruction, 'Verify the artifact');
});
test('expired lease is recoverable; a stale owner cannot commit dispatch', t => {
  const { queue, input } = fixture(t); queue.enqueue(input, 0);
  const old = queue.claim('old', 10); assert.ok(old); assert.equal(queue.claim('new', 90009), null);
  const current = queue.claim('new', 90011); assert.equal(current.key, old.key);
  assert.equal(queue.transition(old.key, 'old', 'waiting', 'dispatch-intent'), false);
  assert.equal(queue.transition(current.key, 'new', 'waiting', 'dispatch-intent'), true);
  assert.equal(queue.claim('later', 999999), null);
});
test('wait deadline releases the lease; failed notification and lost response never auto-retry', async t => {
  const { queue, input } = fixture(t); queue.enqueue(input); let calls = 0;
  await processOne(queue, async () => ({ state: 'wait-deadline' }), async () => { calls++; });
  assert.equal(queue.get(watchKey(input)).state, 'queued'); assert.equal(calls, 0);
  await processOne(queue, async () => { throw Error('delegation revoked'); }, async () => { calls++; throw Error('response lost'); });
  assert.equal(queue.get(watchKey(input)).state, 'needs-reconciliation');
  assert.equal(await processOne(queue, async () => ({}), async () => { calls++; }), false); assert.equal(calls, 1);
});
test('SIGKILL after claim recovers persisted wait; SIGKILL after committed intent cannot dispatch again', async t => {
  const { directory, queue, input } = fixture(t); queue.enqueue(input, 0);
  const child = intent => spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { WatchQueue } from ${JSON.stringify(new URL('./queue.mjs', import.meta.url).href)};
    const q = new WatchQueue(process.argv[1]), job = q.claim('killed', 1);
    if (${intent}) q.transition(job.key, 'killed', 'waiting', 'dispatch-intent');
    process.kill(process.pid, 'SIGKILL');`, directory]);
  assert.equal(child(false).signal, 'SIGKILL'); assert.equal(queue.get(watchKey(input)).state, 'waiting');
  const reclaimed = queue.claim('recovered', 90002); assert.ok(reclaimed);
  queue.transition(reclaimed.key, 'recovered', 'waiting', 'queued', null, 0);
  assert.equal(child(true).signal, 'SIGKILL'); assert.equal(queue.get(watchKey(input)).state, 'dispatch-intent');
  let calls = 0; assert.equal(await processOne(queue, async () => ({}), async () => { calls++; }), false); assert.equal(calls, 0);
});
test('legacy records, invalid identities, private directory and database symlink are fail-closed', t => {
  const { root, queue, input } = fixture(t);
  const legacy = path.join(root, 'conversation-watches'); fs.mkdirSync(legacy);
  fs.writeFileSync(path.join(legacy, watchKey(input) + '.json'), 'retained evidence');
  assert.equal(queue.enqueue(input).state, 'existing-watch'); assert.equal(queue.list().watches.length, 0);
  assert.throws(() => queue.enqueue({ ...input, sessionKey: 'agent:someone:else' }), /identity/);
  const unsafe = path.join(root, 'unsafe'); fs.mkdirSync(unsafe, { mode: 0o755 });
  assert.throws(() => new WatchQueue(unsafe), /Private/); fs.chmodSync(unsafe, 0o700);
  fs.symlinkSync(queue.file, path.join(unsafe, 'queue.sqlite'));
  assert.throws(() => new WatchQueue(unsafe), /Unsafe/);
});
test('group tracking is distinct from turn tracking and preserves correlation across reopen/requeue', async t => {
  const { queue, directory, input } = fixture(t), group = { ...input, scope: 'group', outcomeId: randomUUID() };
  assert.notEqual(watchKey(input), watchKey(group));
  queue.enqueue(group); const reopened = new WatchQueue(directory); t.after(() => reopened.close());
  let called, notice, wakes = 0;
  await processOne(reopened, async a => { called = a; return { state: 'wait-deadline' }; }, async () => { wakes++; });
  assert.equal(called.action, 'wait-group'); assert.equal(called.outcomeId, group.outcomeId); assert.equal(wakes, 0);
  await processOne(reopened, async () => ({ state: 'group-ready', ended: true }), async (_key, text) => { notice = text; wakes++; });
  queue.enqueue(group); assert.equal(await processOne(queue, async () => { throw Error('must not rerun'); }), false);
  assert.equal(wakes, 1); assert.ok(notice.includes(group.outcomeId)); assert.ok(notice.includes('group-status'));
});
test('group acknowledgment requires exact published output and origin, is durable and never manufactures ingress acceptance', async t => {
  const {queue,input}=fixture(t), group={...input,scope:'group',outcomeId:randomUUID()}, evidence='a'.repeat(64);
  const watched=queue.enqueue(group), ack={...group,watchKey:watched.key,outputEvidenceHash:evidence};
  assert.throws(()=>queue.acknowledgeGroup(ack),/delivered outcome/);
  await processOne(queue,async()=>({state:'group-ready',ended:true,messageId:randomUUID(),outputEvidenceHash:evidence}),async()=>({ok:true}));
  for(const change of [{outcomeId:randomUUID()},{messageId:randomUUID()},{outputEvidenceHash:'b'.repeat(64)}]) assert.throws(()=>queue.acknowledgeGroup({...ack,...change}));
  const first=queue.acknowledgeGroup(ack,100), second=queue.acknowledgeGroup(ack,200);
  assert.deepEqual(first,second);assert.equal(first.accepted,false);assert.equal(queue.get(watched.key).state,'handled');assert.equal(queue.get(watched.key).detail.handledAt,100);
  assert.equal(await processOne(queue,async()=>{throw Error('must not replay');}),false);
});
test('group progress and terminal attention retain reasons across database reopen',async t=>{
 const {queue,directory,input}=fixture(t),group={...input,scope:'group',outcomeId:randomUUID()};
 const key=queue.enqueue(group).key,evidence={parent:{status:'running',pending:0},workers:[{requestId:'create',phase:'reserved',ownership:'unresolved'}]};
 await processOne(queue,async()=>({state:'wait-deadline',lastObservation:{state:'group-working',reason:'worker-creation-active',evidence,outputPreview:'must not persist'}}),async()=>{throw Error('must not notify progress');});
 const reopened=new WatchQueue(directory);t.after(()=>reopened.close());
 assert.deepEqual(reopened.get(key).detail,{observed:{state:'group-working',reason:'worker-creation-active',evidence}});
 await processOne(reopened,async()=>({state:'group-needs-attention',needsAttention:true,reason:'pending-permission',evidence}),async()=>({acknowledged:true}));
 assert.equal(queue.get(key).detail.observed.reason,'pending-permission');assert.deepEqual(queue.get(key).detail.observed.evidence,evidence);
});
test('provider expectation survives durable dispatch and cannot be changed during group acknowledgement',async t=>{
 const {queue,input}=fixture(t),group={...input,scope:'group',outcomeId:randomUUID(),workerProvider:'claude'},evidence='a'.repeat(64);
 const key=queue.enqueue(group).key;assert.notEqual(key,watchKey({...group,workerProvider:'codex'}));
 await processOne(queue,async a=>{assert.equal(a.workerProvider,'claude');return{state:'group-ready',outputEvidenceHash:evidence};},async()=>({acknowledged:true}));
 const ack={...group,watchKey:key,outputEvidenceHash:evidence};assert.throws(()=>queue.acknowledgeGroup({...ack,workerProvider:'codex'}));assert(queue.acknowledgeGroup(ack).handled);
});
