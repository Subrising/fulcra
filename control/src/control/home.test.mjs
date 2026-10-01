import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { firstRun, NotConfigured } from '../config.mjs';
import { controlHome } from './home.mjs';
import { shortCanonicalBase, bindable } from './fixture-socket.mjs';
import { socketLocation, prepareSocketLocation } from './socket-location.mjs';
// The portable controller's home is the configured Command Centre root (ORCA_HOME); ORCA_CONTROLLER_HOME and
// its machine default were removed with the portable configuration.
function directory(t){const dir=shortCanonicalBase('orca-home-');t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function configured(t){const home=directory(t);firstRun({ORCA_HOME:home});return home;}
test('the controller home is the configured canonical private ORCA_HOME, with no machine default',t=>{
 const home=configured(t);assert.equal(controlHome({ORCA_HOME:home}),home);assert.throws(()=>controlHome({}),/ORCA_HOME/);
 for(const value of ['', '.', home+'/',home+'/../'+path.basename(home)])assert.throws(()=>controlHome({ORCA_HOME:value}));
 fs.symlinkSync(home,home+'/link');assert.throws(()=>controlHome({ORCA_HOME:home+'/link'}),/canonical/);
 fs.writeFileSync(home+'/file','x',{mode:0o600});assert.throws(()=>controlHome({ORCA_HOME:home+'/file'}),/canonical private owned directory/);
 fs.chmodSync(home,0o755);assert.throws(()=>controlHome({ORCA_HOME:home}),/private/);fs.chmodSync(home,0o700);
});
// J0-3: a refused setting stops the controller at startup, so every message names the setting and the fix.
test('a refused controller home names ORCA_HOME and what to change',t=>{
 const home=configured(t);fs.chmodSync(home,0o755);
 assert.throws(()=>controlHome({ORCA_HOME:home}),/ORCA_HOME must be a canonical private owned directory \(mode 700\)/);fs.chmodSync(home,0o700);
 fs.symlinkSync(home,home+'/link');assert.throws(()=>controlHome({ORCA_HOME:home+'/link'}),/ORCA_HOME must be a canonical private owned directory/);
 assert.throws(()=>controlHome({ORCA_HOME:'relative/home'}),/Set ORCA_HOME to an absolute Command Centre state root/);
});
// PF-1 (INT round 3): a missing folder names ORCA_HOME and the fix, and is a NotConfigured setting error rather
// than a filesystem error a caller could mistake for a missing record.
test('a missing controller home names ORCA_HOME and how to create it',t=>{
 const home=directory(t);
 assert.throws(()=>controlHome({ORCA_HOME:home+'/missing'}),e=>e instanceof NotConfigured&&e.code===undefined&&/^ORCA_HOME names a folder that does not exist \(.+\/missing\): create it with mode 700, or run the first-run setup/.test(e.message));
 assert.throws(()=>controlHome({}),NotConfigured);
});
test('actual supervisor MCP process uses one host-selected grant and private socket',async t=>{
 const home=configured(t),sessionId=randomUUID(),capability=randomBytes(32).toString('base64url'),grantDir=home+'/grants/manager';fs.mkdirSync(grantDir,{recursive:true,mode:0o700});
 const file=grantDir+'/'+randomUUID()+'.json';fs.writeFileSync(file,JSON.stringify({sessionId,capability}),{mode:0o600});
 const seen=[],server=net.createServer(c=>{let bytes='';c.setEncoding('utf8');c.on('data',chunk=>{bytes+=chunk;if(!bytes.endsWith('\n'))return;seen.push(JSON.parse(bytes));c.end(JSON.stringify({result:{privateRuntime:true}})+'\n');});});
 // V4 (#33): the controller socket lives where socket-location.mjs resolves it, not inside ORCA_HOME.
 const location=socketLocation(home);prepareSocketLocation(home);t.after(()=>fs.rmSync(location.directory,{recursive:true,force:true}));
 await new Promise(resolve=>server.listen(bindable(location.socket),resolve));fs.chmodSync(location.socket,0o600);// private, as server.mjs makes it
 const transport=new StdioClientTransport({command:process.execPath,args:[new URL('./inbox.mjs',import.meta.url).pathname],env:{PATH:process.env.PATH,ORCA_HOME:home,ORCA_MANAGER_FILE:file}}),client=new Client({name:'owned-socket-proof',version:'1'});
 try {await client.connect(transport);const out=await client.callTool({name:'manager_create_worker',arguments:{messageId:randomUUID(),provider:'codex',host:'macbook',title:'Owned Book worker'}});assert(!out.isError);assert.equal(seen.length,1);assert.equal(seen[0].method,'manager-create');assert.equal(seen[0].input.sessionId,sessionId);assert.equal(seen[0].input.host,'macbook');assert.equal(seen[0].capability,capability);
 const noInbox=await client.callTool({name:'supervisor_inbox',arguments:{}});assert.equal(noInbox.isError,true);assert.equal(seen.length,1);
 }finally{await client.close();await transport.close();await new Promise(resolve=>server.close(resolve));}
});
