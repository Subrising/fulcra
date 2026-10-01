import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveProviderModel } from './provider-model.mjs';

test('bare family uses only the provider-advertised default with the owned cwd', async () => {
 const client = {providers:{listModels:async(provider, options)=>{assert.equal(provider,'codex');assert.deepEqual(options,{cwd:'/owned'});return {provider,models:[{id:'first'},{provider:'codex',id:'installed-default',isDefault:true}]};}}};
 assert.equal(await resolveProviderModel(client,'codex','/owned'),'codex/installed-default');
});
test('explicit provider/model is preserved without inventory substitution', async () => {
 assert.equal(await resolveProviderModel({},'codex/explicit-model','/owned'),'codex/explicit-model');
});
test('unavailable, wrong-family and ambiguous inventories fail before creating', async () => {
 for(const inventory of [{provider:'codex',error:'offline'},{provider:'claude',models:[{provider:'codex',id:'x',isDefault:true}]},{provider:'codex',models:[{provider:'claude',id:'x',isDefault:true}]},{provider:'codex',models:[{provider:'codex',id:'x',isDefault:true,isSelectable:false}]},{provider:'codex',models:[]},{provider:'codex',models:[{id:'x'}]},{provider:'codex',models:[{provider:'codex',id:'x',isDefault:true},{provider:'codex',id:'y',isDefault:true}]}]){
  await assert.rejects(resolveProviderModel({providers:{listModels:async()=>inventory}},'codex','/owned'),/default|inventory/);
 }
});
