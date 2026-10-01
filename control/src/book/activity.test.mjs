import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {projectBookActivity as project,validateBookActivity as validate} from './activity.mjs';
const projectBookActivity=p=>project(p,'/owned'),validateBookActivity=r=>validate(r,'/owned');
import {bookNative} from './native.mjs';
const page=entries=>({entries,hasOlder:false});
const reply=activity=>({sessionId:randomUUID(),taskId:randomUUID(),agentId:randomUUID(),nativeId:null,observedAt:new Date().toISOString(),hasOlder:false,skippedCount:0,withheldPaths:0,activity});
test('canonical projection exposes fixed message labels and tool metadata, never private contents or thinking',async()=>{
  const entries=[{seqStart:1,item:{type:'user_message',text:'PRIVATE'}},{seqStart:2,item:{type:'assistant_message',text:'PRIVATE'}},{seqStart:3,item:{type:'thinking',text:'PRIVATE'}},{seqStart:4,item:{type:'PRIVATE',text:'PRIVATE'}},{seqStart:5,item:{type:'tool_call',name:'Write',status:'completed',detail:{type:'write',filePath:'/owned/événement.txt',content:'PRIVATE'},arguments:'PRIVATE',result:'PRIVATE'}}];
  const r=projectBookActivity(page(entries));assert.equal(r.activity.length,3);assert(!JSON.stringify(r).includes('PRIVATE'));assert.deepEqual(r.activity[2].files,['/owned/événement.txt']);assert.equal(validateBookActivity(reply(r.activity)).activity.length,3);
  const native=bookNative({agents:{ref:id=>({timeline:{refetch:async options=>{assert.equal(id,'native');assert.deepEqual(options,{limit:50,projection:'canonical'});return page(entries);}}})}}, {}, {});
  assert.deepEqual(await native.activity('native','/owned'),r);
});
test('canonical errors, gaps, oversize windows and malformed signed metadata refuse',()=>{
  for(const field of ['error','gap','reset','staleCursor','hasNewer'])assert.throws(()=>projectBookActivity({...page([]),[field]:true}));
  for(const p of [null,{},page(Array(51).fill({})),{entries:[]}])assert.throws(()=>projectBookActivity(p));
  assert.equal(projectBookActivity({...page(Array(50).fill({item:{type:'user_message'}})),hasOlder:true}).activity.length,50);
  const a={id:'1',kind:'user_message',label:'User instruction',state:null,files:[]};
  for(const change of [{id:1},{kind:'thinking'},{label:'PRIVATE'},{state:'PRIVATE'},{files:['PRIVATE']},{extra:'PRIVATE'}])assert.throws(()=>validateBookActivity(reply([{...a,...change}])));
  for(const change of [{sessionId:'bad'},{nativeId:'bad'},{observedAt:'bad'},{extra:'PRIVATE'},{activity:Array(51).fill(a)}])assert.throws(()=>validateBookActivity({...reply([a]),...change}));
});
test('tool names, status and paths cannot become arbitrary multiline payloads',()=>{
  const r=projectBookActivity(page([{item:{type:'tool_call',name:'PRIVATE\nargs',status:'PRIVATE',detail:{type:'write',filePath:'PRIVATE\ncontent'}}},{item:{type:'tool_call',name:'Read',status:'completed',detail:{type:'command',filePath:'PRIVATE'}}}]));
  assert.deepEqual(r.activity[0],{id:'0',kind:'tool_call',label:'Tool',state:'unknown',files:[]});assert.deepEqual(r.activity[1].files,[]);assert(!JSON.stringify(r).includes('PRIVATE'));
});
test('seeded metadata projection never carries raw prompt, argument, thinking or result payloads',()=>{
 let seed=0x1122026;for(let n=0;n<512;n++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const privateText='PRIVATE_'+seed,kind=['tool_call','user_message','assistant_message','thinking'][seed%4];
  const r=projectBookActivity(page([{seqStart:n,item:{type:kind,name:seed%8?'Read':'invalid\n'+privateText,status:seed%8?'completed':privateText,text:privateText,arguments:{data:privateText},result:privateText,detail:{type:'read',filePath:'/owned/'+seed,content:privateText}}}]));
  validateBookActivity(reply(r.activity));assert(!JSON.stringify(r).includes(privateText));assert(r.activity.length<=1);
 }console.log('Projection property/fuzz seed0x1122026:512 metadata cases; no raw content forwarded.');
});
test('excluded kinds and paths have explicit bounded coverage counts',()=>{
 const p=projectBookActivity(page(Array(50).fill({item:{type:'thinking',text:'PRIVATE'}})));assert.deepEqual(p,{activity:[],hasOlder:false,skippedCount:50,withheldPaths:0});
 const r=projectBookActivity(page(['/elsewhere/private','../secret','relative.txt'].map(filePath=>({item:{type:'tool_call',name:'Read',status:'completed',detail:{type:'read',filePath}}}))));assert.equal(r.withheldPaths,2);assert.deepEqual(r.activity.map(a=>a.files),[[],[],['/owned/relative.txt']]);
 for(const change of [{skippedCount:51},{skippedCount:-1},{skippedCount:0.5},{withheldPaths:1}])assert.throws(()=>validateBookActivity({...reply([]),...change}));
 assert.throws(()=>validateBookActivity(reply([{id:'1',kind:'tool_call',label:'Read',state:'completed',files:['/elsewhere/private']}])));
});
test('each signed metadata field is independently validated, including empty and malformed scopes',()=>{
 const tool={id:'1',kind:'tool_call',label:'Read',state:'completed',files:['/owned/file']},r=reply([tool]);
 for(const cwd of [null,'relative','/owned/../other','/owned/','/owned\nprivate']){assert.throws(()=>project(page([]),cwd),/directory/);assert.throws(()=>validate(r,cwd),/directory/);}
 for(const change of [{taskId:'invalid'},{agentId:'invalid'},{hasOlder:'yes'},{observedAt:'x'.repeat(513)},{skippedCount:null},{withheldPaths:-1},{withheldPaths:0.5},{activity:null}])assert.throws(()=>validateBookActivity({...r,...change}),/Invalid Book/);
 for(const change of [{id:'x'},{kind:'other'},{files:null},{files:['/owned/a','/owned/b']},{label:'Read+More'},{state:null},{files:['/owned/../other/file']},{files:['/owned/file\nprivate']}])assert.throws(()=>validateBookActivity(reply([{...tool,...change}])),/Invalid Book/);
 const p=projectBookActivity(page(['Read-More','Read+More'].map(name=>({item:{type:'tool_call',name,status:'completed'}}))));assert.deepEqual(p.activity.map(a=>a.label),['Read-More','Tool']);
});
