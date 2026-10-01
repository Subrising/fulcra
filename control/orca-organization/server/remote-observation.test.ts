import test from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteObserver } from './remote-observation';
const rows = Array.from({length:7},(_,i)=>({id:`session-${i}`,task:'task',host:'macbook',generation:1,remote:{agentId:`native-${i}`,generation:1}}));
const flush = async () => { for(let i=0;i<30;i++) await Promise.resolve(); };
function controlled(){let active=0,max=0;const calls:string[]=[],releases:Array<(value?:unknown)=>void>=[];const call=async(method:string,input?:unknown)=>{assert.equal(method,'observe');calls.push(String(input));active++;max=Math.max(max,active);try{return await new Promise(resolve=>releases.push(resolve));}finally{active--;}};return{call,calls,releases,get active(){return active},get max(){return max}};}

test('healthy seven-route batch observes all routes with only four underlying calls at once',async()=>{
 const f=controlled(),observe=createRemoteObserver(f.call),result=observe(rows);await flush();assert.equal(f.calls.length,4);assert.equal(f.active,4);
 f.releases.slice(0,4).forEach((release,i)=>release({id:rows[i].id}));await flush();assert.equal(f.calls.length,7);assert.equal(f.active,3);
 f.releases.slice(4).forEach((release,i)=>release({id:rows[i+4].id}));const r=await result;assert.equal(r.values.size,7);assert.equal(r.pending.size,0);assert.equal(f.max,4);assert.equal(f.active,0);
});
test('deadline does not free occupied slots or mutate a returned snapshot; later readers join instead of replaying',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout']});const f=controlled(),observe=createRemoteObserver(f.call),first=observe(rows);await flush();
 t.mock.timers.tick(12000);await flush();const a=await first;assert.equal(a.values.size,0);assert.deepEqual([...a.pending],rows.slice(0,4).map(r=>r.id));assert.equal(f.active,4);
 const second=observe(rows);await flush();assert.equal(f.calls.length,4);assert.equal(f.active,4);
 f.releases.slice(0,4).forEach(release=>release('retained response'));await flush();assert.equal(f.calls.length,7);assert.deepEqual(f.calls.slice(4),rows.slice(4).map(r=>r.id));assert.equal(a.values.size,0);
 f.releases.slice(4).forEach(release=>release('later route'));const b=await second;assert.equal(b.values.size,7);assert.equal(f.max,4);assert.equal(a.values.size,0);
});
test('concurrent batches share full route identity but never completed values',async()=>{
 const f=controlled(),observe=createRemoteObserver(f.call),a=observe(rows.slice(0,1)),b=observe(rows.slice(0,1));await flush();assert.equal(f.calls.length,1);
 f.releases[0]('shared');assert.equal((await a).values.get(rows[0].id),'shared');assert.equal((await b).values.get(rows[0].id),'shared');
 const c=observe(rows.slice(0,1));await flush();assert.equal(f.calls.length,2);f.releases[1]('new');assert.equal((await c).values.get(rows[0].id),'new');
});
test('generation, task and native route changes do not join an older in-flight call',async()=>{
 for(const change of [{generation:2},{task:'other'},{remote:{agentId:'other',generation:1}},{remote:{agentId:rows[0].remote.agentId,generation:2}}]){
 const f=controlled(),observe=createRemoteObserver(f.call),a=observe(rows.slice(0,1)),b=observe([{...rows[0],...change}]);await flush();assert.equal(f.calls.length,2);
 f.releases[0]('old');f.releases[1]('new');assert.equal((await a).values.get(rows[0].id),'old');assert.equal((await b).values.get(rows[0].id),'new');}
});
test('slow refreshes rotate admissions and never start more work after the display deadline',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout']});const f=controlled(),observe=createRemoteObserver(f.call),a=observe(rows);await flush();t.mock.timers.tick(12000);await flush();await a;
 f.releases.slice().forEach(r=>r('late'));await flush();assert.equal(f.calls.length,4);
 const b=observe(rows);await flush();assert.deepEqual(f.calls.slice(4,7),rows.slice(4).map(r=>r.id));assert.equal(f.max,4);
 t.mock.timers.tick(12000);await flush();await b;f.releases.slice(4).forEach(r=>r('late'));await flush();assert.equal(f.calls.length,8);
});
test('one failing route does not prevent other observations and does not retain capacity',async()=>{
 let calls=0;const observe=createRemoteObserver(async(_,id)=>{calls++;if(id===rows[0].id)throw Error('offline');return id});
 const result=await observe(rows);assert.equal(result.values.size,7);assert.equal(result.values.get(rows[0].id),null);assert.equal(calls,7);await observe(rows);assert.equal(calls,14);
});
test('empty and exhausted-budget requests start no controller work',async()=>{
 let calls=0;const observe=createRemoteObserver(async()=>{calls++;},0);assert.equal((await observe(rows)).values.size,0);assert.equal((await observe([])).values.size,0);assert.equal(calls,0);
});
test('property: every bounded fleet size retains exact coverage and four-call maximum',async()=>{
 for(let count=0;count<=64;count++){
 let active=0,max=0,calls=0;const input=Array.from({length:count},(_,i)=>({...rows[0],id:`route-${i}`,remote:{agentId:`native-${i}`,generation:i}}));
 const observe=createRemoteObserver(async(_,id)=>{calls++;active++;max=Math.max(max,active);await Promise.resolve();active--;return id;});
 const r=await observe(input);assert.deepEqual([...r.values.keys()],input.map(row=>row.id));assert.equal(calls,count);assert(max<=4);assert.equal(active,0);assert.equal(r.pending.size,0);
 }
});
