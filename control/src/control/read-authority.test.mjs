import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rpc } from './rpc.mjs';
test('same-user socket client without authority cannot read private operator projections',async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'cc-private-read-')),socket=path.join(home,'control.sock');let reads=0;
 const dispatch=rpc({decisions:{inbox:()=>{reads++;return 'private';}},channels:{inbox:()=>{reads++;return 'private';}},history:()=>{reads++;return 'private';}},randomUUID(),{allowOperatorWrites:false});
 const server=net.createServer(client=>client.once('data',async bytes=>{try {client.end(JSON.stringify({result:await dispatch(JSON.parse(bytes.toString()))}));}catch(error){client.end(JSON.stringify({error:error.message}));}}));
 try {
  await new Promise(resolve=>server.listen(socket,resolve));fs.chmodSync(socket,0o600);
  const script=`import net from 'node:net';const out=[];for(const method of ['decisions-inbox','seat-inbox','history'])for(const marker of [true,false]){out.push(await new Promise((resolve,reject)=>{const c=net.createConnection(process.argv[1]);let data='';c.on('connect',()=>c.write(JSON.stringify({method,...(marker?{read:true}:{}),...(method==='seat-inbox'?{input:{role:'prime',seat:'operations'}}:method==='history'?{input:'11111111-1111-4111-8111-111111111111'}:{})})));c.on('data',b=>data+=b);c.on('end',()=>resolve(JSON.parse(data)));c.on('error',reject);}));}console.log(JSON.stringify({uid:process.getuid(),out}));`;
  const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','-e',script,socket],{timeout:10000});
  const result=JSON.parse(stdout);assert.equal(result.uid,process.getuid());assert.equal(result.out.length,6);
  for(const reply of result.out)assert.ok(reply.error,JSON.stringify(reply));assert.equal(reads,0);
 } finally {await new Promise(resolve=>server.close(resolve));fs.rmSync(home,{recursive:true,force:true});}
});
