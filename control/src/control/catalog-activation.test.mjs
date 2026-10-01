import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { catalogActivation } from './catalog-activation.mjs';
import fs from 'node:fs';
const id = 'orca-organization-next';
function fixture() {
  const boot = randomUUID(); let listener;
  const catalog = { plugins: [], trustedHost: { contract: '1.1', boot }, trustedPlugins: [{id,contract:'1.1',hooks:['input','permission','deny','mcp','codex']}] };
  const connection = {isConnected:true, getPluginCatalog:async()=>catalog, subscribeConnectionStatus:fn=>{listener=fn;return()=>{};}};
  const activation=catalogActivation(connection);
  return {boot,catalog,connection,activation,event:state=>listener(state)};
}
test('activation requires exact own V1.1 report',async()=>{
 const f=fixture();assert.throws(()=>f.activation.require(),/unavailable/);
 assert.equal(await f.activation.refresh(),f.boot);assert.equal(f.activation.require(f.boot),f.boot);
 for(const change of [()=>{f.catalog.trustedPlugins[0].hooks.pop();},()=>{f.catalog.trustedPlugins[0].id='foreign';},()=>{delete f.catalog.trustedHost;}]) {
   change(); await assert.rejects(f.activation.refresh(),/registration/); assert.throws(()=>f.activation.require());
 }
});
test('captured Book hooks admit owned startup but never replace an admission hook',async()=>{
 const f=fixture();f.catalog.trustedPlugins[0].hooks=['automatic','input','permission','queuedReceipt','deny','mcp','codex'];
 const activation=catalogActivation(f.connection,{getHandshakeBoot:()=>f.boot});
 assert.equal(await activation.refresh(),f.boot);assert.equal(activation.require(),f.boot);
 f.catalog.trustedPlugins[0].hooks=f.catalog.trustedPlugins[0].hooks.filter(hook=>hook!=='deny');
 await assert.rejects(activation.refresh(),/registration/);assert.throws(()=>activation.require(),/unavailable/);
 f.catalog.trustedPlugins[0].hooks=['input','permission','deny','mcp','codex','queuedReceipt','queuedReceipt'];
 await assert.rejects(activation.refresh(),/registration/);assert.throws(()=>activation.require(),/unavailable/);
 activation.close();f.activation.close();
});
test('trial prompt has generic ownership and preserves all original constraints',()=>{
 const source=fs.readFileSync(new URL('../session-config.mjs',import.meta.url),'utf8');
 const literal=source.match(/systemPrompt: ('(?:[^'\\]|\\.)*')/);
 assert.ok(literal,'actual session configuration must contain the prompt');
 const prompt=JSON.parse('"'+literal[1].slice(1,-1)+'"');
 assert.equal(prompt,'You are a persistent independent Orca trial worker working on an operator-assigned task. Work only on the assigned synthetic non-Git task in your directory. Preserve existing native configuration. Do not contact other sessions, create agents, schedules or publish anything. Shared memory can search current decisions by default; request history or all explicitly for earlier evidence, then read exact sources with expectedSha256. Corpus labels describe location, not authority or freshness. Do not include unrelated personal or workplace context in outputs.');
 assert.doesNotMatch(prompt,/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i);
});
test('disconnect, late response and boot changes revoke cached activation',async()=>{
 const f=fixture();await f.activation.refresh(); f.connection.isConnected=false;f.event({status:'disconnected'});assert.throws(()=>f.activation.require());
 f.connection.isConnected=true;let resolve;f.connection.getPluginCatalog=()=>new Promise(r=>{resolve=r;});const pending=f.activation.refresh();
 f.event({status:'disconnected'});resolve(f.catalog);await assert.rejects(pending,/changed/);
 f.connection.getPluginCatalog=async()=>f.catalog;await f.activation.refresh();assert.throws(()=>f.activation.require(randomUUID()),/boot changed/);
 f.catalog.trustedHost.boot=randomUUID();await f.activation.refresh();assert.equal(f.activation.require(),f.catalog.trustedHost.boot);
 f.activation.close();assert.throws(()=>f.activation.require());
});
test('distribution handshake boot is an independent activation bound',async()=>{
 const f=fixture();let boot=randomUUID();const activation=catalogActivation(f.connection,{getHandshakeBoot:()=>boot});
 await assert.rejects(activation.refresh(),/registration/);
 boot=f.boot;await activation.refresh();assert.equal(activation.require(),boot);
 boot=randomUUID();assert.throws(()=>activation.require(),/boot changed/);
 activation.close();
});
test('a configured but unavailable handshake boot cannot fall back to the catalog',async()=>{
 const f=fixture(),activation=catalogActivation(f.connection,{getHandshakeBoot:()=>undefined});
 await assert.rejects(activation.refresh(),/handshake boot unavailable/);assert.throws(()=>activation.require(),/handshake boot unavailable/);activation.close();
});

test('owned handshake mismatch and revocation block activation', async () => {
 const boot=randomUUID();let live=true;
 const connection={isConnected:true,subscribeConnectionStatus:()=>()=>{},getPluginCatalog:async()=>({plugins:[],trustedHost:{contract:'1.1',boot},trustedPlugins:[{id:'orca-organization-next',contract:'1.1',hooks:['input','permission','deny','mcp','codex']}]})};
 let actual=randomUUID();const activation=catalogActivation(connection,{getHandshakeBoot:()=>live?actual:undefined});
 await assert.rejects(activation.refresh(),/registration/);actual=boot;await activation.refresh();assert.equal(activation.require(),boot);
 live=false;assert.throws(()=>activation.require(),/handshake boot unavailable/);await assert.rejects(activation.refresh(),/handshake boot unavailable/);activation.close();
});

test('synchronous connected notification and explicit startup refresh share one catalog RPC',async()=>{
 const f=fixture();let reads=0,complete;
 f.catalog.plugins=[{id,clientBundle:'x'.repeat(675000)}];
 f.connection.getPluginCatalog=()=>{reads++;return new Promise(resolve=>{complete=resolve;});};
 f.connection.subscribeConnectionStatus=listener=>{listener({status:'connected'});return()=>{};};
 const activation=catalogActivation(f.connection,{getHandshakeBoot:()=>f.boot});
 const startup=activation.refresh();
 assert.equal(reads,1,'two real-sized catalog replies overflow the unchanged 1 MiB host IPC queue');
 complete(f.catalog);assert.equal(await startup,f.boot);assert.equal(activation.require(),f.boot);activation.close();
});

test('coalescing never joins a catalog request from a disconnected epoch',async()=>{
 const f=fixture();let listener;const reads=[];
 f.connection.subscribeConnectionStatus=fn=>{listener=fn;fn({status:'connected'});return()=>{};};
 f.connection.getPluginCatalog=()=>new Promise(resolve=>reads.push(resolve));
 const activation=catalogActivation(f.connection,{getHandshakeBoot:()=>f.boot}),old=activation.refresh();
 listener({status:'disconnected'});assert.throws(()=>activation.require());
 listener({status:'connected'});const current=activation.refresh();assert.equal(reads.length,1, "old catalog must drain before replacement");
 reads[0](f.catalog);await assert.rejects(old,/changed/);await new Promise(resolve=>setImmediate(resolve));assert.equal(reads.length,2);
 reads[1](f.catalog);assert.equal(await current,f.boot);activation.close();
});
