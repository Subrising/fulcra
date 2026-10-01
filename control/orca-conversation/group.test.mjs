import test from 'node:test';
import assert from 'node:assert/strict';
import { groupObservation, outcomeMarker } from './group.mjs';
const assignment = { sessionId: 'parent', generation: 2, messageId: 'assignment', outcomeId: 'outcome' };
function fixture() {
  const f = { group: { id: 'parent', active: true, workers: [{ workerId: 'worker', ownership: 'linked', fault: null }] },
    parent: { generation: 2, task: 'task', deliveries: [{ id: 'assignment', kind: 'send', state: 'delivered' }], observed: { status: 'idle', pending: 0, lastPromptId: 'final-event' } },
    worker: { mode: 'delegated', task: 'task', observed: { status: 'idle', pending: 0 } },
    events: { unresolved: [], notifications: [] }, output: { ended: true, outputObserved: true, outputPreview: 'Reviewed result\n' + outcomeMarker('outcome') } };
  const copy = x => structuredClone(x);
  f.call = async (method, input) => {
    if (method === 'inspect') return copy(f.parent);
    assert.equal(method, 'result'); assert.equal(input.messageId, f.parent.observed.lastPromptId);
    const out = copy(f.output); f.onResult?.(); return out;
  };
  f.operator = async method => copy(method === 'manager-summary' ? [f.group] : method === 'observe' ? f.worker : f.events);
  f.run = () => groupObservation(assignment, f.call, f.operator);
  return f;
}
test('intermediate ended supervisor turn never completes the team; exact final event output can become ready', async () => {
  const f = fixture(); f.output.outputPreview = 'Waiting for the author';
  assert.equal((await f.run()).state, 'group-awaiting-declaration');
  f.output.outputPreview = 'Reviewed result\n' + outcomeMarker('another-outcome');
  assert.equal((await f.run()).state, 'group-awaiting-declaration');
  f.output.outputPreview = 'Reviewed result\n' + outcomeMarker('outcome');
  const r = await f.run(); assert.equal(r.state, 'group-ready'); assert.equal(r.accepted, false); assert.equal(r.assignmentId, 'assignment');
});
test('declaration cannot bypass busy workers, queued events, unresolved assignments or unconsumed history', async () => {
  for (const mutate of [f => { f.worker.observed.status = 'running'; }, f => { f.events.unresolved = [{ worker: 'worker' }]; }, f => { f.events.notifications = [{ supervisor: 'parent', worker: 'worker', state: 'delivered', consumed: null }]; }, f => { f.parent.observed.status = 'running'; }]) {
    const f = fixture(); mutate(f); assert.equal((await f.run()).state, 'group-working');
  }
  const f = fixture(); f.events.notifications = [{ supervisor: 'parent', worker: 'worker', state: 'delivered', consumed: 123 }]; assert.equal((await f.run()).state, 'group-ready');
});
test('takeover, foreign task, missing roles, permissions and faults produce attention or refusal', async () => {
  for (const mutate of [f => { f.worker.mode = 'human'; }, f => { f.worker.task = 'foreign'; }, f => { f.group.workers[0].fault = 'lost'; }, f => { f.worker.observed.pending = 1; }, f => { f.group.workers[0].ownership = 'orphaned'; }]) {
    const f = fixture(); mutate(f); assert.equal((await f.run()).needsAttention, true);
  }
  const f = fixture(); f.group.active = false; await assert.rejects(f.run(), /no longer active/);
  f.group.active = true; f.parent.generation++; await assert.rejects(f.run(), /generation/);
});
test('native or relationship changes during result read prevent readiness', async () => {
  for (const change of [f => { f.parent.observed.lastPromptId = 'other'; }, f => { f.group.workers[0].ownership = 'orphaned'; }]) {
    const f = fixture(); f.onResult = () => change(f); assert.equal((await f.run()).state, 'group-changing');
  }
});
test('partial output, inline marker and missing delivered assignment cannot signal completion', async () => {
  const f = fixture(); f.output.ended = false; assert.equal((await f.run()).state, 'group-awaiting-declaration');
  f.output.ended = true; f.output.outputPreview = 'Please later write ' + outcomeMarker('outcome'); assert.equal((await f.run()).state, 'group-awaiting-declaration');
  f.parent.deliveries = []; await assert.rejects(f.run(), /unavailable/);
});
test('creation phases require live bounded receipt evidence and exact untouched workers', async () => {
  for(const phase of ['reserved','created','delegated']){
    const f=fixture();f.parent.observed.status='running';
    const w=f.group.workers[0];Object.assign(w,{requestId:'create',phase,ownership:'unresolved',creation:{startedAt:1000,nativeState:phase==='reserved'?'intent':'delivered',generation:phase==='delegated'?2:null}});
    Object.assign(f.worker,{generation:phase==='created'?1:2,mode:phase==='created'?'human':'delegated'});
    Object.assign(f.worker.observed,{lastPromptId:null,humanAt:0});
    if(phase==='reserved')w.workerId=null;
    const run=()=>groupObservation(assignment,f.call,f.operator,()=>2000);
    assert.equal((await run()).reason,'worker-creation-active');
    assert.equal((await groupObservation(assignment,f.call,f.operator,()=>300999)).reason,'worker-creation-active');
    assert.equal((await groupObservation(assignment,f.call,f.operator,()=>301000)).reason,'creation-inactive-or-expired');
    for(const mutate of [
      ()=>{w.creation.startedAt=null;},()=>{w.creation.startedAt=-300000;},()=>{w.creation.startedAt=3000;},
      ()=>{w.creation.nativeState='uncertain';},()=>{f.parent.observed.pending=1;}
    ]){
      const saved=structuredClone({w,parent:f.parent});mutate();assert((await run()).needsAttention);
      Object.assign(w,saved.w);f.parent=saved.parent;
    }
    if(phase!=='reserved'){
      for(const mutate of [()=>{f.worker.generation=8;},()=>{f.worker.task='foreign';},()=>{f.worker.observed.lastPromptId='touched';},()=>{f.worker.observed.humanAt=1;},()=>{f.worker.observed.pending=1;}]){
        const saved=structuredClone(f.worker);mutate();assert((await run()).needsAttention);f.worker=saved;
      }
    }
  }
});
test('pending permission stays attention before and after attachment with explicit evidence',async()=>{
 const f=fixture();f.parent.observed.status='running';f.parent.observed.pending=1;
 const result=await f.run();assert.equal(result.reason,'pending-permission');assert.equal(result.evidence.parent.pending,1);
 f.parent.observed.pending=0;assert.equal((await f.run()).state,'group-working');
});
test('explicit provider expectations refuse mismatched or unknown worker metadata before readiness',async()=>{
 const f=fixture();f.worker.provider='claude';
 assert.equal((await groupObservation({...assignment,workerProvider:'claude'},f.call,f.operator)).state,'group-ready');
 assert.equal((await groupObservation({...assignment,workerProvider:'codex'},f.call,f.operator)).reason,'worker-provider-mismatch');
 assert.equal((await groupObservation({...assignment,workerProvider:'mixed'},f.call,f.operator)).state,'group-ready');
 f.worker.provider=null;assert.equal((await groupObservation({...assignment,workerProvider:'mixed'},f.call,f.operator)).reason,'worker-provider-mismatch');
});
