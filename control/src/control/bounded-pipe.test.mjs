import {test} from 'node:test'; import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {readFrames, writeFrames} from './bounded-pipe.mjs';
test('oversize declared length fails before body allocation or JSON parsing',()=>{
 const stream=new PassThrough(), frames=[], failures=[];
 readFrames(stream,{maxBytes:1024*1024,onFrame:x=>frames.push(x),onError:e=>failures.push(e)});
 const header=Buffer.alloc(4); header.writeUInt32BE(1024*1024+1); stream.write(header);
 assert.equal(failures.length,1); assert.equal(frames.length,0); assert.equal(stream.destroyed,true);
});
test('fragmented/multiple frames roundtrip, invalid JSON and truncated EOF fail closed',async()=>{
 const stream=new PassThrough(), frames=[], failures=[];
 readFrames(stream,{maxBytes:1024,onFrame:x=>frames.push(x),onError:e=>failures.push(e)});
 const encoded=Buffer.from('{"id":1}'),header=Buffer.alloc(4);header.writeUInt32BE(encoded.length);
 const all=Buffer.concat([header,encoded,header,encoded]);
 for(const byte of all) stream.write(Buffer.from([byte]));
 assert.deepEqual(frames,[{id:1},{id:1}]);
 stream.end(Buffer.from([0])); await new Promise(r=>setImmediate(r)); assert.equal(failures.length,1);
 const bad=new PassThrough(),errors=[];readFrames(bad,{maxBytes:1024,onFrame:()=>assert.fail(),onError:e=>errors.push(e)});
 bad.write(Buffer.from([0,0,0,1,123]));assert.equal(errors.length,1);
});
test('writer bounds outstanding bytes and never sends a frame above its directional limit',()=>{
 const callbacks=[],writes=[],failures=[];
 const send=writeFrames({write(bytes,done){writes.push(bytes);callbacks.push(done);}},{maxBytes:16,maxQueuedBytes:24,onError:e=>failures.push(e)});
 assert.throws(()=>send({x:'x'.repeat(32)}),/bound/); assert.equal(writes.length,0);
 send({x:1});send({x:2});assert.throws(()=>send({x:3}),/bound/);
 callbacks.shift()(); send({x:3});assert.equal(writes.length,3);
});

import {spawn} from 'node:child_process';
import {once} from 'node:events';
test('real dedicated child pipes exchange frames and terminate an oversized child before parsing its body', async()=>{
 const moduleUrl=new URL('./bounded-pipe.mjs',import.meta.url).href;
 const child=spawn(process.execPath,['--input-type=module','-e',`
  import fs from 'node:fs';import {readFrames,writeFrames} from ${JSON.stringify(moduleUrl)};
  const out=fs.createWriteStream('',{fd:4});const send=writeFrames(out,{maxBytes:1024,onError:()=>process.exit(2)});
  readFrames(fs.createReadStream('',{fd:3}),{maxBytes:8*1024*1024,onError:()=>process.exit(),onFrame:frame=>{
    send({id:frame.id,ok:true},()=>{const header=Buffer.alloc(4);header.writeUInt32BE(1024*1024+1);out.write(header);});
  }});
 `],{stdio:['ignore','ignore','inherit','pipe','pipe']});
 const frames=[];let rejected=false;
 const exited=once(child,'exit');
 const deadline=setTimeout(()=>child.kill('SIGKILL'),5000);
 try{
  readFrames(child.stdio[4],{maxBytes:1024*1024,onFrame:frame=>frames.push(frame),onError:()=>{rejected=true;child.kill('SIGTERM');}});
  writeFrames(child.stdio[3],{maxBytes:8*1024*1024,onError:()=>child.kill('SIGTERM')})({id:'pipe-fixture'});
  await exited;assert.equal(rejected,true);assert.deepEqual(frames,[{id:'pipe-fixture',ok:true}]);
 }finally{clearTimeout(deadline);if(child.exitCode===null && child.signalCode===null)child.kill('SIGKILL');child.stdio[3].destroy();child.stdio[4].destroy();}
});
