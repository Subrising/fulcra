import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBoundedOutput } from './bounded-output.mjs';

test('three fixture-sized host replies fit; the byte cap remains bounded',()=>{
 const callbacks=[];let failed=0;
 const send=createBoundedOutput({send:(_frame,done)=>callbacks.push(done),fail:()=>failed++});
 const frame={data:'x'.repeat(674540)};
 for(let i=0;i<3;i++)send(frame);
 assert.equal(callbacks.length,3);assert.equal(failed,0);
 for(let i=3;i<13;i++)send(frame);
 assert.equal(callbacks.length,12);assert.equal(failed,1);
 send(frame);assert.equal(callbacks.length,12);assert.equal(failed,1);
});
test('completed sends release bytes; count and transport failure still close once',()=>{
 let failed=0;const callbacks=[];
 const send=createBoundedOutput({send:(_frame,done)=>callbacks.push(done),fail:()=>failed++});
 for(let i=0;i<20;i++){send({data:'x'.repeat(674540)});callbacks.shift()(null);}
 assert.equal(failed,0);
 for(let i=0;i<65;i++)send({data:'small'});
 assert.equal(callbacks.length,64);assert.equal(failed,1);
 const errors=[];let stopped=0;
 const bad=createBoundedOutput({send:(_frame,done)=>errors.push(done),fail:()=>stopped++});
 bad({});errors[0](Error('closed'));errors[0](Error('duplicate'));bad({});assert.equal(stopped,1);
});
