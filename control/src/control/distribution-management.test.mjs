import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { parseControllerCommand, READ_METHODS } from './command-parser.mjs';

test('actual distribution status bridge satisfies the host Promise contract and current authority', async () => {
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'distribution-health-'));fs.chmodSync(home,0o700);
 const product=process.env.FULCRA_TEST_PRODUCT;assert.ok(product);
 const {TrustedPlugins}=await import(pathToFileURL(path.join(product,'packages/server/dist/server/server/plugins/trusted.js')));
 const {consumeManagementDispatch}=await import(pathToFileURL(path.join(product,'packages/server/dist/server/server/plugins/management.js')));
 await mock.module(new URL('../config.mjs',import.meta.url).href,{namedExports:{firstRun:()=>{},loadConfig:()=>({home})}});
 await mock.module(new URL('./child-supervisor.mjs',import.meta.url).href,{namedExports:{createChildSupervisor:()=>({
  ready:true,status:{state:'ready',restarts:0},start(){},stop:async()=>{},
  management:async(command,principal)=>{consumeManagementDispatch(command,principal);assert.equal(command.method,'health');return {ready:true};},
 })}});
 const {createDistribution}=await import('./distribution-host.mjs');
 const distribution=createDistribution({home,bundleDirectory:home});
 const authority=new TrustedPlugins({enabled:()=>true,validate:parseControllerCommand,isRead:c=>READ_METHODS.includes(c.method)});
 authority.initializeKnownAgents([]);authority.registerV11('orca-organization-next',true,server=>distribution.setup(server));
 distribution.start({boot:authority.boot,previousBoot:null,consumeManagement:consumeManagementDispatch,createChannel:()=>{throw Error('No child may be created in this contract test');}});
 let permissions=['daemon.manage','command-centre.manage'];
 const invocation=authority.management.open({pluginId:'orca-organization-next',bundleDirectory:home,isCurrent:()=>true},()=>({id:'fixture-owner',authentication:'daemon-password',deviceId:null,permissions}));
 try {
  assert.ok(invocation);
  assert.deepEqual(await invocation.invoke(randomUUID(),{method:'controller-status',input:null}),{state:'ready',restarts:0});
  assert.deepEqual(await invocation.invoke(randomUUID(),{method:'health',input:null}),{ready:true});
  permissions=[];await assert.rejects(invocation.invoke(randomUUID(),{method:'controller-status',input:null}),/unavailable|unauthorised/i);
 } finally {invocation?.close();authority.close();mock.reset();fs.rmSync(home,{recursive:true});}
});
