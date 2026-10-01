import test from 'node:test';import assert from 'node:assert/strict';
import {projectMessages,validateMessages} from './work-messages.mjs';
const row=(seq,type,text)=>({seqStart:seq,item:{type,text,arguments:'PRIVATE_TOOL',result:'PRIVATE_TOOL',thinking:'PRIVATE_THINKING'}});
test('readable excerpts retain actual words and roles, not tools, thinking or provider metadata',()=>{
 const result=projectMessages([row(1,'user_message','Check the receipt failure.'),row(2,'thinking','PRIVATE_THINKING'),row(3,'tool_call','PRIVATE_TOOL'),row(4,'assistant_message','Receipts are delayed. I am checking the retry path.')]);
 assert.deepEqual(result,[{id:'1',role:'instruction',text:'Check the receipt failure.',truncated:false},{id:'4',role:'agent',text:'Receipts are delayed. I am checking the retry path.',truncated:false}]);assert(!JSON.stringify(result).includes('PRIVATE'));
});
test('pages expose at most six messages from the displayed fifty entries and preserve Unicode boundaries',()=>{
 const r=projectMessages(Array.from({length:90},(_,i)=>row(i,'assistant_message','x'.repeat(1999)+'😀')));assert.equal(r.length,6);assert.equal(r[0].id,'84');assert(r.every(m=>m.text.length===1999&&m.truncated&&m.text.isWellFormed()));
 assert.deepEqual(projectMessages([row(1,'assistant_message','earlier'),...Array.from({length:50},(_,i)=>row(i+2,'tool_call','PRIVATE'))]),[]);
 assert.equal(projectMessages([row(1,'assistant_message','a\u202eb\u0000c\nnext')])[0].text,'abc\nnext');
});
test('signed excerpts refuse malformed, unbounded, duplicate, unordered and out-of-page content',()=>{
 const a={id:'1',role:'agent',text:'Report',truncated:false};
 for(const change of [{id:'-1'},{id:'9007199254740992'},{role:'thinking'},{text:''},{text:'x'.repeat(2001)},{text:'\ud800'},{text:'hidden\u202e'},{truncated:1},{extra:'private'}])assert.throws(()=>validateMessages([{...a,...change}]));
 for(const messages of [null,[a,a],Array(7).fill(a),[{...a,id:'2'},a]])assert.throws(()=>validateMessages(messages));
 assert.throws(()=>validateMessages([a],[{id:'2',kind:'assistant_message'}]));assert.throws(()=>validateMessages([a],[{id:'1',kind:'user_message'}]));assert.deepEqual(validateMessages([a],[{id:'1',kind:'assistant_message'}]),[a]);
});
