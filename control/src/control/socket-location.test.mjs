import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { firstRun } from '../config.mjs';
import { request } from './client.mjs';
import { reader } from './control-read.mjs';
import {captureOwnedFiles,recoverOwnedFiles} from './owned-child-files.mjs';
import { socketLocation, prepareSocketLocation, resolveSocketPath } from './socket-location.mjs';
const roots=[];
const originalTmp=process.env.TMPDIR;
const privateTmp=fs.realpathSync(fs.mkdtempSync('/tmp/fcc-tmp-'));process.env.TMPDIR=privateTmp;roots.push(privateTmp);
function fixture(long=false){const root=fs.realpathSync(fs.mkdtempSync('/tmp/fcc-test-'));roots.push(root);const home=path.join(root,long?'long-home-'.repeat(15):'home');fs.mkdirSync(home,{mode:0o700});return home;}
test.after(()=>{if(originalTmp===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=originalTmp;for(const root of roots)fs.rmSync(root,{recursive:true,force:true});});
test('short homes retain their existing socket address',()=>{const home=fixture();assert.equal(prepareSocketLocation(home),path.join(home,'control.sock'));assert.equal(resolveSocketPath(home),path.join(home,'control.sock'));});
test('long UTF-8 homes use one private bounded address shared by real server and client',async()=>{
 const home=fixture(true),location=socketLocation(home),address=prepareSocketLocation(home);
 assert(Buffer.byteLength(path.join(home,'control.sock'))>=104);assert(Buffer.byteLength(address)<104);
 assert.equal(fs.statSync(location.directory).mode&0o777,0o700);assert.equal(resolveSocketPath(home),address);
 const server=net.createServer(c=>c.end('fixture-ready'));
 try{
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(address,()=>{fs.chmodSync(address,0o600);resolve();});});
  const body=await new Promise((resolve,reject)=>{const c=net.createConnection(resolveSocketPath(home));let data='';c.on('data',b=>data+=b);c.on('error',reject);c.on('end',()=>resolve(data));});assert.equal(body,'fixture-ready');
  assert.notEqual(socketLocation(fixture(true)).socket,address);
 }finally{await new Promise(resolve=>server.close(resolve));fs.rmdirSync(location.directory);}
});
function withPreparedSocketDirectory(home, check) {
 const location=socketLocation(home);prepareSocketLocation(home);
 try { return check(location); }
 finally { fs.rmSync(location.directory,{recursive:true,force:true}); }
}
test('socket fixture cleanup preserves an assertion before the directory becomes a symlink',()=>{
 const home=fixture(true);
 assert.throws(()=>withPreparedSocketDirectory(home,()=>assert.fail('original socket assertion')),error=>error.code==='ERR_ASSERTION' && error.message==='original socket assertion');
});
test('a replaced, public or symlink socket directory is not trusted',()=>{
 const home=fixture(true);
 withPreparedSocketDirectory(home,location=>{
  fs.chmodSync(location.directory,0o755);
  assert.throws(()=>resolveSocketPath(home),/Canonical private owned socket directory required/,'resolve must reject public directory');
  assert.throws(()=>prepareSocketLocation(home),/Canonical private owned socket directory required/,'prepare must reject public directory');
  fs.chmodSync(location.directory,0o700);fs.rmdirSync(location.directory);fs.symlinkSync(home,location.directory);
  assert.throws(()=>resolveSocketPath(home),/Canonical private owned socket directory required/,'resolve must reject symlink directory');
  assert.throws(()=>prepareSocketLocation(home),/Canonical private owned socket directory required/,'prepare must reject symlink directory');
 });
});

test('long-path recovery checks the captured private directory identity before deleting anything',()=>{
 const home=fixture(true),location=socketLocation(home);prepareSocketLocation(home);
 const lock=path.join(home,'process.lock');fs.writeFileSync(lock,JSON.stringify({pid:101,epoch:'fixture'}),{mode:0o600});
 const owner=captureOwnedFiles(home,{pid:101,epoch:'fixture'}),saved=location.directory+'-saved';
 try{fs.renameSync(location.directory,saved);fs.mkdirSync(location.directory,{mode:0o700});assert.throws(()=>recoverOwnedFiles(owner,{exited:true}));assert(fs.existsSync(lock));fs.rmdirSync(location.directory);fs.renameSync(saved,location.directory);recoverOwnedFiles(owner,{exited:true});assert(!fs.existsSync(lock));assert(!fs.existsSync(location.directory));}
 finally{fs.rmSync(location.directory,{recursive:true,force:true});fs.rmSync(saved,{recursive:true,force:true});}
});

test('wrong directory or socket owner and non-private sockets are refused', async()=>{
 const home=fixture(true),location=socketLocation(home),address=prepareSocketLocation(home);
 const server=net.createServer();
 await new Promise(resolve=>server.listen(address,resolve));
 const original=fs.lstatSync;
 try {
  fs.chmodSync(address,0o600);
  for(const target of [location.directory,address]) {
   fs.lstatSync=(file,...args)=>{const stat=original(file,...args);if(file===target)stat.uid=process.getuid()+1;return stat;};
   assert.throws(()=>prepareSocketLocation(home));assert.throws(()=>resolveSocketPath(home));
   fs.lstatSync=original;
  }
  fs.chmodSync(address,0o666);assert.throws(()=>resolveSocketPath(home));assert.throws(()=>prepareSocketLocation(home));
 } finally {fs.lstatSync=original;await new Promise(resolve=>server.close(resolve));fs.rmdirSync(location.directory);}
});

test('ordinary request and read clients resolve the same long-home socket',async()=>{
 const home=fixture(true),previous=process.env.ORCA_HOME;firstRun({ORCA_HOME:home});process.env.ORCA_HOME=home;
 const location=socketLocation(home),address=prepareSocketLocation(home);
 const server=net.createServer(c=>c.once('data',()=>c.end(JSON.stringify({result:{fixture:'rendered'}})+'\n')));
 try {
  await new Promise(resolve=>server.listen(address,resolve));fs.chmodSync(address,0o600);
  assert.deepEqual(await request({method:'fixture'}),{fixture:'rendered'});
  assert.deepEqual(await reader({home,reads:['fixture']})('fixture'),{fixture:'rendered'});
 } finally {if(previous===undefined)delete process.env.ORCA_HOME;else process.env.ORCA_HOME=previous;await new Promise(resolve=>server.close(resolve));fs.rmdirSync(location.directory);}
});
