import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ControlStore } from './store.mjs';
import { admitBootstrap, requireBootstrapBinding, reconcileBootstrap } from './native-bootstrap.mjs';
function fixture(t) {
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'bootstrap-')),file=path.join(home,'journal.sqlite'),store=new ControlStore(file),db=store.db;
 store.created('worker','task',home);
 db.prepare("UPDATE sessions SET boot='boot' WHERE id='worker'").run();
 db.prepare("INSERT INTO deliveries VALUES ('create',NULL,'create',?,'delivered',?)").run(JSON.stringify({provider:'claude',taskId:'task'}),JSON.stringify({id:'worker',cwd:home,runtimeInstanceId:'instance'}));
 db.prepare("INSERT INTO deliveries VALUES ('first','worker','send','{}','intent','{}')").run();
 const agent={id:'worker',cwd:home,provider:'claude',runtime:{status:'known',instanceId:'instance',nativeSessionId:null,lastUserMessageAt:null}},operation={operationId:'operation',attemptId:'attempt'},delivery={id:'first'};
 t.after(()=>{store.close();fs.rmSync(home,{recursive:true,force:true});});
 return {db,file,agent,operation,delivery};
}
test('bootstrap identity survives a new connection and only the original operation may reuse it',t=>{
 const f=fixture(t);admitBootstrap(f.db,f.agent,f.operation,f.delivery,'boot');
 const reopened=new DatabaseSync(f.file);
 try {
  admitBootstrap(reopened,f.agent,f.operation,f.delivery,'boot');
  for(const operation of [{...f.operation,operationId:'new'},{...f.operation,attemptId:'new'}])assert.throws(()=>admitBootstrap(reopened,f.agent,operation,f.delivery,'boot'));
  assert.throws(()=>admitBootstrap(reopened,f.agent,f.operation,f.delivery,'new-boot'));
 } finally {reopened.close();}
});
test('only acknowledged exact first-turn observation binds native id; later sends require that id',t=>{
 const f=fixture(t);admitBootstrap(f.db,f.agent,f.operation,f.delivery,'boot');
 const observed={id:'worker',runtimeInstanceId:'instance',boot:'boot',lastPromptId:'first',lastUserAt:'2026-09-28T00:00:00Z',nativeId:'native'};
 reconcileBootstrap(f.db,observed);assert.equal(f.db.prepare('SELECT nativeId FROM native_bootstrap').get().nativeId,null);
 f.db.exec("UPDATE deliveries SET state='delivered' WHERE id='first'");
 for(const patch of [{runtimeInstanceId:'other'},{boot:'other'},{lastPromptId:'other'},{lastUserAt:null}]){
  reconcileBootstrap(f.db,{...observed,...patch});assert.equal(f.db.prepare('SELECT nativeId FROM native_bootstrap').get().nativeId,null);
 }
 assert.throws(()=>requireBootstrapBinding(f.db,{...f.agent,runtime:{nativeSessionId:'native'}}));
 reconcileBootstrap(f.db,observed);
 assert.equal(f.db.prepare('SELECT nativeId FROM native_bootstrap').get().nativeId,'native');
 requireBootstrapBinding(f.db,{...f.agent,runtime:{nativeSessionId:'native'}});
 assert.throws(()=>requireBootstrapBinding(f.db,{...f.agent,runtime:{nativeSessionId:'other'}}));
 assert.throws(()=>requireBootstrapBinding(f.db,f.agent));
 assert.throws(()=>admitBootstrap(f.db,f.agent,f.operation,f.delivery,'boot'));
 reconcileBootstrap(f.db,{...observed,nativeId:'replacement'});
 assert.equal(f.db.prepare('SELECT nativeId FROM native_bootstrap').get().nativeId,'native');
});
