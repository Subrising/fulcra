import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { auditPackagedBundle } from './no-machine-ties.mjs';
function fixture(fn){const root=fs.mkdtempSync(path.join(os.tmpdir(),'generic-review-'));try{fn(root);}finally{fs.rmSync(root,{recursive:true,force:true});}}
const file='Contents/Resources/app-dist/main.js';
function put(root,body){fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.writeFileSync(path.join(root,file),body);}
function review(hit){return {file:hit.file,sha256:hit.sha256,kind:'first-party-generic',line:hit.line,offset:hit.offset,context:hit.context,pattern:hit.pattern,justification:'UI duration in milliseconds; not a network port.'};}
test('generic own matches require exact hash, position, token and context',()=>fixture(root=>{
 put(root,'const timeout = '+['32','00'].join('')+';');
 const hit=auditPackagedBundle(root).findings[0],entry=review(hit);
 assert.equal(auditPackagedBundle(root,[entry]).passed,true);
 for(const key of ['offset','line','pattern','context','sha256']){
  const changed={...entry,[key]:typeof entry[key]==='number'?entry[key]+1:'changed'};
  let failed;try{failed=!auditPackagedBundle(root,[changed]).passed;}catch{failed=true;}assert(failed,key);
 }
 put(root,'const timeout = '+['32','00'].join('')+'; // change');
 assert.equal(auditPackagedBundle(root,[entry]).passed,false);
}));
test('another same-token occurrence on the same line is not automatically reviewed',()=>fixture(root=>{
 put(root,['32','00'].join('')+'; '+['32','00'].join(''));
 const findings=auditPackagedBundle(root).findings;
 assert.equal(findings.length,2);
 assert.equal(auditPackagedBundle(root,[review(findings[0])]).passed,false);
}));
test('exact personal paths and credentials cannot be made generic by a review',()=>fixture(root=>{
 for(const body of [['','Users','real-person','project'].join('/'),['','Volumes','mac','private'].join('/'),'sk-'+ 'q'.repeat(40)]){
  put(root,body);const result=auditPackagedBundle(root);
  assert(result.findings.length>0);
  assert(result.findings.some(hit=>hit.blocker));
  assert.equal(auditPackagedBundle(root,result.findings.map(review)).passed,false);
 }
}));

test('binary root prefix and nested API path are generic, not personal homes',()=>fixture(root=>{
 for(const body of ['/Users/\0next-symbol','`/organization/projects/${project}/users/${user}/roles`']) {
  put(root,body);const result=auditPackagedBundle(root);
  assert(result.findings.length>0);assert(result.findings.every(hit=>!hit.blocker),body);
  assert.equal(auditPackagedBundle(root,result.findings.map(review)).passed,true);
 }
}));
