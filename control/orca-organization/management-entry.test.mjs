import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
test('actual plugin entry refuses absent management before cleanup and uses each fresh host context',async t=>{
 assert.ok(process.env.FULCRA_TEST_PLUGIN,'Build the actual plugin entry under heavy-lock');
 const {default:contribute}=await import(pathToFileURL(process.env.FULCRA_TEST_PLUGIN).href);
 const handlers=new Map();const dispose=contribute({handle:(contract,handler)=>handlers.set(contract.name,handler)});t.after(dispose);
 const name=[...handlers.keys()].find(name=>/cleanup.*preview|preview.*cleanup/.test(name));assert.ok(name,[...handlers.keys()].filter(n=>n.includes('cleanup')).join(','));
 const preview=handlers.get(name);assert.throws(()=>preview({},{}),/Management unavailable/);
 const seen=[];
 for(const id of [1,2])assert.equal(await preview({}, {management:{invoke:async command=>{seen.push([id,command]);return id;}}}),id);
 assert.deepEqual(seen.map(([id,command])=>[id,command.method]),[[1,'worktree-lifecycle-preview'],[2,'worktree-lifecycle-preview']]);
 const read=handlers.get('organization.projects');assert.ok(read);
 assert.throws(()=>read({}, {paseo:{}}),/Management unavailable/);
});
