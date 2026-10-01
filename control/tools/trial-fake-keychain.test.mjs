import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import fake from './trial/fake-keychain.cjs';
test('private fault gate delays a read and observes deletion/rotation on release',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'trial-keychain-'));const keychain=fake.createFakeKeychain(root);
 try{await keychain.set('trial','old');fs.writeFileSync(root+'/keychain-hold','');let done=false;const pending=keychain.get('trial').then(v=>{done=true;return v;});await new Promise(r=>setTimeout(r,60));assert.equal(done,false);assert.equal(fs.readFileSync(root+'/keychain-pending','utf8'),'pending');await keychain.set('trial','new');fs.unlinkSync(root+'/keychain-hold');assert.equal(await pending,'new');fs.unlinkSync(root+'/fake-keychain.json');assert.equal(await keychain.get('trial'),null);}finally{fs.rmSync(root,{recursive:true,force:true});}
});
