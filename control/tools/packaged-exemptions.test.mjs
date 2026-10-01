import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { auditPackagedBundle } from './no-machine-ties.mjs';
const marker = ['', 'Users', 'runner', 'build'].join('/');
const digest = value => createHash('sha256').update(value).digest('hex');
function fixture(fn) {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-exemption-'));
 try { fn(root); } finally { fs.rmSync(root, {recursive:true,force:true}); }
}
const file = 'Contents/Resources/app.asar.unpacked/node_modules/vendor/native.node';
function put(root, name, body) { fs.mkdirSync(path.dirname(path.join(root,name)),{recursive:true}); fs.writeFileSync(path.join(root,name),body); }
const exemption = {file, sha256:digest(marker), patterns:[marker.slice(0,7)], justification:'Vendor compiler source path; not a Fulcra runtime setting.'};
test('only exact reviewed third-party bytes and matched patterns are exempt', () => fixture(root => {
 put(root,file,marker);
 assert.equal(auditPackagedBundle(root,[]).passed,false);
 assert.equal(auditPackagedBundle(root,[exemption]).passed,true);
 put(root,file,marker+' changed');
 assert.equal(auditPackagedBundle(root,[exemption]).passed,false);
 put(root,file,'clean but changed');
 assert.equal(auditPackagedBundle(root,[exemption]).passed,false);
 put(root,file,marker);
 put(root,file+'.new',marker);
 assert.equal(auditPackagedBundle(root,[exemption]).passed,false);
 fs.rmSync(path.join(root,file));
 assert(auditPackagedBundle(root,[exemption]).errors.some(error=>error.error==='Exempted file missing'));
}));
test('our bundles and wildcard paths cannot be exempted', () => fixture(root => {
 for(const own of ['Contents/Resources/app-dist/main.js','Contents/Resources/bundled-plugins/controller.mjs','Contents/Resources/app.asar!/dist/main.js','Contents/Resources/app.asar!/node_modules/@getpaseo/server/main.js']) {
  put(root,'clean','clean');
  assert.throws(()=>auditPackagedBundle(root,[{...exemption,file:own}]),/third-party/);
 }
 assert.throws(()=>auditPackagedBundle(root,[{...exemption,file:'**/vendor/*'}]),/exact/);
}));
function asar(entries) {
 let offset=0; const files={}; const buffers=[];
 for(const [name,body] of Object.entries(entries)) {
  let cursor=files; const parts=name.split('/');
  for(const part of parts.slice(0,-1)) cursor=(cursor[part]??={files:{}}).files;
  const data=Buffer.from(body); cursor[parts.at(-1)]={size:data.length,offset:String(offset)};offset+=data.length;buffers.push(data);
 }
 const json=Buffer.from(JSON.stringify({files}));const headerSize=8+json.length+((4-json.length%4)%4);
 const header=Buffer.alloc(8+headerSize);header.writeUInt32LE(4,0);header.writeUInt32LE(headerSize,4);header.writeUInt32LE(headerSize-4,8);header.writeUInt32LE(json.length,12);json.copy(header,16);
 return Buffer.concat([header,...buffers]);
}
test('archive entries have independent provenance; vendor exemption cannot hide app content',()=>fixture(root=>{
 const archive='Contents/Resources/app.asar'; const vendor=archive+'!/node_modules/vendor/index.js';
 put(root,archive,asar({'node_modules/vendor/index.js':marker,'dist/main.js':'clean'}));
 const ex={...exemption,file:vendor};
 assert.equal(auditPackagedBundle(root,[ex]).passed,true);
 put(root,archive,asar({'node_modules/vendor/index.js':marker,'dist/main.js':marker}));
 const result=auditPackagedBundle(root,[ex]);
 assert.equal(result.passed,false);
 assert(result.unexempted.some(hit=>hit.file===archive+'!/dist/main.js'));
}));
test('archive tails and multiple patterns on one line are not hidden by entry reviews',()=>fixture(root=>{
 const archive='Contents/Resources/app.asar',vendor=archive+'!/node_modules/vendor/index.js';
 const second=['Da','vid'].join('');const body=marker+' '+second;
 put(root,archive,asar({'node_modules/vendor/index.js':body}));
 assert.equal(auditPackagedBundle(root,[{...exemption,file:vendor,sha256:digest(body)}]).passed,false);
 put(root,archive,Buffer.concat([asar({'node_modules/vendor/index.js':marker}),Buffer.from(marker)]));
 assert.equal(auditPackagedBundle(root,[{...exemption,file:vendor}]).passed,false);
}));

test('malformed and escaping archive entries fail closed',()=>fixture(root=>{
 const archive='Contents/Resources/app.asar';
 put(root,archive,asar({'../outside':'portable'}));
 assert.throws(()=>auditPackagedBundle(root,[]),/Invalid ASAR path/);
 put(root,archive,asar({'main.js':'portable'}).subarray(0,17));
 assert.throws(()=>auditPackagedBundle(root,[]),/Invalid ASAR bounds/);
}));
